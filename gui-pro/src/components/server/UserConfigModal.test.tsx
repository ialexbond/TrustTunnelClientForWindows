import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import i18n from "../../shared/i18n";
import { UserConfigModal } from "./UserConfigModal";
import { renderWithProviders as render } from "../../test/test-utils";

// Mock qrcode.react so tests don't pull the real SVG renderer.
vi.mock("qrcode.react", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QRCodeSVG: (props: any) => (
    <svg
      data-testid="qr-code"
      data-value={props.value}
      width={props.size}
      height={props.size}
    />
  ),
}));

// Mock useActivityLog — spy on log calls for D-29 security verification.
const activityLogSpy = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

// Mock tauri.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "***",
};

describe("UserConfigModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityLogSpy.mockClear();
    // UAT (06-uat fix 14): clear the GeoIP cache between tests so a seeded
    // tt_geoip_<host> entry never leaks into a test that expects no country prefix.
    localStorage.clear();
    i18n.changeLanguage("ru");

    // Mock clipboard API — writeText + write.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        write: vi.fn().mockResolvedValue(undefined),
      },
    });
    // Provide ClipboardItem for happy path (tests override for fallback).
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = class {
      constructor(_data: Record<string, Blob>) {
        void _data;
      }
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render when isOpen=false", () => {
    const { container } = render(
      <UserConfigModal
        isOpen={false}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    // WR-03: UserConfigModal returns null when isOpen=false — container stays empty.
    // (Prior assertion `[role="dialog"]` was a false-positive — Modal primitive
    // does not set role="dialog", so the selector was null regardless of state.)
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("qr-code")).not.toBeInTheDocument();
  });

  it("fetches deeplink via invoke when opened (advanced probe FIRST, then basic export)", async () => {
    // FIX (false green :80-98): the old test relied on the GLOBAL `vi.fn()`
    // default returning undefined for the unmocked first probe, so the basic
    // export "happened to" be the only matched call — it never proved the
    // ordering of the two-step fetch (advanced probe → basic fallback). Pin the
    // exact order with mockResolvedValueOnce + toHaveBeenNthCalledWith.
    vi.mocked(invoke)
      .mockResolvedValueOnce(null) // 1st: server_get_user_advanced → no advanced params
      .mockResolvedValueOnce("tt://example.com/config?token=abc"); // 2nd: basic export
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(2);
    });
    // Probe order is contractual: advanced params first, basic export second.
    expect(invoke).toHaveBeenNthCalledWith(1, "server_get_user_advanced", {
      ...mockSshParams,
      username: "swift-fox",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "server_export_config_deeplink", {
      ...mockSshParams,
      clientName: "swift-fox",
    });
  });

  it("renders QR code with fetched deeplink (240px)", async () => {
    // FIX-NN: fetchDeeplink now probes `server_get_user_advanced` first.
    // Returning null falls through to the basic `server_export_config_deeplink`
    // path, which the second Once-mock answers.
    vi.mocked(invoke).mockResolvedValueOnce(null);
    vi.mocked(invoke).mockResolvedValueOnce(
      "tt://example.com/config?token=abc",
    );
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    const qr = await screen.findByTestId("qr-code");
    expect(qr).toHaveAttribute("data-value", "tt://example.com/config?token=abc");
    expect(qr).toHaveAttribute("width", "240");
  });

  it("bypasses invoke when _deeplinkOverride provided (Storybook)", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://overridden.com/test"
      />,
    );
    await waitFor(() => {
      const qr = screen.getByTestId("qr-code");
      expect(qr).toHaveAttribute("data-value", "tt://overridden.com/test");
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "server_export_config_deeplink",
      expect.anything(),
    );
  });

  it("calls onClose when X button clicked", async () => {
    const onClose = vi.fn();
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={onClose}
        _deeplinkOverride="tt://test"
      />,
    );
    const closeBtn = await screen.findByRole("button", {
      name: i18n.t("buttons.close"),
    });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("copies deeplink text when Copy icon clicked (D-23)", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test-link"
      />,
    );
    const copyBtn = await screen.findByRole("button", {
      name: i18n.t("server.users.copy_deeplink_tooltip"),
    });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "tt://test-link",
      );
    });
    expect(activityLogSpy).toHaveBeenCalledWith(
      "USER",
      expect.stringContaining("user.config.link_copied user=swift-fox"),
    );
  });

  it("clicking the QR copies the tt:// link as TEXT (image copy was removed, D-09)", async () => {
    // The QR image-clipboard path was removed (it did not work in the WebView2), so
    // clicking the QR copies the link — the same as the link copy icon.
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://fallback-test"
      />,
    );
    const qrBtn = await screen.findByRole("button", {
      name: i18n.t("server.users.qr_click_to_copy"),
    });
    fireEvent.click(qrBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "tt://fallback-test",
      );
    });
    expect(activityLogSpy).toHaveBeenCalledWith(
      "USER",
      expect.stringContaining("user.config.link_copied user=swift-fox"),
    );
  });

  it("D-29 SECURITY: activity log never contains deeplink value", async () => {
    delete (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;

    const secret =
      "tt://example.com/config?secret_token=ABC-SECRET-DO-NOT-LEAK-123";
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride={secret}
      />,
    );
    const qrBtn = await screen.findByRole("button", {
      name: i18n.t("server.users.qr_click_to_copy"),
    });
    const copyBtn = await screen.findByRole("button", {
      name: i18n.t("server.users.copy_deeplink_tooltip"),
    });
    fireEvent.click(qrBtn);
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalled();
    });

    const allLogCalls = activityLogSpy.mock.calls;
    for (const call of allLogCalls) {
      const message = String(call[1] ?? "");
      expect(message).not.toContain("ABC-SECRET-DO-NOT-LEAK-123");
      expect(message).not.toContain("secret_token");
    }
  });

  it("Download button invokes fetch_server_config + save + copy_file (D-27)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      if (cmd === "copy_file") return undefined;
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    const downloadBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("server.users.download_config"), "i"),
    });
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "fetch_server_config",
        expect.objectContaining({ clientName: "swift-fox" }),
      );
    });
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    // UAT (06-uat fix 14): the save-dialog default name is branded + consistent —
    // `TrustTunnel_<username>.toml` (no country prefix when none is cached for the host).
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "TrustTunnel_swift-fox.toml" }),
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "copy_file",
        expect.objectContaining({ destination: "/home/user/config.toml" }),
      );
    });
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "STATE",
        expect.stringContaining("user.config.downloaded user=swift-fox"),
      );
    });
  });

  // UAT (06-uat fix 14): when the host's country is already cached, the save-dialog
  // default name carries the country prefix — `<COUNTRY>_TrustTunnel_<username>.toml`.
  it("Download default name includes the country prefix when the host geoip is cached", async () => {
    // Seed the GeoIP cache the same way useServerGeoIp persists it (tt_geoip_<host>).
    localStorage.setItem(
      "tt_geoip_192.168.1.100",
      JSON.stringify({
        country: "Germany",
        country_code: "DE",
        flag_emoji: "🇩🇪",
        fetched_at: new Date().toISOString(),
      }),
    );
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      if (cmd === "copy_file") return undefined;
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "DE_TrustTunnel_swift-fox.toml" }),
    );
  });

  it("Download cancelled (user closes save dialog) does not invoke copy_file", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce(null);

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    const downloadBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("server.users.download_config"), "i"),
    });
    fireEvent.click(downloadBtn);

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith(
      "copy_file",
      expect.anything(),
    );
  });

  // Phase 25 (FLOW-01 / D-05): plan 25-01 replaced the English «Access denied…»
  // prose with stable machine codes. Without translation the user would now see a
  // bare code — worse than the English sentence. The snackbar must show Russian
  // while the activity log keeps the raw code for diagnosis.
  it("Download failure shows the localized path error while the activity log keeps the RAW code", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      // Tauri rejects a command with the Err string itself, not an Error object.
      if (cmd === "copy_file") throw "COPY_SOURCE_OUTSIDE_ROOTS";
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    // role="alert" is the error-variant snackbar (SnackBar.tsx:214) — asserting the
    // a11y contract, not a CSS class. The expected copy is resolved through the real
    // i18n instance so this can never drift from ru.json.
    const snack = await screen.findByRole("alert");
    expect(snack).toHaveTextContent(i18n.t("pathErrors.sourceOutsideRoots"));
    // …and it is NOT the raw code the backend sent.
    expect(snack).not.toHaveTextContent("COPY_SOURCE_OUTSIDE_ROOTS");

    // The diagnostic record keeps the machine code — a translated sentence there
    // would destroy the ability to grep the log for the failing branch.
    expect(activityLogSpy).toHaveBeenCalledWith(
      "ERROR",
      "user.config.download_failed err=COPY_SOURCE_OUTSIDE_ROOTS",
    );
  });

  it("Download failure with an UNMAPPED backend error still shows it verbatim", async () => {
    // Fallthrough guarantee: an error the translator does not know keeps today's
    // behaviour instead of degrading to a blank snackbar or a rendered i18n key.
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      if (cmd === "copy_file") throw "some unmapped backend failure";
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    const snack = await screen.findByRole("alert");
    expect(snack).toHaveTextContent("some unmapped backend failure");
  });

  // ─── T-41(a): the save dialog itself refusing to open ─────────────────────────────
  //
  // `save()` can reject (plugin missing, OS refusing to show the picker). That rejection
  // carries no code, so it used to slip past BOTH translators and reach the snackbar as
  // the plugin's own English sentence on an otherwise Russian screen.
  it("Download failure from the save DIALOG is localized, not shown as the plugin's English", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      return null;
    });
    vi.mocked(save).mockRejectedValueOnce(new Error("dialog plugin unavailable"));

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    const snack = await screen.findByRole("alert");
    expect(snack).toHaveTextContent(i18n.t("pathErrors.saveDialogFailed"));
    expect(snack).toHaveTextContent(/[А-Яа-я]/);
    expect(snack).not.toHaveTextContent("dialog plugin unavailable");
    expect(snack).not.toHaveTextContent("SAVE_DIALOG_FAILED");

    // Same log/display divergence as the other families: the code AND the plugin's own
    // wording stay in the diagnostic record, so a broken dialog is still greppable.
    expect(activityLogSpy).toHaveBeenCalledWith(
      "ERROR",
      "user.config.download_failed err=SAVE_DIALOG_FAILED|dialog plugin unavailable",
    );
  });

  // ─── T-41(b): a throw that carries no message at all ──────────────────────────────
  //
  // `formatError` turns a non-Error, non-string throw into the English literal
  // "Unknown error". It has to STAY English in the log (greppable) and become Russian
  // in the snackbar — this test pins both halves at once.
  it("Download failure with no message at all is localized, while the log keeps the English fallback", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      if (cmd === "copy_file") throw { unexpected: true };
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    const snack = await screen.findByRole("alert");
    expect(snack).toHaveTextContent(i18n.t("commonErrors.unknown"));
    expect(snack).toHaveTextContent(/[А-Яа-я]/);
    expect(snack).not.toHaveTextContent("Unknown error");

    expect(activityLogSpy).toHaveBeenCalledWith(
      "ERROR",
      "user.config.download_failed err=Unknown error",
    );
  });

  // ─── WR-01: the download's catch sees TWO code vocabularies ───────────────────────
  //
  // `fetch_server_config` is an SSH call and fails with SSH_* codes; only `copy_file` speaks
  // the COPY_* family. Translating by the path vocabulary alone left the MOST LIKELY failure
  // of this flow — the server-side export — rendering as raw English.
  it("Download failure from the SSH export is localized too, not just the copy failure", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      // Tauri rejects with the Err string itself. `2` is the exporter's exit code.
      if (cmd === "fetch_server_config") throw "SSH_EXPORT_FAILED|2";
      return null;
    });

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    const snack = await screen.findByRole("alert");
    expect(snack).toHaveTextContent(i18n.t("sshErrors.exportFailed", { code: "2" }));
    expect(snack).not.toHaveTextContent("SSH_EXPORT_FAILED");
    // The log still keeps the RAW code — the same log/display divergence the copy family has.
    expect(activityLogSpy).toHaveBeenCalledWith(
      "ERROR",
      "user.config.download_failed err=SSH_EXPORT_FAILED|2",
    );
    // Nothing was staged (the export never got that far), so there is nothing to clean up.
    expect(invoke).not.toHaveBeenCalledWith(
      "delete_staged_temp_file",
      expect.anything(),
    );
  });

  // ─── WR-01 round 2: the four `fetch_server_config` exits that carried NO code ─────────
  //
  // SSH_EXPORT_FAILED (above) was only one of the ways the export refuses. Four OTHER exits
  // returned a bare English sentence with no machine code at all, so neither translator
  // could key on them and they reached this snackbar as raw English prose
  // («TrustTunnel not found on server (/opt/trusttunnel/trusttunnel_endpoint)»). None of
  // them is exotic: a partially-uninstalled endpoint, an install that never finished, or a
  // user list that drifted from credentials.toml. Each now returns `CODE|detail`.
  //
  // Table-driven because the assertion is identical for all four — the interesting part is
  // the code/copy pair, and a table makes a missing one visible at a glance.
  const codedFetchFailures: ReadonlyArray<{
    label: string;
    raw: string;
    key: string;
    params?: Record<string, string>;
  }> = [
    {
      label: "endpoint binary gone (partially uninstalled server)",
      raw: "SSH_ENDPOINT_NOT_INSTALLED|/opt/trusttunnel/trusttunnel_endpoint",
      key: "sshErrors.endpointNotInstalled",
    },
    {
      label: "vpn.toml / hosts.toml missing (install never finished)",
      raw: "SSH_ENDPOINT_CONFIG_MISSING",
      key: "sshErrors.endpointConfigMissing",
    },
    {
      // Both details are rendered: the user needs to know WHICH login was refused and
      // WHICH ones exist, otherwise the message is unactionable.
      label: "requested login is not in credentials.toml",
      raw: "SSH_USER_NOT_IN_CREDENTIALS|carol|alice, bob",
      key: "sshErrors.userNotInCredentials",
      params: { user: "carol", users: "alice, bob" },
    },
    {
      label: "login fails the backend whitelist",
      raw: "SSH_CLIENT_NAME_INVALID|bad?name",
      key: "sshErrors.clientNameInvalid",
      params: { user: "bad?name" },
    },
  ];

  for (const { label, raw, key, params } of codedFetchFailures) {
    it(`Download failure — ${label} — is shown in Russian, not raw English`, async () => {
      vi.mocked(invoke).mockImplementation(async (cmd) => {
        // Tauri rejects with the Err string itself.
        if (cmd === "fetch_server_config") throw raw;
        return null;
      });

      render(
        <UserConfigModal
          isOpen={true}
          username="swift-fox"
          sshParams={mockSshParams}
          onClose={vi.fn()}
          _deeplinkOverride="tt://test"
        />,
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: new RegExp(i18n.t("server.users.download_config"), "i"),
        }),
      );

      // role="alert" is the error-variant snackbar; the expected copy is resolved through
      // the real i18n instance (language forced to "ru" in beforeEach) so this can never
      // drift from ru.json.
      const snack = await screen.findByRole("alert");
      expect(snack).toHaveTextContent(i18n.t(key, params ?? {}));
      // …and the machine code never reaches the reader.
      expect(snack).not.toHaveTextContent(raw.split("|")[0]);

      // The diagnostic record keeps the RAW code — the same log/display divergence the
      // COPY_* family has. A translated sentence there would destroy the ability to grep
      // the log for the exact failing branch.
      expect(activityLogSpy).toHaveBeenCalledWith(
        "ERROR",
        `user.config.download_failed err=${raw}`,
      );
    });
  }

  // ─── CR-01: the staged temp file carries the endpoint password ────────────────────
  //
  // `fetch_server_config(stageToTemp: true)` writes the export into %TEMP%. Nothing deleted
  // it, so every download left a plaintext VPN credential on disk under a predictable name.
  // The cleanup must run on ALL THREE exits, not only the happy one — hence three tests.

  it("CR-01: the staged temp file is deleted after a SUCCESSFUL download", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/TrustTunnel_swift-fox.toml";
      if (cmd === "copy_file") return undefined;
      if (cmd === "delete_staged_temp_file") return undefined;
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("delete_staged_temp_file", {
        // Exactly the path fetch_server_config staged — not the user's Save-As pick.
        path: "/tmp/TrustTunnel_swift-fox.toml",
      });
    });
  });

  it("CR-01: the staged temp file is deleted when the user CANCELS Save-As", async () => {
    // The credential is on disk from the moment fetch_server_config returns, so cancelling
    // the dialog must not leave it behind — this exit never reaches copy_file at all.
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/TrustTunnel_swift-fox.toml";
      if (cmd === "delete_staged_temp_file") return undefined;
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce(null);

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("delete_staged_temp_file", {
        path: "/tmp/TrustTunnel_swift-fox.toml",
      });
    });
    expect(invoke).not.toHaveBeenCalledWith("copy_file", expect.anything());
  });

  it("CR-01: the staged temp file is deleted when the COPY FAILS", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/TrustTunnel_swift-fox.toml";
      if (cmd === "copy_file") throw "COPY_FAILED|Access is denied. (os error 5)";
      if (cmd === "delete_staged_temp_file") return undefined;
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    // The user is told the save failed…
    await screen.findByRole("alert");
    // …and the credential is still removed from %TEMP% regardless.
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("delete_staged_temp_file", {
        path: "/tmp/TrustTunnel_swift-fox.toml",
      });
    });
  });

  it("CR-01: a FAILED cleanup is logged but never shown as a download error", async () => {
    // Best-effort by design: the user's file is already written, so a leftover temp file must
    // not repaint a successful download red. It still has to be visible in diagnostics.
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/TrustTunnel_swift-fox.toml";
      if (cmd === "copy_file") return undefined;
      if (cmd === "delete_staged_temp_file") throw "TEMP_CLEANUP_FAILED|os error 32";
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(i18n.t("server.users.download_config"), "i"),
      }),
    );

    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "ERROR",
        "user.config.staged_cleanup_failed err=TEMP_CLEANUP_FAILED|os error 32",
      );
    });
    // The download itself is still recorded as a success…
    expect(activityLogSpy).toHaveBeenCalledWith(
      "STATE",
      expect.stringContaining("user.config.downloaded user=swift-fox"),
    );
    // …and the user still sees the SUCCESS snackbar. Asserting its presence (role="status",
    // SnackBar.tsx:214) keeps the absence check below from passing vacuously on a screen that
    // simply never rendered a snackbar at all.
    expect(await screen.findByRole("status")).toHaveTextContent(
      i18n.t("server.users.config_saved", { user: "swift-fox" }),
    );
    // No error snackbar — role="alert" is the error variant.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows skeleton loading state when deeplink fetch is in flight", () => {
    vi.mocked(invoke).mockReturnValueOnce(new Promise(() => {}));
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    // Skeleton layout replaces the old spinner — 4 placeholders matching QR/caption/deeplink/download.
    // CSS-coupling FIX: query the busy region by its accessible name (the
    // loading aria-label) instead of `document.querySelector('[aria-busy]')`,
    // which couples the test to a markup attribute rather than the a11y
    // contract a screen-reader actually consumes.
    const busyRegion = screen.getByLabelText(i18n.t("common.loading"));
    expect(busyRegion).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("qr-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("deeplink-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("download-skeleton")).toBeInTheDocument();
  });

  it("shows error state with retry button when deeplink fetch fails", async () => {
    // FIX-NN: first probe `server_get_user_advanced` (returns null → fall
    // through to basic path), then the basic export rejects.
    vi.mocked(invoke).mockResolvedValueOnce(null);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("SSH connection failed"));
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/SSH connection failed/i)).toBeInTheDocument();
    });
    const retryBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("buttons.retry"), "i"),
    });
    expect(retryBtn).toBeInTheDocument();
  });

  it("retries deeplink fetch when retry button clicked", async () => {
    // FIX-NN: two invokes per fetchDeeplink pass (advanced probe + basic
    // export). First pass: advanced=null, then basic rejects. Second pass
    // on Retry: advanced=null, then basic succeeds.
    vi.mocked(invoke).mockResolvedValueOnce(null);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("first fail"));
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    const retryBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("buttons.retry"), "i"),
    });
    vi.mocked(invoke).mockResolvedValueOnce(null);
    vi.mocked(invoke).mockResolvedValueOnce("tt://retry-success");
    fireEvent.click(retryBtn);
    await waitFor(() => {
      // 4 total invokes: 2 for initial failed fetch, 2 for successful retry.
      expect(invoke).toHaveBeenCalledTimes(4);
    });
  });

  it("_forceLoading prop displays skeleton loading state (storybook)", () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _forceLoading
      />,
    );
    // CSS-coupling FIX: same accessible-name query as above.
    expect(screen.getByLabelText(i18n.t("common.loading"))).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("qr-skeleton")).toBeInTheDocument();
  });

  it("_forceError prop displays error state (storybook)", () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _forceError="Mock error for storybook"
      />,
    );
    expect(screen.getByText(/Mock error for storybook/)).toBeInTheDocument();
  });

  // ══════════════════════════════════════════════════════
  // Phase 14 post-install: download blocks close
  // ══════════════════════════════════════════════════════

  it("Download in-flight: X close button is disabled (can't dismiss during SSH)", async () => {
    const onClose = vi.fn();
    // fetch_server_config returns a pending promise — download never completes.
    let resolveFetch!: (v: string) => void;
    const fetchPromise = new Promise<string>((res) => {
      resolveFetch = res;
    });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "server_export_config_deeplink") {
        return Promise.resolve("tt://?test");
      }
      if (cmd === "fetch_server_config") return fetchPromise;
      return Promise.resolve();
    });
    vi.mocked(save).mockResolvedValue(null);

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={onClose}
      />,
    );

    // Wait for deeplink ready + download button visible
    const downloadBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("server.users.download_config"), "i"),
    });

    // Click download — isDownloading becomes true, fetch_server_config pending
    fireEvent.click(downloadBtn);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fetch_server_config", expect.anything()));

    // X close button is disabled during download
    const closeBtn = screen.getByRole("button", { name: i18n.t("buttons.close") });
    expect(closeBtn).toBeDisabled();

    // Clicking X doesn't trigger onClose
    fireEvent.click(closeBtn);
    expect(onClose).not.toHaveBeenCalled();

    // Release the fetch — download completes
    resolveFetch("/tmp/ok.toml");
  });

  it("Download NOT in-flight: X close button is enabled", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "server_export_config_deeplink") {
        return Promise.resolve("tt://?ready");
      }
      return Promise.resolve();
    });

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );

    await screen.findByTestId("qr-code");
    const closeBtn = screen.getByRole("button", { name: i18n.t("buttons.close") });
    expect(closeBtn).not.toBeDisabled();
  });

  // ══════════════════════════════════════════════════════
  // GAP: preloadedDeeplink bypass (FIX-W) — skip the backend roundtrip
  // ══════════════════════════════════════════════════════

  it("GAP: preloadedDeeplink is shown verbatim WITHOUT any backend fetch (FIX-W)", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        preloadedDeeplink="tt://preloaded-from-edit?tlv=1"
        onClose={vi.fn()}
      />,
    );
    const qr = await screen.findByTestId("qr-code");
    expect(qr).toHaveAttribute("data-value", "tt://preloaded-from-edit?tlv=1");
    // The whole point of preloadedDeeplink: no fetch (would strip edited TLVs).
    expect(invoke).not.toHaveBeenCalledWith(
      "server_export_config_deeplink",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "server_get_user_advanced",
      expect.anything(),
    );
  });

  // ══════════════════════════════════════════════════════
  // GAP: QR caption text under the QR code
  // ══════════════════════════════════════════════════════

  it("GAP: renders the «scan QR» caption under the QR code", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://with-caption"
      />,
    );
    await screen.findByTestId("qr-code");
    expect(
      screen.getByText(i18n.t("server.export.scan_qr")),
    ).toBeInTheDocument();
  });

  // ══════════════════════════════════════════════════════
  // GAP: readonly deeplink input mirrors the deeplink value
  // ══════════════════════════════════════════════════════

  it("GAP: deeplink is shown in a read-only input carrying the deeplink value", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://readonly-input-value"
      />,
    );
    const input = (await screen.findByLabelText(
      i18n.t("server.users.deeplink_aria"),
    )) as HTMLInputElement;
    expect(input).toHaveAttribute("readonly");
    expect(input.value).toBe("tt://readonly-input-value");
  });

  // ══════════════════════════════════════════════════════
  // GAP: advanced-deeplink invoke path (server_get_user_advanced → advanced export)
  // ══════════════════════════════════════════════════════

  it("GAP: when advanced params exist, the advanced export command is used (not the basic one)", async () => {
    // First probe returns a persisted advanced record → fetchDeeplink takes the
    // server_export_config_deeplink_advanced branch with the TLV params baked in.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_advanced") {
        // Shape must satisfy isUserAdvancedServerResponse (userAdvanced.ts):
        // username + the typed flags are required.
        return {
          username: "swift-fox",
          display_name: "Alice",
          custom_sni: "cdn.example.com",
          upstream_protocol: "h3",
          anti_dpi: true,
          skip_verification: false,
          pin_cert_der_b64: null,
          dns_upstreams: [],
        };
      }
      if (cmd === "server_export_config_deeplink_advanced") {
        return "tt://advanced-export-result";
      }
      return null;
    });
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    const qr = await screen.findByTestId("qr-code");
    expect(qr).toHaveAttribute("data-value", "tt://advanced-export-result");
    expect(invoke).toHaveBeenCalledWith(
      "server_export_config_deeplink_advanced",
      expect.objectContaining({ clientName: "swift-fox" }),
    );
    // Basic export is NOT used when advanced params are present.
    expect(invoke).not.toHaveBeenCalledWith(
      "server_export_config_deeplink",
      expect.anything(),
    );
  });
});
