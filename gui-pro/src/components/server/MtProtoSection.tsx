import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { MtProtoModal } from "./MtProtoModal";
import type { MtProtoState, SshParams } from "./useMtProtoState";

/**
 * MtProtoSection — Phase 17 Plan 04 (D-4.1).
 *
 * Card preview для MTProto Proxy в табе «Утилиты».
 * Показывает StatusIndicator (active port / not installed) + кнопку «Установить» / «Настроить».
 * Вся install/configure логика перенесена в MtProtoModal compound.
 *
 * Pattern: identical to SecuritySection Card-1 (Firewall) — Phase 16.
 */

interface MtProtoSectionProps {
  state: MtProtoState;
  sshParams: SshParams;
}

export function MtProtoSection({ state, sshParams }: MtProtoSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const installed = state.status?.installed ?? false;
  const active = state.status?.active ?? false;

  // StatusIndicator: success = installed && active, warning = installed && !active, danger = !installed
  const indicatorStatus: "success" | "warning" | "danger" = installed && active
    ? "success"
    : installed
      ? "warning"
      : "danger";

  // Subtitle label describing current state
  const subtitleLabel = installed && active
    ? t("server.service.mtproto.card.active_on_port", { port: state.status?.port })
    : installed
      ? t("server.service.mtproto.card.installed_inactive")
      : t("server.service.mtproto.card.not_installed");

  return (
    <Card data-testid="mtproto-section-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Send
            className="w-5 h-5 shrink-0"
            style={{ color: "var(--color-accent-interactive)" }}
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-subtitle">{t("server.service.mtproto.card.title")}</h3>
              <StatusIndicator
                status={indicatorStatus}
                size="sm"
                label={subtitleLabel}
              />
            </div>
            <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
              {subtitleLabel}
            </p>
          </div>
        </div>
        <Button
          variant={installed ? "secondary" : "primary"}
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="mtproto-open-button"
        >
          {installed
            ? t("server.service.mtproto.configure")
            : t("server.service.mtproto.install")}
        </Button>
      </div>

      {/* Phase 17.1 D-4.3 — legacy migration banner (Option B). Показываем
          в Card-уровне когда modal закрыт но миграция была — пользователь
          снова видит сводку при beглом взгляде на таб «Утилиты». */}
      {state.legacyMigrationNote && (
        <div className="mt-[var(--space-3)]">
          <ErrorBanner
            severity="info"
            message={state.legacyMigrationNote}
            data-testid="mtproto-section-legacy-banner"
          />
        </div>
      )}

      {/* MtProtoModal always in JSX tree — T-03: NEVER {open && <MtProtoModal />} */}
      <MtProtoModal
        isOpen={open}
        onClose={() => setOpen(false)}
        state={state}
        sshParams={sshParams}
      />
    </Card>
  );
}
