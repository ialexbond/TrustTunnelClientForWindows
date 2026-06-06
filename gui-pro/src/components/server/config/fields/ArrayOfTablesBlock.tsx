import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Plus, List } from "lucide-react";
import { Button } from "../../../../shared/ui/Button";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Tooltip } from "../../../../shared/ui/Tooltip";
import { cn } from "../../../../shared/lib/cn";
import type { TomlFieldSchema } from "../types";

/**
 * Phase 15.1 D-5.1 + D-10.1 — array-of-tables renderer (inline cards).
 *
 * Layout per UI-SPEC §Layout hosts.toml:
 *   Each array element = inline Card with trash icon header + nested fields below.
 *   Empty array → EmptyState с "+Добавить" Button.secondary.
 *
 * Last-element guard (D-5.2):
 *   ONLY for main_hosts (matched by schema.key === "main_hosts"):
 *   When length === 1, trash icon disabled + tooltip "Сервер требует минимум 1 main host".
 *
 * NOTE: This component does NOT recursively render nested fields itself.
 * It exposes an onRenderEntry slot for parent (Plan 15.1-04 schema-builder)
 * to dispatch back through SchemaFieldRenderer for each entry's fields.
 * Decoupled to avoid circular import (SchemaFieldRenderer ←→ ArrayOfTablesBlock).
 */
export interface ArrayOfTablesBlockProps {
  schema: TomlFieldSchema;
  /** Called when add button clicked. Parent constructs empty entry shape from defaults map. */
  onAdd: (path: string[]) => void;
  /** Called when trash clicked. Parent removes entry at index. */
  onRemove: (path: string[], index: number) => void;
  /**
   * Render slot для каждой entry. Parent constructs nested SchemaFieldRenderer trees
   * для каждого поля entry. Receives entry index + raw entry data (Record<string, unknown>).
   */
  renderEntry: (index: number, entry: Record<string, unknown>) => ReactNode;
  disabled?: boolean;
}

export function ArrayOfTablesBlock({
  schema,
  onAdd,
  onRemove,
  renderEntry,
  disabled,
}: ArrayOfTablesBlockProps) {
  const { t } = useTranslation();

  if (schema.type.kind !== "array-of-tables") return null;

  const entries = schema.type.value;
  const isLastMainHost = schema.key === "main_hosts" && entries.length === 1;

  // Empty state per D-10.1
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<List size={32} />}
        heading={t("server.config.empty_array", { defaultValue: "Нет записей" })}
        body={t("server.config.empty_array_body", { defaultValue: "Добавьте первую запись." })}
        action={
          <Button variant="secondary" size="sm" onClick={() => onAdd(schema.path)} disabled={disabled}>
            <Plus size={16} className="mr-1" aria-hidden="true" />
            {t("common.add", { defaultValue: "Добавить" })}
          </Button>
        }
      />
    );
  }

  // Resolve display name для trash aria-label (hostname для hosts; index для rules)
  const getEntryName = (entry: Record<string, unknown>, idx: number): string => {
    if (typeof entry.hostname === "string" && entry.hostname.trim().length > 0) {
      return entry.hostname;
    }
    return `#${idx + 1}`;
  };

  const trashAriaLabel = (idx: number, name: string): string => {
    if (
      schema.key === "main_hosts" ||
      schema.key === "ping_hosts" ||
      schema.key === "speedtest_hosts" ||
      schema.key === "reverse_proxy_hosts"
    ) {
      return t("server.config.delete_host", {
        hostname: name,
        defaultValue: `Удалить host ${name}`,
      });
    }
    // D-03.1: the key interpolates {{index}} (was the buggy {{hostname}}, which
    // left the unnumbered "Удалить правило " label). Pass the 1-based rule number
    // so the trash button gains a NAMED accessible label "Удалить правило 1".
    return t("server.config.delete_rule", {
      index: idx + 1,
      defaultValue: `Удалить правило ${idx + 1}`,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry, idx) => {
        const name = getEntryName(entry, idx);
        const trashDisabled = !!disabled || (isLastMainHost && idx === 0);
        const trashButton = (
          <button
            type="button"
            onClick={() => onRemove(schema.path, idx)}
            disabled={trashDisabled}
            aria-label={trashAriaLabel(idx, name)}
            className={cn(
              "p-1 rounded-sm transition-opacity",
              "text-[var(--color-text-muted)] hover:text-[var(--color-destructive)]",
              "focus-visible:shadow-[var(--focus-ring)] outline-none",
              trashDisabled && "opacity-30 cursor-not-allowed"
            )}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        );

        return (
          <div
            key={`${schema.path.join(".")}-${idx}`}
            className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-sm)] p-3"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-body font-medium text-[var(--color-text-primary)]">
                {name}
              </span>
              {isLastMainHost && idx === 0 ? (
                <Tooltip
                  text={t("server.config.min_one_host", {
                    defaultValue: "Сервер требует минимум 1 main host",
                  })}
                  position="left"
                >
                  {trashButton}
                </Tooltip>
              ) : (
                trashButton
              )}
            </div>
            <div className="flex flex-col gap-3">{renderEntry(idx, entry)}</div>
          </div>
        );
      })}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onAdd(schema.path)}
        disabled={disabled}
      >
        <Plus size={16} className="mr-1" aria-hidden="true" />
        {t("common.add", { defaultValue: "Добавить" })}
      </Button>
    </div>
  );
}
