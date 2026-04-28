import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { Button } from "../../../shared/ui/Button";
import { Badge } from "../../../shared/ui/Badge";

/**
 * Phase 15.1 D-2.1 + D-11.1 + D-29 — credentials.toml read-only preview.
 *
 * Renders [[client]] entries as username + masked password (••••••••).
 * D-29 invariant: real password values stay в bundle.credentialsToml (in-memory),
 * but NEVER rendered в DOM text or activity log. Only mask shown.
 *
 * D-11.1: fully masked без reveal — для просмотра/редактирования password →
 * navigate-button «Редактировать в Пользователях» (D-2.1).
 *
 * Banner с button «Редактировать в Пользователях» triggers tab switch (D-2.1).
 * Tab switch via callback prop — ConfigurationTab passes through от ServerTabs context.
 */
export interface CredentialsPreviewProps {
  /** Parsed credentials.toml object — { client: [{ username, password }, ...] }. */
  parsed: Record<string, unknown> | null;
  /** Navigate to Users tab. */
  onNavigateToUsers: () => void;
}

export function CredentialsPreview({
  parsed,
  onNavigateToUsers,
}: CredentialsPreviewProps) {
  const { t } = useTranslation();

  const clients =
    (parsed?.client as Array<{ username?: string; password?: string }>) ?? [];

  return (
    <div className="flex flex-col gap-3">
      {/* Read-only banner */}
      <div
        role="region"
        aria-label={t("server.config.credentials_readonly_notice")}
        className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-bg-elevated)] border border-[var(--color-border)] p-3"
      >
        <div className="flex items-center gap-2">
          <Badge variant="neutral" size="sm">
            {t("server.config.readonly_label", {
              defaultValue: "ТОЛЬКО ЧТЕНИЕ",
            })}
          </Badge>
          <span className="text-body-sm text-[var(--color-text-secondary)]">
            {t("server.config.credentials_readonly_notice")}
          </span>
        </div>
        <Button variant="secondary" size="sm" onClick={onNavigateToUsers}>
          {t("server.config.edit_in_users")}
          <ArrowRight size={14} className="ml-1" aria-hidden="true" />
        </Button>
      </div>

      {/* Entries — read-only, masked */}
      {clients.length === 0 ? (
        <p className="text-body-sm text-[var(--color-text-muted)] py-2">
          {t("server.config.empty_credentials_body")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {clients.map((client, idx) => (
            <div
              key={idx}
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 bg-[var(--color-bg-surface)]"
            >
              <div className="flex flex-col gap-1">
                <span className="text-mono-sm text-[var(--color-text-secondary)]">
                  [[client]] #{idx + 1}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-mono text-[var(--color-text-secondary)] w-24">
                    username:
                  </span>
                  <span className="text-mono text-[var(--color-text-primary)]">
                    {client.username ?? ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-mono text-[var(--color-text-secondary)] w-24">
                    password:
                  </span>
                  {/* D-11.1 D-29: NEVER render real password value — hardcoded mask only. */}
                  <span className="text-mono text-[var(--color-text-muted)]">
                    ••••••••
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
