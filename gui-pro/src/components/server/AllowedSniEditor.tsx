import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { X, Loader2, Shield } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Input } from "../../shared/ui/Input";
import { Button } from "../../shared/ui/Button";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { validateFqdnSni } from "../../shared/utils/validators";
import { formatError } from "../../shared/utils/formatError";
import { cn } from "../../shared/lib/cn";
import type { SshParamsLite } from "./useVpnTomlState";

export interface AllowedSniHost {
  hostname: string;
  allowedSni: string[];
}

export interface AllowedSniEditorProps {
  /** Initial host data from useVpnTomlState.allowedSni. */
  hosts: AllowedSniHost[];
  /** SSH connection params for invoke calls. */
  sshParams: SshParamsLite;
  /**
   * Called after every optimistic local update with the new full hosts list
   * (consumer can update its parent state to keep useVpnTomlState in sync
   * without a full bundle refetch). On backend failure the rollback also
   * fires this callback so the parent's mirror state stays consistent.
   * If omitted, the editor still works fully but the parent's `hostsToml`
   * mirror may go stale until next refetch.
   */
  onHostsChange?: (next: AllowedSniHost[]) => void;
}

interface PerHostState {
  pendingValue: string;
  inlineError: string;
  saving: boolean;
  error: string | null;
}

const EMPTY_PER_HOST: PerHostState = {
  pendingValue: "",
  inlineError: "",
  saving: false,
  error: null,
};

/**
 * Phase 15 REQ-15.A — chip-list editor for [[main_hosts]] → allowed_sni.
 *
 * One Card+fieldset per host. Each fieldset:
 *   - header (legend) with hostname (mono font + Shield icon)
 *   - chip-rail of current allowed_sni (X to remove, aria-labelled per domain)
 *   - Add input + Add button (validated via validateFqdnSni from Plan 03)
 *   - inline error for validation/duplicate
 *   - per-host ErrorBanner if invoke fails (rollback already applied to chips)
 *
 * **Save flow:**
 *   1. User clicks Add (or X to remove) — local state updates optimistically
 *   2. invoke('server_update_hosts_allowed_sni', { hostname, allowedSni: nextList })
 *   3. On success — pushSnack(saved) + onHostsChange callback (with new list)
 *   4. On failure — rollback chip change + ErrorBanner inside fieldset
 *
 * **Last-SNI guard:** Removing the very last chip from a host's list opens
 * a ConfirmDialog warning that anti-DPI decoration will be disabled for
 * that host. Cancel keeps the chip and skips the invoke entirely.
 *
 * **Cross-cache awareness (Pitfall 5):** UserModal caches allowed_sni list
 * per-mount for Custom SNI autocomplete. Edits here don't invalidate that
 * cache automatically — accepted as documented limitation in 15-06-SUMMARY;
 * Tauri-event-driven invalidation is Phase 15.1+ scope.
 */
export function AllowedSniEditor({
  hosts,
  sshParams,
  onHostsChange,
}: AllowedSniEditorProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const pushSnack = useSnackBar();
  const { log } = useActivityLog();

  // Local optimistic state — keyed by hostname.
  const [localHosts, setLocalHosts] = useState<AllowedSniHost[]>(hosts);
  const [perHost, setPerHost] = useState<Record<string, PerHostState>>(() =>
    Object.fromEntries(
      hosts.map((h) => [h.hostname, { ...EMPTY_PER_HOST }] as const),
    ),
  );

  // Sync when parent passes a new `hosts` reference (e.g. after refetch).
  // Pattern: «Adjusting state when a prop changes» from React docs — the inline
  // setState during render is safe because it short-circuits via the reference
  // check, preventing an infinite loop. We additionally guard with a length
  // check so identical-shape refetches don't blow away pending pendingValue
  // strings the user may have typed.
  if (hosts !== localHosts && hosts.length !== localHosts.length) {
    setLocalHosts(hosts);
    setPerHost((prev) => {
      const next: Record<string, PerHostState> = {};
      for (const h of hosts) {
        next[h.hostname] = prev[h.hostname] ?? { ...EMPTY_PER_HOST };
      }
      return next;
    });
  }

  const updateHostState = (hostname: string, patch: Partial<PerHostState>) => {
    setPerHost((prev) => ({
      ...prev,
      [hostname]: { ...(prev[hostname] ?? EMPTY_PER_HOST), ...patch },
    }));
  };

  const updateLocalHostList = (hostname: string, nextSni: string[]) => {
    setLocalHosts((prev) => {
      const next = prev.map((h) =>
        h.hostname === hostname ? { ...h, allowedSni: nextSni } : h,
      );
      onHostsChange?.(next);
      return next;
    });
  };

  const persist = async (
    hostname: string,
    nextSni: string[],
    rollbackTo: string[],
  ) => {
    updateHostState(hostname, { saving: true, error: null });
    try {
      const idx = localHosts.findIndex((h) => h.hostname === hostname);
      log(
        "USER",
        `hosts.sni.save host=<idx-${idx}> count=${nextSni.length}`,
        "AllowedSniEditor.persist",
      );
      await invoke("server_update_hosts_allowed_sni", {
        ...(sshParams as unknown as Record<string, unknown>),
        hostname,
        allowedSni: nextSni,
      });
      pushSnack(t("server.config.saved"));
    } catch (e) {
      const msg = formatError(e);
      log(
        "ERROR",
        `hosts.sni.save.failed err="${msg.slice(0, 200)}"`,
        "AllowedSniEditor.persist",
      );
      // Rollback optimistic UI; parent mirror also restored via onHostsChange
      // inside updateLocalHostList so consumer state matches displayed UI.
      updateLocalHostList(hostname, rollbackTo);
      updateHostState(hostname, { error: msg });
    } finally {
      updateHostState(hostname, { saving: false });
    }
  };

  const handleAdd = async (hostname: string) => {
    const state = perHost[hostname] ?? EMPTY_PER_HOST;
    const trimmed = state.pendingValue.trim();
    if (!trimmed) {
      // Empty input — show generic format error. (Add button is also
      // disabled when pendingValue is empty, so this is defence-in-depth.)
      updateHostState(hostname, {
        inlineError: t("server.config.error_sni_format"),
      });
      return;
    }
    const errKey = validateFqdnSni(trimmed);
    if (errKey) {
      updateHostState(hostname, { inlineError: t(errKey) });
      return;
    }
    const host = localHosts.find((h) => h.hostname === hostname);
    if (!host) return;
    if (host.allowedSni.includes(trimmed)) {
      updateHostState(hostname, {
        inlineError: t("server.config.sni_duplicate"),
      });
      return;
    }
    // Optimistic add
    const previous = host.allowedSni;
    const next = [...previous, trimmed];
    updateLocalHostList(hostname, next);
    updateHostState(hostname, { pendingValue: "", inlineError: "" });
    await persist(hostname, next, previous);
  };

  const handleRemove = async (hostname: string, sni: string) => {
    const host = localHosts.find((h) => h.hostname === hostname);
    if (!host) return;
    const previous = host.allowedSni;
    const next = previous.filter((s) => s !== sni);

    // Last-SNI guard — server requires ≥1 SNI for anti-DPI decoration to
    // function; warn user before disabling it for this host.
    if (next.length === 0 && previous.length === 1) {
      const ok = await confirm({
        title: t("server.config.remove_last_sni_title"),
        message: t("server.config.remove_last_sni_message", { hostname }),
        variant: "warning",
        confirmText: t("buttons.confirm", "Удалить"),
        cancelText: t("buttons.cancel", "Отмена"),
      });
      if (!ok) return;
    }

    updateLocalHostList(hostname, next);
    await persist(hostname, next, previous);
  };

  // ─── Empty state ───────────────────────────────────────────────────
  if (localHosts.length === 0) {
    return (
      <Card>
        <CardHeader
          title={t("server.config.allowed_sni_label")}
          icon={<Shield className="w-3.5 h-3.5" />}
        />
        <div className="text-center py-[var(--space-6)] space-y-2">
          <p className="text-body text-[var(--color-text-secondary)]">
            {t("server.config.sni_empty")}
          </p>
          <p className="text-body-sm text-[var(--color-text-muted)]">
            {t("server.config.sni_empty_hint")}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="allowed-sni-editor">
      {localHosts.map((host, hostIdx) => {
        const state = perHost[host.hostname] ?? EMPTY_PER_HOST;
        return (
          <Card key={host.hostname}>
            <fieldset
              disabled={state.saving}
              className="space-y-3"
              data-testid={`sni-host-${host.hostname}`}
            >
              <legend className="inline-flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                <span className="text-mono text-[var(--color-text-primary)]">
                  {host.hostname}
                </span>
                {state.saving && (
                  <Loader2
                    className="w-3.5 h-3.5 animate-spin text-[var(--color-accent-interactive)]"
                    data-testid="saving-spinner"
                  />
                )}
              </legend>

              {/* Per-host error banner (rollback case) */}
              {state.error && (
                <ErrorBanner
                  severity="error"
                  message={t("server.config.error_save")}
                  onDismiss={() =>
                    updateHostState(host.hostname, { error: null })
                  }
                />
              )}

              {/* Chip rail */}
              <div
                className="flex flex-wrap gap-1.5"
                data-testid={`sni-chips-${host.hostname}`}
              >
                {host.allowedSni.length === 0 ? (
                  <span className="text-body-sm text-[var(--color-text-muted)]">
                    {t("server.config.sni_empty")}
                  </span>
                ) : (
                  host.allowedSni.map((sni) => (
                    <span
                      key={sni}
                      className={cn(
                        "inline-flex items-center gap-1.5",
                        "px-[var(--space-2)] py-1 rounded-[var(--radius-sm)]",
                        "text-body-sm font-mono",
                        "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]",
                        "border border-[var(--color-border)]",
                      )}
                    >
                      <span>{sni}</span>
                      <button
                        type="button"
                        onClick={() => void handleRemove(host.hostname, sni)}
                        aria-label={t("server.config.remove_sni", {
                          domain: sni,
                        })}
                        className={cn(
                          "p-0.5 rounded transition-colors",
                          "text-[var(--color-text-muted)]",
                          "hover:text-[var(--color-destructive)]",
                          "focus-visible:shadow-[var(--focus-ring)] outline-none",
                        )}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))
                )}
              </div>

              {/* Add input + button */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    value={state.pendingValue}
                    onChange={(e) =>
                      updateHostState(host.hostname, {
                        pendingValue: e.target.value,
                        inlineError: "",
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleAdd(host.hostname);
                      }
                    }}
                    placeholder={t("server.config.sni_placeholder")}
                    error={state.inlineError || undefined}
                    aria-label={t("server.config.allowed_sni_label")}
                    className="font-mono"
                    disabled={state.saving}
                  />
                </div>
                <Button
                  variant="primary"
                  onClick={() => void handleAdd(host.hostname)}
                  disabled={state.saving || !state.pendingValue.trim()}
                >
                  {t("common.add", "Добавить")}
                </Button>
              </div>

              {/* Hint shown once on the first host to avoid repetition */}
              {hostIdx === 0 && (
                <p className="text-body-sm text-[var(--color-text-muted)]">
                  ⓘ {t("server.config.allowed_sni_hint")}
                </p>
              )}
            </fieldset>
          </Card>
        );
      })}
    </div>
  );
}
