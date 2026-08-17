import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Link2, Clipboard, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { useSnackBar } from "../../shared/ui/SnackBarContext";

interface ImportConfigModalProps {
  open: boolean;
  onClose: () => void;
  onImported: (configPath: string) => void;
  /** Pre-filled URL from deep-link launch */
  initialUrl?: string;
}

export function ImportConfigModal({ open: isOpen, onClose, onImported, initialUrl }: ImportConfigModalProps) {
  const { t } = useTranslation();
  const [linkValue, setLinkValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [showLinkInput, setShowLinkInput] = useState(false);
  // IN-06: this snackbar handle pushes BOTH success and error toasts (the "error"
  // severity arg below), so it is named neutrally — not pushSuccess.
  const pushSnack = useSnackBar();

  const resetState = () => {
    setLinkValue("");
    setLoading(false);
    setShowLinkInput(false);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const importToml = async (content: string, source: string) => {
    setLoading(true);
    try {
      const path = await invoke<string>("import_config_from_string", { content, source });
      localStorage.setItem("tt_navigate_after_setup", "settings");
      onImported(path);
      handleClose();
    } catch (e) {
      pushSnack(String(e), "error");
    } finally {
      setLoading(false);
    }
  };

  const handleFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "TrustTunnel Config", extensions: ["toml"] }],
    });
    if (selected) {
      setLoading(true);
      try {
        const copied = await invoke<string>("copy_config_to_app_dir", { sourcePath: selected as string });
        localStorage.setItem("tt_navigate_after_setup", "settings");
        onImported(copied);
        handleClose();
      } catch {
        onImported(selected as string);
        handleClose();
      }
    }
  };

  const handleLink = async () => {
    const trimmed = linkValue.trim();
    if (!trimmed) return;

    // WR-02: gate the button for the WHOLE round-trip. Without this, `loading` was only
    // set inside importToml — AFTER the awaited decode_deeplink call — so «Импортировать»
    // stayed clickable during decode, leaving a double-submit window. Mirror handleClipboard:
    // set loading up front and reset it in finally (importToml manages its own loading once
    // it runs; on the error/invalid paths the finally restores the button).
    setLoading(true);
    try {
      if (trimmed.startsWith("trusttunnel://") || trimmed.startsWith("tt://")) {
        const configContent = await invoke<string>("decode_deeplink", { url: trimmed });
        await importToml(configContent, "deeplink");
      } else {
        pushSnack(t("wizard.import.invalid_link"), "error");
      }
    } catch (e) {
      pushSnack(String(e), "error");
    } finally {
      setLoading(false);
    }
  };

  const handleClipboard = async () => {
    setLoading(true);
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();

      if (trimmed.startsWith("trusttunnel://") || trimmed.startsWith("tt://")) {
        const configContent = await invoke<string>("decode_deeplink", { url: trimmed });
        await importToml(configContent, "clipboard-deeplink");
      } else if (trimmed.includes("[endpoint]") || trimmed.includes("hostname")) {
        await importToml(trimmed, "clipboard-toml");
      } else {
        pushSnack(t("wizard.import.clipboard_invalid"), "error");
        setLoading(false);
      }
    } catch {
      pushSnack(t("wizard.import.clipboard_error"), "error");
      setLoading(false);
    }
  };

  // Auto-fill and show link input when opened with initialUrl
  useEffect(() => {
    if (isOpen && initialUrl) {
      setLinkValue(initialUrl);
      setShowLinkInput(true);
    }
  }, [isOpen, initialUrl]);

  // G-10 — do NOT early-return null before <Modal>. The Modal primitive
  // owns its mount/animating lifecycle (200ms exit transition), and an
  // early return here kills the exit animation by unmounting the subtree
  // before Modal can fade. Parent passes isOpen as-is. State cleanup
  // happens in handleClose() via resetState() before onClose() fires.
  // See CLAUDE.md §Gotchas + memory/v3/design-system/known-issues.md#10.
  return (
    <Modal isOpen={isOpen} onClose={handleClose} closeOnBackdrop={false}>
      <div className="w-[380px] p-5 space-y-4 rounded-xl bg-[var(--color-bg-surface)] border border-[var(--color-border)] shadow-[var(--shadow-xl)]">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
            {t("wizard.import.title")}
          </h2>
          <button onClick={handleClose} className="p-1 rounded hover:bg-[var(--color-bg-hover)]">
            <X className="w-4 h-4 text-[var(--color-text-muted)]" />
          </button>
        </div>

        {/* Option cards */}
        <div className="space-y-2">
          {/* File */}
          <button
            onClick={handleFile}
            className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-colors hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)]"
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-[var(--color-accent-tint-10)]">
              <FileText className="w-4 h-4 text-[var(--color-accent-fg)]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--color-text-primary)]">{t("wizard.import.from_file")}</p>
              <p className="text-xs text-[var(--color-text-muted)]">{t("wizard.import.from_file_desc")}</p>
            </div>
          </button>

          {/* Link + Clipboard combined */}
          <div className="rounded-xl overflow-hidden border border-[var(--color-border)]">
            <button
              onClick={() => setShowLinkInput(!showLinkInput)}
              className="w-full flex items-center gap-3 p-3 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-[var(--color-accent-tint-10)]">
                <Link2 className="w-4 h-4 text-[var(--color-accent-fg)]" />
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--color-text-primary)]">{t("wizard.import.from_link")}</p>
                <p className="text-xs text-[var(--color-text-muted)]">{t("wizard.import.from_link_desc")}</p>
              </div>
            </button>

            {showLinkInput && (
              <div className="px-3 pb-3 space-y-2">
                {/* C-22 / D-14: when the modal was opened from a clicked deep-link
                    (initialUrl set), tell a non-technical user WHY the field is
                    pre-filled. The URL is untrusted — it is only PRE-FILLED here,
                    never auto-imported; the user must click «Импортировать», which
                    routes it through the backend decode_deeplink boundary. */}
                {initialUrl && (
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {t("wizard.import.deeplink_received")}
                  </p>
                )}
                <Input
                  value={linkValue}
                  onChange={(e) => {
                    // ASCII only — no cyrillic
                    const ascii = e.target.value.replace(/[^\x20-\x7E]/g, "");
                    setLinkValue(ascii);
                  }}
                  placeholder="tt://?BASE64... or trusttunnel://..."
                  icon={<Link2 className="w-3.5 h-3.5" />}
                />
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Clipboard className="w-3.5 h-3.5" />}
                    onClick={handleClipboard}
                    disabled={loading}
                    loading={loading}
                  >
                    {t("wizard.import.paste_clipboard")}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={loading}
                    onClick={handleLink}
                    disabled={!linkValue.trim()}
                    fullWidth
                  >
                    {t("wizard.import.import_button")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
