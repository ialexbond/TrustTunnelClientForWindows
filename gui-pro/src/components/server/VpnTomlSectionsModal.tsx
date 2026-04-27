/* eslint-disable react-refresh/only-export-components -- sliceTomlForSection is a co-located pure helper exported for unit tests + future Phase 15.5 reuse */
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Settings2, Network, Clock, BarChart3, Activity } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";

export type VpnTomlSection = "main" | "protocols" | "timeouts" | "metrics" | "icmp";

export interface VpnTomlSectionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Which section to display. */
  section: VpnTomlSection | null;
  /** Full raw vpn.toml string — sliced internally per section. */
  vpnTomlContent: string;
}

const SECTION_TITLE_KEY: Record<VpnTomlSection, string> = {
  main: "server.config.section.main",
  protocols: "server.config.section.protocols",
  timeouts: "server.config.section.timeouts",
  metrics: "server.config.section.metrics",
  icmp: "server.config.section.icmp",
};

const SECTION_ICONS: Record<VpnTomlSection, ComponentType<{ className?: string }>> = {
  main: Settings2,
  protocols: Network,
  timeouts: Clock,
  metrics: BarChart3,
  icmp: Activity,
};

/**
 * Slice raw vpn.toml string to lines relevant to a section.
 *
 * Algorithm:
 *   - "main": lines OUTSIDE any [table] header (top-level scalar fields like
 *     listen_address, ipv6_available, log_level, auth_failure_status_code etc).
 *   - "protocols": lines under [listen_protocols.*], [forward_protocol], [reverse_proxy].
 *   - "timeouts": lines containing `_timeout_secs` (whether top-level or in tables).
 *   - "metrics": lines under [metrics] header.
 *   - "icmp": lines under [icmp] header.
 *
 * Returns empty string if no matching section content found.
 */
export function sliceTomlForSection(raw: string, section: VpnTomlSection): string {
  if (!raw) return "";
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];

  if (section === "timeouts") {
    // Special case: cross-section grep for *_timeout_secs lines, regardless of header.
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed === "") continue;
      if (/_timeout_secs\s*=/.test(line)) out.push(line);
    }
    return out.join("\n");
  }

  // Header-based filtering for main / protocols / metrics / icmp
  const isHeader = (l: string): boolean => /^\s*\[\[?[^\]]+\]?\]\s*$/.test(l);
  const headerName = (l: string): string | null => {
    const m = l.trim().match(/^\[\[?([^\]]+?)\]?\]$/);
    return m ? m[1] : null;
  };
  const headerMatches = (name: string): boolean => {
    if (section === "protocols") {
      return (
        name.startsWith("listen_protocols") ||
        name === "forward_protocol" ||
        name === "reverse_proxy"
      );
    }
    if (section === "metrics") return name === "metrics";
    if (section === "icmp") return name === "icmp";
    return false;
  };

  let inMatchingTable = section === "main"; // start in implicit top-level table
  for (const line of lines) {
    if (isHeader(line)) {
      const name = headerName(line);
      if (section === "main") {
        // top-level keys end at first table header
        inMatchingTable = false;
      } else if (name !== null) {
        inMatchingTable = headerMatches(name);
        if (inMatchingTable) out.push(line);
      }
      continue;
    }
    if (inMatchingTable) out.push(line);
  }

  // Trim trailing empty lines for cleanliness
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

/**
 * Phase 15 per-section TOML stub modal.
 *
 * Phase 15 ships READ-ONLY view of the TOML slice for the section. Full per-field
 * edit form deferred to Phase 15.5. Существует сейчас чтобы Advanced Accordion
 * имел что-то визуальное чтобы открыть per section, давал пользователю inspection
 * capability, и фиксировал public API (`section: VpnTomlSection`,
 * `vpnTomlContent: string`) до того как формы будут wired up.
 *
 * **T-03 invariant:** Без early-return-null. Modal сам управляет 200ms exit-анимацией.
 * Cleanup state через setTimeout(200) внутри useEffect — mirrors UserModal pattern.
 */
export function VpnTomlSectionsModal({
  isOpen,
  onClose,
  section,
  vpnTomlContent,
}: VpnTomlSectionsModalProps) {
  const { t } = useTranslation();

  // T-03: keep a copy of `section` so during the 200ms exit animation the modal
  // still renders the most-recent valid section title (otherwise rapid close →
  // reopen with new section would show stale content for one frame).
  const [displayedSection, setDisplayedSection] = useState<VpnTomlSection | null>(
    section,
  );

  useEffect(() => {
    if (section) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- T-03: keep displayedSection synced with section prop while open; cleanup-delay branch below handles close-out
      setDisplayedSection(section);
      return;
    }
    // Renamed `t` -> `timer` to avoid shadowing the `useTranslation()` t hook.
    // Mirrors UserModal.tsx cleanup pattern (setTimeout(200) после exit-анимации).
    const timer = setTimeout(() => setDisplayedSection(null), 200);
    return () => clearTimeout(timer);
  }, [section]);

  const slice = useMemo(
    () =>
      displayedSection ? sliceTomlForSection(vpnTomlContent, displayedSection) : "",
    [vpnTomlContent, displayedSection],
  );

  const titleKey = displayedSection ? SECTION_TITLE_KEY[displayedSection] : null;
  const Icon = displayedSection ? SECTION_ICONS[displayedSection] : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={titleKey ? t(titleKey) : ""}
      size="lg"
    >
      <div className="space-y-4">
        {Icon && (
          <div className="inline-flex items-center gap-2 text-caption text-[var(--color-text-secondary)]">
            <Icon className="w-3.5 h-3.5" />
            <span>{t("server.config.advanced_accordion_title")}</span>
          </div>
        )}

        {/* Phase 15 stub notice */}
        <div
          role="note"
          className="text-body-sm p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--color-status-info-bg)] text-[var(--color-status-info)]"
        >
          {t("server.config.section_stub_notice")}
        </div>

        {/* Read-only TOML slice */}
        <pre
          data-testid="section-toml-slice"
          className="text-mono-sm whitespace-pre overflow-auto p-[var(--space-3)] rounded-[var(--radius-md)]"
          style={{
            backgroundColor: "var(--color-bg-primary)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-primary)",
            maxHeight: "50vh",
          }}
        >
          {slice || t("server.config.section_empty")}
        </pre>

        {/* Footer */}
        <div className="flex justify-end pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t("buttons.close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
