import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  FAIL2BAN_PRESETS,
  type Fail2banPresetId,
  type SecurityState,
} from "./useSecurityState";
import { Button } from "../../shared/ui/Button";
import { Accordion } from "../../shared/ui/Accordion";
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
}

export function Fail2banSettingsTab({ state, jail }: Fail2banSettingsTabProps) {
  const { t } = useTranslation();
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
    const matched = Object.entries(FAIL2BAN_PRESETS).find(
      ([, cfg]) =>
        cfg.maxretry === jail.maxretry &&
        cfg.bantime === jail.bantime &&
        cfg.findtime === jail.findtime,
    );
    return matched ? (matched[0] as Fail2banPresetId) : "custom";
  }, [jail]);

  const activePreset = selectedPreset ?? detectedPreset;

  // Custom NumberInput draft. Synced на jail primitive changes — позволяет
  // user редактировать draft, но при backend refresh подтягивает actual
  // values как baseline.
  const [custom, setCustom] = useState({
    maxretry: jail?.maxretry ?? 5,
    bantime: jail?.bantime ?? "600",
    findtime: jail?.findtime ?? "600",
  });

  // External sync: jail config refreshes (backend reload after preset apply)
  // → mirror values into draft state. Pattern allows user editing without
  // losing pending edits on background refresh.
  useEffect(() => {
    if (!jail) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mirror of jail config primitives into draft state on backend refresh
    setCustom({
      maxretry: jail.maxretry,
      bantime: jail.bantime,
      findtime: jail.findtime,
    });
  }, [jail]);

  // Clear optimistic override when jail catches up to selected — synchronously
  // обновляем чтобы radio reflected real backend state на том же frame.
  useEffect(() => {
    if (selectedPreset && detectedPreset === selectedPreset) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- post-apply sync: backend caught up to optimistic selection, clear override on the same frame so derived state takes over
      setSelectedPreset(null);
    }
  }, [detectedPreset, selectedPreset]);

  const handleApplyPreset = (preset: keyof typeof FAIL2BAN_PRESETS) => {
    setSelectedPreset(preset);
    void state.applyFail2banPreset(preset);
  };

  const handleApplyCustom = () => {
    setSelectedPreset("custom");
    void state.applyFail2banCustom(custom);
  };

  return (
    <div className="space-y-3" data-testid="fail2ban-settings-tab">
      <fieldset
        className="space-y-2"
        aria-label={t("server.security.fail2ban.tabs.settings")}
      >
        {(["soft", "balanced", "strict"] as const).map((presetId) => {
          const isActive = activePreset === presetId;
          const isBusy = state.isBusy(`f2b-preset-${presetId}`);
          return (
            <label
              key={presetId}
              className={cn(
                "flex items-start gap-3 p-3 rounded-[var(--radius-md)] cursor-pointer",
                "border transition-colors",
                isActive
                  ? "border-[var(--color-accent-interactive)] bg-[var(--color-accent-tint-08)]"
                  : "border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]",
              )}
            >
              <input
                type="radio"
                name="fail2ban-preset"
                value={presetId}
                checked={isActive}
                onChange={() => handleApplyPreset(presetId)}
                disabled={isBusy}
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
      </fieldset>

      <Accordion
        items={[
          {
            id: "custom-mode",
            title: t("server.security.fail2ban.custom_title"),
            content: (
              <div className="space-y-3 pt-2">
                <div>
                  <label
                    htmlFor="f2b-maxretry"
                    className="text-body-sm font-medium block mb-1"
                  >
                    {t("server.security.fail2ban.custom_maxretry_label")}
                  </label>
                  <input
                    id="f2b-maxretry"
                    type="number"
                    min={1}
                    max={1000}
                    value={custom.maxretry}
                    onChange={(e) =>
                      setCustom({
                        ...custom,
                        maxretry: parseInt(e.target.value, 10) || 5,
                      })
                    }
                    className="w-24 px-3 py-2 rounded-[var(--radius-md)] border bg-[var(--color-input-bg)] text-mono-sm"
                    style={{ borderColor: "var(--color-input-border)" }}
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
                    htmlFor="f2b-bantime"
                    className="text-body-sm font-medium block mb-1"
                  >
                    {t("server.security.fail2ban.custom_bantime_label")}
                  </label>
                  <input
                    id="f2b-bantime"
                    type="number"
                    min={1}
                    max={86400}
                    value={custom.bantime}
                    onChange={(e) =>
                      setCustom({ ...custom, bantime: e.target.value })
                    }
                    className="w-24 px-3 py-2 rounded-[var(--radius-md)] border bg-[var(--color-input-bg)] text-mono-sm"
                    style={{ borderColor: "var(--color-input-border)" }}
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
                    htmlFor="f2b-findtime"
                    className="text-body-sm font-medium block mb-1"
                  >
                    {t("server.security.fail2ban.custom_findtime_label")}
                  </label>
                  <input
                    id="f2b-findtime"
                    type="number"
                    min={1}
                    max={86400}
                    value={custom.findtime}
                    onChange={(e) =>
                      setCustom({ ...custom, findtime: e.target.value })
                    }
                    className="w-24 px-3 py-2 rounded-[var(--radius-md)] border bg-[var(--color-input-bg)] text-mono-sm"
                    style={{ borderColor: "var(--color-input-border)" }}
                    data-testid="custom-findtime-input"
                  />
                  <p
                    className="text-caption mt-1"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {t("server.security.fail2ban.custom_findtime_help")}
                  </p>
                </div>
                <Button
                  onClick={handleApplyCustom}
                  loading={state.isBusy("f2b-preset-custom")}
                  disabled={state.isBusy("f2b-preset-custom")}
                  variant="secondary"
                  data-testid="apply-custom-button"
                >
                  {t("server.security.fail2ban.custom_apply_button")}
                </Button>
              </div>
            ),
          },
        ]}
        defaultOpen={activePreset === "custom" ? ["custom-mode"] : []}
      />
    </div>
  );
}
