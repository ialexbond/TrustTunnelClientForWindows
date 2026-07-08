/**
 * Russian pluralization helper — relocated from `components/server/certUtils.ts`
 * into `shared/lib` (PA-6) so the generic count-declension is a cross-feature
 * primitive: «Подключение» (ImportModal, useFileDrop) and «Сервер» (Cert/Security)
 * both reuse it WITHOUT «Подключение» reaching into the «Сервер» feature dir.
 *
 * BUG-26 history: originally extracted from CertSection + CertModal (was duplicated
 * in two files). Used for cert days display («1 день / 2 дня / 5 дней»), config
 * batch counts («2 конфига / 5 конфигов»), rule counts, and any other date/count
 * formatting. Pure function — no i18next dependency (English uses i18next `_one/_other`
 * plural keys instead).
 *
 * Russian plural rules:
 *   - last digit 1 (except teens 11-19) → "one" form ("день")
 *   - last digit 2-4 (except teens) → "few" form ("дня")
 *   - last digit 0, 5-9, or teens 11-19 → "many" form ("дней")
 */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const lastDigit = abs % 10;
  if (abs >= 11 && abs <= 19) return `${n} ${many}`;
  if (lastDigit === 1) return `${n} ${one}`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}
