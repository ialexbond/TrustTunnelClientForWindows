import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal, Network, Shield, Activity } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Toggle } from "../../shared/ui/Toggle";
import { Input } from "../../shared/ui/Input";
import { Select } from "../../shared/ui/Select";
import { FormField } from "../../shared/ui/FormField";
import { Skeleton } from "../../shared/ui/Skeleton";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import {
  validateListenAddress,
  validateLogLevel,
  validateUrlPath,
  validateAuthStatusCode,
} from "../../shared/utils/validators";
import { RestartRequiredBadge } from "./RestartRequiredBadge";
import { DirtyChangesBanner } from "./DirtyChangesBanner";
import {
  useVpnTomlState,
  type SshParamsLite,
  type VpnTomlState,
} from "./useVpnTomlState";

interface Props {
  sshParams: SshParamsLite;
  /** Storybook escape hatch — supply a pre-baked state instead of triggering load. */
  _storybookState?: VpnTomlState;
}

interface FieldErrors {
  listen_address: string;
  log_level: string;
  ping_path: string;
  speedtest_path: string;
  auth_failure_status_code: string;
}

const LOG_LEVEL_OPTIONS = [
  { value: "", label: "(default)" },
  { value: "trace", label: "trace" },
  { value: "debug", label: "debug" },
  { value: "info", label: "info" },
  { value: "warn", label: "warn" },
  { value: "error", label: "error" },
];

const AUTH_STATUS_OPTIONS = [
  { value: "405", label: "405 Method Not Allowed" },
  { value: "407", label: "407 Proxy Authentication Required" },
];

/**
 * Phase 15 Quick Settings — top-of-«Конфигурация» tab section.
 *
 * 6 fields per D-1: listen_address, log_level, allow_private_network_connections,
 * auth_failure_status_code, ping_path, speedtest_path.
 *
 * Save flow (D-3): explicit «Применить настройки» button → useConfirm dialog
 * (copy variant per disrupt level — D-4) → sequential per-field invokes via
 * useVpnTomlState.saveBatch → SnackBar success / ErrorBanner failure.
 *
 * Storybook integration via `_storybookState` prop bypasses the hook entirely
 * so stories can render any state combination without IPC mocks.
 */
export function QuickSettingsSection({ sshParams, _storybookState }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const pushSuccess = useSnackBar();

  // Always invoke the hook to satisfy rules-of-hooks; if a story provides
  // _storybookState we shadow `liveState` for rendering.
  const liveState = useVpnTomlState(sshParams);
  const state: VpnTomlState = _storybookState ?? liveState;

  const errors = useMemo<FieldErrors>(
    () => ({
      listen_address: validateListenAddress(state.fields.listen_address),
      log_level: validateLogLevel(state.fields.log_level),
      ping_path: validateUrlPath(state.fields.ping_path),
      speedtest_path: validateUrlPath(state.fields.speedtest_path),
      auth_failure_status_code: validateAuthStatusCode(
        state.fields.auth_failure_status_code,
      ),
    }),
    [state.fields],
  );

  const hasError = useMemo(
    () => Object.values(errors).some((v) => v.length > 0),
    [errors],
  );

  const canSave = !state.saving && !hasError && state.isDirty;

  const handleSave = async () => {
    const isHighRisk = state.highRiskCount > 0;
    const messageKey = isHighRisk
      ? "server.config.confirm_save_message_high_disrupt"
      : "server.config.confirm_save_message";
    const ok = await confirm({
      title: t("server.config.confirm_save_title"),
      message: t(messageKey),
      variant: isHighRisk ? "danger" : "warning",
      confirmText: t("server.config.apply_and_restart"),
      cancelText: t("buttons.cancel", "Отмена"),
      action: async () => {
        await state.saveBatch();
      },
    });
    if (ok) pushSuccess(t("server.config.saved"));
  };

  const handleDiscard = async () => {
    const ok = await confirm({
      title: t("server.config.confirm_discard_title"),
      message: t("server.config.confirm_discard_message"),
      variant: "warning",
      confirmText: t("server.config.discard_confirm_cta"),
      cancelText: t("buttons.cancel", "Отмена"),
    });
    if (ok) state.discard();
  };

  // ─── Loading state ─────────────────────────────────────
  if (state.loading) {
    return (
      <div className="space-y-4" data-testid="quick-settings-loading">
        <Skeleton variant="card" height={120} />
        <Skeleton variant="card" height={120} />
        <Skeleton variant="card" height={120} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Dirty banner (hidden when no changes) */}
      <DirtyChangesBanner
        changeCount={state.dirtyFields.length}
        onApply={canSave ? () => void handleSave() : undefined}
        onDiscard={() => void handleDiscard()}
      />

      {/* Persistent error banner (load or save failures) */}
      {state.error && (
        <ErrorBanner severity="error" message={t("server.config.error_save")} />
      )}

      {/* Card 1: Соединение — listen_address (disrupt-high) + log_level */}
      <Card>
        <CardHeader
          title={t("server.config.section.main")}
          icon={<Network className="w-3.5 h-3.5" />}
        />
        <div className="space-y-4">
          <FieldRow
            label={t("server.config.listen_address_label")}
            badge={<RestartRequiredBadge level="disrupt-high" />}
          >
            <FormField
              label=""
              error={
                errors.listen_address ? t(errors.listen_address) : undefined
              }
              hint={t("server.config.listen_address_helper")}
            >
              <Input
                value={state.fields.listen_address}
                onChange={(e) =>
                  state.setField("listen_address", e.target.value)
                }
                placeholder="0.0.0.0:443"
                disabled={state.saving}
                error={
                  errors.listen_address ? t(errors.listen_address) : undefined
                }
                aria-label={t("server.config.listen_address_label")}
                className="font-mono"
              />
            </FormField>
          </FieldRow>

          <FieldRow
            label={t("server.config.log_level_label")}
            badge={<RestartRequiredBadge level="disrupt-low" />}
          >
            <Select
              options={LOG_LEVEL_OPTIONS}
              value={state.fields.log_level}
              onChange={(e) => state.setField("log_level", e.target.value)}
              disabled={state.saving}
            />
          </FieldRow>
        </div>
      </Card>

      {/* Card 2: Безопасность — allow_private_network + auth_failure_code */}
      <Card>
        <CardHeader
          title={t("server.config.section.protocols")}
          icon={<Shield className="w-3.5 h-3.5" />}
        />
        <div className="space-y-4">
          <Toggle
            checked={state.fields.allow_private_network_connections}
            onChange={(v) =>
              state.setField("allow_private_network_connections", v)
            }
            label={t("server.config.allow_private_label")}
            description={t("server.config.allow_private_helper")}
            disabled={state.saving}
            labelExtra={
              <RestartRequiredBadge
                level="disrupt-low"
                className="ml-2"
              />
            }
          />

          <FieldRow
            label={t("server.config.auth_failure_code_label")}
            badge={<RestartRequiredBadge level="disrupt-low" />}
          >
            <FormField
              label=""
              hint={t("server.config.auth_failure_code_helper")}
              error={
                errors.auth_failure_status_code
                  ? t(errors.auth_failure_status_code)
                  : undefined
              }
            >
              <Select
                options={AUTH_STATUS_OPTIONS}
                value={String(state.fields.auth_failure_status_code)}
                onChange={(e) =>
                  state.setField(
                    "auth_failure_status_code",
                    parseInt(e.target.value, 10),
                  )
                }
                disabled={state.saving}
              />
            </FormField>
          </FieldRow>
        </div>
      </Card>

      {/* Card 3: Диагностика — ping_path + speedtest_path */}
      <Card>
        <CardHeader
          title={t("server.config.section.metrics")}
          icon={<Activity className="w-3.5 h-3.5" />}
        />
        <div className="space-y-4">
          <FieldRow
            label={t("server.config.ping_path_label")}
            badge={<RestartRequiredBadge level="disrupt-low" />}
          >
            <FormField
              label=""
              hint={t("server.config.ping_path_helper")}
              error={errors.ping_path ? t(errors.ping_path) : undefined}
            >
              <Input
                value={state.fields.ping_path}
                onChange={(e) => state.setField("ping_path", e.target.value)}
                placeholder="/ping"
                disabled={state.saving}
                aria-label={t("server.config.ping_path_label")}
                error={errors.ping_path ? t(errors.ping_path) : undefined}
                className="font-mono"
              />
            </FormField>
          </FieldRow>

          <FieldRow
            label={t("server.config.speedtest_path_label")}
            badge={<RestartRequiredBadge level="disrupt-low" />}
          >
            <FormField
              label=""
              hint={t("server.config.speedtest_path_helper")}
              error={
                errors.speedtest_path ? t(errors.speedtest_path) : undefined
              }
            >
              <Input
                value={state.fields.speedtest_path}
                onChange={(e) =>
                  state.setField("speedtest_path", e.target.value)
                }
                placeholder="/speedtest"
                disabled={state.saving}
                aria-label={t("server.config.speedtest_path_label")}
                error={
                  errors.speedtest_path ? t(errors.speedtest_path) : undefined
                }
                className="font-mono"
              />
            </FormField>
          </FieldRow>
        </div>
      </Card>

      {/* Save CTA — bottom of section */}
      <div className="flex justify-end pt-2">
        <Button
          variant="primary"
          onClick={() => void handleSave()}
          disabled={!canSave}
          loading={state.saving}
        >
          <SlidersHorizontal className="w-3.5 h-3.5 mr-1.5" />
          {state.dirtyFields.length > 0
            ? t("server.config.save_button_with_count", {
                count: state.dirtyFields.length,
              })
            : t("server.config.apply_settings")}
        </Button>
      </div>
    </div>
  );
}

interface FieldRowProps {
  label: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}

function FieldRow({ label, badge, children }: FieldRowProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-body font-medium text-[var(--color-text-secondary)]">
          {label}
        </label>
        {badge}
      </div>
      {children}
    </div>
  );
}
