import { useState, useEffect, useMemo, useId } from "react";
import { useTranslation } from "react-i18next";
import {
  FAIL2BAN_PRESETS,
  type Fail2banPresetId,
  type SecurityState,
} from "./useSecurityState";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { useConfirm } from "../../shared/ui/useConfirm";
import { durationsEqual, normalizeDurationToSeconds } from "./fail2banUtils";
import { cn } from "../../shared/lib/cn";

/**
 * Phase 16 Plan 04 — Fail2banSettingsTab.
 *
 * Renders 3 RadioGroup presets (Мягкая / Сбалансированная / Строгая) +
 * a collapsed Accordion with custom mode (3 NumberInput'а).
 *
 * Behaviour (D-4.2):
 *   - activePreset = derived value из jail config — matched preset из
 *     FAIL2BAN_PRESETS map'a; если нет совпадения → "custom"; если jail
 *     не loaded → дефолт "balanced".
 *   - Selecting preset radio → setSelectedPreset (optimistic UI) +
 *     invoke `security_fail2ban_set_jail` с PRESETS[id] (через
 *     state.applyFail2banPreset).
 *   - Apply custom button → invoke с inline values из локального state.
 *
 * Custom inputs draft state — useState с initial value из jail (через
 * useEffect mirror) чтобы пользователь мог редактировать без потери
 * draft при background refresh. Synced когда jail.maxretry/bantime/
 * findtime меняются.
 *
 * Backend `security_fail2ban_set_jail` НЕ изменяется — фронт строит
 * config из preset map.
 */
interface Fail2banSettingsTabProps {
  state: SecurityState;
  jail:
    | {
        name: string;
        maxretry: number;
        bantime: string;
        findtime: string;
      }
    | undefined;
  /**
   * P0-2 #K — fires when custom draft state diverges from / converges with jail
   * config. Parent Modal uses this to show close-confirm warning.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

export function Fail2banSettingsTab({ state, jail, onDirtyChange }: Fail2banSettingsTabProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  // BUG-22 fix: useId() для unique ids (не "f2b-maxretry" hardcode'ы).
  // Многократные instances Fail2banSettingsTab (например, multi-server
  // panels — planned future) или Storybook docs page rendering нескольких
  // stories на одной странице — duplicate ids ломали label-input pairing.
  const idPrefix = useId();
  // Optimistic preset selection — overrides derived detection между
  // click и refresh. null = use derived value.
  const [selectedPreset, setSelectedPreset] = useState<Fail2banPresetId | null>(
    null,
  );

  // Derived activePreset из jail.maxretry/bantime/findtime.
  // Если selectedPreset (optimistic) — используем его пока jail не
  // обновится с матчующими values (тогда selectedPreset cleared).
  // useMemo передаёт `jail` целиком (ESLint compiler не любит дробные
  // зависимости), но логика читает только 3 примитива — backend refresh
  // даёт новый object identity, кэш инвалидируется один раз и считает
  // detection заново.
  const detectedPreset = useMemo<Fail2banPresetId>(() => {
    if (!jail) return "balanced";
    // BUG-01 fix: durationsEqual нормализует "1h" ↔ "3600" ↔ "60m" ↔ "10m" ↔ "600"
    // перед сравнением. Backend install_fail2ban template пишет "1h" / "10m"
    // (suffix format), frontend presets хранят numeric seconds. Без normalize'а
    // string compare всегда false → fresh install детектился как "custom".
    const matched = Object.entries(FAIL2BAN_PRESETS).find(
      ([, cfg]) =>
        cfg.maxretry === jail.maxretry &&
        durationsEqual(cfg.bantime, jail.bantime) &&
        durationsEqual(cfg.findtime, jail.findtime),
    );
    return matched ? (matched[0] as Fail2banPresetId) : "custom";
  }, [jail]);

  const activePreset = selectedPreset ?? detectedPreset;

  // BUG-01 fix: NumberInput draft нормализуется к canonical seconds string —
  // backend может возвращать "1h"/"10m" (suffix format из install template),
  // но `<input type="number">` не отрендерит "1h" корректно. Нормализуем к
  // числовым секундам, чтобы input value был всегда valid number.
  const normalizeJailDuration = (raw: string, fallback: string): string => {
    const seconds = normalizeDurationToSeconds(raw);
    return seconds !== null ? String(seconds) : fallback;
  };

  // P UAT 2026-05-04 fix: maxretry state — STRING вместо number. Раньше
  // `parseInt(e.target.value) || 5` — при empty input parseInt вернёт
  // NaN → `|| 5` снова ставит 5 → backspace «не работает». Now string state
  // позволяет empty/incomplete drafts; parse на submit (validateCustom).
  const [custom, setCustom] = useState({
    maxretry: jail?.maxretry !== undefined ? String(jail.maxretry) : "5",
    bantime: jail ? normalizeJailDuration(jail.bantime, "600") : "600",
    findtime: jail ? normalizeJailDuration(jail.findtime, "600") : "600",
  });

  // External sync: jail config refreshes (backend reload after preset apply)
  // → mirror values into draft state. Pattern allows user editing без
  // losing pending edits on background refresh.
  //
  // BUG-10 fix: depend on PRIMITIVE values (maxretry/bantime/findtime),
  // не на jail object reference. Когда backend.load() возвращает идентичные
  // values но новый object identity, useEffect больше не fires → draft
  // user'а не wipe'ается silently.
  useEffect(() => {
    if (!jail) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mirror of jail config primitives into draft state on backend refresh (only when actual values change)
    setCustom({
      maxretry: String(jail.maxretry),
      bantime: normalizeJailDuration(jail.bantime, "600"),
      findtime: normalizeJailDuration(jail.findtime, "600"),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: depend on primitive values not object reference
  }, [jail?.maxretry, jail?.bantime, jail?.findtime]);

  // Clear optimistic override when jail catches up to selected — synchronously
  // обновляем чтобы radio reflected real backend state на том же frame.
  useEffect(() => {
    if (selectedPreset && detectedPreset === selectedPreset) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- post-apply sync: backend caught up to optimistic selection, clear override on the same frame so derived state takes over
      setSelectedPreset(null);
    }
  }, [detectedPreset, selectedPreset]);

  // P0-2 #K — Dirty state: custom draft != jail config (pre-Apply edits exist).
  // Used by Accordion title indicator + parent Modal close-warning.
  // BUG-01 fix: durationsEqual для bantime/findtime — иначе после backend
  // refresh с "1h" а draft "3600" → false dirty (semantically equal).
  const isCustomDirty = useMemo(() => {
    if (!jail) return false;
    const draftRetry = parseInt(custom.maxretry, 10);
    return (
      (Number.isFinite(draftRetry) ? draftRetry !== jail.maxretry : true) ||
      !durationsEqual(custom.bantime, jail.bantime) ||
      !durationsEqual(custom.findtime, jail.findtime)
    );
  }, [custom, jail]);

  // Bubble dirty state to parent Modal via callback (для close-warning).
  //
  // BUG-08 fix: cleanup сбрасывает dirty=false на unmount. Без этого parent's
  // customDirty оставался true после tab-switch (Settings tab unmount'ится
  // когда TabsInline переключается на Banned IPs). Возврат на Settings →
  // tab remount → useEffect re-syncs draft → dirty=false. Но parent's флаг
  // оставался stale (с прошлой жизни tab'а).
  useEffect(() => {
    onDirtyChange?.(isCustomDirty);
    return () => onDirtyChange?.(false);
  }, [isCustomDirty, onDirtyChange]);

  const handleApplyPreset = async (preset: keyof typeof FAIL2BAN_PRESETS) => {
    // P1-7 #L — confirm перед «Строгая» (3 retries / 1 hour ban). Aggressive
    // preset может выбить legitimate scripts/CI делающих rapid SSH connect.
    // Soft + Balanced apply без confirm — risk их низок.
    if (preset === "strict") {
      const ok = await confirm({
        title: t("server.security.fail2ban.strict_confirm_title"),
        message: t("server.security.fail2ban.strict_confirm_message"),
        variant: "warning",
        confirmText: t("server.security.fail2ban.strict_confirm_action"),
        cancelText: t("buttons.cancel"),
      });
      if (!ok) return;
    }
    setSelectedPreset(preset);
    try {
      await state.applyFail2banPreset(preset);
    } catch {
      // BUG-16 fix: revert optimistic selection on backend failure (sshd
      // restart fail / SSH_CHANNEL_FAILED / etc.). Без revert'а radio
      // оставался highlighted на failed preset, UI lying about backend state.
      // applyFail2banPreset wraps run() которое catches и shows error toast,
      // поэтому здесь только revert визуального state — toast already fired.
      setSelectedPreset(null);
    }
  };

  // BUG-19 fix: disable ALL preset radios пока ANY preset apply в полёте.
  // Раньше disabled={isBusy} (per-radio) — позволяло rapid-click через
  // несколько presets, queue'ить параллельные invokes. End state мог не
  // совпасть с last clicked. Now: один busy → все disabled.
  const anyPresetBusy = (["soft", "balanced", "strict", "custom"] as const).some((p) =>
    state.isBusy(`f2b-preset-${p}`),
  );

  // BUG-05 fix: client-side validation перед invoke. Backend `is_safe_duration`
  // принимает любое непустое строковое + цифры/буквы, но не gates min/max
  // ranges → empty string, "0", или "99999999" приходили в `fail2ban-client
  // set` и silently ломали jail. Frontend mirror invariant: maxretry 1-1000,
  // bantime 1-31536000s (1y), findtime 1-86400s (1d).
  const validateCustom = (): string | null => {
    // P UAT 2026-05-04: maxretry now string state — parse here.
    const r = parseInt(custom.maxretry, 10);
    if (!Number.isFinite(r) || r < 1) return t("server.security.fail2ban.errors.maxretry_too_low");
    if (r > 1000) return t("server.security.fail2ban.errors.maxretry_too_high");
    const bt = normalizeDurationToSeconds(custom.bantime);
    if (bt === null) return t("server.security.fail2ban.errors.bantime_invalid");
    if (bt < 1) return t("server.security.fail2ban.errors.bantime_too_low");
    if (bt > 31536000) return t("server.security.fail2ban.errors.bantime_too_high");
    const ft = normalizeDurationToSeconds(custom.findtime);
    if (ft === null) return t("server.security.fail2ban.errors.findtime_invalid");
    if (ft < 1) return t("server.security.fail2ban.errors.findtime_too_low");
    if (ft > 86400) return t("server.security.fail2ban.errors.findtime_too_high");
    return null;
  };

  const [customError, setCustomError] = useState<string | null>(null);

  const handleApplyCustom = () => {
    const err = validateCustom();
    if (err) {
      setCustomError(err);
      return;
    }
    setCustomError(null);
    setSelectedPreset("custom");
    // applyFail2banCustom expects { maxretry: number, ... } — parse string draft.
    const payload = {
      maxretry: parseInt(custom.maxretry, 10),
      bantime: custom.bantime,
      findtime: custom.findtime,
    };
    void state.applyFail2banCustom(payload).catch(() => {
      // BUG-16 mirror: revert optimistic selection on backend failure.
      setSelectedPreset(null);
    });
  };

  // Custom radio handler: when user explicitly picks "Своя конфигурация",
  // open Accordion + flip optimistic override so UI reflects custom mode
  // immediately (without waiting for any backend invoke — values stay
  // whatever was last applied; user must explicitly hit Apply).
  const handlePickCustom = () => {
    setSelectedPreset("custom");
  };

  return (
    <div className="space-y-3" data-testid="fail2ban-settings-tab">
      <fieldset
        className="space-y-2"
        aria-label={t("server.security.fail2ban.tabs.settings")}
      >
        {(["soft", "balanced", "strict"] as const).map((presetId) => {
          const isActive = activePreset === presetId;
          return (
            <label
              key={presetId}
              className={cn(
                "flex items-start gap-3 p-3 rounded-[var(--radius-md)] cursor-pointer",
                "border transition-colors",
                isActive
                  ? "border-[var(--color-accent-interactive)] bg-[var(--color-accent-tint-08)]"
                  : "border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]",
                anyPresetBusy && "opacity-60",
              )}
            >
              <input
                type="radio"
                name="fail2ban-preset"
                value={presetId}
                checked={isActive}
                onChange={() => void handleApplyPreset(presetId)}
                disabled={anyPresetBusy}
                className="mt-1"
                data-testid={`preset-radio-${presetId}`}
              />
              <div className="flex-1">
                <div className="text-body font-medium">
                  {t(`server.security.fail2ban.presets.${presetId}`)}
                </div>
                <div
                  className="text-caption"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {t(`server.security.fail2ban.presets.${presetId}_help`)}
                </div>
              </div>
            </label>
          );
        })}

        {/* P0-1 #J — 4-й radio "Своя конфигурация". Когда detected/selected = "custom",
            radio checked + Accordion auto-opens (defaultOpen prop ниже).
            Backend НЕ invoked при выборе — пользователь должен явно нажать
            Apply внутри Accordion. */}
        <label
          key="custom"
          className={cn(
            "flex items-start gap-3 p-3 rounded-[var(--radius-md)] cursor-pointer",
            "border transition-colors",
            activePreset === "custom"
              ? "border-[var(--color-accent-interactive)] bg-[var(--color-accent-tint-08)]"
              : "border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]",
            anyPresetBusy && "opacity-60",
          )}
        >
          <input
            type="radio"
            name="fail2ban-preset"
            value="custom"
            checked={activePreset === "custom"}
            onChange={handlePickCustom}
            disabled={anyPresetBusy}
            className="mt-1"
            data-testid="preset-radio-custom"
          />
          <div className="flex-1">
            <div className="text-body font-medium">
              {t("server.security.fail2ban.presets.custom")}
            </div>
            <div
              className="text-caption"
              style={{ color: "var(--color-text-muted)" }}
            >
              {t("server.security.fail2ban.presets.custom_help")}
            </div>
          </div>
        </label>
      </fieldset>

      {/* P UAT 2026-05-04: Accordion убран. Custom-mode fields появляются
          inline ТОЛЬКО когда выбран radio «Своя конфигурация». При выборе
          soft/balanced/strict — fields скрыты совсем (Accordion не нужен,
          лишний level wrapper). Input primitive вместо raw `<input>`:
          корректный focus ring, theme-aware colors, no browser default
          thick blue outline. */}
      {activePreset === "custom" && (
        <div
          className="space-y-3 pt-2 pl-4"
          style={{
            borderLeft: "2px solid var(--color-accent-interactive)",
          }}
          data-testid="custom-fields-section"
        >
          {isCustomDirty && (
            <p
              className="text-caption flex items-center gap-1.5"
              style={{ color: "var(--color-status-warning)" }}
            >
              <span
                aria-hidden="true"
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: "var(--color-status-warning)" }}
                data-testid="custom-dirty-indicator"
              />
              {t("server.security.fail2ban.custom_dirty_aria")}
            </p>
          )}
          <div>
            <label
              htmlFor={`${idPrefix}-maxretry`}
              className="text-body-sm font-medium block mb-1"
            >
              {t("server.security.fail2ban.custom_maxretry_label")}
            </label>
            <Input
              id={`${idPrefix}-maxretry`}
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              fullWidth={false}
              value={custom.maxretry}
              onChange={(e) =>
                setCustom({ ...custom, maxretry: e.target.value })
              }
              className="w-32"
              data-testid="custom-maxretry-input"
            />
            <p
              className="text-caption mt-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              {t("server.security.fail2ban.custom_maxretry_help")}
            </p>
          </div>
          <div>
            <label
              htmlFor={`${idPrefix}-bantime`}
              className="text-body-sm font-medium block mb-1"
            >
              {t("server.security.fail2ban.custom_bantime_label")}
            </label>
            <Input
              id={`${idPrefix}-bantime`}
              type="number"
              inputMode="numeric"
              min={1}
              max={86400}
              fullWidth={false}
              value={custom.bantime}
              onChange={(e) => setCustom({ ...custom, bantime: e.target.value })}
              className="w-32"
              data-testid="custom-bantime-input"
            />
            <p
              className="text-caption mt-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              {t("server.security.fail2ban.custom_bantime_help")}
            </p>
          </div>
          <div>
            <label
              htmlFor={`${idPrefix}-findtime`}
              className="text-body-sm font-medium block mb-1"
            >
              {t("server.security.fail2ban.custom_findtime_label")}
            </label>
            <Input
              id={`${idPrefix}-findtime`}
              type="number"
              inputMode="numeric"
              min={1}
              max={86400}
              fullWidth={false}
              value={custom.findtime}
              onChange={(e) => setCustom({ ...custom, findtime: e.target.value })}
              className="w-32"
              data-testid="custom-findtime-input"
            />
            <p
              className="text-caption mt-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              {t("server.security.fail2ban.custom_findtime_help")}
            </p>
          </div>
          {/* BUG-05 fix: validation error inline под inputs */}
          {customError && (
            <p
              className="text-caption"
              style={{ color: "var(--color-status-danger)" }}
              role="alert"
              data-testid="custom-validation-error"
            >
              {customError}
            </p>
          )}
          <Button
            onClick={handleApplyCustom}
            loading={state.isBusy("f2b-preset-custom")}
            disabled={state.isBusy("f2b-preset-custom")}
            variant="primary"
            size="sm"
            data-testid="apply-custom-button"
          >
            {t("server.security.fail2ban.custom_apply_button")}
          </Button>
        </div>
      )}
    </div>
  );
}
