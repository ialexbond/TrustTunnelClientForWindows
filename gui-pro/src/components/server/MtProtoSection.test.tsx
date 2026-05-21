import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { MtProtoSection } from "./MtProtoSection";
import type { MtProtoState, MtProtoStatus, SshParams } from "./useMtProtoState";
import { renderWithProviders as render } from "../../test/test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));

const SSH_PARAMS: SshParams = {
  host: "example.com",
  port: 22,
  user: "admin",
  password: "test-section-pass",
};

// Phase 17.1 D-5.5 — 7-step list (telemt rewrite).
const STEPS = [
  { key: "cleanup_legacy", label: "Очистка старого MTProxy" },
  { key: "download_binary", label: "Скачивание бинаря telemt" },
  { key: "create_user", label: "Создание пользователя" },
  { key: "configure_telemt", label: "Настройка telemt.toml" },
  { key: "start_service", label: "Запуск сервиса" },
  { key: "open_firewall", label: "Открытие порта firewall" },
  { key: "complete", label: "Готово" },
];

function mkState(
  statusOverride?: Partial<MtProtoStatus> | null,
  extras?: Partial<{ legacyMigrationNote: string | null }>,
): MtProtoState {
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
    loading: false,
    error: null,
    installing: false,
    uninstalling: false,
    currentStep: 0,
    stepStatus: "active",
    steps: STEPS,
    load: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    requestUninstall: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
    sshParams: SSH_PARAMS,
    // Phase 17.1 — additive поле (Option B per researcher §Migration Plan).
    legacyMigrationNote: extras?.legacyMigrationNote ?? null,
  } as unknown as MtProtoState;
}

beforeEach(() => {
  vi.clearAllMocks();
  void i18n.changeLanguage("ru");
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("MtProtoSection", () => {
  it("renders Card with correct data-testid", () => {
    const state = mkState({ installed: false, active: false });
    render(<MtProtoSection state={state} sshParams={SSH_PARAMS} />);
    expect(screen.getByTestId("mtproto-section-card")).toBeVisible();
  });

  it("not_installed state shows «Установить» button (primary)", () => {
    const state = mkState({ installed: false, active: false });
    render(<MtProtoSection state={state} sshParams={SSH_PARAMS} />);
    const btn = screen.getByTestId("mtproto-open-button");
    expect(btn).toBeVisible();
    expect(btn.textContent).toContain("Установить");
  });

  it("installed+active state shows «Настроить» button and success indicator", () => {
    const state = mkState({ installed: true, active: true, port: 4443 });
    render(<MtProtoSection state={state} sshParams={SSH_PARAMS} />);
    const btn = screen.getByTestId("mtproto-open-button");
    expect(btn).toBeVisible();
    expect(btn.textContent).toContain("Настроить");
    // StatusIndicator should have success aria-label (содержит "Активен на порту 4443")
    const indicator = screen.getByRole("img");
    expect(indicator).toBeVisible();
    expect(indicator.getAttribute("aria-label")).toContain("Активен на порту 4443");
  });

  it("click button opens MtProtoModal (modal install button appears)", () => {
    const state = mkState({ installed: false, active: false });
    render(<MtProtoSection state={state} sshParams={SSH_PARAMS} />);
    const btn = screen.getByTestId("mtproto-open-button");
    fireEvent.click(btn);
    // After click, MtProtoModal renders install form — install button inside Modal appears
    expect(screen.getByTestId("mtproto-install-button")).toBeInTheDocument();
  });
});
