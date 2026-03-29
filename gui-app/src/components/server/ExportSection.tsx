import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Share2,
  Info,
  Copy,
  Check,
  Link2,
  ChevronDown,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import { useDropdownPortal } from "../../shared/hooks/useDropdownPortal";
import { colors } from "../../shared/ui/colors";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

export function ExportSection({ state }: Props) {
  const { t } = useTranslation();
  const { sshParams, serverInfo, setActionResult } = state;

  const [selectedUser, setSelectedUser] = useState("");
  const [generating, setGenerating] = useState(false);
  const [deeplink, setDeeplink] = useState("");
  const [copied, setCopied] = useState(false);
  const userDropdown = useDropdownPortal();

  const users = serverInfo?.users ?? [];

  const handleGenerate = async () => {
    if (!selectedUser) return;
    setGenerating(true);
    setDeeplink("");

    try {
      const link = await invoke<string>("server_export_config_deeplink", {
        ...sshParams,
        clientName: selectedUser,
      });
      setDeeplink(link);
    } catch (e) {
      state.pushSuccess(formatError(e), "error");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(deeplink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    state.pushSuccess(t("server.export.copied", "Скопировано"));
  };

  const truncateLink = (link: string, maxLen = 60) =>
    link.length <= maxLen ? link : link.slice(0, maxLen) + "...";

  return (
    <Card>
      <CardHeader
        title={t("server.export.title")}
        icon={<Share2 className="w-3.5 h-3.5" />}
        action={
          <Tooltip text={t("server.export.tooltip")}>
            <Info className="w-3.5 h-3.5 cursor-help" style={{ color: "var(--color-text-muted)" }} />
          </Tooltip>
        }
      />

      <div className="space-y-3">
        {/* Description */}
        <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
          {t("server.export.description")}
        </p>

        {/* User selector — custom dropdown */}
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>
            {t("server.export.user")}
          </label>
          <div className="relative" ref={userDropdown.containerRef}>
            <button
              ref={userDropdown.triggerRef}
              onClick={userDropdown.toggle}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs cursor-pointer transition-all outline-none"
              style={{
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                color: selectedUser ? "var(--color-text-primary)" : "var(--color-text-muted)",
                height: "34px",
              }}
            >
              <span className="truncate">{selectedUser || t("server.export.select_user")}</span>
              <ChevronDown
                className="w-3.5 h-3.5 shrink-0 transition-transform duration-200"
                style={{
                  color: "var(--color-text-muted)",
                  transform: userDropdown.open ? "rotate(180deg)" : "rotate(0deg)",
                }}
              />
            </button>
            {userDropdown.open && createPortal(
              <div
                ref={userDropdown.portalRef}
                style={{
                  ...userDropdown.style,
                  backgroundColor: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: colors.dropdownShadow,
                  overflow: "hidden",
                }}
              >
                <div className="max-h-40 overflow-y-auto" style={{ padding: "4px" }}>
                  {users.map((u) => {
                    const isSelected = u === selectedUser;
                    return (
                      <button
                        key={u}
                        onClick={() => { setSelectedUser(u); userDropdown.close(); setDeeplink(""); }}
                        className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors rounded-[var(--radius-md)]"
                        style={{
                          backgroundColor: isSelected ? colors.accentBg : "transparent",
                          color: isSelected ? "var(--color-accent-500)" : "var(--color-text-primary)",
                        }}
                        onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--color-bg-hover)"; }}
                        onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent"; }}
                      >
                        <span>{u}</span>
                        {isSelected && <Check className="w-3 h-3 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>,
              document.body
            )}
          </div>
        </div>

        {/* Generate button */}
        <Button
          variant="primary"
          size="sm"
          icon={<Link2 className="w-3.5 h-3.5" />}
          loading={generating}
          disabled={!selectedUser || generating}
          onClick={handleGenerate}
        >
          {generating ? t("server.export.generating") : t("server.export.generate")}
        </Button>

        {/* Deeplink result with QR code */}
        <div
          className="overflow-hidden transition-all duration-300 ease-in-out"
          style={{ maxHeight: deeplink ? "500px" : "0px", opacity: deeplink ? 1 : 0 }}
        >
          {deeplink && (
            <div className="space-y-3">
              {/* QR Code — transparent bg, adapts to theme */}
              <div className="flex justify-center py-4">
                <QRCodeSVG
                  value={deeplink}
                  size={180}
                  bgColor="transparent"
                  fgColor="currentColor"
                  level="M"
                  style={{ color: "var(--color-text-primary)", borderRadius: 8, opacity: 0.85 }}
                />
              </div>

              {/* Deeplink URL */}
              <div
                className="flex items-center gap-2 p-2 rounded-[var(--radius-md)]"
                style={{ backgroundColor: "var(--color-bg-primary)", border: "1px solid var(--color-border)" }}
              >
                <code
                  className="flex-1 text-[10px] font-mono truncate"
                  style={{ color: "var(--color-text-muted)" }}
                  title={deeplink}
                >
                  {truncateLink(deeplink)}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  onClick={handleCopy}
                >
                  {copied ? t("server.export.copied") : t("server.export.copy_link")}
                </Button>
              </div>

              {/* Scan instruction */}
              <p className="text-[10px] text-center" style={{ color: "var(--color-text-muted)" }}>
                {t("server.export.scan_qr")}
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
