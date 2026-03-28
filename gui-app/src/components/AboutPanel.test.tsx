import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import i18n from "../shared/i18n";
import AboutPanel from "./AboutPanel";

describe("AboutPanel", () => {
  const defaultProps = {
    updateInfo: {
      available: false,
      latestVersion: "1.5.0",
      currentVersion: "1.5.0",
      downloadUrl: "",
      releaseNotes: "",
      checking: false,
    },
    onCheckUpdates: vi.fn(),
    onOpenDownload: vi.fn(),
  };

  let listenCallback: ((event: { payload: unknown }) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    listenCallback = null;
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      if (eventName === "update-progress") {
        listenCallback = handler as (event: { payload: unknown }) => void;
      }
      return () => {};
    });
  });

  // ─── Basic rendering ───

  it("renders app name and version", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText("TrustTunnel")).toBeInTheDocument();
    expect(screen.getByText(/v1\.5\.0/)).toBeInTheDocument();
  });

  it("renders about description", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText(i18n.t("about.description"))).toBeInTheDocument();
  });

  it("renders vibe-coding mention", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText(i18n.t("about.vibe_coding"))).toBeInTheDocument();
  });

  it("renders GitHub link", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("opens GitHub URL when GitHub button clicked", () => {
    render(<AboutPanel {...defaultProps} />);
    fireEvent.click(screen.getByText("GitHub"));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/ialexbond/TrustTunnelClient"
    );
  });

  it("shows default version when currentVersion is empty", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{ ...defaultProps.updateInfo, currentVersion: "" }}
      />
    );
    expect(screen.getByText(/v2\.0\.0/)).toBeInTheDocument();
  });

  // ─── No update available ───

  it("shows 'up to date' when no update available", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(
      screen.getByText("У вас установлена актуальная версия")
    ).toBeInTheDocument();
  });

  // ─── Update available ───

  it("shows update available with version", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );
    expect(screen.getByText("Доступна версия 2.0.0")).toBeInTheDocument();
    expect(screen.getByText("Обновить автоматически")).toBeInTheDocument();
  });

  it("shows release notes first line when available", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
          releaseNotes: "Bug fixes and improvements\nMore details here",
        }}
      />
    );
    expect(
      screen.getByText("Bug fixes and improvements")
    ).toBeInTheDocument();
  });

  it("disables auto-update button when no downloadUrl", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "",
        }}
      />
    );
    const btn = screen.getByText("Обновить автоматически").closest("button");
    expect(btn).toBeDisabled();
  });

  it("calls onOpenDownload when manual download button clicked", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );
    const downloadBtn = screen.getByTitle("Скачать вручную из браузера");
    fireEvent.click(downloadBtn);
    expect(defaultProps.onOpenDownload).toHaveBeenCalledOnce();
  });

  // ─── Checking state ───

  it("shows checking state on check button", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{ ...defaultProps.updateInfo, checking: true }}
      />
    );
    expect(screen.getByText("Проверка...")).toBeInTheDocument();
  });

  it("disables check button while checking", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{ ...defaultProps.updateInfo, checking: true }}
      />
    );
    const btn = screen.getByText("Проверка...").closest("button");
    expect(btn).toBeDisabled();
  });

  it("calls onCheckUpdates when check button clicked", () => {
    render(<AboutPanel {...defaultProps} />);
    fireEvent.click(screen.getByText("Проверить обновления"));
    expect(defaultProps.onCheckUpdates).toHaveBeenCalledOnce();
  });

  // ─── Self-update flow ───

  it("invokes self_update when auto-update button clicked", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );
    fireEvent.click(screen.getByText("Обновить автоматически"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("self_update", {
        downloadUrl: "https://example.com/update.zip",
      });
    });
  });

  it("shows downloading progress UI after clicking auto-update", async () => {
    vi.mocked(invoke).mockImplementation(
      () => new Promise(() => {}) // never resolves — simulates ongoing download
    );
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );
    fireEvent.click(screen.getByText("Обновить автоматически"));
    await waitFor(() => {
      expect(screen.getByText("Подготовка...")).toBeInTheDocument();
    });
  });

  it("disables check-updates button while updating", async () => {
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );
    fireEvent.click(screen.getByText("Обновить автоматически"));
    await waitFor(() => {
      const checkBtn = screen.getByText("Проверить обновления").closest("button");
      expect(checkBtn).toBeDisabled();
    });
  });

  // ─── Update progress via event listener ───

  it("updates progress when update-progress event is received", async () => {
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );

    // Start update
    fireEvent.click(screen.getByText("Обновить автоматически"));
    await waitFor(() => {
      expect(screen.getByText("Подготовка...")).toBeInTheDocument();
    });

    // Simulate progress event
    act(() => {
      listenCallback?.({
        payload: {
          stage: "download",
          percent: 50,
          message: "Скачивание 50%...",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Скачивание 50%...")).toBeInTheDocument();
    });
  });

  it("registers update-progress listener on mount", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(listen).toHaveBeenCalledWith(
      "update-progress",
      expect.any(Function)
    );
  });

  // ─── Update error ───

  it("displays error when self_update fails", async () => {
    vi.mocked(invoke).mockRejectedValue("Network error: connection refused");
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );
    fireEvent.click(screen.getByText("Обновить автоматически"));
    await waitFor(() => {
      expect(
        screen.getByText("Network error: connection refused")
      ).toBeInTheDocument();
    });
  });

  it("hides progress and shows update buttons again after error", async () => {
    vi.mocked(invoke).mockRejectedValue("Update failed");
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );
    fireEvent.click(screen.getByText("Обновить автоматически"));
    await waitFor(() => {
      expect(screen.getByText("Update failed")).toBeInTheDocument();
    });
    // Auto-update button should be visible again
    expect(screen.getByText("Обновить автоматически")).toBeInTheDocument();
  });

  // ─── Updates section heading ───

  it("renders copyright line", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText(i18n.t("about.copyright", { year: new Date().getFullYear() }))).toBeInTheDocument();
  });
});
