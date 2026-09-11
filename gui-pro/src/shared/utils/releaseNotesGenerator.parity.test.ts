import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { parseReleaseNotes } from "./parseReleaseNotes";

// Vite raw import — loaded at bundle time, no Node.js fs required. The same bytes the app renders.
import realNotes from "../release-notes/RELEASE_NOTES.ru.md?raw";

/**
 * Сторож намеренного дублирования.
 *
 * Описание GitHub-выпуска порождается скриптом `scripts/release-notes-section.cjs`, а окно «Что
 * нового» рисует то, что вернул `parseReleaseNotes`. Это две реализации одного разбора: общий
 * модуль между корневым CJS-скриптом и ESM/TypeScript-кодом приложения потребовал бы отдельного
 * шага сборки ради десяти строк. Урок фазы 28 («одна общая функция решения») применён там, где
 * буквально общего модуля быть не может: раз кода два, их совпадение обязан доказывать тест.
 *
 * Смысл именно в побайтовом равенстве. Разойдись эти две реализации — и одно и то же обновление
 * окажется описано двумя разными способами одному и тому же человеку: до установки он читает
 * описание выпуска, после установки — файл в сборке (D-20).
 */

/** Путь к скрипту относительно корня vitest-проекта (`gui-pro/`), куда рантест переходит сам. */
const SCRIPT = "../scripts/release-notes-section.cjs";

function runScript(args: readonly string[], cwd?: string) {
  return spawnSync("node", args, { encoding: "utf8", cwd });
}

/** Все версии, у которых в реальном файле есть раздел. */
function versionsInFile(raw: string): string[] {
  return [...raw.matchAll(/^##[ \t]+Версия[ \t]+([0-9]+(?:\.[0-9]+)*)[ \t]*\r?$/gm)].map((m) => m[1]);
}

describe("release-notes-section.cjs ↔ parseReleaseNotes parity", () => {
  const versions = versionsInFile(realNotes);

  it("the real file has at least one version section to compare", () => {
    // Без этой проверки все случаи ниже прошли бы вхолостую на пустом списке версий.
    expect(versions.length).toBeGreaterThan(0);
  });

  it.each(versions)("emits byte-identical text to the app's parser for %s", (version) => {
    const result = runScript([SCRIPT, version]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(parseReleaseNotes(realNotes, version));
  });

  /*
   * Byte parity makes the two texts the same SOURCE; this makes them the same PICTURE. The app
   * renders with react-markdown (CommonMark), where a line break inside a paragraph is a space.
   * GitHub renders a release description as a comment, where the same break is a hard <br> —
   * measured through its /markdown API in gfm mode before 3.0.0 shipped. A section wrapped at 100
   * columns therefore read as one paragraph in the app and as ragged half-sentences on GitHub.
   */
  it.each(versions)("%s writes every paragraph and list item on one line", (version) => {
    const lines = (parseReleaseNotes(realNotes, version) ?? "").split(/\r?\n/);
    const blockStart = /^([-*+]|\d+[.)])\s|^#{1,6}\s|^>|^\|/;
    let inFence = false;
    const wrapped = lines.filter((line, i) => {
      if (/^```/.test(line)) inFence = !inFence;
      if (inFence || i === 0 || line.trim() === "") return false;
      const prev = lines[i - 1];
      if (prev.trim() === "" || /^#{1,6}\s/.test(prev)) return false;
      return !blockStart.test(line);
    });
    expect(wrapped, "these lines continue the line above — join them, or GitHub breaks the sentence there").toEqual([]);
  });

  it("exits non-zero and writes nothing to stdout for a version with no section", () => {
    // Публикация обязана падать громко, а не создавать выпуск с пустым описанием.
    const result = runScript([SCRIPT, "9.9.9"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("9.9.9");
    expect(parseReleaseNotes(realNotes, "9.9.9")).toBeNull();
  });

  it("is idempotent — two consecutive runs for the same version emit identical stdout", () => {
    const first = runScript([SCRIPT, "3.0.0"]);
    const second = runScript([SCRIPT, "3.0.0"]);

    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.length).toBeGreaterThan(0);
  });

  it("defaults to the version in tauri.conf.json when called with no argument", () => {
    // Так скрипт и сборка не могут разойтись: обе берут номер версии из одного места.
    const withArgument = runScript([SCRIPT, "3.0.0"]);
    const withoutArgument = runScript([SCRIPT]);

    expect(withoutArgument.status).toBe(0);
    expect(withoutArgument.stdout).toBe(withArgument.stdout);
  });

  it("does not care about the caller's cwd", () => {
    // Корень скрипт берёт от собственного каталога (`path.join(__dirname, "..")`), поэтому вызов
    // из корня репозитория и из gui-pro/ обязан давать один и тот же текст.
    const fromGuiPro = runScript([SCRIPT, "3.0.0"]);
    const fromRepoRoot = runScript(["scripts/release-notes-section.cjs", "3.0.0"], "..");

    expect(fromRepoRoot.status).toBe(0);
    expect(fromRepoRoot.stdout).toBe(fromGuiPro.stdout);
  });
});
