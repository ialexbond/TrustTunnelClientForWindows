/* eslint-disable react-refresh/only-export-components -- module-level configTabDirtyRef preserved для ServerTabs navigate-away guard backwards-compat (всегда false в raw-view режиме). */
import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (_storybook) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load lifecycle for fetched bundle
    setLoading(true);
    setError(null);
    invoke<ConfigBundle>("server_get_config_bundle", { ...sshParams })
      .then((b) => {
        if (cancelled) return;
        setFetchedBundle(b);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sshParams, _storybook]);

  const reload = () => {
    setLoading(true);
    setError(null);
    invoke<ConfigBundle>("server_get_config_bundle", { ...sshParams })
      .then(setFetchedBundle)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

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
