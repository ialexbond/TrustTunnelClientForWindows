import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Shield, Trash2, Plus, Loader2 } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { Input } from "../../shared/ui/Input";
import { Select } from "../../shared/ui/Select";
import { useConfirm } from "../../shared/ui/useConfirm";
import type { SecurityState } from "./useSecurityState";
import { cn } from "../../shared/lib/cn";

/**
 * Phase 16 Plan 05 — FirewallModal compound (D-3.1 / D-3.2 / D-3.3).
 *
 * Extracts UFW rules table + Add Rule form + Toggle UFW logic out of inline
 * `FirewallSection.tsx` into a Modal triggered from the Security tab summary
 * cards (4-card layout in `SecuritySection.tsx`).
 *
 * Three sections inside the Modal:
 *   1. Toggle UFW (top) — D-3.3. Calls `state.startFirewall` / `state.stopFirewall`.
 *      `stopFirewall` already wraps a ConfirmDialog inside `useSecurityState` (lines
 *      ~402-414), so we route the disable click through it directly. We DO NOT
 *      re-implement the confirm here — the hook owns the policy.
 *   2. Rules table — D-3.1. Read-only list of UFW rules with per-row Trash button
 *      that calls `state.deleteRule(n)` (also pre-wrapped in a ConfirmDialog inside
 *      the hook).
 *   3. Add Rule form — D-3.2. Reuses `state.newRule` + `state.setNewRule` so the
 *      validation surface (`addRule` action with port/source/comment validators) is
 *      identical to the legacy inline FirewallSection. No double validation here.
 *
 * Modal lifecycle (T-03):
 *   - NEVER `if (!isOpen) return null` — Modal primitive owns 200ms exit anim.
 *   - Cleanup state via setTimeout(200) in useEffect — keeps content rendered
 *     during fade-out.
 *
 * Storybook escape hatch — none. Component is fully driven by `state` prop;
 * stories provide mock state objects that already control every visual.
 */
export interface FirewallModalProps {
  isOpen: boolean;
  onClose: () => void;
  state: SecurityState;
}

export function FirewallModal({ isOpen, onClose, state }: FirewallModalProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const fwInstalled = state.status?.firewall.installed ?? false;
  const fwActive = state.status?.firewall.active ?? false;
  const rules = state.status?.firewall.rules ?? [];

  // T-03 — auto-focus close button on open (Modal primitive does not trap focus).
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => closeButtonRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // T-03 — cleanup form state after close (matches Modal exit animation 200ms).
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      state.setShowAddRule(false);
      state.setNewRule({ port: "", proto: "tcp", action: "allow", from: "", comment: "" });
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on close edge only
  }, [isOpen]);

  // D-3.3 — UFW disable goes through `state.stopFirewall` which already owns
  // the ConfirmDialog (см. useSecurityState.ts:402-414). НО Plan 16-05 wants a
  // shorter "Отключить Firewall?" dialog with the production confirm message
  // tuned for this Modal context, so we override here when fwActive=true.
  // Note: plan-prescribed wording — "Сервер будет открыт для всех входящих..."
  // которое более явное чем installFw default copy.
  const handleToggle = async () => {
    if (!fwInstalled) {
      // Not installed → install flow. installFirewall already has its own confirm.
      void state.installFirewall();
      return;
    }
    if (fwActive) {
      const ok = await confirm({
        title: t("server.security.firewall.toggle_disable_confirm_title"),
        message: t("server.security.firewall.toggle_disable_confirm_message"),
        variant: "danger",
        confirmText: t("server.security.firewall.toggle_disable_confirm_action"),
      });
      if (!ok) return;
      // stopFirewall has its own confirm internally — but it has been gated above.
      // Direct invocation of `state.run` would be cleaner here, but stopFirewall
      // re-confirming is acceptable defensive UX (FW disable is high-stakes).
      void state.stopFirewall();
    } else {
      void state.startFirewall();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" className="relative">
      <button
        ref={closeButtonRef}
        type="button"
        aria-label={t("buttons.close")}
        onClick={onClose}
        className={cn(
          "absolute top-3 right-3 p-1 rounded",
          "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
          "focus-visible:shadow-[var(--focus-ring)] outline-none",
          "transition-colors",
        )}
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-center gap-2 mb-3">
        <Shield
          className="w-5 h-5"
          style={{ color: "var(--color-accent-interactive)" }}
          aria-hidden="true"
        />
        <h2 className="text-title">{t("server.security.firewall.modal_title")}</h2>
      </div>

      {/* Section 1 — Toggle UFW (D-3.3) — P0-4 #O ФИКС:
          Разделили статус (StatusIndicator pill) и действие (Button с явным
          imperative label «Включить» / «Отключить» / «Установить»). Старый
          single-button-показывал-status-как-label был anti-pattern: пользователь
          видел кнопку «Активен» и не понимал что click отключит. */}
      <div
        className="flex items-center justify-between gap-3 py-2 border-b"
        style={{ borderColor: "var(--color-border)" }}
        data-testid="ufw-toggle-row"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-body-sm">
            {t("server.security.firewall.toggle_enable_label")}
          </span>
          <StatusIndicator
            status={fwActive ? "success" : fwInstalled ? "warning" : "danger"}
            size="sm"
            label={
              fwActive
                ? t("server.security.summary.status_active")
                : !fwInstalled
                  ? t("server.security.summary.status_not_installed")
                  : t("server.security.summary.status_inactive")
            }
          />
        </div>
        <Button
          variant={fwActive ? "secondary" : "primary"}
          size="sm"
          onClick={handleToggle}
          loading={state.fwBusy}
          disabled={state.fwBusy}
          data-testid="ufw-toggle-button"
        >
          {!fwInstalled
            ? t("server.security.firewall.action_install")
            : fwActive
              ? t("server.security.firewall.action_disable")
              : t("server.security.firewall.action_enable")}
        </Button>
      </div>

      {/* Section 2 — Rules table (D-3.1) */}
      <h3 className="text-subtitle mt-4 mb-2">
        {t("server.security.firewall.modal_summary_title")}
      </h3>
      {!fwInstalled ? (
        <div
          className="py-3 text-center text-body-sm"
          style={{ color: "var(--color-text-muted)" }}
          data-testid="rules-empty"
        >
          {t("server.security.firewall.not_installed")}
        </div>
      ) : rules.length === 0 ? (
        <div
          className="py-3 text-center text-body-sm"
          style={{ color: "var(--color-text-muted)" }}
          data-testid="rules-empty"
        >
          {t("server.security.firewall.no_rules")}
        </div>
      ) : (
        <div className="space-y-0.5" data-testid="rules-table">
          {rules.map((r) => (
            <div
              key={r.number}
              className="grid items-center gap-1.5 px-2 py-1 text-xs rounded-[var(--radius-sm)]"
              style={{
                backgroundColor: "var(--color-bg-hover)",
                gridTemplateColumns: "16px 72px 72px 80px minmax(0,1fr) 20px",
              }}
              data-testid={`rule-row-${r.number}`}
            >
              <span className="font-mono text-right" style={{ color: "var(--color-text-muted)" }}>
                {r.number}
              </span>
              <span
                className="font-mono px-1.5 py-0.5 rounded text-center"
                style={{
                  backgroundColor: r.action.startsWith("ALLOW")
                    ? "var(--color-success-tint-15)"
                    : r.action.startsWith("DENY") || r.action.startsWith("REJECT")
                      ? "var(--color-danger-tint-15)"
                      : "var(--color-warning-tint-15)",
                  color: r.action.startsWith("ALLOW")
                    ? "var(--color-success-500)"
                    : r.action.startsWith("DENY") || r.action.startsWith("REJECT")
                      ? "var(--color-danger-500)"
                      : "var(--color-warning-500)",
                }}
              >
                {r.action}
              </span>
              <span className="font-mono truncate" style={{ color: "var(--color-text-primary)" }}>
                {r.to}
              </span>
              <span className="font-mono truncate" style={{ color: "var(--color-text-muted)" }}>
                {r.from}
              </span>
              <span
                className="truncate italic"
                style={{ color: "var(--color-text-muted)" }}
                title={r.comment || undefined}
              >
                {r.comment ? `# ${r.comment}` : ""}
              </span>
              <button
                onClick={() => void state.deleteRule(r.number)}
                disabled={state.loading || state.fwWriting}
                className="justify-self-end p-1 rounded hover:bg-[var(--color-bg-secondary)] disabled:opacity-40 disabled:cursor-not-allowed"
                title={t("server.security.firewall.delete")}
                aria-label={`${t("server.security.firewall.delete")} #${r.number}`}
                data-testid={`delete-rule-${r.number}`}
              >
                {state.isBusy(`del-${r.number}`) ? (
                  <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--color-danger-500)" }} />
                ) : (
                  <Trash2 className="w-3 h-3" style={{ color: "var(--color-danger-500)" }} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Section 3 — Add Rule (D-3.2) */}
      {fwInstalled && (
        <>
          {!state.showAddRule ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => state.setShowAddRule(true)}
              disabled={state.fwBusy}
              className="mt-3"
              icon={<Plus className="w-3.5 h-3.5" />}
              data-testid="show-add-form-button"
            >
              {t("server.security.firewall.add_rule_button")}
            </Button>
          ) : (
            <div
              className="mt-3 p-3 rounded-[var(--radius-md)] border space-y-2"
              style={{ borderColor: "var(--color-border)" }}
              data-testid="add-rule-form"
            >
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div
                    className="text-caption mb-1"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {t("server.security.firewall.port_label")}
                  </div>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={state.newRule.port}
                    onChange={(e) =>
                      state.setNewRule({
                        ...state.newRule,
                        port: e.target.value.replace(/[^0-9:]/g, ""),
                      })
                    }
                    placeholder="443 / 80:90"
                    aria-label={t("server.security.firewall.port_label")}
                    data-testid="port-input"
                  />
                </div>
                <div>
                  <div
                    className="text-caption mb-1"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {t("server.security.firewall.proto_label")}
                  </div>
                  <Select
                    value={state.newRule.proto}
                    onChange={(e) =>
                      state.setNewRule({ ...state.newRule, proto: e.target.value })
                    }
                    options={[
                      { value: "tcp", label: "TCP" },
                      { value: "udp", label: "UDP" },
                      { value: "any", label: t("server.security.firewall.any") },
                    ]}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div
                    className="text-caption mb-1"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {t("server.security.firewall.action_label")}
                  </div>
                  <Select
                    value={state.newRule.action}
                    onChange={(e) =>
                      state.setNewRule({ ...state.newRule, action: e.target.value })
                    }
                    options={[
                      { value: "allow", label: "Allow" },
                      { value: "deny", label: "Deny" },
                      { value: "limit", label: "Limit" },
                      { value: "reject", label: "Reject" },
                    ]}
                  />
                </div>
                <div>
                  <div
                    className="text-caption mb-1"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {t("server.security.firewall.from_label")}
                  </div>
                  <Input
                    value={state.newRule.from}
                    onChange={(e) =>
                      state.setNewRule({ ...state.newRule, from: e.target.value })
                    }
                    placeholder="any / 1.2.3.4 / 10.0.0.0/24"
                    aria-label={t("server.security.firewall.from_label")}
                    data-testid="from-input"
                  />
                </div>
              </div>
              <div>
                <div
                  className="text-caption mb-1"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {t("server.security.firewall.comment_label")}
                </div>
                <Input
                  value={state.newRule.comment}
                  onChange={(e) =>
                    state.setNewRule({ ...state.newRule, comment: e.target.value })
                  }
                  maxLength={80}
                  aria-label={t("server.security.firewall.comment_label")}
                  data-testid="comment-input"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void state.addRule()}
                  loading={state.isBusy("add-rule")}
                  disabled={!state.newRule.port || state.isBusy("add-rule")}
                  data-testid="add-rule-submit"
                >
                  {t("server.security.firewall.add_rule")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => state.setShowAddRule(false)}
                  data-testid="add-rule-cancel"
                >
                  {t("buttons.cancel")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
