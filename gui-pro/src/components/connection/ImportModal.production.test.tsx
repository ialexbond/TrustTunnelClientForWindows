import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ImportModal } from "./ImportModal";

// ── Tauri mocks ──────────────────────────────────────────────────────────────
// invoke is the single IPC seam: decode_deeplink → import_config_from_string. The
// production modal NEVER imports unless the user explicitly clicks, so the assertions below
// can detect an accidental auto-import by spying on these calls.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

// Resolve labels through i18n so the test is language-agnostic.
const L = {
  title: i18n.t("connection.import.title"),
  cta: i18n.t("connection.import.cta"),
  tileLink: i18n.t("connection.import.tile_link"),
  tileFile: i18n.t("connection.import.tile_file"),
  close: i18n.t("buttons.close"),
};

function setup(props?: Partial<Parameters<typeof ImportModal>[0]>) {
  const onClose = vi.fn();
  const onImported = vi.fn();
  renderWithProviders(
    <ImportModal isOpen onClose={onClose} onImported={onImported} {...props} />,
  );
  return { onClose, onImported };
}

describe("ImportModal (production)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
  });

  // F06 — the modal exposes an accessible dialog name via aria-labelledby → «Добавить конфиг».
  it("has an accessible dialog name resolving to the title", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The accessible name is the h2 referenced by aria-labelledby.
    expect(dialog).toHaveAccessibleName(L.title);
  });

  // Link-format validation: «Импортировать» is disabled for a non-tt:// link and enabled for
  // a valid tt:// link.
  it("disables import for a non-tt:// link and enables it for a valid tt:// link", async () => {
    const user = userEvent.setup();
    setup();
    // Expand the «По ссылке» tile (its accessible name is label + caption, so match by regex).
    await user.click(screen.getByRole("button", { name: new RegExp(L.tileLink) }));
    const field = screen.getByLabelText(L.tileLink);
    const importBtn = screen.getByRole("button", { name: L.cta });

    // A bare number is not a link → import disabled.
    await user.type(field, "12345");
    expect(importBtn).toBeDisabled();

    // Clear + type a valid tt:// link → import enabled.
    await user.clear(field);
    await user.type(field, "tt://example-placeholder-config");
    expect(importBtn).toBeEnabled();
  });

  // deeplink-never-auto: a prefilled valid tt:// link does NOT auto-import on open — invoke
  // must not have been called until the explicit «Импортировать» click.
  it("does NOT auto-import a deeplink-prefilled link (deeplink-never-auto)", async () => {
    const user = userEvent.setup();
    setup({ initialUrl: "tt://example-placeholder-config" });

    // The field is prefilled + the import button is enabled, but NOTHING was imported.
    const importBtn = screen.getByRole("button", { name: L.cta });
    expect(importBtn).toBeEnabled();
    expect(invokeMock).not.toHaveBeenCalled();

    // Import fires ONLY on the explicit click.
    invokeMock
      .mockResolvedValueOnce("[endpoint]\nhostname=\"x\"\n") // decode_deeplink
      .mockResolvedValueOnce("C:/app/config.toml"); // import_config_from_string → path
    await user.click(importBtn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("decode_deeplink", expect.objectContaining({ url: "tt://example-placeholder-config" }));
    });
  });

  // An import error renders IN-MODAL (the modal stays open) — never a flyaway toast that
  // dismisses the dialog.
  it("renders an error in-modal and keeps the modal open", async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ initialUrl: "tt://broken" });

    invokeMock.mockRejectedValueOnce("decode failed"); // decode_deeplink throws

    await user.click(screen.getByRole("button", { name: L.cta }));

    // The error banner shows the invalid-link message; the modal is still mounted.
    await screen.findByText(i18n.t("connection.import.error_invalid_link"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Success (added) closes the modal + calls onImported with the destination path.
  it("on a successful import closes the modal and reports the new path", async () => {
    const user = userEvent.setup();
    const { onClose, onImported } = setup({ initialUrl: "tt://ok" });

    invokeMock
      .mockResolvedValueOnce("[endpoint]\nhostname=\"x\"\n") // decode_deeplink
      .mockResolvedValueOnce("C:/app/TrustTunnel_x.toml"); // import_config_from_string → path

    await user.click(screen.getByRole("button", { name: L.cta }));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith("C:/app/TrustTunnel_x.toml"));
    expect(onClose).toHaveBeenCalled();
  });

  // IN-21: from the «По ссылке» view a close (×) must STEP BACK to the file/link choice, not
  // dismiss the whole modal (the owner saw both windows close at once). A second close from the
  // choice view then fully dismisses.
  it("closing the «По ссылке» view steps back to the choice, not full dismiss (IN-21)", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();

    // Open the link view → the link field is present, the choice tiles are gone.
    await user.click(screen.getByRole("button", { name: new RegExp(L.tileLink) }));
    expect(screen.getByLabelText(L.tileLink)).toBeInTheDocument();

    // First close → back to the two choice tiles; the link field is gone; modal NOT dismissed.
    await user.click(screen.getByRole("button", { name: L.close }));
    expect(screen.getByRole("button", { name: new RegExp(L.tileFile) })).toBeInTheDocument();
    expect(screen.queryByLabelText(L.tileLink)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Second close from the choice view → fully dismisses.
    await user.click(screen.getByRole("button", { name: L.close }));
    expect(onClose).toHaveBeenCalled();
  });

  // IN-42: «Из файла» with a single picked file imports it and closes. The picker may hand back a
  // bare string (older shim) — the normalization wraps it into a one-element batch.
  it("«Из файла» imports a single picked config and closes (IN-42)", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValueOnce("C:/dl/RU_TrustTunnel_alice.toml");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_config_file_for_import") return Promise.resolve("[endpoint]\nhostname='h'");
      if (cmd === "import_config_from_string") return Promise.resolve("C:/app/imported.toml");
      return Promise.resolve(null);
    });
    const { onClose, onImported } = setup();

    await user.click(screen.getByRole("button", { name: new RegExp(L.tileFile) }));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith("C:/app/imported.toml"));
    const importCalls = invokeMock.mock.calls.filter((c) => c[0] === "import_config_from_string");
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0][1]).toMatchObject({ source: "file", originalFileName: "RU_TrustTunnel_alice.toml" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // IN-42: «Из файла» is MULTI-select (parity with drag-drop) — several picked files all import in
  // one batch, preserving each original filename, with a single onImported + one modal close.
  it("«Из файла» imports several picked configs in one batch (IN-42)", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValueOnce(["C:/dl/RU_TrustTunnel_a.toml", "C:/dl/RU_TrustTunnel_b.toml"]);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_config_file_for_import") return Promise.resolve("[endpoint]\nhostname='h'");
      if (cmd === "import_config_from_string") return Promise.resolve("C:/app/imported.toml");
      return Promise.resolve(null);
    });
    const { onClose, onImported } = setup();

    await user.click(screen.getByRole("button", { name: new RegExp(L.tileFile) }));

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    const importCalls = invokeMock.mock.calls.filter((c) => c[0] === "import_config_from_string");
    expect(importCalls).toHaveLength(2);
    expect(importCalls[0][1]).toMatchObject({ originalFileName: "RU_TrustTunnel_a.toml" });
    expect(importCalls[1][1]).toMatchObject({ originalFileName: "RU_TrustTunnel_b.toml" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ─── Phase 14 (14-03): lock the import CTA while a switch is in flight (D-13) ───
  //
  // RED until 14-03 — `isSwitching` is not yet on ImportModal. D-13: importing mid-switch adds a
  // config and may auto-promote/open a competing flow while the swap is in flight, so the
  // «Импортировать» CTA must be disabled while isSwitching (OR'd into the existing importDisabled),
  // even for a valid tt:// link. The existing in-flight (loading) lock is unchanged.
  describe("Phase 14 — lock import while switching (RED until 14-03)", () => {
    // D-13: while a switch is in flight NO import door may be entered — both the «Из файла» and «По
    // ссылке» tiles are disabled (the file tile imports directly on pick; the link tile enters an
    // import flow). This is the honest lock: a mid-switch import cannot be started at all.
    it("disables both import entry tiles while isSwitching", () => {
      setup({ isSwitching: true });
      expect(screen.getByRole("button", { name: new RegExp(L.tileFile) })).toBeDisabled();
      expect(screen.getByRole("button", { name: new RegExp(L.tileLink) })).toBeDisabled();
    });

    // D-13: on the expanded link view, the «Импортировать» CTA stays disabled while switching even
    // for a valid tt:// link (defense-in-depth if the modal is already on the link view when a switch
    // starts — importDisabled OR's isSwitching).
    it("keeps the import CTA disabled while isSwitching even for a valid link", () => {
      // Seed the modal ALREADY on the expanded link view via initialUrl (a valid-link prefill expands
      // it), so the «Импортировать» CTA is present without clicking the now-locked tile. The prefilled
      // valid link would normally ENABLE import; the switch lock (importDisabled OR's isSwitching)
      // keeps it disabled — defense-in-depth if a switch starts while the modal is on the link view.
      setup({ isSwitching: true, initialUrl: "tt://example-placeholder-config" });
      const importBtn = screen.getByRole("button", { name: L.cta });
      expect(importBtn).toBeDisabled();
    });

    it("re-enables the import entry tiles when not switching", () => {
      setup({ isSwitching: false });
      expect(screen.getByRole("button", { name: new RegExp(L.tileFile) })).toBeEnabled();
      expect(screen.getByRole("button", { name: new RegExp(L.tileLink) })).toBeEnabled();
    });
  });

  // ─── Phase 19 (19-03): rich partial-import UX (D-09) ──────────────────────────
  //
  // A multi-file «Из файла» batch where SOME files fail must keep the result IN-MODAL: a warning
  // banner with the pluralised ok count + the failed count, a list of ONLY the failed files each
  // with a short reason, and a «Повторить» button that retries ONLY the failed items. An all-failed
  // batch (ok===0) is a pure error (red banner, no success snackbar). RED until 19-03 Task 2 ports
  // the story's rich partial block into ImportModal.tsx (today it renders one flat `partial_count`
  // banner that discards per-file labels/reasons).
  describe("Phase 19 — rich partial-import (D-09)", () => {
    const reasonFile = i18n.t("connection.import.reason_invalid_file");
    const retryLabel = i18n.t("connection.import.retry");

    // A batch picker whose reads succeed for every path EXCEPT those in `failing` (a mutable Set so
    // a later retry can flip a path to succeed). import_config_from_string always resolves a dest.
    function mockBatch(paths: string[], failing: Set<string>) {
      openMock.mockResolvedValueOnce(paths);
      invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
        if (cmd === "read_config_file_for_import") {
          return failing.has(args!.path!)
            ? Promise.reject(new Error("read fail"))
            : Promise.resolve("[endpoint]\nhostname='h'");
        }
        if (cmd === "import_config_from_string") return Promise.resolve("C:/app/imported.toml");
        return Promise.resolve(null);
      });
    }

    it("partial batch (ok>0) → WARNING banner + ONLY the failed files with their reason", async () => {
      const user = userEvent.setup();
      mockBatch(
        ["C:/dl/ok.toml", "C:/dl/bad1.toml", "C:/dl/bad2.toml"],
        new Set(["C:/dl/bad1.toml", "C:/dl/bad2.toml"]),
      );
      const { onClose } = setup();

      await user.click(screen.getByRole("button", { name: new RegExp(L.tileFile) }));

      // Warning banner (not error): variant is surfaced as data-variant, not asserted via CSS.
      const banner = await screen.findByRole("alert");
      expect(banner).toHaveAttribute("data-variant", "warning");
      const okPlural = i18n.t("connection.import.config_count", { count: 1 });
      expect(banner).toHaveTextContent(
        i18n.t("connection.import.partial_ok_failed", { ok_plural: okPlural, failed: 2 }),
      );
      // ONLY the failed basenames are listed (the successful one is already committed to the list).
      expect(screen.getByText("bad1.toml")).toBeInTheDocument();
      expect(screen.getByText("bad2.toml")).toBeInTheDocument();
      expect(screen.queryByText("ok.toml")).not.toBeInTheDocument();
      expect(screen.getAllByText(reasonFile)).toHaveLength(2);
      // The result STAYS in-modal — never a flyaway toast.
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("all-failed batch (ok===0) → RED error banner and NO success snackbar", async () => {
      const user = userEvent.setup();
      mockBatch(
        ["C:/dl/bad1.toml", "C:/dl/bad2.toml"],
        new Set(["C:/dl/bad1.toml", "C:/dl/bad2.toml"]),
      );
      const { onClose, onImported } = setup();

      await user.click(screen.getByRole("button", { name: new RegExp(L.tileFile) }));

      const banner = await screen.findByRole("alert");
      expect(banner).toHaveAttribute("data-variant", "error");
      expect(banner).toHaveTextContent(i18n.t("connection.import.all_failed", { total: 2 }));
      // Nothing imported → no onImported, modal stays open, no success snackbar fired.
      expect(onImported).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(
        screen.queryByText(i18n.t("connection.snackbar.config_added")),
      ).not.toBeInTheDocument();
    });

    it("«Повторить» retries ONLY the failed items; all-success then closes + reports", async () => {
      const user = userEvent.setup();
      const failing = new Set(["C:/dl/bad1.toml", "C:/dl/bad2.toml"]);
      mockBatch(["C:/dl/ok.toml", "C:/dl/bad1.toml", "C:/dl/bad2.toml"], failing);
      const { onClose, onImported } = setup();

      await user.click(screen.getByRole("button", { name: new RegExp(L.tileFile) }));
      await screen.findByText("bad1.toml");

      // First batch imported ONLY the ok file.
      const firstImports = invokeMock.mock.calls.filter((c) => c[0] === "import_config_from_string");
      expect(firstImports).toHaveLength(1);

      // Let the two previously-failed items succeed on retry.
      failing.clear();
      invokeMock.mockClear();
      await user.click(screen.getByRole("button", { name: retryLabel }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      // Retry re-ran ONLY the two failed paths — never the already-imported ok.toml.
      const retryReads = invokeMock.mock.calls
        .filter((c) => c[0] === "read_config_file_for_import")
        .map((c) => (c[1] as { path: string }).path)
        .sort();
      expect(retryReads).toEqual(["C:/dl/bad1.toml", "C:/dl/bad2.toml"]);
      expect(onImported).toHaveBeenCalled();
    });
  });
});
