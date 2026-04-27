import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";
import { AllowedSniEditor, type AllowedSniHost } from "./AllowedSniEditor";
import type { SshParamsLite } from "./useVpnTomlState";

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

function renderEditor(
  hosts: AllowedSniHost[],
  onHostsChange?: (h: AllowedSniHost[]) => void,
) {
  return render(
    <SnackBarProvider>
      <ConfirmDialogProvider>
        <AllowedSniEditor
          hosts={hosts}
          sshParams={mockSsh}
          onHostsChange={onHostsChange}
        />
      </ConfirmDialogProvider>
    </SnackBarProvider>,
  );
}

beforeEach(() => {
  i18n.changeLanguage("ru");
  vi.clearAllMocks();
});

describe("AllowedSniEditor", () => {
  it("renders empty state when no hosts", () => {
    renderEditor([]);
    expect(screen.getByText("Нет декораций anti-DPI")).toBeInTheDocument();
  });

  it("renders one fieldset per host with hostname + chips", () => {
    renderEditor([
      {
        hostname: "a.example.com",
        allowedSni: ["x.example.com", "y.example.com"],
      },
    ]);
    expect(screen.getByText("a.example.com")).toBeInTheDocument();
    expect(screen.getByText("x.example.com")).toBeInTheDocument();
    expect(screen.getByText("y.example.com")).toBeInTheDocument();
  });

  it("chip remove button has aria-label with domain interpolation", () => {
    renderEditor([{ hostname: "a.com", allowedSni: ["x.example.com"] }]);
    expect(
      screen.getByLabelText("Удалить SNI x.example.com"),
    ).toBeInTheDocument();
  });

  it("Add valid SNI: optimistic add + invoke called", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    renderEditor([{ hostname: "a.com", allowedSni: ["x.com"] }]);
    const input = screen.getByLabelText("Разрешённые SNI");
    fireEvent.change(input, { target: { value: "new.example.com" } });
    fireEvent.click(screen.getByText("Добавить"));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith(
      "server_update_hosts_allowed_sni",
      expect.objectContaining({
        hostname: "a.com",
        allowedSni: ["x.com", "new.example.com"],
      }),
    );
    expect(await screen.findByText("new.example.com")).toBeInTheDocument();
  });

  it("Add invalid SNI: validation error inline, invoke NOT called", async () => {
    renderEditor([{ hostname: "a.com", allowedSni: [] }]);
    const input = screen.getByLabelText("Разрешённые SNI");
    fireEvent.change(input, { target: { value: "with spaces" } });
    fireEvent.click(screen.getByText("Добавить"));
    // Inline error shown (one of the FQDN validation messages)
    await waitFor(() => {
      const errorTexts = screen.queryAllByText(/неверный формат|пробел/i);
      expect(errorTexts.length).toBeGreaterThanOrEqual(1);
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Add duplicate SNI: error inline, invoke NOT called", async () => {
    renderEditor([{ hostname: "a.com", allowedSni: ["x.com"] }]);
    const input = screen.getByLabelText("Разрешённые SNI");
    fireEvent.change(input, { target: { value: "x.com" } });
    fireEvent.click(screen.getByText("Добавить"));
    await waitFor(() =>
      expect(screen.getByText("Этот SNI уже добавлен")).toBeInTheDocument(),
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Remove non-last SNI: chip removed + invoke called", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    renderEditor([{ hostname: "a.com", allowedSni: ["x.com", "y.com"] }]);
    fireEvent.click(screen.getByLabelText("Удалить SNI x.com"));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith(
      "server_update_hosts_allowed_sni",
      expect.objectContaining({
        hostname: "a.com",
        allowedSni: ["y.com"],
      }),
    );
    await waitFor(() => expect(screen.queryByText("x.com")).toBeNull());
  });

  it("Remove LAST SNI triggers ConfirmDialog (cancel keeps chip)", async () => {
    renderEditor([{ hostname: "a.com", allowedSni: ["x.com"] }]);
    fireEvent.click(screen.getByLabelText("Удалить SNI x.com"));
    await waitFor(() =>
      expect(screen.getByText("Удалить последний SNI?")).toBeInTheDocument(),
    );
    // Find Cancel button by role + name (i18n: "Отмена")
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    // Confirm dialog closes, chip stays, NO invoke
    await waitFor(() =>
      expect(screen.queryByText("Удалить последний SNI?")).toBeNull(),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByText("x.com")).toBeInTheDocument();
  });

  it("Remove LAST SNI triggers ConfirmDialog (confirm deletes + invokes)", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    renderEditor([{ hostname: "a.com", allowedSni: ["x.com"] }]);
    fireEvent.click(screen.getByLabelText("Удалить SNI x.com"));
    await waitFor(() =>
      expect(screen.getByText("Удалить последний SNI?")).toBeInTheDocument(),
    );
    // Click Confirm — accepts either "Удалить" or "Подтвердить" depending on
    // which fallback i18n key resolves (plan uses t("buttons.confirm", "Удалить")
    // → "Подтвердить" from buttons.confirm).
    const confirmBtn = screen.getByRole("button", {
      name: /удалить$|подтверди/i,
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith(
      "server_update_hosts_allowed_sni",
      expect.objectContaining({
        hostname: "a.com",
        allowedSni: [],
      }),
    );
  });

  it("Optimistic rollback on backend error: chip removed back + ErrorBanner visible", async () => {
    vi.mocked(invoke).mockRejectedValue("HOSTS_TOML_WRITE_FAILED|code=1");
    renderEditor([{ hostname: "a.com", allowedSni: [] }]);
    const input = screen.getByLabelText("Разрешённые SNI");
    fireEvent.change(input, { target: { value: "new.com" } });
    fireEvent.click(screen.getByText("Добавить"));
    // Wait for invoke to settle (rejection)
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    // Rollback: chip removed
    await waitFor(() => expect(screen.queryByText("new.com")).toBeNull());
    // ErrorBanner inside fieldset visible (uses generic save error i18n)
    expect(screen.getByText(/не удалось сохранить/i)).toBeInTheDocument();
  });

  it("Multiple hosts isolated: editing host A does not affect host B chips", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    renderEditor([
      { hostname: "a.com", allowedSni: ["x-a.com"] },
      { hostname: "b.com", allowedSni: ["y-b.com"] },
    ]);
    // Add chip to host A — first Add button in DOM order
    const aFieldset = screen.getByTestId("sni-host-a.com");
    const aInput = aFieldset.querySelector(
      'input[placeholder="cdn.example.com"]',
    ) as HTMLInputElement;
    fireEvent.change(aInput, { target: { value: "new-a.com" } });
    const allAddButtons = screen.getAllByText("Добавить");
    fireEvent.click(allAddButtons[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    // Host B unchanged
    expect(screen.getByText("y-b.com")).toBeInTheDocument();
    // Verify last invoke targeted host A
    expect(invoke).toHaveBeenLastCalledWith(
      "server_update_hosts_allowed_sni",
      expect.objectContaining({ hostname: "a.com" }),
    );
  });

  it("onHostsChange callback fires with updated full list after add", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const onHostsChange = vi.fn();
    renderEditor(
      [{ hostname: "a.com", allowedSni: ["x.com"] }],
      onHostsChange,
    );
    const input = screen.getByLabelText("Разрешённые SNI");
    fireEvent.change(input, { target: { value: "new.com" } });
    fireEvent.click(screen.getByText("Добавить"));
    await waitFor(() => expect(onHostsChange).toHaveBeenCalled());
    const calls = onHostsChange.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall).toEqual([
      { hostname: "a.com", allowedSni: ["x.com", "new.com"] },
    ]);
  });
});
