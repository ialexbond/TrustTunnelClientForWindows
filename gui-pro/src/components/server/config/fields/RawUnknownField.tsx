import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Input } from "../../../../shared/ui/Input";
import { Badge } from "../../../../shared/ui/Badge";
import type { TomlFieldSchema } from "../types";

/**
 * Phase 15.1 D-16.1 — Forward-compat field renderer.
 *
 * Renders unknown TOML fields (present в файле но отсутствуют в Plan 15.1-05
 * static defaults map) as raw editable Input + warning Badge "новое upstream
 * поле" с lucide AlertTriangle (D-16.1).
 * Tooltip отсутствует (no i18n key) — fallback message rendered как helper
 * caption под Input.
 *
 * Note: Lucide AlertTriangle renders с классом `lucide-triangle-alert` (NOT
 * `lucide-alert-triangle`) — verified via Phase 15-03 test selector finding.
 */
export interface RawUnknownFieldProps {
  schema: TomlFieldSchema;
  onChange: (path: string[], value: string) => void;
  disabled?: boolean;
}

export function RawUnknownField({ schema, onChange, disabled }: RawUnknownFieldProps) {
  const { t } = useTranslation();

  if (schema.type.kind !== "unknown") return null;

  const initialValue = schema.type.rawValue;

  const [localValue, setLocalValue] = useState<string>(initialValue);

  useEffect(() => {
    setLocalValue(schema.type.kind === "unknown" ? schema.type.rawValue : "");
  }, [schema.type]);

  const handleBlur = () => {
    if (localValue !== initialValue) {
      onChange(schema.path, localValue);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 flex-wrap">
        <span className="text-mono text-[var(--color-text-secondary)]">{schema.key}</span>
        <Badge variant="warning" size="sm">
          <AlertTriangle size={12} aria-hidden="true" />
          {t("server.config.unknown_field_badge", { defaultValue: "новое upstream поле" })}
        </Badge>
      </label>
      <Input
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={handleBlur}
        disabled={disabled}
      />
      <span className="text-caption text-[var(--color-text-muted)]">
        {t("server.config.unknown_field_desc", { defaultValue: "Нет описания — обновите GUI" })}
      </span>
    </div>
  );
}
