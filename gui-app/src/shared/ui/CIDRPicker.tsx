import { useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { NumberInput } from "./NumberInput";
import { Select } from "./Select";
import { cn } from "../lib/cn";
import { parseCidr, formatCidr, describeCidr, isValidCidr } from "../utils/cidr";

export interface CIDRPickerProps {
  /** Current CIDR string, e.g. "10.0.0.0/24". Empty string = no restriction. */
  value: string;
  /** Called with the new CIDR string. "" when any octet is empty (partial state). */
  onChange: (value: string) => void;
  /** Optional: called with the current validation error i18n key, or "" if valid/empty. */
  onError?: (errorKey: string) => void;
  disabled?: boolean;
  /** Label rendered above the inputs. */
  label?: string;
  /** Helper text below. If omitted, auto-generated via describeCidr(). */
  helperText?: string;
  className?: string;
  "aria-label"?: string;
}

/**
 * Prefix options 0..=32 (33 total). Exported so tests can assert length without
 * opening the Select portal. See W12 revision note in 14.1-02-PLAN.md.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const PREFIX_OPTIONS: Array<{ value: string; label: string }> = Array.from(
  { length: 33 },
  (_, i) => ({ value: String(i), label: String(i) })
);

export function CIDRPicker({
  value,
  onChange,
  onError,
  disabled = false,
  label,
  helperText,
  className,
  "aria-label": ariaLabel,
}: CIDRPickerProps) {
  const { t } = useTranslation();

  const parsed = useMemo(() => parseCidr(value), [value]);
  const octets = useMemo<[string, string, string, string]>(
    () => parsed?.octets ?? ["", "", "", ""],
    [parsed]
  );
  const prefix = parsed?.prefix ?? "";

  const handleOctetChange = useCallback(
    (index: 0 | 1 | 2 | 3, next: string) => {
      const copy: [string, string, string, string] = [octets[0], octets[1], octets[2], octets[3]];
      copy[index] = next;
      const formatted = formatCidr(copy, prefix);
      onChange(formatted);
      if (onError) {
        onError(formatted !== "" && !isValidCidr(formatted) ? "server.users.cidr_invalid" : "");
      }
    },
    [octets, prefix, onChange, onError]
  );

  const handlePrefixChange = useCallback(
    (next: string) => {
      const formatted = formatCidr(octets, next);
      onChange(formatted);
      if (onError) {
        onError(formatted !== "" && !isValidCidr(formatted) ? "server.users.cidr_invalid" : "");
      }
    },
    [octets, onChange, onError]
  );

  // Helper text resolution: prop > key from describeCidr (if it's a key) > describeCidr literal
  const autoHelper = useMemo(() => {
    if (helperText !== undefined) return helperText;
    const desc = describeCidr(value);
    if (desc === "") return "";
    // describeCidr returns either i18n keys ("server.users.cidr_*") or literal ranges.
    if (desc.startsWith("server.users.cidr_")) return t(desc);
    return desc;
  }, [helperText, value, t]);

  const dotSpan = (
    <span aria-hidden="true" className="text-[var(--color-text-muted)] select-none">
      .
    </span>
  );

  return (
    <div className={cn("w-full", className)} aria-label={ariaLabel}>
      {label && (
        <label className="block text-sm font-[var(--font-weight-semibold)] mb-1.5 text-[var(--color-text-secondary)]">
          {label}
        </label>
      )}
      <div className="flex items-center gap-1">
        <NumberInput
          value={octets[0]}
          onChange={(v) => handleOctetChange(0, v)}
          min={0}
          max={255}
          disabled={disabled}
          className="w-14 text-center"
          aria-label={t("server.users.cidr_octet_1")}
        />
        {dotSpan}
        <NumberInput
          value={octets[1]}
          onChange={(v) => handleOctetChange(1, v)}
          min={0}
          max={255}
          disabled={disabled}
          className="w-14 text-center"
          aria-label={t("server.users.cidr_octet_2")}
        />
        {dotSpan}
        <NumberInput
          value={octets[2]}
          onChange={(v) => handleOctetChange(2, v)}
          min={0}
          max={255}
          disabled={disabled}
          className="w-14 text-center"
          aria-label={t("server.users.cidr_octet_3")}
        />
        {dotSpan}
        <NumberInput
          value={octets[3]}
          onChange={(v) => handleOctetChange(3, v)}
          min={0}
          max={255}
          disabled={disabled}
          className="w-14 text-center"
          aria-label={t("server.users.cidr_octet_4")}
        />
        <span aria-hidden="true" className="mx-1 text-[var(--color-text-muted)] select-none">
          /
        </span>
        <Select
          value={prefix}
          onChange={(e) => handlePrefixChange(e.target.value)}
          options={PREFIX_OPTIONS}
          placeholder="—"
          disabled={disabled}
          fullWidth={false}
          className="w-20"
          aria-label={t("server.users.cidr_prefix")}
        />
      </div>
      {autoHelper && (
        <p className="text-xs mt-1.5 text-[var(--color-text-muted)]">{autoHelper}</p>
      )}
    </div>
  );
}
