import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../shared/lib/cn";

/**
 * DnsUpstreamsInput — multi-line DNS upstream list input.
 *
 * User types one DNS server per line (IP or hostname).
 * Validation happens per-line; invalid entries are highlighted.
 * Empty lines are allowed (ignored on output).
 *
 * D-4: dns_upstreams (0x0D) field in deeplink TLV spec.
 *
 * Props:
 *   - value: string[] — array of DNS entries (processed)
 *   - onChange: (entries: string[]) — called with non-empty filtered lines
 *   - onError: (hasError: boolean) — called when any entry is invalid
 */

/** Validates a single DNS entry (IP or hostname, no shell metachar). */
function isValidDnsEntry(entry: string): boolean {
  if (!entry) return true; // empty lines are skipped, not invalid
  // Reject shell metacharacters (mirrors server-side validate_dns_list)
  if (/[;&|`$(){}[\]<>\\!#^~]/.test(entry)) return false;
  // Allow IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(entry)) {
    return entry.split(".").every((o) => {
      const n = Number(o);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  // Allow hostname (RFC 1035 subset: letters, digits, dots, hyphens)
  if (/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(entry)) return true;
  // Allow IPv4 with port: ip:port
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(entry)) return true;
  // Allow hostname:port
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*:\d+$/.test(entry)) return true;
  return false;
}

export interface DnsUpstreamsInputProps {
  /** Current DNS entries as array. */
  value: string[];
  /** Called when user changes entries — provides filtered non-empty array. */
  onChange: (entries: string[]) => void;
  /** Called when validation state changes (true = has invalid entries). */
  onError?: (hasError: boolean) => void;
  disabled?: boolean;
  label?: string;
  helperText?: string;
  className?: string;
}

export function DnsUpstreamsInput({
  value,
  onChange,
  onError,
  disabled = false,
  label,
  helperText,
  className,
}: DnsUpstreamsInputProps) {
  const { t } = useTranslation();

  // WR-06: keep a local `draft` so that empty lines (used for mid-text cursor support
  // and "press Enter to start a new line") are not lost on the next render. The
  // controlled `value` prop is filtered (no empty entries), so naively echoing
  // `value.join("\n")` back into the textarea would erase the trailing "\n" the
  // user just typed and snap the caret to the end of the previous line.
  //
  // Pattern: «Adjusting state when a prop changes» from React docs. We track the
  // last `value` we received in state and compare against the current prop in the
  // render body — when they differ we adopt the new array AND reset the draft.
  // When the parent simply echoes back our filtered `entries` (most common path
  // since we call onChange ourselves), the previous-value sentinel is updated to
  // the same reference inside handleChange, so this branch does not fire.
  const [draft, setDraft] = useState<string>(() => value.join("\n"));
  const [lastValueSeen, setLastValueSeen] = useState<string[]>(value);

  const externalChanged =
    value !== lastValueSeen &&
    (value.length !== lastValueSeen.length ||
      value.some((entry, i) => entry !== lastValueSeen[i]));
  if (externalChanged) {
    setLastValueSeen(value);
    setDraft(value.join("\n"));
  }

  // Parse textarea value → array (split by newline)
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const raw = e.target.value;
      setDraft(raw); // preserve empty / trailing lines locally
      // Split by newline; non-empty lines flow downstream (validators reject empty).
      const lines = raw.split("\n");
      const entries = lines.filter((l) => l.trim().length > 0).map((l) => l.trim());
      // Mark the value we are about to emit so the prop-sync branch above does
      // not re-overwrite our draft when the parent echoes it back.
      setLastValueSeen(entries);
      onChange(entries);

      // Validate non-empty lines
      if (onError) {
        const hasInvalid = lines.some((l) => l.trim().length > 0 && !isValidDnsEntry(l.trim()));
        onError(hasInvalid);
      }
    },
    [onChange, onError]
  );

  // Per-line validation for visual highlighting in helper text
  const invalidLines = useMemo(
    () =>
      value.filter((l) => l.trim().length > 0 && !isValidDnsEntry(l.trim())),
    [value]
  );

  const hasError = invalidLines.length > 0;
  const resolvedHelper = helperText ?? t("server.users.dns_upstreams_hint");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="block text-sm font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]">
          {label}
        </label>
      )}
      <textarea
        value={draft}
        onChange={handleChange}
        disabled={disabled}
        rows={4}
        placeholder="8.8.8.8&#10;1.1.1.1"
        aria-label={label ?? t("server.users.field_dns_upstreams")}
        aria-invalid={hasError}
        spellCheck={false}
        data-testid="dns-upstreams-textarea"
        className={cn(
          "w-full resize-y font-mono text-sm",
          "px-[var(--space-3)] py-[var(--space-2)]",
          "rounded-[var(--radius-md)] border",
          "bg-[var(--color-input-bg)]",
          "text-[var(--color-text-primary)]",
          "placeholder:text-[var(--color-text-muted)]",
          "outline-none transition-colors",
          hasError
            ? "border-[var(--color-status-error)] focus-visible:border-[var(--color-status-error)] focus-visible:shadow-[0_0_0_2px_var(--color-status-error-border)]"
            : "border-[var(--color-input-border)] focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)]",
          disabled && "opacity-[var(--opacity-disabled)] cursor-not-allowed",
        )}
      />
      {hasError ? (
        <p className="text-xs text-[var(--color-status-error)]" data-testid="dns-error">
          {t("server.users.dns_upstreams_hint")} — {invalidLines.join(", ")}
        </p>
      ) : resolvedHelper ? (
        <p className="text-xs text-[var(--color-text-muted)]">{resolvedHelper}</p>
      ) : null}
    </div>
  );
}

// Re-export validator for testing and parent components
// eslint-disable-next-line react-refresh/only-export-components
export { isValidDnsEntry };
