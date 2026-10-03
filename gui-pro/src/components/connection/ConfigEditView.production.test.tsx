import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConfigEditView } from "./ConfigEditView";

// ── Tauri mocks ──────────────────────────────────────────────────────────────
// invoke is the single IPC seam: read_client_config (load) / save_client_config (save) /
// the shell open (folder). The config returned carries a REAL password so the D-29 spy can
// prove it never leaks to the DOM or any log sink.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const openPathMock = vi.fn();
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (...args: unknown[]) => openPathMock(...args),
}));

// The REAL secret the config carries. The D-29 invariant: this value must NEVER appear in
// the rendered DOM, and no log/sanitize sink may ever be called with it.
const REAL_PASSWORD = "s3cr3t-Pa55w0rd-do-not-leak";
const MASKED = "••••••••••";

function configFixture() {
  return {
    loglevel: "info",
    vpn_mode: "general",
    killswitch_enabled: false,
    post_quantum_group_enabled: false,
    endpoint: {
      hostname: "de1.example.com",
      addresses: ["198.51.100.10:443"],
      upstream_protocol: "http2",
      anti_dpi: true,
      skip_verification: false,
      custom_sni: "",
      has_ipv6: false,
      username: "swift-fox",
      password: REAL_PASSWORD,
      dns_upstreams: ["1.1.1.1"],
    },
    listener: {
      tun: { mtu_size: 1280, change_system_dns: true, included_routes: [], excluded_routes: [] },
    },
  };
}

const L = {
  title: i18n.t("connection.editView.title"),
  save: i18n.t("connection.editView.save"),
  saveReconnect: i18n.t("connection.editView.save_and_reconnect"),
  close: i18n.t("connection.editView.close"),
  loadError: i18n.t("connection.editView.load_error"),
  passwordAria: i18n.t("connection.editView.credentials_password_aria"),
};

function setup(props?: Partial<Parameters<typeof ConfigEditView>[0]>) {
  const onClose = vi.fn();
  const onReconnect = vi.fn().mockResolvedValue(undefined);
  const onConfigChange = vi.fn();
  renderWithProviders(
    <ConfigEditView
      isOpen
      onClose={onClose}
      configPath="C:/app/configs/germany.toml"
      configName="Германия — Frankfurt"
      isActiveConfig
      status="connected"
      onReconnect={onReconnect}
      onConfigChange={onConfigChange}
      {...props}
    />,
  );
  return { onClose, onReconnect, onConfigChange };
}

describe("ConfigEditView (production)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openPathMock.mockReset();
    // Default: read_client_config resolves with the fixture (carrying the real password).
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_client_config") return Promise.resolve(configFixture());
      if (cmd === "save_client_config") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the dialog with the accessible name «Настройки конфигурации»", async () => {
    setup();
    const dialog = await screen.findByRole("dialog", { name: L.title });
    expect(dialog).toBeInTheDocument();
  });

  // D-29 / T-11-14: the password field shows a MASKED placeholder, NEVER the real value,
  // AND no log/sanitize sink is ever called with the password argument.
  it("D-29: password field is masked and the secret never reaches the DOM or a log sink", async () => {
    // Spy on every plausible log sink so a regression that logs the config (and thus the
    // password) is caught. console.* covers the JS side; the Rust emit_log side cannot read
    // a value the FE never sent — and the FE only ever invokes read/save with the path/config
    // object, never logging the password.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    setup();
    // Wait for the config to load (the form replaces the loading window).
    const pwField = await screen.findByLabelText(L.passwordAria);

    // The rendered password field shows the masked placeholder, not the real secret.
    expect(pwField).toHaveValue(MASKED);
    expect(pwField).not.toHaveValue(REAL_PASSWORD);

    // The real password must not be present ANYWHERE in the document.
    expect(document.body.innerHTML).not.toContain(REAL_PASSWORD);

    // No log sink was ever called with an argument containing the password.
    for (const spy of [logSpy, errSpy, warnSpy, infoSpy, debugSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(JSON.stringify(arg ?? "")).not.toContain(REAL_PASSWORD);
        }
      }
    }
  });

  // F26: the save label is derived from isActiveConfig, NOT the live save mode.
  it("active config save label is «Сохранить и переподключить»", async () => {
    setup({ isActiveConfig: true });
    await screen.findByLabelText(L.passwordAria);
    expect(screen.getByRole("button", { name: L.saveReconnect })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: L.save })).not.toBeInTheDocument();
  });

  it("inactive config save label is «Сохранить»", async () => {
    setup({ isActiveConfig: false, status: "disconnected" });
    await screen.findByLabelText(L.passwordAria);
    expect(screen.getByRole("button", { name: L.save })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: L.saveReconnect })).not.toBeInTheDocument();
  });

  // load-error: a corrupt/unreadable .toml renders an ErrorBanner instead of the form, with a
  // single «Закрыть» and NO «Повторить» (re-reading a broken file is pointless).
  it("load-error shows ErrorBanner + «Закрыть» and NO retry", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_client_config") return Promise.reject(new Error("corrupt toml"));
      return Promise.resolve(undefined);
    });
    setup();
    await screen.findByText(L.loadError);
    // The footer «Закрыть» button carries VISIBLE text (the Modal's corner × has the same
    // accessible name but no text content) — query by the text node to disambiguate.
    const footerClose = screen.getByText(L.close, { selector: "button" });
    expect(footerClose).toBeInTheDocument();
    // No retry button — re-reading a corrupt file changes nothing. (The dead
    // connection.import.retry_failed i18n key was removed in CA-5; assert the wording
    // directly so the guard survives without leaning on a nonexistent key.)
    expect(screen.queryByRole("button", { name: /Повторить/ })).not.toBeInTheDocument();
    // The form is NOT rendered (no password field in the error branch).
    expect(screen.queryByLabelText(L.passwordAria)).not.toBeInTheDocument();
  });

  // The flat-list rule: NO accordion / «Дополнительно» disclosure element in the modal.
  it("renders a flat field list with NO «Дополнительно» disclosure", async () => {
    setup();
    await screen.findByLabelText(L.passwordAria);
    expect(screen.queryByText(/Дополнительно/i)).not.toBeInTheDocument();
    // No <details>/<summary> accordion machinery.
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector("summary")).toBeNull();
  });

  // save: clicking the active-config save invokes save_client_config (the per-config write).
  it("save invokes save_client_config for the per-config path", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    setup({ isActiveConfig: false, status: "disconnected" });
    await screen.findByLabelText(L.passwordAria);

    // Make the form dirty so save is enabled: toggle IPv6.
    const ipv6 = screen.getByRole("switch", { name: i18n.t("connection.editView.ipv6") });
    await user.click(ipv6);

    const saveBtn = screen.getByRole("button", { name: L.save });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter((c) => c[0] === "save_client_config");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][1]).toMatchObject({ configPath: "C:/app/configs/germany.toml" });
    });
  });

  // TA-5 / B3: the no-auto-save invariant (ConfigEditView autoSave:false). A dirty form must NOT
  // write anything until the user clicks Save — a regression that re-enabled auto-save would leave
  // every other test green (they all save via an explicit click), so lock it directly: make the
  // form dirty two ways (toggle IPv6 + type in the name), let timers/microtasks flush, and assert
  // ZERO save_client_config calls until the Save button is clicked (then exactly the click writes).
  it("B3: no auto-save — a dirty form never writes until Save is clicked", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    setup({ isActiveConfig: false, status: "disconnected" });
    await screen.findByLabelText(L.passwordAria);

    // Dirty the form via a toggle AND a text field (the two dirty paths the audit calls out).
    await user.click(screen.getByRole("switch", { name: i18n.t("connection.editView.ipv6") }));
    await user.type(
      screen.getByLabelText(i18n.t("connection.editView.display_name")),
      "Изменённое имя",
    );

    // Give any hypothetical debounced auto-save every chance to fire: wait PAST the 1200 ms
    // auto-save debounce the hook would use IF autoSave were on (ConfigEditView.tsx:180 sets it
    // false, disabling that debounce + the peer-save flush), then flush microtasks. If a
    // regression re-enabled auto-save the debounced write would have landed inside this window.
    await new Promise((r) => setTimeout(r, 1300));
    await Promise.resolve();

    // The invariant: nothing was saved WITHOUT a click.
    expect(invokeMock.mock.calls.filter((c) => c[0] === "save_client_config")).toHaveLength(0);

    // Now click Save → exactly the explicit action writes (proving the form WAS dirty/saveable).
    const saveBtn = screen.getByRole("button", { name: L.save });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter((c) => c[0] === "save_client_config").length,
      ).toBeGreaterThan(0);
    });
  });

  // 11-UAT IN-09/IN-12: the «Имя конфига» field is where the config TITLE is edited (incl. for
  // the active config — the lead card itself is read-only). The name lives in endpoint.name; the
  // fixture has none, so the field starts empty; editing it makes the form dirty and the saved
  // config carries endpoint.name (which the card then shows over the username).
  it("config-name field edits and persists endpoint.name", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    setup({ isActiveConfig: false, status: "disconnected" });
    await screen.findByLabelText(L.passwordAria);

    const nameField = screen.getByLabelText(i18n.t("connection.editView.display_name"));
    expect(nameField).toHaveValue(""); // fixture has no endpoint.name
    await user.type(nameField, "Тестирование");

    const saveBtn = screen.getByRole("button", { name: L.save });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter((c) => c[0] === "save_client_config");
      expect(calls.length).toBeGreaterThan(0);
      const saved = calls[0][1] as { config: { endpoint: { name?: string } } };
      expect(saved.config.endpoint.name).toBe("Тестирование");
    });
  });

  // 11-UAT IN-13: the «Имя конфига» field carries a live N/64 character counter.
  it("config-name field shows a character counter", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    setup({ isActiveConfig: false, status: "disconnected" });
    await screen.findByLabelText(L.passwordAria);
    // Fixture has no endpoint.name → counter starts at 0/64.
    expect(screen.getByText("0/64")).toBeInTheDocument();
    await user.type(screen.getByLabelText(i18n.t("connection.editView.display_name")), "abc");
    expect(screen.getByText("3/64")).toBeInTheDocument();
  });

  // 11-UAT IN-17: «Открыть папку» opens the config's PARENT folder via the shell opener (it was
  // a silent no-op before — the open-scope rejected local paths and the error was swallowed).
  it("«Открыть папку» opens the config's parent folder", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    openPathMock.mockResolvedValue(undefined);
    setup(); // configPath = "C:/app/configs/germany.toml"
    await screen.findByLabelText(L.passwordAria);
    await user.click(
      screen.getByRole("button", { name: i18n.t("connection.editView.open_folder") }),
    );
    expect(openPathMock).toHaveBeenCalledWith("C:/app/configs");
  });

  // 11-UAT IN-13: the modal CLOSES after a successful save (and the SnackBar — fired by the
  // hook — confirms it). A failed save keeps it open (covered by the hook's error path).
  it("closes the modal after a successful save", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const { onClose } = setup({ isActiveConfig: false, status: "disconnected" });
    await screen.findByLabelText(L.passwordAria);
    // Make the form dirty so save is enabled.
    await user.click(screen.getByRole("switch", { name: i18n.t("connection.editView.ipv6") }));
    const saveBtn = screen.getByRole("button", { name: L.save });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // ─── Phase 14 (14-03): lock the ACTIVE-config save while a switch is in flight (D-13) ───
  //
  // RED until 14-03 — the `isSwitching` prop is not yet on ConfigEditView. D-13: re-saving the
  // ACTIVE config mid-switch reruns «Сохранить и переподключить» → a competing reconnect that races
  // the in-flight swap. So while isSwitching the active-config save must be disabled (OR'd into the
  // existing saveDisabled). An INACTIVE-config save does NOT race the tunnel, so it stays enabled.
  describe("Phase 14 — lock active save while switching (RED until 14-03)", () => {
    // D-13: active config + switch in flight → save disabled even when the form is dirty.
    it("disables the active-config save while isSwitching", async () => {
      const { default: userEvent } = await import("@testing-library/user-event");
      const user = userEvent.setup();
      // isActiveConfig + connected + isSwitching. Make the form dirty so the ONLY thing that could
      // keep save disabled is the switch lock.
      setup({ isActiveConfig: true, status: "connected", isSwitching: true });
      await screen.findByLabelText(L.passwordAria);
      await user.click(screen.getByRole("switch", { name: i18n.t("connection.editView.ipv6") }));

      const saveBtn = screen.getByRole("button", { name: L.saveReconnect });
      await waitFor(() => expect(saveBtn).toBeDisabled());
    });

    // D-13 must-keep: an INACTIVE-config save does not touch the live tunnel, so a switch on the
    // active config must NOT lock an unrelated inactive-config edit's save.
    it("leaves an inactive-config save enabled while isSwitching", async () => {
      const { default: userEvent } = await import("@testing-library/user-event");
      const user = userEvent.setup();
      setup({ isActiveConfig: false, status: "disconnected", isSwitching: true });
      await screen.findByLabelText(L.passwordAria);
      await user.click(screen.getByRole("switch", { name: i18n.t("connection.editView.ipv6") }));

      const saveBtn = screen.getByRole("button", { name: L.save });
      await waitFor(() => expect(saveBtn).not.toBeDisabled());
    });
  });

  // ─── G-30.1-01 (30.1 UAT, T-14): the edited `.toml` is deleted on disk while the modal is open ───
  //
  // The owner deleted a config from the folder. The app noticed — the card went, the active pointer
  // was cleared — and this modal went on offering «Сохранить и переподключить» for the file that had
  // just stopped existing. The pane must state the deletion and take its actions away, without
  // vanishing on its own.
  describe("G-30.1-01 — the config file is deleted while the modal is open", () => {
    it("replaces the form with the deletion reason and a single «Закрыть»", async () => {
      setup({ fileMissing: true });

      expect(await screen.findByText(i18n.t("connection.editView.file_missing"))).toBeInTheDocument();
      // The whole form is gone with it — the fields as well as the buttons.
      expect(screen.queryByLabelText(L.passwordAria)).not.toBeInTheDocument();
      // The footer «Закрыть» carries VISIBLE text; the Modal's corner × shares the accessible
      // name but has no text content — query by the text node, as the loadError guard above does.
      expect(screen.getByText(L.close, { selector: "button" })).toBeInTheDocument();
    });

    it("takes «Сохранить и переподключить» away entirely — not merely disables it", async () => {
      setup({ fileMissing: true, isActiveConfig: true, status: "connected" });

      await screen.findByText(i18n.t("connection.editView.file_missing"));
      expect(screen.queryByRole("button", { name: L.saveReconnect })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: L.save })).not.toBeInTheDocument();
    });

    it("«Закрыть» closes the modal", async () => {
      const { default: userEvent } = await import("@testing-library/user-event");
      const user = userEvent.setup();
      const { onClose } = setup({ fileMissing: true });

      await screen.findByText(i18n.t("connection.editView.file_missing"));
      await user.click(screen.getByText(L.close, { selector: "button" }));
      expect(onClose).toHaveBeenCalled();
    });

    it("keeps the config's name and status visible, so the user knows WHICH config went", async () => {
      setup({ fileMissing: true });

      await screen.findByText(i18n.t("connection.editView.file_missing"));
      expect(screen.getByText("Германия — Frankfurt")).toBeInTheDocument();
    });

    it("says «удалён», not «повреждён» — a deleted file is not the corrupt-file state", async () => {
      setup({ fileMissing: true });

      await screen.findByText(i18n.t("connection.editView.file_missing"));
      // load_error tells the user to re-import; there is nothing to re-import here, and the two
      // messages must never be substituted for one another.
      expect(screen.queryByText(L.loadError)).not.toBeInTheDocument();
    });

    it("wins over loadError when a corrupt read and a deletion are both reported", async () => {
      // A read that fails AND the file gone: the deletion is the more specific, more recent fact.
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_client_config") return Promise.reject(new Error("parse error"));
        return Promise.resolve(undefined);
      });
      setup({ fileMissing: true });

      expect(await screen.findByText(i18n.t("connection.editView.file_missing"))).toBeInTheDocument();
      expect(screen.queryByText(L.loadError)).not.toBeInTheDocument();
    });

    it("renders the ordinary editable form when the file is still there", async () => {
      setup({ fileMissing: false });

      await screen.findByLabelText(L.passwordAria);
      expect(screen.queryByText(i18n.t("connection.editView.file_missing"))).not.toBeInTheDocument();
    });
  });
});
