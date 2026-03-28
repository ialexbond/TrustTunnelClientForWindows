import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ExportSection } from "./ExportSection";
import type { ServerState } from "./useServerState";

// Mock qrcode.react
vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: any) => <svg data-testid="qr-code" data-value={props.value} />,
}));

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: ["alice", "bob"] },
    setActionResult: vi.fn(),
    pushSuccess: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("ExportSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders export title", () => {
    const state = makeState();
    render(<ExportSection state={state} />);
    expect(screen.getByText(i18n.t("server.export.title"))).toBeInTheDocument();
  });

  it("shows description text", () => {
    const state = makeState();
    render(<ExportSection state={state} />);
    expect(screen.getByText(i18n.t("server.export.description"))).toBeInTheDocument();
  });

  it("shows user selector label", () => {
    const state = makeState();
    render(<ExportSection state={state} />);
    expect(screen.getByText(i18n.t("server.export.user"))).toBeInTheDocument();
  });

  it("shows user dropdown trigger with placeholder text", () => {
    const state = makeState();
    render(<ExportSection state={state} />);
    expect(screen.getByText(i18n.t("server.export.select_user"))).toBeInTheDocument();
  });

  it("shows users in dropdown when clicked", () => {
    const state = makeState();
    render(<ExportSection state={state} />);
    // Click dropdown trigger
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("generate button is disabled when no user is selected", () => {
    const state = makeState();
    render(<ExportSection state={state} />);
    const genBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) });
    expect(genBtn).toBeDisabled();
  });

  it("renders without crashing when serverInfo has no users", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: [] },
    });
    render(<ExportSection state={state} />);
    expect(screen.getByText(i18n.t("server.export.title"))).toBeInTheDocument();
  });

  it("selecting a user from dropdown enables generate button", () => {
    const state = makeState();
    render(<ExportSection state={state} />);
    // Open dropdown
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    // Click alice
    fireEvent.click(screen.getByText("alice"));
    // Generate button should now be enabled
    const genBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) });
    expect(genBtn).not.toBeDisabled();
  });

  it("dropdown closes after selecting a user", () => {
    const state = makeState();
    render(<ExportSection state={state} />);
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    fireEvent.click(screen.getByText("alice"));
    // Dropdown should be closed - only alice should be visible (as selected text), not bob
    // The selected user name appears in the trigger button
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
  });

  it("generate button calls invoke with correct params", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/xyz");
    const state = makeState();
    render(<ExportSection state={state} />);
    // Select user
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    fireEvent.click(screen.getByText("alice"));
    // Click generate
    const genBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) });
    fireEvent.click(genBtn);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_export_config_deeplink", {
        host: "10.0.0.1", port: 22, user: "root", password: "pass",
        clientName: "alice",
      });
    });
  });

  it("shows QR code after successful generation", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/xyz");
    const state = makeState();
    render(<ExportSection state={state} />);
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    fireEvent.click(screen.getByText("alice"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) }));
    await waitFor(() => {
      expect(screen.getByTestId("qr-code")).toBeInTheDocument();
    });
  });

  it("shows deeplink URL and copy button after generation", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/xyz");
    const state = makeState();
    render(<ExportSection state={state} />);
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    fireEvent.click(screen.getByText("alice"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) }));
    await waitFor(() => {
      expect(screen.getByText("trusttunnel://config/xyz")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.copy_link")) })).toBeInTheDocument();
  });

  it("copy button copies deeplink to clipboard", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/xyz");
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const state = makeState();
    render(<ExportSection state={state} />);
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    fireEvent.click(screen.getByText("alice"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.copy_link")) })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.copy_link")) }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("trusttunnel://config/xyz");
  });

  it("calls pushSuccess with error when generation fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("SSH timeout"));
    const pushSuccess = vi.fn();
    const state = makeState({ pushSuccess });
    render(<ExportSection state={state} />);
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    fireEvent.click(screen.getByText("alice"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) }));
    await waitFor(() => {
      expect(pushSuccess).toHaveBeenCalledWith("Error: SSH timeout", "error");
    });
  });

  it("truncates long deeplinks in display", async () => {
    const longLink = "trusttunnel://config/" + "a".repeat(100);
    vi.mocked(invoke).mockResolvedValueOnce(longLink);
    const state = makeState();
    render(<ExportSection state={state} />);
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    fireEvent.click(screen.getByText("alice"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) }));
    await waitFor(() => {
      // The truncated link should end with "..."
      const codeEl = screen.getByTitle(longLink);
      expect(codeEl.textContent).toContain("...");
      expect(codeEl.textContent!.length).toBeLessThan(longLink.length);
    });
  });

  it("shows scan QR instruction text after generation", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/xyz");
    const state = makeState();
    render(<ExportSection state={state} />);
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    fireEvent.click(screen.getByText("alice"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) }));
    await waitFor(() => {
      expect(screen.getByText(i18n.t("server.export.scan_qr"))).toBeInTheDocument();
    });
  });

  it("resets deeplink and error when selecting a new user", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/xyz");
    const state = makeState();
    render(<ExportSection state={state} />);
    // Generate for alice
    fireEvent.click(screen.getByText(i18n.t("server.export.select_user")));
    fireEvent.click(screen.getByText("alice"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.export.generate")) }));
    await waitFor(() => {
      expect(screen.getByTestId("qr-code")).toBeInTheDocument();
    });
    // Now select bob - should reset
    fireEvent.click(screen.getByText("alice")); // Click the dropdown trigger (shows alice)
    fireEvent.click(screen.getByText("bob"));
    expect(screen.queryByTestId("qr-code")).not.toBeInTheDocument();
  });

  it("handles null serverInfo gracefully", () => {
    const state = makeState({ serverInfo: null });
    render(<ExportSection state={state} />);
    expect(screen.getByText(i18n.t("server.export.title"))).toBeInTheDocument();
  });
});
