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
});
