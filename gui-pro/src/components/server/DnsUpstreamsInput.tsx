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

/**
 * Validates a single DNS entry. Returns "" if valid or an i18n key describing
 * WHY it is invalid. Kept alongside the legacy boolean helper so existing
 * callers / tests don't break.
 *
 * WR-14.1-UAT-04: users complained that invalid entries were only flagged in
 * red with no explanation. Specific messages cover the common failure modes:
 * whitespace, Cyrillic/non-ASCII, shell metacharacters, and generic "not a
 * valid hostname or IP" fallback.
 */
function getDnsEntryError(entry: string): string {
  if (!entry) return ""; // empty lines are skipped
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(entry)) return "server.users.dns_err_non_ascii";
  if (/\s/.test(entry)) return "server.users.dns_err_whitespace";
  // Reject shell metacharacters (mirrors server-side validate_dns_list)
  if (/[;&|`$(){}[\]<>\\!#^~]/.test(entry)) return "server.users.dns_err_shell_chars";

  // Protocol-prefixed encrypted DNS (DoT / DoH / DoQ), stripped into host(+port) for the shape check.
  const protoMatch = entry.match(/^(tls|https|h3|quic):\/\/(.+)$/i);
  if (protoMatch) {
    const rest = protoMatch[2]; // host[:port][/path]
    // For https:// allow /path suffix, for tls:// / quic:// / h3:// expect host[:port] only
    const isHttps = protoMatch[1].toLowerCase() === "https";
    const hostPart = isHttps ? rest.split("/")[0] : rest;
    if (!hostPart) return "server.users.dns_err_invalid_format";
    // host or host:port
    if (/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d{1,5})?$/.test(hostPart)) return "";
    if (/^\d+\.\d+\.\d+\.\d+(?::\d{1,5})?$/.test(hostPart)) return "";
    return "server.users.dns_err_invalid_format";
  }

  // Allow IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(entry)) {
    const ok = entry.split(".").every((o) => {
      const n = Number(o);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
    return ok ? "" : "server.users.dns_err_ipv4_octet_range";
  }
  // Allow IPv4 with port: ip:port
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(entry)) return "";
  // Allow hostname (RFC 1035 subset: letters, digits, dots, hyphens)
  if (/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(entry)) return "";
  // Allow hostname:port
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*:\d+$/.test(entry)) return "";
  return "server.users.dns_err_invalid_format";
}

/** Legacy boolean helper retained for backward-compat callers / tests. */
function isValidDnsEntry(entry: string): boolean {
  return getDnsEntryError(entry) === "";
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
      // UX-dns-filter: whitelist at the *input* layer. Only characters
      // that legitimately appear in a DNS entry pass through:
      //   - letters / digits (hostnames, IPs)
      //   - dot . dash - colon : slash /  (IP octets, IP:port, DoH path,
      //     tls:// / https:// / h3:// / quic:// prefixes)
      //   - newline \n as the between-entry separator
      // Everything else — spaces, tabs, Cyrillic, symbols, emojis — is
      // silently dropped. This matches what the server-side validator
      // would reject anyway but fixes it on keystroke/paste instead of
      // after submit, so the list never contains invisible garbage.
      const raw = e.target.value.replace(/[^a-zA-Z0-9.\-:/\n]/g, "");
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

  // Per-line validation with specific error reasons (WR-14.1-UAT-04).
  // Collect {entry, errorKey} pairs so users see WHY each line is invalid, not
  // just that it's red.
  const invalidDetails = useMemo(() => {
    const details: Array<{ entry: string; errorKey: string }> = [];
    for (const l of value) {
      const trimmed = l.trim();
      if (!trimmed) continue;
      const errKey = getDnsEntryError(trimmed);
      if (errKey) details.push({ entry: trimmed, errorKey: errKey });
    }
    return details;
  }, [value]);

  const hasError = invalidDetails.length > 0;
  // UX-dns-hint (B): short hint — just explain that ENTER is the separator
  // and each server goes on its own line. Format examples already live in
  // the placeholder, no need to repeat them.
  const resolvedHelper = helperText ?? t("server.users.dns_upstreams_hint");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
          {label}
        </label>
      )}
      <textarea
        value={draft}
        onChange={handleChange}
        disabled={disabled}
        rows={4}
        // WR-14.1-UAT-02 (rev. 2): 3 distinct format families so user sees the
        // full surface at a glance — plain IP, hostname, and protocol-prefixed
        // encrypted DNS (DoT via tls://, DoH via https://). Backend accepts
        // all three shapes; validator and placeholder stay in sync.
        placeholder={
          "8.8.8.8\ndns.example.com\ntls://dns.example.com:853"
        }
        aria-label={label ?? t("server.users.field_dns_upstreams")}
        aria-invalid={hasError}
        spellCheck={false}
        data-testid="dns-upstreams-textarea"
        // WR-14.1-UAT-03: floor = standard Input height (h-8, 32px). Resize
        // down never goes below an ordinary text input; expanding down is
        // unlimited via resize-y.
        style={{ minHeight: "2rem" }}
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
        <ul
          className="text-xs text-[var(--color-status-error)] list-none m-0 p-0 space-y-0.5"
          data-testid="dns-error"
        >
          {invalidDetails.map(({ entry, errorKey }, i) => (
            <li key={`${entry}-${i}`}>
              <span className="font-mono">«{entry}»</span> — {t(errorKey)}
            </li>
          ))}
        </ul>
      ) : resolvedHelper ? (
        <p className="text-xs text-[var(--color-text-muted)]">{resolvedHelper}</p>
      ) : null}
    </div>
  );
}

// Re-export validator for testing and parent components
// eslint-disable-next-line react-refresh/only-export-components
export { isValidDnsEntry };
