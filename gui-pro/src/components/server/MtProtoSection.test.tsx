import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { MtProtoSection } from "./MtProtoSection";
import type { MtProtoState } from "./useMtProtoState";

// ─── Helpers ────────────────────────────────────────

const STEPS = [
  { key: "download", label: "Скачивание" },
  { key: "configure", label: "Настройка" },
  { key: "generate_secret", label: "Генерация ключа" },
  { key: "start_service", label: "Запуск сервиса" },
  { key: "complete", label: "Готово" },
];

function makeState(overrides?: Partial<MtProtoState>): MtProtoState {
  return {
    status: null,
    loading: false,
    error: null,
    installing: false,
    uninstalling: false,
    currentStep: 0,
    stepStatus: "active",
    steps: STEPS,
    load: vi.fn(),
    install: vi.fn(),
    requestUninstall: vi.fn(),
    retry: vi.fn(),
    sshParams: { host: "1.2.3.4", port: 22, user: "root", password: "pass", keyPath: "" },
    ...overrides,
  } as unknown as MtProtoState;
}

// ─── Tests ──────────────────────────────────────────

describe("MtProtoSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");

    // Mock clipboard API — writeText returns a resolved promise.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders not_installed state with port input and Install button (MTPROTO-01)", () => {
    const state = makeState({
      status: { installed: false, active: false, port: 0, secret: "", proxy_link: "" },
    });

    render(<MtProtoSection state={state} />);

    // Status pill shows "Не установлен"
    expect(screen.getByText("Не установлен")).toBeVisible();
    // Install CTA
    expect(screen.getByRole("button", { name: "Установить" })).toBeVisible();
    // Port input with placeholder hinting the 1024-65535 range
    expect(screen.getByPlaceholderText("Случайный (1024-65535)")).toBeVisible();
  });

  it("renders installing state with StepProgress (MTPROTO-02)", () => {
    const state = makeState({
      status: { installed: false, active: false, port: 0, secret: "", proxy_link: "" },
      installing: true,
      currentStep: 1,
      stepStatus: "active",
    });

    render(<MtProtoSection state={state} />);

    // Status label
    expect(screen.getByText("Установка...")).toBeVisible();
    // Every StepProgress label rendered (means StepProgress is mounted)
    for (const step of STEPS) {
      expect(screen.getByText(step.label)).toBeVisible();
    }
    // Install CTA is NOT shown while installing
    expect(screen.queryByRole("button", { name: "Установить" })).not.toBeInTheDocument();
  });

  it("renders installed state with proxy_link and Copy button (MTPROTO-05, MTPROTO-06)", () => {
    const proxyLink = "tg://proxy?server=1.2.3.4&port=8443&secret=ee00";
    const state = makeState({
      status: {
        installed: true,
        active: true,
        port: 8443,
        secret: "ee00",
        proxy_link: proxyLink,
      },
    });

    render(<MtProtoSection state={state} />);

    // Proxy link rendered verbatim
    expect(screen.getByText(proxyLink)).toBeVisible();
    // Copy button
    expect(screen.getByRole("button", { name: "Скопировать" })).toBeVisible();
    // Uninstall button
    expect(screen.getByRole("button", { name: "Удалить" })).toBeVisible();
    // Port display
    expect(screen.getByText("Порт: 8443")).toBeVisible();
  });

  it("renders error state with error message and Retry button", () => {
    const state = makeState({
      status: { installed: false, active: false, port: 0, secret: "", proxy_link: "" },
      error: "SSH connection refused",
    });

    render(<MtProtoSection state={state} />);

    expect(screen.getByText("SSH connection refused")).toBeVisible();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeVisible();
    // Status pill reflects the error
    expect(screen.getByText("Ошибка")).toBeVisible();
  });

  it("Copy button writes proxy_link to clipboard", async () => {
    const proxyLink = "tg://proxy?server=host&port=443&secret=ff";
    const state = makeState({
      status: {
        installed: true,
        active: true,
        port: 443,
        secret: "ff",
        proxy_link: proxyLink,
      },
    });

    render(<MtProtoSection state={state} />);

    fireEvent.click(screen.getByRole("button", { name: "Скопировать" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(proxyLink);
    });
  });

  it("Uninstall button calls requestUninstall (MTPROTO-08)", () => {
    const requestUninstall = vi.fn();
    const state = makeState({
      status: {
        installed: true,
        active: true,
        port: 8443,
        secret: "ee",
        proxy_link: "tg://proxy?x=1",
      },
      requestUninstall,
    });

    render(<MtProtoSection state={state} />);

    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(requestUninstall).toHaveBeenCalledTimes(1);
  });

  it("port input accepts values 1024-65535 (MTPROTO-03)", () => {
    const state = makeState({
      status: { installed: false, active: false, port: 0, secret: "", proxy_link: "" },
    });

    render(<MtProtoSection state={state} />);

    const input = screen.getByPlaceholderText("Случайный (1024-65535)") as HTMLInputElement;

    // NumberInput filters input to digits and exposes inputMode=numeric.
    expect(input).toHaveAttribute("inputMode", "numeric");

    // Valid port 1024 — no internal error surfaces on blur.
    fireEvent.change(input, { target: { value: "1024" } });
    fireEvent.blur(input);
    expect(input.value).toBe("1024");
    expect(screen.queryByText(/^Min:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Max:/)).not.toBeInTheDocument();

    // Out-of-range port 80 — NumberInput shows the Min: hint on blur.
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.blur(input);
    expect(screen.getByText("Min: 1024")).toBeVisible();

    // Above-max 70000 triggers Max hint.
    fireEvent.change(input, { target: { value: "70000" } });
    fireEvent.blur(input);
    expect(screen.getByText("Max: 65535")).toBeVisible();
  });
});
