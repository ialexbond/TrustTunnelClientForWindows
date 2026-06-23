/**
 * formatLastUpdated — единый формат «последнего обновления / последней проверки»
 * для карточек вкладки «Сервис».
 *
 * Раньше карточки расходились: «Проверка IP сервера» показывала время С датой
 * (BenchmarkSection), а «Логи сервера» — только время (LogsSection). R4-F07 свёл
 * оба к одному формату, чтобы метки времени на соседних карточках выглядели
 * одинаково. Round-6 (owner): порядок «дата, затем время» — «DD.MM.YYYY HH:MM»
 * (напр. «23.06.2026 18:05»): день, месяц, год, часы, минуты (раньше было
 * время-первым «HH:MM DD.MM.YYYY»).
 *
 * Принимает Date (LogsSection хранит Date) — для ISO-строки сначала `new Date(iso)`.
 */
export function formatLastUpdated(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
