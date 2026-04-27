import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";
import { QuickSettingsSection } from "./QuickSettingsSection";
import type {
  SshParamsLite,
  VpnTomlState,
  QuickSettingsFields,
} from "./useVpnTomlState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const stableLog = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: stableLog }),
}));

const mockSsh: SshParamsLite = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "secret",
};

const SAMPLE_BUNDLE = {
  vpnToml: 'listen_address = "0.0.0.0:443"\n',
  hostsToml: "",
  typed: {
    listen_address: "0.0.0.0:443",
    ipv6_available: true,
    allow_private_network_connections: false,
    log_level: "info",
    auth_failure_status_code: 407,
    ping_enable: false,
    speedtest_enable: false,
    ping_path: "/ping",
    speedtest_path: "/speedtest",
    credentials_file: "credentials.toml",
    extra: {},
  },
  allowedSni: [],
  serviceStatus: "active",
};

function renderSection() {
  return render(
    <SnackBarProvider>
      <ConfirmDialogProvider>
        <QuickSettingsSection sshParams={mockSsh} />
      </ConfirmDialogProvider>
    </SnackBarProvider>,
  );
}

beforeEach(() => {
  i18n.changeLanguage("ru");
  vi.clearAllMocks();
});

describe("QuickSettingsSection", () => {
  it("renders Skeleton during initial load", () => {
    vi.mocked(invoke).mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );
    renderSection();
    expect(screen.getByTestId("quick-settings-loading")).toBeInTheDocument();
  });

  it("renders 6 fields after bundle resolves", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Путь Health Check")).toBeInTheDocument();
    expect(screen.getByLabelText("Путь Speed Test")).toBeInTheDocument();
    // Toggle for allow_private (label rendered as text)
    expect(screen.getByText("Частные сети")).toBeInTheDocument();
    // Selects for log_level + auth_status (rendered via Select component)
    expect(screen.getByText("Уровень логов")).toBeInTheDocument();
    expect(screen.getByText("Код ошибки авторизации")).toBeInTheDocument();
  });

  it("renders disrupt-high RestartRequiredBadge for listen_address", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument();
    });
    // listen_address is the only disrupt-high field
    const highBadges = screen.getAllByText("Прервёт активные подключения");
    expect(highBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders disrupt-low badges for the other 5 fields", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument();
    });
    const lowBadges = screen.getAllByText("Перезапустит сервис");
    // 5 disrupt-low fields: log_level, allow_private, auth_status, ping_path, speedtest_path
    expect(lowBadges.length).toBe(5);
  });

  it("DirtyChangesBanner hidden initially, shown after edit", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument();
    });
    expect(screen.queryByText(/несохранённ/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Адрес и порт"), {
      target: { value: "0.0.0.0:8443" },
    });
    await waitFor(() => {
      expect(screen.getByText(/несохранённ/i)).toBeInTheDocument();
    });
  });

  it("frontend validation blocks Save when listen_address invalid (no port)", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Адрес и порт"), {
      target: { value: "0.0.0.0" },
    });
    await waitFor(() => {
      // Some validator-derived error text appears (format/port)
      const matches = screen.getAllByText(/формат|порт|пуст/i);
      expect(matches.length).toBeGreaterThan(0);
    });
    // Bottom Save CTA should be disabled
    const saveButton = screen.getByRole("button", {
      name: /применить настройки|применить \(/i,
    });
    expect(saveButton).toBeDisabled();
  });

  it("Discard button triggers ConfirmDialog and restores initial values", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument();
    });
    // Edit listen_address
    fireEvent.change(screen.getByLabelText("Адрес и порт"), {
      target: { value: "0.0.0.0:8443" },
    });
    await waitFor(() => {
      expect(screen.getByText(/несохранённ/i)).toBeInTheDocument();
    });
    // Click discard from banner
    fireEvent.click(screen.getByText("Отменить изменения"));
    // ConfirmDialog appears
    await waitFor(() => {
      expect(screen.getByText("Отменить изменения?")).toBeInTheDocument();
    });
    // Confirm discard
    fireEvent.click(screen.getByText("Да, отменить"));
    await waitFor(() => {
      // Field should revert
      expect(
        (screen.getByLabelText("Адрес и порт") as HTMLInputElement).value,
      ).toBe("0.0.0.0:443");
    });
  });

  it("Save flow shows ConfirmDialog with disrupt-high copy when listen_address dirty", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Адрес и порт"), {
      target: { value: "0.0.0.0:8443" },
    });
    await waitFor(() => {
      expect(screen.getByText(/несохранённ/i)).toBeInTheDocument();
    });
    // Use bottom CTA — get all save-named buttons and pick last (bottom CTA)
    const buttons = screen.getAllByRole("button");
    const saveBtn = buttons.find(
      (b) =>
        b.textContent?.match(/применить/i) &&
        !b.textContent?.match(/отменить/i),
    );
    expect(saveBtn).toBeTruthy();
    fireEvent.click(saveBtn!);
    // ConfirmDialog appears with disrupt-high copy
    await waitFor(() => {
      expect(screen.getByText("Применить настройки?")).toBeInTheDocument();
    });
    // High-disrupt copy contains "прервёт"
    expect(
      screen.getByText(/прервёт все активные подключения/i),
    ).toBeInTheDocument();
  });

  it("Save flow shows ConfirmDialog with disrupt-low copy when only log_level dirty", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument();
    });
    // Open log_level Select and select "debug". Select primitive renders
    // the trigger as `<button role="combobox">` without an accessible name —
    // the visible value is in an inner `<span>`, but role-name matching does
    // not pick that up reliably. We use index-based selection (first combobox
    // = log_level, second = auth_status_code) which matches the render order.
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes.length).toBe(2);
    const logLevelTrigger = comboboxes[0];
    fireEvent.click(logLevelTrigger);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "debug" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("option", { name: "debug" }));
    await waitFor(() => {
      expect(screen.getByText(/несохранённ/i)).toBeInTheDocument();
    });
    // Click bottom Save CTA
    const buttons = screen.getAllByRole("button");
    const saveBtn = buttons.find(
      (b) =>
        b.textContent?.match(/применить/i) &&
        !b.textContent?.match(/отменить/i),
    );
    expect(saveBtn).toBeTruthy();
    fireEvent.click(saveBtn!);
    // Disrupt-low confirm message contains "перезапустится"
    await waitFor(() => {
      expect(screen.getByText("Применить настройки?")).toBeInTheDocument();
    });
    expect(screen.getByText(/перезапустится/i)).toBeInTheDocument();
    // Should NOT contain disrupt-high copy
    expect(screen.queryByText(/прервёт все активные подключения/i)).toBeNull();
  });

  it("ErrorBanner shown on load failure", async () => {
    vi.mocked(invoke).mockRejectedValue("SSH_TIMEOUT");
    renderSection();
    await waitFor(() => {
      expect(screen.queryByTestId("quick-settings-loading")).toBeNull();
    });
    // ErrorBanner uses generic save-error i18n string ("Не удалось ...")
    expect(screen.getByText(/не удалось/i)).toBeInTheDocument();
  });

  it("uses parent-provided state instead of internal hook when state prop set", async () => {
    // Make invoke hang — internal hook would stay in loading=true forever
    vi.mocked(invoke).mockImplementation(
      () => new Promise(() => { /* hangs */ }),
    );
    const parentFields: QuickSettingsFields = {
      listen_address: "0.0.0.0:443",
      log_level: "debug", // pre-edited via parent state
      allow_private_network_connections: false,
      auth_failure_status_code: 407,
      ping_path: "/ping",
      speedtest_path: "/speedtest",
    };
    const initialFields: QuickSettingsFields = {
      ...parentFields,
      log_level: "info",
    };
    const parentState: VpnTomlState = {
      vpnTomlRaw: 'listen_address = "0.0.0.0:443"\n',
      hostsTomlRaw: "",
      fields: parentFields,
      initialFields,
      allowedSni: [],
      serviceStatus: "active",
      loading: false, // <-- key: parent says NOT loading even though invoke hangs
      saving: false,
      error: null,
      isDirty: true,
      dirtyFields: ["log_level"],
      highRiskCount: 0,
      setField: vi.fn(),
      discard: vi.fn(),
      loadBundle: vi.fn(),
      saveBatch: vi.fn(),
    };
    render(
      <SnackBarProvider>
        <ConfirmDialogProvider>
          <QuickSettingsSection sshParams={mockSsh} state={parentState} />
        </ConfirmDialogProvider>
      </SnackBarProvider>,
    );
    // Despite invoke hanging, parent state has loading=false → form is rendered
    await waitFor(() =>
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument(),
    );
    // Skeleton is NOT shown because parent-provided state has loading=false
    expect(screen.queryByTestId("quick-settings-loading")).toBeNull();
  });
});
