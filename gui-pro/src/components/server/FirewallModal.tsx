import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Shield, Trash2, Plus, Loader2 } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { Select } from "../../shared/ui/Select";
import { useConfirm } from "../../shared/ui/useConfirm";
import type { SecurityState } from "./useSecurityState";

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
  /**
   * P UAT 2026-05-04 — parent reload callback. Без этого SecuritySection
   * card 1 + Overview tab security card остаются stale после toggle/add/
   * delete actions. SecuritySection wires это к `security.load`.
   */
  onSecurityChanged?: () => void | Promise<void>;
}

export function FirewallModal({ isOpen, onClose, state, onSecurityChanged }: FirewallModalProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const fwInstalled = state.status?.firewall.installed ?? false;
  const fwActive = state.status?.firewall.active ?? false;
  const rules = state.status?.firewall.rules ?? [];

  // T-03 — initial focus is now owned by the Modal primitive (09-05): on open
  // it focuses the first focusable inside the content box (the canonical close
  // button). The hand-rolled auto-focus effect + ref were removed in 09-23 when
  // this modal adopted Modal's showCloseButton.

  // UAT 2026-05-20 — refresh rules on every open.
  //
  // Without this, `state.status` is loaded once when ServerPanel mounts and is
  // never refetched. If something outside Firewall UI mutates ufw (e.g. MTProto
  // install runs `ufw allow {port}/tcp`), the rules list shown in this modal
  // keeps the stale snapshot from initial load. Calling state.load() on every
  // open ensures the user always sees ground truth.
  //
  // UAT-F11 (09-25): gate the fetch on `fwActive`. While the firewall is
  // inactive the rules list is hidden behind the amber "disabled" plate, so
  // loading rules on open is wasted work — and it would just repeat once the
  // user enables the firewall (which triggers its own reload). Only fetch when
  // the firewall is active and the rules are actually shown.
  //
  // WR-03: depend on `fwActive` too. Previously this was keyed on `[isOpen]`
  // only, so if the modal was open while the user enabled the firewall
  // (inactive→active mid-session), the effect did NOT re-run and the rules
  // table relied entirely on `startFirewall` triggering its own reload — an
  // undocumented cross-dependency. Re-running on the fwActive edge makes the
  // "fetch when active and rules are shown" guarantee self-contained while the
  // `!isOpen` guard keeps the open-edge intent (no fetch while closed).
  useEffect(() => {
    if (!isOpen || !fwActive) return;
    void state.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isOpen/fwActive are the edges; state.load is stable
  }, [isOpen, fwActive]);

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

  // P UAT 2026-05-03 — FirewallModal — single source of confirm UX.
  // Hook-internal confirms removed (см. useSecurityState.ts comment) so this
  // is the ONLY confirm dialog в toggle flow. install/disable get explicit
  // user-facing copy tuned для брандмауэр терминологии.
  const handleToggle = async () => {
    if (!fwInstalled) {
      // Install — confirm с user-facing summary (firewall = high-stakes,
      // меняет inbound traffic policy сервера сразу).
      const ok = await confirm({
        title: t("server.security.firewall.install_confirm_title"),
        message: t("server.security.firewall.install_confirm_message", {
          ssh: state.status?.firewall.current_ssh_port ?? "22",
        }),
        variant: "warning",
        confirmText: t("server.security.firewall.action_install"),
      });
      if (!ok) return;
      // P UAT 2026-05-04: trigger parent reload (Overview/SecuritySection cards)
      // после успешной операции. `state.load` уже вызывается внутри hook'а
      // через `run()` — но не информирует ВНЕШНЮЮ кэш-точку (Overview).
      await state.installFirewall();
      void onSecurityChanged?.();
      return;
    }
    if (fwActive) {
      const ok = await confirm({
        title: t("server.security.firewall.toggle_disable_confirm_title"),
        message: t("server.security.firewall.toggle_disable_confirm_message"),
        variant: "danger",
        confirmText: t("server.security.firewall.action_disable"),
      });
      if (!ok) return;
      await state.stopFirewall();
      void onSecurityChanged?.();
    } else {
      // Enable — instant, никаких confirm (включение безопасно).
      await state.startFirewall();
      void onSecurityChanged?.();
    }
  };

  // P UAT 2026-05-03 — Per-row delete confirm moved here (hook больше не делает).
  const handleDeleteRule = async (n: number) => {
    const ok = await confirm({
      title: t("server.security.firewall.delete_rule_confirm_title"),
      message: t("server.security.firewall.delete_rule_confirm_message", { n }),
      variant: "danger",
      confirmText: t("buttons.delete"),
    });
    if (!ok) return;
    await state.deleteRule(n);
    void onSecurityChanged?.();
  };

  // SACRED SSH PORT (post-UAT brick fix): the rule for the port THIS session rides on
  // must never be deletable — deleting it (with ufw default-deny) locks the admin out
  // entirely (no app, no terminal). The backend also refuses it (SECURITY_UFW_REFUSE_
  // DELETE_SSH); disabling the trash here hides the trap so the user never triggers it.
  const sshPortStr = String(state.status?.firewall?.current_ssh_port ?? "");
  const isSshRule = (to: string) => {
    if (sshPortStr === "") return false;
    const base = to.split("/")[0];
    const lower = base.toLowerCase();
    // `ufw allow OpenSSH`/`ssh` app profile opens port 22 (Fable HIGH-1).
    if ((lower === "openssh" || lower === "ssh") && sshPortStr === "22") return true;
    if (base === sshPortStr) return true;
    // Port range a:b that contains the SSH port.
    const [a, b] = base.split(":");
    if (b !== undefined) {
      const lo = Number(a), hi = Number(b), p = Number(sshPortStr);
      if (Number.isFinite(lo) && Number.isFinite(hi)) return lo <= p && p <= hi;
    }
    return false;
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      showCloseButton
      // a11y (review a11y-3): Modal applies an unconditional focus-trap, so the
      // trapped container must be announced as a NAMED dialog (role + accessible
      // name via aria-labelledby → the visible <h2>). Mirrors UserModal.
      role="dialog"
      ariaModal
      ariaLabelledby="firewall-modal-title"
    >
      <div className="flex items-center gap-2 mb-3">
        <Shield
          className="w-5 h-5"
          style={{ color: "var(--color-accent-interactive)" }}
          aria-hidden="true"
        />
        <h2 id="firewall-modal-title" className="text-title">{t("server.security.firewall.modal_title")}</h2>
      </div>

      {/* Section 1 — Toggle UFW (D-3.3) — P0-4 #O ФИКС:
          Разделили статус (StatusIndicator pill) и действие (Button с явным
          imperative label «Включить» / «Отключить» / «Установить»). Старый
          single-button-показывал-status-как-label был anti-pattern: пользователь
          видел кнопку «Активен» и не понимал что click отключит. */}
      {/* P UAT 2026-05-04 fix: dot indicator убран — он только для табы
          «Безопасность» (summary cards). В Modal'е достаточно текста.
          Status text окрашен в соответствующий semantic color. */}
      <div
        className="flex items-center justify-between gap-3 py-2 border-b"
        style={{ borderColor: "var(--color-border)" }}
        data-testid="ufw-toggle-row"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-body-sm" style={{ color: "var(--color-text-secondary)" }}>
            {t("server.security.firewall.state_label")}
          </span>
          <span
            className="text-body-sm font-medium"
            style={{
              color: fwActive
                ? "var(--color-status-connected)"
                : !fwInstalled
                  ? "var(--color-status-error)"
                  : "var(--color-status-warning)",
            }}
            data-testid="ufw-state-text"
          >
            {fwActive
              ? t("server.security.summary.status_active")
              : !fwInstalled
                ? t("server.security.summary.status_not_installed")
                : t("server.security.summary.status_inactive")}
          </span>
        </div>
        {/* When installed, the enable/disable action lives here in the status row.
            The INSTALL action (not-installed) moved to the bottom footer (owner UAT) —
            unified with MtProto / Fail2ban so the install CTA is always at the bottom. */}
        {fwInstalled && (
          <Button
            variant={fwActive ? "secondary" : "primary"}
            size="sm"
            onClick={handleToggle}
            loading={state.fwBusy}
            disabled={state.fwBusy}
            data-testid="ufw-toggle-button"
          >
            {fwActive
              ? t("server.security.firewall.action_disable")
              : t("server.security.firewall.action_enable")}
          </Button>
        )}
      </div>

      {/* Section 2 — Rules table (D-3.1) */}
      <h3 className="text-subtitle mt-4 mb-2">
        {t("server.security.firewall.modal_summary_title")}
      </h3>
      {state.loading ? (
        /* UAT 2026-05-20 — visual feedback for refresh-on-open.
           Without this the user sees stale rules → fresh rules without any
           cue that data was refetched. The spinner is the loader-skeleton
           equivalent for the rules table. */
        <div
          className="py-6 flex items-center justify-center gap-2 text-body-sm"
          style={{ color: "var(--color-text-muted)" }}
          data-testid="rules-loading"
          aria-live="polite"
        >
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{t("server.security.firewall.loading_rules")}</span>
        </div>
      ) : !fwInstalled ? (
        <div
          className="py-3 text-center text-body-sm"
          style={{ color: "var(--color-text-muted)" }}
          data-testid="rules-empty"
        >
          {t("server.security.firewall.not_installed")}
        </div>
      ) : !fwActive ? (
        // P UAT 2026-05-03 fix: rules скрыты пока UFW выключен (backend
        // парсит `ufw status numbered` только когда active). Объясняем
        // пользователю что правила НЕ удалены, они применятся при включении.
        <div
          className="py-3 text-body-sm rounded-[var(--radius-md)] border"
          style={{
            color: "var(--color-text-secondary)",
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-warning-tint-08)",
            padding: "12px 16px",
          }}
          data-testid="rules-hidden-inactive"
        >
          {t("server.security.firewall.rules_hidden_inactive")}
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
              {/* P1-8 #P — UFW raw output («ALLOW IN» / «DENY IN» / «REJECT IN»)
                  заменён на RU-friendly labels через translateAction(). Direction
                  IN остаётся implicit (input rules — стандарт). */}
              <span
                className="px-1.5 py-0.5 rounded text-center"
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
                {r.action.startsWith("ALLOW")
                  ? t("server.security.firewall.action_label_allow")
                  : r.action.startsWith("REJECT")
                    ? t("server.security.firewall.action_label_reject")
                    : r.action.startsWith("DENY")
                      ? t("server.security.firewall.action_label_deny")
                      : r.action}
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
                onClick={() => void handleDeleteRule(r.number)}
                disabled={state.loading || state.fwWriting || isSshRule(r.to)}
                className="justify-self-end p-1 rounded hover:bg-[var(--color-bg-secondary)] disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed"
                title={isSshRule(r.to) ? t("server.security.firewall.delete_ssh_protected") : t("server.security.firewall.delete")}
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

      {/* Section 3 — Add Rule (D-3.2). P UAT 2026-05-03 fix: показываем
          «Add rule» button только когда UFW active. Backend `ufw allow ...`
          accept'ит правило когда disabled тоже, но они НЕ отображаются в
          rules table (parse_ufw_status пропускает при !active). User
          добавляет → не видит → думает что не сработало. Решение: disable
          add'а пока user не enable'нул UFW. */}
      {fwInstalled && fwActive && (
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
                  {/* BUG-07 fix: hardcoded English labels → i18n keys.
                      Existing rules-table column already uses RU labels
                      via action_label_allow/_deny/_reject; form was оставшийся
                      English leak. */}
                  <Select
                    value={state.newRule.action}
                    onChange={(e) =>
                      state.setNewRule({ ...state.newRule, action: e.target.value })
                    }
                    options={[
                      { value: "allow", label: t("server.security.firewall.action_label_allow") },
                      { value: "deny", label: t("server.security.firewall.action_label_deny") },
                      { value: "limit", label: t("server.security.firewall.action_label_limit") },
                      { value: "reject", label: t("server.security.firewall.action_label_reject") },
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
              {/* Modal-footer standard (09-25, owner §6): «Отмена» (ghost)
                  LEFT, «Добавить правило» (primary) RIGHT, content-width. */}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => state.setShowAddRule(false)}
                  data-testid="add-rule-cancel"
                >
                  {t("buttons.cancel")}
                </Button>
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
              </div>
            </div>
          )}
        </>
      )}

      {/* Install CTA — modal-footer standard (owner UAT): bottom-right, unified with
          MtProtoModal / Fail2banModal so the install button is always in the same place. */}
      {!fwInstalled && (
        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="primary"
            size="sm"
            onClick={handleToggle}
            loading={state.fwBusy}
            disabled={state.fwBusy}
            data-testid="ufw-toggle-button"
          >
            {t("server.security.firewall.action_install")}
          </Button>
        </div>
      )}
    </Modal>
  );
}
