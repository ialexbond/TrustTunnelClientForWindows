import { useState, useMemo, type ReactNode, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  Settings2,
  Network,
  Clock,
  BarChart3,
  Activity,
  Shield,
  FileText,
  ChevronRight,
} from "lucide-react";
import { Accordion } from "../../shared/ui/Accordion";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { cn } from "../../shared/lib/cn";
import {
  VpnTomlSectionsModal,
  type VpnTomlSection,
} from "./VpnTomlSectionsModal";
import { RawTomlModal } from "./RawTomlModal";

export interface AdvancedConfigAccordionProps {
  /** Full vpn.toml content — passed to per-section modals + raw modal. */
  vpnTomlContent: string;
  /** hosts.toml content — passed to RawTomlModal as alternate file (optional). */
  hostsTomlContent?: string;
  /**
   * Slot for AllowedSniEditor (Plan 06). Plan 07 wires it. Plan 05 ships
   * accordion со слотом empty + «(Будет в Plan 06)» placeholder.
   */
  allowedSniSlot?: ReactNode;
  /** Optional dirty count from useVpnTomlState advanced fields — shown as badge in trigger. */
  dirtyAdvancedCount?: number;
}

interface SectionDef {
  id: VpnTomlSection;
  titleKey: string;
  icon: ComponentType<{ className?: string }>;
}

const SECTION_DEFS: SectionDef[] = [
  {
    id: "main",
    titleKey: "server.config.advanced_section_main",
    icon: Settings2,
  },
  {
    id: "protocols",
    titleKey: "server.config.advanced_section_protocols",
    icon: Network,
  },
  {
    id: "timeouts",
    titleKey: "server.config.advanced_section_timeouts",
    icon: Clock,
  },
  {
    id: "metrics",
    titleKey: "server.config.advanced_section_metrics",
    icon: BarChart3,
  },
  {
    id: "icmp",
    titleKey: "server.config.advanced_section_icmp",
    icon: Activity,
  },
];

/**
 * Phase 15 Advanced Accordion — раскрывающаяся секция «Расширенная конфигурация».
 *
 * Closed by default. Когда открыт, показывает три группы:
 *   1. **vpn.toml** — 5 кнопок-секций (Основные / Протоколы / Таймауты / Метрики / ICMP).
 *      Каждая открывает VpnTomlSectionsModal с соответствующим section enum
 *      (Plan 05 ships read-only view, full edit deferred to Phase 15.5).
 *   2. **hosts.toml** — TLS-хосты slot. Plan 07 wires AllowedSniEditor (Plan 06) here.
 *   3. **Raw TOML** — кнопка «Показать сырой TOML» открывает RawTomlModal (Plan 05).
 *
 * **T-03 invariant:** Both modals receive `isOpen={state !== null}` directly without
 * early-return-null wrappers. Caller (этот компонент) держит `openSection` / `openRaw`
 * state и переключает в null/false на close — modals fade out через own 200ms lifecycle.
 */
export function AdvancedConfigAccordion({
  vpnTomlContent,
  hostsTomlContent: _hostsTomlContent,
  allowedSniSlot,
  dirtyAdvancedCount = 0,
}: AdvancedConfigAccordionProps) {
  const { t } = useTranslation();
  const [openSection, setOpenSection] = useState<VpnTomlSection | null>(null);
  const [openRaw, setOpenRaw] = useState<boolean>(false);

  const trigger = useMemo(
    () => (
      <span className="inline-flex items-center gap-2">
        <span className="text-subtitle text-[var(--color-text-primary)]">
          {t("server.config.advanced_accordion_title")}
        </span>
        {dirtyAdvancedCount > 0 && (
          <Badge variant="warning" size="sm">
            {t("server.config.dirty_banner", { count: dirtyAdvancedCount })}
          </Badge>
        )}
      </span>
    ),
    [t, dirtyAdvancedCount],
  );

  const accordionContent = (
    <div className="space-y-4 pt-2">
      {/* Group 1: vpn.toml */}
      <div>
        <h3 className="text-caption uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
          vpn.toml
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {SECTION_DEFS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                data-testid={`section-trigger-${s.id}`}
                onClick={() => setOpenSection(s.id)}
                className={cn(
                  "flex items-center justify-between gap-2 w-full",
                  "px-[var(--space-3)] py-[var(--space-2)] rounded-[var(--radius-md)]",
                  "text-button text-[var(--color-text-primary)]",
                  "bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)]",
                  "border border-[var(--color-border)]",
                  "transition-colors",
                  "focus-visible:shadow-[var(--focus-ring)] outline-none",
                )}
              >
                <span className="inline-flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5" />
                  {t(s.titleKey)}
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Group 2: hosts.toml — slot for AllowedSniEditor (Plan 06) */}
      <div>
        <h3 className="text-caption uppercase tracking-wide text-[var(--color-text-muted)] mb-2 inline-flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5" />
          {t("server.config.advanced_section_hosts")}
        </h3>
        {allowedSniSlot ?? (
          <div
            className="text-body-sm text-[var(--color-text-muted)] p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--color-bg-surface)] border border-dashed border-[var(--color-border)]"
            data-testid="allowed-sni-slot-placeholder"
          >
            {t("server.config.allowed_sni_slot_placeholder")}
          </div>
        )}
      </div>

      {/* Group 3: Raw TOML view */}
      <div className="pt-2 border-t border-[var(--color-border)]">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpenRaw(true)}
          aria-expanded={openRaw}
        >
          <FileText className="w-3.5 h-3.5 mr-1.5" />
          {t("server.config.show_raw_toml")}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Accordion
        items={[{ id: "advanced", title: trigger, content: accordionContent }]}
        defaultOpen={[]}
      />

      {/* Lazy-mounted modals — T-03: pass isOpen directly, без early-return-null */}
      <VpnTomlSectionsModal
        isOpen={openSection !== null}
        onClose={() => setOpenSection(null)}
        section={openSection}
        vpnTomlContent={vpnTomlContent}
      />
      <RawTomlModal
        isOpen={openRaw}
        onClose={() => setOpenRaw(false)}
        content={vpnTomlContent}
        fileLabel="vpn.toml"
      />
    </>
  );
}
