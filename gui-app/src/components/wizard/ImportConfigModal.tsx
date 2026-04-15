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
  const pushSuccess = useSnackBar();

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
      pushSuccess(String(e), "error");
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

    if (trimmed.startsWith("trusttunnel://") || trimmed.startsWith("tt://")) {
      try {
        const configContent = await invoke<string>("decode_deeplink", { url: trimmed });
        await importToml(configContent, "deeplink");
      } catch (e) {
        pushSuccess(String(e), "error");
      }
    } else {
      pushSuccess(t("wizard.import.invalid_link"), "error");
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
        pushSuccess(t("wizard.import.clipboard_invalid"), "error");
        setLoading(false);
      }
    } catch {
      pushSuccess(t("wizard.import.clipboard_error"), "error");
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

  if (!isOpen) return null;

  return (
    <>
    <Modal open={isOpen} onClose={handleClose} closeOnBackdrop={false}>
      <div
        className="w-[380px] p-5 space-y-4 rounded-xl"
        style={{
          backgroundColor: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 16px 48px var(--color-overlay-40)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
            {t("wizard.import.title")}
          </h2>
          <button onClick={handleClose} className="p-1 rounded hover:bg-[var(--color-bg-hover)]">
            <X className="w-4 h-4" style={{ color: "var(--color-text-muted)" }} />
          </button>
        </div>

        {/* Option cards */}
        <div className="space-y-2">
          {/* File */}
          <button
            onClick={handleFile}
            className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-colors hover:bg-[var(--color-bg-hover)]"
            style={{ border: "1px solid var(--color-border)" }}
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: "var(--color-accent-tint-10)" }}>
              <FileText className="w-4 h-4" style={{ color: "var(--color-accent-500)" }} />
            </div>
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>{t("wizard.import.from_file")}</p>
              <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>{t("wizard.import.from_file_desc")}</p>
            </div>
          </button>

          {/* Link + Clipboard combined */}
          <div
            className="rounded-xl overflow-hidden"
            style={{ border: "1px solid var(--color-border)" }}
          >
            <button
              onClick={() => setShowLinkInput(!showLinkInput)}
              className="w-full flex items-center gap-3 p-3 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: "var(--color-accent-tint-10)" }}>
                <Link2 className="w-4 h-4" style={{ color: "var(--color-accent-500)" }} />
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>{t("wizard.import.from_link")}</p>
                <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>{t("wizard.import.from_link_desc")}</p>
              </div>
            </button>

            {showLinkInput && (
              <div className="px-3 pb-3 space-y-2">
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
    </>
  );
}
