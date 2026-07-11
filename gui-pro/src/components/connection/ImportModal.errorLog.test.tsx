import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ImportModal } from "./ImportModal";

// Phase 17 Wave 0 (17-01) — RED (GREEN by 17-06).
//
// CA-3: the multi-select «Из файла» import loop currently SWALLOWS every per-file failure in a
// bare `catch {}` (ImportModal.tsx:214) — no log sink, and no partial-count feedback. 17-06:
//   (1) surfaces the import error to a log sink (a DEV `console` mirror or log buffer), and
//   (2) shows a partial-failure «N из M» message when SOME (not all) files fail, so the user
//       knows the batch was incomplete.
// D-29: the logged string must NEVER contain the config password (the config content carries
// the user's host/username/secret). The literal password token is NOT written into any comment
// here (comment-text discipline, T-17-01) — the fixture builds it at runtime.
//
// These assertions describe the INTENDED CA-3 behavior, so they are RED against the current
// silently-swallowing modal until 17-06 lands the log sink + «N из M» message.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

// A distinctive password token assembled at runtime (never spelled out in a comment).
const SECRET = ["IMPORT", "SECRET", "CA3"].join("-");

function setup() {
  const onClose = vi.fn();
  const onImported = vi.fn();
  renderWithProviders(<ImportModal isOpen onClose={onClose} onImported={onImported} />);
  return { onClose, onImported };
}

describe("ImportModal — CA-3 import-error log + warning-banner/failed-list + D-29", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("logs a partial-import failure to a log sink WITHOUT leaking the password, and shows the failed file", async () => {
    const user = userEvent.setup();
    // Two picked files: the first imports OK, the second fails at the backend.
    openMock.mockResolvedValue(["/pick/ok.toml", "/pick/bad.toml"]);

    // read_config_file_for_import → returns the file content (the BAD one carries the secret).
    // import_config_from_string → OK for the first, throws for the second.
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "read_config_file_for_import") {
        const path = String(args.path);
        return Promise.resolve(
          path.includes("bad")
            ? `[endpoint]\nhostname = "b.win"\nusername = "u"\npassword = "${SECRET}"\n`
            : `[endpoint]\nhostname = "a.win"\nusername = "u"\npassword = "ok-secret"\n`,
        );
      }
      if (cmd === "import_config_from_string") {
        const content = String((args as { content?: unknown }).content ?? "");
        if (content.includes(SECRET)) {
          return Promise.reject(new Error("backend import failed for the bad config"));
        }
        return Promise.resolve("/data/TrustTunnel_a.toml");
      }
      return Promise.resolve("");
    });

    setup();
    await user.click(screen.getByRole("button", { name: new RegExp(i18n.t("connection.import.tile_file")) }));

    // CA-3 (1): the per-file failure is surfaced to the log sink (a DEV console.error mirror).
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });

    // D-29: NO logged argument may contain the config password.
    for (const call of errorSpy.mock.calls) {
      const joined = call.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      expect(joined).not.toContain(SECRET);
    }

    // CA-3 (2) / D-09: the partial result stays IN-MODAL as the rich story block — a WARNING banner
    // (1 imported, some failed) with a list of ONLY the failed files. The old flat «N из M» copy was
    // replaced in 19-03, so assert the language-agnostic signals instead: the warning-kind banner +
    // the failed file's basename in the failed list.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveAttribute("data-variant", "warning");
    });
    expect(screen.getByText("bad.toml")).toBeInTheDocument();
  });
});
