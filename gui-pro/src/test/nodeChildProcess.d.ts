/**
 * Минимальное объявление одной функции Node, которая нужна тестам, — `spawnSync`.
 *
 * Почему объявление, а не пакет типов. `@types/node` в этом пакете не установлен, а
 * `gui-pro/tsconfig.json` ограничивает `types` тремя записями (`vitest/globals`,
 * `@testing-library/jest-dom`, `vite/client`). Ставить `@types/node` ради одной сигнатуры в одном
 * тесте — это новая зависимость, а любая новая зависимость по правилам фазы проходит проверку
 * легитимности пакета и блокирующий человеческий чекпоинт. Ради удобства теста это несоразмерно,
 * поэтому объявлена ровно та форма, которой тест пользуется, и ничего сверх неё.
 *
 * Кто пользуется: `shared/utils/releaseNotesGenerator.parity.test.ts` запускает
 * `scripts/release-notes-section.cjs` настоящим процессом. Именно `spawnSync`, а не `execFileSync`:
 * `execFileSync` бросает исключение на ненулевом коде выхода, а тесту код выхода нужен как обычное
 * значение — он его как раз и проверяет.
 *
 * Сознательно сужено: только `encoding: "utf8"`, поэтому `stdout`/`stderr` типизированы как строки
 * и в тесте не нужно разбираться, строка это или буфер. Понадобится больше — дописать здесь, а не
 * расширять `any`.
 */
declare module "node:child_process" {
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: { encoding: "utf8"; cwd?: string },
  ): { status: number | null; stdout: string; stderr: string };
}
