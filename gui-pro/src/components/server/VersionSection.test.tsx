import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { VersionSection } from "./VersionSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: ["alice"] },
    availableVersions: ["v1.5.0", "v1.4.0", "v1.3.0"],
    selectedVersion: "v1.5.0",
    setSelectedVersion: vi.fn(),
    actionLoading: null,
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    runAction: vi.fn(),
    pushSuccess: vi.fn(),
    loadServerInfo: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("VersionSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    void i18n.changeLanguage("ru");
  });

  it("renders nothing when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    const { container } = render(<VersionSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders version title", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    expect(screen.getByText(i18n.t("server.version.title"))).toBeInTheDocument();
  });

  it("displays current version badge", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    expect(screen.getByText("v1.4.0")).toBeInTheDocument();
  });

  it("shows current version label", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    expect(
      screen.getByText(new RegExp(i18n.t("server.version.current"))),
    ).toBeInTheDocument();
  });

  // ─── A-1/CC-6: the picker is the shared Select (role=combobox + options) ───
  it("renders the version picker as the shared Select (role=combobox)", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    // The hand-rolled <button style="height:34px"> is gone — the picker now
    // exposes a combobox role from the design-system Select primitive.
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("opens the Select listbox and surfaces available versions as options", async () => {
    const user = userEvent.setup();
    const state = makeState();
    render(<VersionSection state={state} />);
    await user.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    const labels = options.map((o) => (o.textContent ?? "").trim());
    // All three available versions are surfaced as real options (not CSS hover).
    expect(labels).toEqual(
      expect.arrayContaining(["v1.5.0", "v1.4.0", "v1.3.0"]),
    );
  });

  it("calls setSelectedVersion with the original tag when an option is chosen", async () => {
    const user = userEvent.setup();
    const setSelectedVersion = vi.fn();
    const state = makeState({ selectedVersion: "v1.4.0", setSelectedVersion });
    render(<VersionSection state={state} />);
    await user.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").trim() === "v1.5.0");
    expect(option).toBeDefined();
    await user.click(option!);
    // The Select must hand back the raw tag string the rest of the flow expects.
    expect(setSelectedVersion).toHaveBeenCalledWith("v1.5.0");
  });

  // ─── E-7 (analog): Install never offered for a non-real / "unknown" pick ───
  it("shows install button when a real non-current version is selected", () => {
    const state = makeState({ selectedVersion: "v1.5.0" });
    render(<VersionSection state={state} />);
    const installBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.version.install_version")),
    });
    expect(installBtn).toBeInTheDocument();
  });

  it("does not show install button when selected version matches current", () => {
    const state = makeState({ selectedVersion: "v1.4.0" });
    render(<VersionSection state={state} />);
    expect(
      screen.queryByRole("button", {
        name: new RegExp(i18n.t("server.version.install_version")),
      }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Install when the selected version is 'unknown'", () => {
    // E-7: a literal "unknown" must never reach the install command path.
    const state = makeState({ selectedVersion: "unknown" });
    render(<VersionSection state={state} />);
    expect(
      screen.queryByRole("button", {
        name: new RegExp(i18n.t("server.version.install_version")),
      }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Install when no version is selected (empty)", () => {
    const state = makeState({ selectedVersion: "" });
    render(<VersionSection state={state} />);
    expect(
      screen.queryByRole("button", {
        name: new RegExp(i18n.t("server.version.install_version")),
      }),
    ).not.toBeInTheDocument();
  });

  it("does not show the picker when no versions are available", () => {
    const state = makeState({ availableVersions: [] });
    render(<VersionSection state={state} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  // ─── §K CTA-03: the Install confirm uses an action-verb label, not generic
  //          «Подтвердить». Upgrade → «Установить»; downgrade → «Установить
  //          старую версию». ───
  it("CTA-03: the install confirm button reads «Установить» (upgrade)", async () => {
    const user = userEvent.setup();
    // selectedVersion newer than current (1.5.0 > 1.4.0) → upgrade label.
    const state = makeState({ selectedVersion: "v1.5.0" });
    render(<VersionSection state={state} />);

    await user.click(
      screen.getByRole("button", {
        name: new RegExp(i18n.t("server.version.install_version")),
      }),
    );

    // Scope to the confirm dialog by its title, then its button row — the
    // upgrade trigger label «Установить» also matches by name page-wide, so we
    // assert the confirm action specifically inside the dialog.
    const dialogTitle = await screen.findByText(
      i18n.t("server.version.confirm_title"),
    );
    const dialogBody = dialogTitle.parentElement as HTMLElement;
    const cancelBtn = within(dialogBody).getByRole("button", {
      name: i18n.t("buttons.cancel"),
    });
    const buttonRow = cancelBtn.parentElement as HTMLElement;
    // The dialog's confirm button uses the action verb, not «Подтвердить».
    expect(
      within(buttonRow).getByRole("button", {
        name: i18n.t("server.version.confirm_install"),
      }),
    ).toBeInTheDocument();
    expect(
      within(buttonRow).queryByRole("button", {
        name: i18n.t("buttons.confirm"),
      }),
    ).not.toBeInTheDocument();
  });

  it("CTA-03: the install confirm reads «Установить старую версию» (downgrade)", async () => {
    const user = userEvent.setup();
    // selectedVersion older than current (1.3.0 < 1.4.0) → downgrade label.
    const state = makeState({ selectedVersion: "v1.3.0" });
    render(<VersionSection state={state} />);

    await user.click(
      screen.getByRole("button", {
        name: new RegExp(i18n.t("server.version.install_version")),
      }),
    );

    const confirmBtn = await screen.findByRole("button", {
      name: i18n.t("server.version.confirm_install_downgrade"),
    });
    expect(confirmBtn).toBeInTheDocument();
  });
});
