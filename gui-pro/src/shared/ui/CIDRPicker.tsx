import { useMemo, useCallback, useState, useEffect, useRef } from "react";
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
 * Prefix options: leading "—" (empty) as a clearable reset, then 0..=32.
 * FIX-I: the empty entry lets the user revert a previously-picked prefix
 * back to "no selection" — required for resetting CIDR to "no restriction"
 * without clearing every octet.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const PREFIX_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "—" },
  ...Array.from({ length: 33 }, (_, i) => ({ value: String(i), label: String(i) })),
];

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

  // Hybrid controlled+local state: octet/prefix fields are tracked locally so
  // partial entry (e.g. user typed only first octet) survives the empty-string
  // round-trip through parent. formatCidr returns "" when any octet is empty,
  // so a fully-controlled implementation would clear the input the moment the
  // user starts typing — see Phase 14.1 post-review feedback.
  const initial = useMemo(() => parseCidr(value), [value]);
  const [octets, setOctets] = useState<[string, string, string, string]>(
    () => initial?.octets ?? ["", "", "", ""],
  );
  const [prefix, setPrefix] = useState<string>(() => initial?.prefix ?? "");
  // FIX-F: aggregate per-octet error flags (from NumberInput onErrorChange).
  // Any non-zero entry → reserve bottom space for the absolute-positioned
  // inline error; all clean → no extra gap below the row.
  const [octetErrors, setOctetErrors] = useState<[boolean, boolean, boolean, boolean]>(
    [false, false, false, false],
  );
  const anyOctetError = octetErrors.some(Boolean);
  const setOctetError = useCallback(
    (index: 0 | 1 | 2 | 3, hasError: boolean) =>
      setOctetErrors((prev) => {
        if (prev[index] === hasError) return prev;
        const next: [boolean, boolean, boolean, boolean] = [...prev] as [boolean, boolean, boolean, boolean];
        next[index] = hasError;
        return next;
      }),
    [],
  );
  const lastEmitted = useRef<string>(value);

  // Sync from external `value` changes only when the parent value didn't come
  // from our own onChange (e.g. parent reset CIDR to "" or loaded a new value).
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const parsed = parseCidr(value);
    if (parsed) {
      setOctets(parsed.octets);
      setPrefix(parsed.prefix);
    } else if (value === "") {
      setOctets(["", "", "", ""]);
      setPrefix("");
    }
    lastEmitted.current = value;
  }, [value]);

  const emit = useCallback(
    (nextOctets: [string, string, string, string], nextPrefix: string) => {
      const formatted = formatCidr(nextOctets, nextPrefix);
      lastEmitted.current = formatted;
      onChange(formatted);
      if (onError) {
        onError(formatted !== "" && !isValidCidr(formatted) ? "server.users.cidr_invalid" : "");
      }
    },
    [onChange, onError],
  );

  const handleOctetChange = useCallback(
    (index: 0 | 1 | 2 | 3, next: string) => {
      const copy: [string, string, string, string] = [octets[0], octets[1], octets[2], octets[3]];
      copy[index] = next;
      setOctets(copy);
      emit(copy, prefix);
    },
    [octets, prefix, emit],
  );

  const handlePrefixChange = useCallback(
    (next: string) => {
      setPrefix(next);
      emit(octets, next);
    },
    [octets, emit],
  );

  /**
   * Paste handler — fan'ит вставленную IP-строку по всем четырём octet'ам и
   * prefix, если угадывается CIDR shape. Примеры входов, которые принимаются:
   *   - `109.194.163.8`               → octets, prefix остаётся
   *   - `10.0.0.0/24`                 → octets + prefix=24
   *   - ` 10.0.0.0 /24 `              → trims whitespace
   *   - `http://10.0.0.0`             → сначала выдёргиваем цифры+точки
   *   - `10.0.0` (< 4 octets)         → игнорируется, default paste
   *   - `abc.def.ghi.jkl`             → все октеты non-numeric → default paste
   *
   * WR-05 (14.1-REVIEW deep pass): дополнительные guard-ы для ambiguous
   * pastes:
   *   - >4 цифровых групп в body → rejected (`10.20.30.40.50` мог быть
   *     5-octet опечаткой; silent truncation до «10.20.30.40» скрывает
   *     ошибку от пользователя; лучше fall-through к default paste,
   *     чтобы юзер увидел странное значение в одном поле).
   *   - malformed prefix (`/3a4`, `/99`) → игнорируется полностью, текущий
   *     prefix сохраняется. До фикса `/3a4` давал prefix=3 без обратной
   *     связи — теперь юзер видит, что его ввод не сработал, и может
   *     исправить руками.
   *
   * Возвращает true если мы взяли paste на себя (caller должен вызвать
   * preventDefault); false — пусть браузер вставит значение в одно поле.
   */
  const tryFanOutPaste = useCallback(
    (pasted: string): boolean => {
      const trimmed = pasted.trim();
      if (!trimmed) return false;
      // Разделяем на body + optional /prefix.
      const [body, prefixPart] = trimmed.split("/", 2);
      // Внутри body достаём подряд идущие числа через любые non-digit
      // разделители — покрывает копипаст типа «IP: 109.194.163.8 (ru)».
      const nums = body.match(/\d{1,3}/g);
      if (!nums || nums.length < 4) return false;
      // WR-05: >4 цифровых групп → ambiguous, не уверены, что вычленили
      // именно правильные. Falling through к default paste в одиночное
      // поле делает ошибку видимой для юзера.
      if (nums.length > 4) return false;
      const first4 = nums.slice(0, 4);
      // Validate each octet ∈ [0..255].
      const validOctets = first4.every((o) => {
        const n = Number.parseInt(o, 10);
        return Number.isInteger(n) && n >= 0 && n <= 255;
      });
      if (!validOctets) return false;
      // Prefix — optional. Принимаем только чистый `\d{1,2}` в диапазоне
      // 0..32. Если prefixPart содержит не-цифровые символы кроме leading/
      // trailing whitespace (например `/3a4`) — prefix НЕ трогается и юзер
      // видит, что ввёл нечто странное (свой старый / пустой prefix в
      // Select'е). До WR-05 мы silent-обрезали до первых цифр.
      let nextPrefix = prefix;
      if (prefixPart !== undefined) {
        const trimmedPrefix = prefixPart.trim();
        if (/^\d{1,2}$/.test(trimmedPrefix)) {
          const p = Number.parseInt(trimmedPrefix, 10);
          if (Number.isInteger(p) && p >= 0 && p <= 32) {
            nextPrefix = String(p);
          }
        }
      }
      const nextOctets: [string, string, string, string] = [
        first4[0],
        first4[1],
        first4[2],
        first4[3],
      ];
      setOctets(nextOctets);
      setPrefix(nextPrefix);
      // Сбрасываем per-octet error flags — свежие значения валидированы
      // выше, старые ошибки не должны висеть.
      setOctetErrors([false, false, false, false]);
      emit(nextOctets, nextPrefix);
      return true;
    },
    [prefix, emit],
  );

  const handleOctetPaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = e.clipboardData.getData("text");
      if (tryFanOutPaste(pasted)) {
        e.preventDefault();
      }
      // Else — default paste behaviour в одиночный octet (NumberInput
      // отфильтрует non-digits на onChange).
    },
    [tryFanOutPaste],
  );

  /**
   * Backspace при пустом octet прыгает на предыдущее поле. Зажимая
   * Backspace юзер очищает всю строку подряд, без ручного перехода
   * Shift+Tab между полями. Работает только для индексов 1..3 — в
   * первом octet'е некуда прыгать, поведение default.
   *
   * Реализовано через refs на `<input>` элементы. Focus + selection
   * ставится в конец значения, чтобы следующий Backspace сразу удалял
   * последнюю цифру — не выделенное поле.
   */
  const octetRefs: [
    React.RefObject<HTMLInputElement | null>,
    React.RefObject<HTMLInputElement | null>,
    React.RefObject<HTMLInputElement | null>,
    React.RefObject<HTMLInputElement | null>,
  ] = [useRef(null), useRef(null), useRef(null), useRef(null)];

  const handleOctetKeyDown = useCallback(
    (index: 0 | 1 | 2 | 3) =>
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Backspace") return;
        if (index === 0) return;
        const target = e.currentTarget;
        // Backspace в пустом поле → прыгаем на предыдущий octet. Пустое
        // выделение (selectionStart === selectionEnd === 0) в непустом
        // поле тоже летим: юзер уже очистил цифры вручную и дожимает
        // delete дальше.
        if (
          target.value === "" ||
          (target.selectionStart === 0 && target.selectionEnd === 0)
        ) {
          e.preventDefault();
          const prev = octetRefs[(index - 1) as 0 | 1 | 2]?.current;
          if (prev) {
            prev.focus();
            // Cursor в конец значения — следующий Backspace удалит
            // последний символ, не выделит всё поле.
            const len = prev.value.length;
            prev.setSelectionRange(len, len);
          }
        }
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
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

  // FIX-E: dots bottom-aligned with input bottom edge. A span with its own
  // h-8 + inner flex items-end anchors the "." glyph at the bottom, and the
  // outer row uses items-end so the baseline of every piece (input, dot,
  // prefix Select) meets at y=row-height. Inline per-octet errors from
  // NumberInput are absolutely positioned, so they never push the row.
  const dotSpan = (
    <span
      aria-hidden="true"
      className="h-8 flex items-end pb-1 leading-none text-[var(--color-text-muted)] select-none"
    >
      .
    </span>
  );

  // WR-14.1-UAT-07: +2px over old w-12 (48px→56px) so «300» and similar
  // 3-digit values don't clip the last character visually.
  const octetBox = "w-14 shrink-0";

  return (
    <div className={cn(className)} aria-label={ariaLabel}>
      {label && (
        <label className="block text-sm font-medium mb-1.5 text-[var(--color-text-secondary)]">
          {label}
        </label>
      )}
      {/* FIX-F: reserve bottom space (pb-5) only when an octet actually
          shows an inline error — clean state keeps the row flush against
          the helper text below. */}
      <div
        className={cn(
          "inline-flex items-end gap-1",
          anyOctetError && "pb-5",
        )}
      >
        <div className={octetBox}>
          <NumberInput
            ref={octetRefs[0]}
            value={octets[0]}
            onChange={(v) => handleOctetChange(0, v)}
            onErrorChange={(hasErr) => setOctetError(0, hasErr)}
            min={0}
            max={255}
            maxLength={3}
            disabled={disabled}
            onPaste={handleOctetPaste}
            onKeyDown={handleOctetKeyDown(0)}
            className="text-center"
            aria-label={t("server.users.cidr_octet_1")}
          />
        </div>
        {dotSpan}
        <div className={octetBox}>
          <NumberInput
            ref={octetRefs[1]}
            value={octets[1]}
            onChange={(v) => handleOctetChange(1, v)}
            onErrorChange={(hasErr) => setOctetError(1, hasErr)}
            min={0}
            max={255}
            maxLength={3}
            disabled={disabled}
            onPaste={handleOctetPaste}
            onKeyDown={handleOctetKeyDown(1)}
            className="text-center"
            aria-label={t("server.users.cidr_octet_2")}
          />
        </div>
        {dotSpan}
        <div className={octetBox}>
          <NumberInput
            ref={octetRefs[2]}
            value={octets[2]}
            onChange={(v) => handleOctetChange(2, v)}
            onErrorChange={(hasErr) => setOctetError(2, hasErr)}
            min={0}
            max={255}
            maxLength={3}
            disabled={disabled}
            onPaste={handleOctetPaste}
            onKeyDown={handleOctetKeyDown(2)}
            className="text-center"
            aria-label={t("server.users.cidr_octet_3")}
          />
        </div>
        {dotSpan}
        <div className={octetBox}>
          <NumberInput
            ref={octetRefs[3]}
            value={octets[3]}
            onChange={(v) => handleOctetChange(3, v)}
            onErrorChange={(hasErr) => setOctetError(3, hasErr)}
            min={0}
            max={255}
            maxLength={3}
            disabled={disabled}
            onPaste={handleOctetPaste}
            onKeyDown={handleOctetKeyDown(3)}
            className="text-center"
            aria-label={t("server.users.cidr_octet_4")}
          />
        </div>
        <span
          aria-hidden="true"
          className="h-8 flex items-center mx-1 text-[var(--color-text-muted)] select-none"
        >
          /
        </span>
        {/* WR-14.1-UAT-05: widened prefix trigger w-16→w-20 so 2-digit labels
            sit comfortably; dropdown now matches trigger width (Select.minWidth removed). */}
        <div className="w-20 shrink-0">
          <Select
            value={prefix}
            onChange={(e) => handlePrefixChange(e.target.value)}
            options={PREFIX_OPTIONS}
            placeholder="—"
            disabled={disabled}
            fullWidth
            aria-label={t("server.users.cidr_prefix")}
          />
        </div>
      </div>
      {autoHelper && (
        <p className="text-xs mt-1.5 text-[var(--color-text-muted)]">{autoHelper}</p>
      )}
    </div>
  );
}
