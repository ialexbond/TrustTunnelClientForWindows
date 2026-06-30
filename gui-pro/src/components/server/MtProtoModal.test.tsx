import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import MtProtoModalSource from "./MtProtoModal.tsx?raw";
import i18n from "../../shared/i18n";
import { MtProtoModal } from "./MtProtoModal";
import type { MtProtoState, MtProtoStatus, SshParams } from "./useMtProtoState";
import { renderWithProviders as render } from "../../test/test-utils";

// ─── Mocks ──────────────────────────────────────────

// D-29: activityLogSpy для security verification — никакие passwords
// и proxy_link-и не должны попадать в activityLog
const activityLogSpy = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// useConfirm — auto-confirm by default (override in specific tests)
const confirmMock = vi.fn().mockResolvedValue(true);
vi.mock("../../shared/ui/useConfirm", () => ({
  useConfirm: () => confirmMock,
}));

// ─── Fixtures ───────────────────────────────────────

const SSH_PARAMS: SshParams = {
  host: "example.com",
  port: 22,
  user: "admin",
  password: "testpass-MTProto-XYZ",
};

// Phase 17.1 D-5.5 — 7-step fixture (telemt). Labels берутся из ru.json
// (i18n активирован в beforeEach). STEPS здесь — это уже "translated" array
// который реальный hook возвращает в `steps` поле.
const STEPS = [
  { key: "cleanup_legacy", label: "Очистка старого MTProxy" },
  { key: "download_binary", label: "Скачивание бинаря telemt" },
  { key: "create_user", label: "Создание пользователя" },
  { key: "configure_telemt", label: "Настройка telemt.toml" },
  { key: "start_service", label: "Запуск сервиса" },
  { key: "open_firewall", label: "Открытие порта firewall" },
  { key: "complete", label: "Готово" },
];

function mkState(statusOverride?: Partial<MtProtoStatus> | null, extras?: Partial<{
  installing: boolean;
  uninstalling: boolean;
  loading: boolean;
  error: string | null;
  currentStep: number;
  stepStatus: "active" | "error" | "completed";
  install: ReturnType<typeof vi.fn>;
  requestUninstall: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  legacyMigrationNote: string | null;
}>): MtProtoState {
  const status: MtProtoStatus | null =
    statusOverride === null
      ? null
      : {
          installed: false,
          active: false,
          port: 0,
          secret: "",
          proxy_link: "",
          ...(statusOverride ?? {}),
        };

  return {
    status,
    loading: extras?.loading ?? false,
    error: extras?.error ?? null,
    installing: extras?.installing ?? false,
    uninstalling: extras?.uninstalling ?? false,
    currentStep: extras?.currentStep ?? 0,
    stepStatus: extras?.stepStatus ?? "active",
    steps: STEPS,
    load: vi.fn().mockResolvedValue(undefined),
    install: extras?.install ?? vi.fn().mockResolvedValue(undefined),
    requestUninstall: extras?.requestUninstall ?? vi.fn().mockResolvedValue(undefined),
    retry: extras?.retry ?? vi.fn(),
    sshParams: SSH_PARAMS,
    // Phase 17.1 — additive поле в hook return type, опциональное в test fixture.
    legacyMigrationNote: extras?.legacyMigrationNote ?? null,
  } as unknown as MtProtoState;
}

// ─── Setup ──────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  activityLogSpy.mockClear();
  confirmMock.mockResolvedValue(true);
  void i18n.changeLanguage("ru");
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

// ─── Tests ──────────────────────────────────────────

describe("MtProtoModal", () => {
  // Test 1: install view when not installed
  it("renders_install_view_when_not_installed — port input + Install button visible", () => {
    const state = mkState({ installed: false, active: false });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    expect(screen.getByPlaceholderText("8443")).toBeInTheDocument();
    expect(screen.getByTestId("mtproto-install-button")).toBeInTheDocument();
  });

  // Test 2: configured view when installed
  it("renders_configured_view_when_installed — port + proxy_link + Copy + Uninstall", () => {
    const state = mkState({
      installed: true,
      active: true,
      port: 4443,
      proxy_link: "tg://proxy?server=example.com&port=4443&secret=aabb",
    });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    // Port number visible in mono
    expect(screen.getByText("4443")).toBeInTheDocument();
    // Proxy link visible — now a read-only <input>, so assert its display value.
    expect(
      screen.getByDisplayValue("tg://proxy?server=example.com&port=4443&secret=aabb"),
    ).toBeInTheDocument();
    // Buttons
    expect(screen.getByRole("button", { name: /скопировать/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /удалить/i })).toBeInTheDocument();
  });

  // Test 3: default port on open = 8443 (Phase 17.1 D-2.3 / D-2.4)
  it("default_port_on_open — port input initialized с 8443 (telemt default)", () => {
    const state = mkState({ installed: false });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    const input = screen.getByPlaceholderText("8443") as HTMLInputElement;
    expect(input.value).toBe("8443");
  });

  // Test 4: install click calls state.install with port number
  it("install_click_calls_state_install_with_port — type 5555 → install called with 5555", async () => {
    const installFn = vi.fn().mockResolvedValue(undefined);
    const state = mkState({ installed: false }, { install: installFn });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    const input = screen.getByPlaceholderText("8443") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5555" } });
    fireEvent.click(screen.getByTestId("mtproto-install-button"));
    await waitFor(() => {
      expect(installFn).toHaveBeenCalledWith(5555);
    });
  });

  // Test 5: uninstall click calls requestUninstall (confirm dialog)
  it("uninstall_click_confirms_then_calls_state_requestUninstall", async () => {
    const requestUninstall = vi.fn().mockResolvedValue(undefined);
    const state = mkState(
      { installed: true, active: true, port: 4443, proxy_link: "tg://proxy?x=1" },
      { requestUninstall },
    );
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /удалить/i }));
    await waitFor(() => {
      expect(requestUninstall).toHaveBeenCalledTimes(1);
    });
  });

  // Test 6: Copy button writes proxy_link to clipboard
  it("copy_button_writes_to_clipboard — clipboard.writeText called with proxy_link", async () => {
    const proxyLink = "tg://proxy?server=example.com&port=4443&secret=deadbeef";
    const state = mkState({
      installed: true,
      active: true,
      port: 4443,
      proxy_link: proxyLink,
    });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /скопировать/i }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(proxyLink);
    });
  });

  // Test 7: T-03 SOURCE — anti-pattern guard: no early return null before <Modal> in non-comment code
  it("T-03 SOURCE early_return_null_absent — MtProtoModal.tsx has no early return null in code", () => {
    const source = MtProtoModalSource as string;
    // Strip single-line comments and block JSDoc comments, then check no runtime early-return
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, "") // remove block comments (JSDoc)
      .replace(/\/\/[^\n]*/g, "");      // remove single-line comments
    expect(withoutComments).not.toMatch(/if\s*\(!isOpen\)\s*return\s+null/);
  });

  // Test 8: D-29 SECURITY — password NEVER in activityLog
  it("D-29 SECURITY no_password_in_activity_log — testpass-MTProto-XYZ absent from log calls", async () => {
    const installFn = vi.fn().mockResolvedValue(undefined);
    const requestUninstall = vi.fn().mockResolvedValue(undefined);
    const proxyLink = "tg://proxy?server=example.com&port=4443&secret=s3cr3t";

    // Phase 1: install flow
    const stateInstall = mkState({ installed: false }, { install: installFn });
    const { unmount } = render(
      <MtProtoModal
        isOpen={true}
        onClose={vi.fn()}
        state={stateInstall}
        sshParams={SSH_PARAMS}
      />,
    );
    const input = screen.getByPlaceholderText("8443") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "4443" } });
    fireEvent.click(screen.getByTestId("mtproto-install-button"));
    await waitFor(() => expect(installFn).toHaveBeenCalled());
    unmount();

    // Phase 2: uninstall flow
    const stateUninstall = mkState(
      { installed: true, active: true, port: 4443, proxy_link: proxyLink },
      { requestUninstall },
    );
    const { unmount: unmount2 } = render(
      <MtProtoModal
        isOpen={true}
        onClose={vi.fn()}
        state={stateUninstall}
        sshParams={SSH_PARAMS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /удалить/i }));
    await waitFor(() => expect(requestUninstall).toHaveBeenCalled());
    unmount2();

    // Phase 3: copy flow
    const stateCopy = mkState(
      { installed: true, active: true, port: 4443, proxy_link: proxyLink },
    );
    render(
      <MtProtoModal
        isOpen={true}
        onClose={vi.fn()}
        state={stateCopy}
        sshParams={SSH_PARAMS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /скопировать/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());

    // D-29 assertion: password NEVER logged
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("testpass-MTProto-XYZ"),
    );
  });

  // Test 9: D-29 SECURITY — proxy_link (contains MTProto secret) NEVER in activityLog
  it("D-29 SECURITY no_proxy_link_in_activity_log — tg://proxy secret absent from log calls", async () => {
    const proxyLink = "tg://proxy?server=example.com&port=4443&secret=s3cr3t";
    const state = mkState({
      installed: true,
      active: true,
      port: 4443,
      proxy_link: proxyLink,
    });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /скопировать/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());

    // D-29: proxy_link content NEVER appears in activityLog (contains MTProto secret)
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("tg://proxy"),
    );
  });

  // ─── E-14 (09-08): retry must validate the port range (never send 0) ───
  //
  // Root cause (MtProtoModal.tsx:414-419): the retry branch called
  // state.retry(parseInt(portInput,10) || 0), bypassing handleInstall's range
  // validation. An empty port → parseInt("") === NaN → `|| 0` → retry(0) fired
  // with port 0 and a confusing backend error. Fix routes retry through the
  // same guard handleInstall uses.
  it("E-14: retry with a cleared port does NOT call retry/install with 0", async () => {
    const retryFn = vi.fn();
    const installFn = vi.fn().mockResolvedValue(undefined);
    const state = mkState(
      { installed: false },
      { error: "network down", retry: retryFn, install: installFn },
    );
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    // In error state the button reads «Повторить».
    const btn = screen.getByTestId("mtproto-install-button");
    expect(btn.textContent).toContain("Повторить");

    // Clear the port input (default 8443 → empty).
    const input = screen.getByPlaceholderText("8443") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    fireEvent.click(btn);

    // Neither retry nor install may fire with an invalid/zero port.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(retryFn).not.toHaveBeenCalled();
    expect(retryFn).not.toHaveBeenCalledWith(0);
    expect(installFn).not.toHaveBeenCalled();
  });

  it("E-14 positive control: retry with a valid port retries with that port", async () => {
    const retryFn = vi.fn();
    const state = mkState(
      { installed: false },
      { error: "network down", retry: retryFn },
    );
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    const input = screen.getByPlaceholderText("8443") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9443" } });
    fireEvent.click(screen.getByTestId("mtproto-install-button"));
    await waitFor(() => {
      expect(retryFn).toHaveBeenCalledWith(9443);
    });
  });

  // ─── 09-25: footer standard (owner §6) ───

  // Configured-view footer carries NO labeled «Закрыть» text button — the
  // corner × is the close affordance instead (F18 / owner §6.5).
  it("09-25 configured footer has NO «Закрыть» text button", () => {
    const state = mkState({
      installed: true,
      active: true,
      port: 4443,
      proxy_link: "tg://proxy?x=1",
    });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    // The corner × uses aria-label buttons.close ("Закрыть") — so query the
    // labeled FOOTER button specifically: a button whose visible TEXT is
    // «Закрыть». The corner × has no text content.
    const labeledClose = screen
      .queryAllByRole("button")
      .filter((b) => b.textContent?.trim() === i18n.t("buttons.close"));
    expect(labeledClose).toHaveLength(0);
  });

  // Canonical corner × is present (queryable by its close aria-label).
  it("09-25 renders the canonical corner close button", () => {
    const state = mkState({ installed: true, active: true, port: 4443, proxy_link: "tg://proxy?x=1" });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    expect(
      screen.getByRole("button", { name: i18n.t("buttons.close") }),
    ).toBeInTheDocument();
  });

  // When active, the stop control is variant=danger (solid red); when inactive
  // the start control is variant=primary (solid teal). Owner §6.4.
  it("09-25 stop=danger when active", () => {
    const state = mkState({ installed: true, active: true, port: 4443, proxy_link: "tg://proxy?x=1" });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    expect(screen.getByTestId("mtproto-stop-button")).toHaveAttribute("data-variant", "danger");
  });

  it("09-25 start=primary when inactive", () => {
    const state = mkState({ installed: true, active: false, port: 4443 });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    expect(screen.getByTestId("mtproto-start-button")).toHaveAttribute("data-variant", "primary");
  });

  // Test 10: port validation rejects out-of-range
  it("port_validation_rejects_out_of_range — invalid port 100 does NOT call state.install", async () => {
    const installFn = vi.fn().mockResolvedValue(undefined);
    const state = mkState({ installed: false }, { install: installFn });
    render(
      <MtProtoModal isOpen={true} onClose={vi.fn()} state={state} sshParams={SSH_PARAMS} />,
    );
    const input = screen.getByPlaceholderText("8443") as HTMLInputElement;
    // Enter out-of-range port
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByTestId("mtproto-install-button"));
    // install should NOT be called — validation fails
    await waitFor(() => {
      expect(installFn).not.toHaveBeenCalled();
    });
    // Validation error message visible
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
