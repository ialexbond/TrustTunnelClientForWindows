/*
 * release-notes-section.cjs — печатает в stdout раздел одной версии из файла заметок приложения
 * gui-pro/src/shared/release-notes/RELEASE_NOTES.ru.md.
 *
 * Зачем это вообще есть. Заметки одной и той же версии человек читает дважды и каждый раз из
 * разного места: ДО установки — из описания выпуска на GitHub, ПОСЛЕ установки — уже из файла,
 * вложенного в сборку. Написанные порознь, эти два текста расходятся, и одно и то же обновление
 * оказывается описано двумя разными способами одному и тому же человеку. Поэтому источник правды
 * один — файл заметок, — а описание выпуска порождается из его раздела для этой версии. Совпадение
 * получается по построению, а не по внимательности того, кто публикует (решение владельца D-20,
 * memory/v3/screens/about.md §«Один источник правды, два места показа»).
 *
 * CommonJS (.cjs) — по той же причине, что и у соседнего scripts/i18n-dead-keys.cjs:
 * gui-pro/package.json объявляет "type": "module", но этот скрипт живёт вне того пакета и
 * запускается голым `node`, который определяет тип модуля по ближайшему package.json, — а в корне
 * репозитория его нет, поэтому .cjs здесь единственное однозначное расширение.
 *
 * Запуск: node scripts/release-notes-section.cjs [версия]
 * Корень берётся от каталога самого файла, поэтому команда одинаково работает и из корня
 * репозитория, и из gui-pro/ — cwd вызывающего роли не играет. Без аргумента версия читается из
 * gui-pro/src-tauri/tauri.conf.json, чтобы скрипт и сборка не могли разойтись.
 *
 * Выходит с кодом 1, если раздела для запрошенной версии нет, и НИЧЕГО при этом не пишет в stdout:
 * публикация должна упасть громко, а не создать выпуск с пустым описанием.
 *
 * Разбор здесь продублирован из gui-pro/src/shared/utils/parseReleaseNotes.ts намеренно: общий
 * модуль между корневым CJS-скриптом и ESM/TypeScript-кодом приложения стоил бы отдельного шага
 * сборки ради десяти строк. Дублирование стережёт тест
 * gui-pro/src/shared/utils/releaseNotesGenerator.parity.test.ts — он требует, чтобы вывод этого
 * скрипта побайтово совпадал с тем, что для той же версии возвращает парсер приложения. Правишь
 * регулярку здесь — правь и там, тест иначе покраснеет.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NOTES_PATH = path.join(ROOT, "gui-pro", "src", "shared", "release-notes", "RELEASE_NOTES.ru.md");
const TAURI_CONF_PATH = path.join(ROOT, "gui-pro", "src-tauri", "tauri.conf.json");

// Якорь заголовка версии. `\r?$` обязателен: в репозитории core.autocrlf = true и нет
// .gitattributes, поэтому в свежем клоне файл лежит с CRLF, а в рабочем дереве автора — с LF.
// Номер версии захватывается целиком и сравнивается на полное равенство, а не как префикс, —
// «3.0» не может подобрать раздел «3.0.0», и наоборот.
const VERSION_HEADING = /^##[ \t]+Версия[ \t]+([0-9]+(?:\.[0-9]+)*)[ \t]*\r?$/gm;

function fail(message) {
  console.error(`release-notes-section: ${message}`);
  process.exit(1);
}

/** Возвращает тело раздела с вырезанным заголовком, либо null. Зеркало parseReleaseNotes.ts. */
function parseReleaseNotes(raw, version) {
  const heading = new RegExp(VERSION_HEADING.source, "gm");

  const sections = [];
  let match;
  while ((match = heading.exec(raw)) !== null) {
    sections.push({
      version: match[1],
      headingStart: match.index,
      bodyStart: match.index + match[0].length,
    });
  }

  for (let i = 0; i < sections.length; i += 1) {
    if (sections[i].version !== version) continue;
    const end = i + 1 < sections.length ? sections[i + 1].headingStart : raw.length;
    const body = raw.slice(sections[i].bodyStart, end).trim();
    return body.length > 0 ? body : null;
  }

  return null;
}

/** Версия приложения из tauri.conf.json — та же, что попадёт в имя инсталлятора. */
function readInstalledVersion() {
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, "utf8"));
  } catch (e) {
    fail(`не удалось прочитать ${TAURI_CONF_PATH}: ${e.message}`);
  }
  if (typeof conf.version !== "string" || conf.version.length === 0) {
    fail(`в ${TAURI_CONF_PATH} нет строкового поля "version"`);
  }
  return conf.version;
}

const version = process.argv[2] || readInstalledVersion();

let raw;
try {
  raw = fs.readFileSync(NOTES_PATH, "utf8");
} catch (e) {
  fail(`не удалось прочитать файл заметок ${NOTES_PATH}: ${e.message}`);
}

const body = parseReleaseNotes(raw, version);

if (body === null) {
  fail(
    `в файле заметок нет раздела «## Версия ${version}» (или он пустой). ` +
      `Опиши версию в ${NOTES_PATH} и повтори — описание выпуска пишется только оттуда.`,
  );
}

// Только текст раздела и ничего больше: вывод уходит прямо в `gh release create --notes-file -`.
// Без завершающего перевода строки — вывод обязан побайтово совпадать с результатом парсера
// приложения, а тот отдаёт тело раздела обрезанным с обоих концов.
process.stdout.write(body);
