/* eslint-disable react-refresh/only-export-components -- module-level configTabDirtyRef preserved для ServerTabs navigate-away guard backwards-compat (всегда false в raw-view режиме). */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openExternalUrl } from "@tauri-apps/plugin-shell";
import { ExternalLink, AlertCircle, RotateCcw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Skeleton } from "../../shared/ui/Skeleton";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { cn } from "../../shared/lib/cn";

import { LazyAccordionSection } from "./config/LazyAccordionSection";
import type { SshParams } from "./config/useTomlConfigState";
import type { ConfigBundle } from "./config/types";

/**
 * Phase 15.1 (raw-view) — Configuration tab.
 *
 * UAT feedback (2026-04-28): schema-driven парсинг был слишком агрессивным —
 * пользователь хочет видеть raw TOML файлы как технический лог. Каждый аккордеон
 * показывает содержимое одного файла как `<pre className="text-mono">`.
 *
 * Schema-driven компоненты (SchemaFieldRenderer, QuickSettingsCard, useTomlConfigState
 * с dirty-tracking, SaveFlowDialog) пока сохранены в кодовой базе для будущей
 * итерации, но не используются здесь — этот orchestrator делает один invoke
 * и рендерит raw content.
 *
 * Storybook escape hatch (D-PRE-4 single Screen story):
 *   - _storybook flag bypasses real invoke + uses _mockBundle
 *   - _forceLoading shows skeleton
 *   - _forceError shows error state
 */

/** Module-level ref for ServerTabs navigate-away guard. Raw-view режим = always false. */
export const configTabDirtyRef: { current: boolean } = { current: false };

export interface ConfigurationTabProps {
  sshParams: SshParams;
  /** Switch active tab — preserved для cross-tab navigation API stability. */
  onNavigateToTab: (tabId: "users") => void;
  /**
   * UAT-F01: refresh signal threaded from useServerState.configEpoch. Bumped by
   * UsersSection on user add/delete; when it changes the tab silently re-reads
   * credentials.toml + rules.toml so the new/removed user shows up live without
   * a reconnect. Default 0 keeps the prop optional for Storybook/tests.
   */
  configEpoch?: number;
  // Storybook escape hatches:
  _storybook?: boolean;
  _mockBundle?: ConfigBundle;
  _forceLoading?: boolean;
  _forceError?: string;
}

const MASK_PASSWORD_LINE = /^(\s*password\s*=\s*)("[^"]*"|'[^']*'|\S+)/m;

/** D-29 / D-11.1: маскирует password строки в credentials.toml для display. */
function maskCredentialsToml(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(MASK_PASSWORD_LINE, '$1"••••••••"'))
    .join("\n");
}

export function ConfigurationTab({
  sshParams,
  onNavigateToTab,
  configEpoch = 0,
  _storybook,
  _mockBundle,
  _forceLoading,
  _forceError,
}: ConfigurationTabProps) {
  const { t } = useTranslation();
  const { log: activityLog } = useActivityLog();

  const [fetchedBundle, setFetchedBundle] = useState<ConfigBundle | null>(null);
  const [loading, setLoading] = useState<boolean>(!_storybook);
  const [error, setError] = useState<string | null>(null);

  // Live bundle: prop в Storybook, fetch state в production.
  const bundle = _storybook ? _mockBundle ?? null : fetchedBundle;

  // H-1 (Plan 15): single cancellation token OWNED by the mount-load effect and
  // REUSED by the imperative reload() (Retry button). The audit found reload()
  // had no `cancelled` guard, unlike the effect — so a reload still in flight when
  // the user switched servers (sshParams change) or closed the tab (unmount)
  // could resolve late and overwrite the fresher state with stale data from the
  // OLD server. Both loaders now share the SAME token: the effect cleanup flips
  // `current=true` on every sshParams change / unmount, dropping any in-flight
  // manual reload that was started against the previous server.
  const loadTokenRef = useRef<{ current: boolean }>({ current: false });

  // Shared loader so the mount effect and reload() apply byte-identical
  // resolve / cancel / finally semantics against the ACTIVE token.
  //
  // UAT-F01: `silent` skips the skeleton toggle (setLoading) so a background
  // refresh triggered by configEpoch does NOT flash the loading placeholders
  // over an already-rendered bundle — the accordions stay mounted and the
  // content is swapped in place once the fetch resolves. The owner explicitly
  // preferred this silent refresh. On a silent error we keep the existing
  // bundle visible (no error state) — the next non-silent load surfaces it.
  const runLoad = (token: { current: boolean }, silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    invoke<ConfigBundle>("server_get_config_bundle", { ...sshParams })
      .then((b) => {
        if (token.current) return;
        setFetchedBundle(b);
      })
      .catch((e) => {
        if (token.current) return;
        // Silent refresh: don't tear down the current view on a transient error.
        if (!silent) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!token.current && !silent) setLoading(false);
      });
  };

  useEffect(() => {
    if (_storybook) return;
    const token = { current: false };
    loadTokenRef.current = token;
    runLoad(token);
    return () => {
      token.current = true;
    };
    // runLoad closes over sshParams; the effect already re-runs on sshParams,
    // so re-creating runLoad each render is fine and keeps semantics in one place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshParams, _storybook]);

  const reload = () => {
    // Reuse the active effect token so the NEXT effect-cleanup (sshParams change /
    // unmount) cancels this manual reload too — the H-1 guard parity.
    runLoad(loadTokenRef.current);
  };

  // UAT-F01: re-read the bundle silently when configEpoch changes (UsersSection
  // bumps it on user add/delete). We track the previous value in a ref so the
  // initial mount — already covered by the sshParams effect above — does NOT
  // trigger a redundant second fetch; only an actual bump fires the refresh.
  const prevConfigEpochRef = useRef(configEpoch);
  useEffect(() => {
    if (_storybook) return;
    if (prevConfigEpochRef.current === configEpoch) return;
    prevConfigEpochRef.current = configEpoch;
    // Silent: reuse the active cancellation token (H-1 parity) and skip the
    // skeleton so the refresh is invisible per owner preference.
    runLoad(loadTokenRef.current, true);
    // runLoad closes over sshParams; configEpoch is the only trigger we want
    // here (sshParams changes are owned by the mount effect above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configEpoch, _storybook]);

  const handleNavigateToUsers = () => {
    activityLog("USER", "config.navigate.users", "ConfigurationTab");
    onNavigateToTab("users");
  };

  const handleDocsClick = () => {
    void openExternalUrl(
      "https://github.com/TrustTunnel/TrustTunnel/blob/master/CONFIGURATION.md",
    ).catch(() => {});
  };

  const finalLoading = _forceLoading ?? loading;
  const finalError = _forceError ?? error;

  if (finalLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton variant="line" width="100%" height={44} />
        <Skeleton variant="line" width="100%" height={44} />
        <Skeleton variant="line" width="100%" height={44} />
        <Skeleton variant="line" width="100%" height={44} />
      </div>
    );
  }

  if (finalError) {
    return (
      <EmptyState
        icon={<AlertCircle size={48} strokeWidth={1.5} />}
        heading={t("server.config.error_load", {
          defaultValue: "Не удалось загрузить конфигурацию",
        })}
        body={finalError}
        action={
          <Button variant="secondary" onClick={reload}>
            <RotateCcw size={16} className="mr-1.5" aria-hidden="true" />
            {t("errors.retry", { defaultValue: "Повторить" })}
          </Button>
        }
      />
    );
  }

  if (!bundle) return null;

  const files: Array<{
    name: string;
    title: string;
    content: string;
  }> = [
    { name: "vpn", title: "vpn.toml", content: bundle.vpnToml ?? "" },
    { name: "hosts", title: "hosts.toml", content: bundle.hostsToml ?? "" },
    {
      name: "credentials",
      title: "credentials.toml",
      content: maskCredentialsToml(bundle.credentialsToml ?? ""),
    },
    { name: "rules", title: "rules.toml", content: bundle.rulesToml ?? "" },
  ];

  return (
    <div className="flex flex-col gap-4">
      {files.map((file) => (
        <LazyAccordionSection key={file.name} title={file.title}>
          {file.content.trim().length === 0 ? (
            <p className="text-body-sm text-[var(--color-text-muted)] italic">
              {t("server.config.empty_file", {
                defaultValue: "Файл пуст",
              })}
            </p>
          ) : (
            <pre
              className={cn(
                "text-mono-sm whitespace-pre-wrap break-all",
                "p-3 rounded-[var(--radius-md)]",
                "bg-[var(--color-bg-surface)] border border-[var(--color-border)]",
                "text-[var(--color-text-primary)]",
              )}
            >
              {file.content}
            </pre>
          )}
          {file.name === "credentials" && (
            <div className="flex justify-end pt-3">
              <Button variant="ghost" size="sm" onClick={handleNavigateToUsers}>
                {t("server.config.edit_in_users", {
                  defaultValue: "Редактировать в Пользователях",
                })}
              </Button>
            </div>
          )}
        </LazyAccordionSection>
      ))}

      {/* Footer docs link */}
      <div className="flex justify-center pt-3">
        <button
          type="button"
          onClick={handleDocsClick}
          className={cn(
            "inline-flex items-center gap-1 text-body-sm text-[var(--color-text-muted)]",
            "hover:text-[var(--color-text-secondary)] transition-colors",
            "focus-visible:shadow-[var(--focus-ring)] outline-none rounded-sm",
          )}
        >
          {t("server.config.docs_link", {
            defaultValue: "Документация конфигурации",
          })}
          <ExternalLink size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
