import { describe, it, expect, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { saveFileDialog, SAVE_DIALOG_FAILED } from "./saveFileDialog";
import { translatePathError } from "./translatePathError";
import i18n from "../i18n";

// `@tauri-apps/plugin-dialog` is mocked globally in src/test/tauri-mock.ts.
const mockSave = vi.mocked(save);

describe("saveFileDialog", () => {
  it("passes a chosen path straight through", async () => {
    mockSave.mockResolvedValueOnce("C:/Users/tester/config.toml");
    await expect(saveFileDialog({ defaultPath: "config.toml" })).resolves.toBe(
      "C:/Users/tester/config.toml",
    );
  });

  // Cancelling is not a failure — it must stay a plain `null` so the call sites'
  // `if (dest)` guard keeps them silent instead of showing an error.
  it("passes a cancelled dialog through as null, not as a rejection", async () => {
    mockSave.mockResolvedValueOnce(null);
    await expect(saveFileDialog({ defaultPath: "config.toml" })).resolves.toBeNull();
  });

  it("stamps a code onto a dialog rejection and keeps the plugin text as the detail", async () => {
    mockSave.mockRejectedValueOnce(new Error("dialog plugin unavailable"));
    await expect(saveFileDialog({ defaultPath: "config.toml" })).rejects.toThrow(
      `${SAVE_DIALOG_FAILED}|dialog plugin unavailable`,
    );
  });

  // The plugin can reject with a bare string too (Tauri IPC serializes some
  // failures that way), and `formatError` has to normalize both shapes.
  it("stamps a code onto a rejection that is a bare string", async () => {
    mockSave.mockRejectedValueOnce("os refused to show the dialog");
    await expect(saveFileDialog({})).rejects.toThrow(
      `${SAVE_DIALOG_FAILED}|os refused to show the dialog`,
    );
  });

  // The whole point of the wrapper: the coded rejection must survive the trip
  // through the translator that both Save-As doors already use, and come out
  // Russian rather than as the plugin's English sentence.
  it("produces Russian, not the plugin's English, once run through translatePathError", async () => {
    i18n.changeLanguage("ru");
    mockSave.mockRejectedValueOnce(new Error("dialog plugin unavailable"));

    let thrown: unknown;
    try {
      await saveFileDialog({ defaultPath: "config.toml" });
    } catch (e) {
      thrown = e;
    }

    const message = translatePathError(thrown, i18n.t);
    expect(message).toBe(i18n.t("pathErrors.saveDialogFailed"));
    expect(message).toMatch(/[А-Яа-я]/);
    expect(message).not.toContain("dialog plugin unavailable");
    expect(message).not.toContain(SAVE_DIALOG_FAILED);
  });
});
