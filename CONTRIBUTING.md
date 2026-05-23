<!-- generated-by: gsd-doc-writer -->
# Руководство контрибьютора

TrustTunnel Client for Windows — закрытый продукт, разрабатываемый небольшой
командой. Внешние pull request'ы принимаются, но это **не community-driven OSS
проект**: бэклог и приоритеты определяются maintainer'ами, релизный поезд идёт
по своему расписанию (см. `.planning/ROADMAP.md`).

Документ короткий — только то, что нужно, чтобы внести изменение без трения.
Правила дизайн-системы, архитектура и build-команды живут в:

- [CLAUDE.md](CLAUDE.md) — главный источник правды для разработчиков (и AI-агентов)
- [ARCHITECTURE.md](ARCHITECTURE.md) — слои, IPC, две редакции
- [DEVELOPMENT.md](DEVELOPMENT.md) — локальная сборка, инструменты
- [TESTING.md](TESTING.md) — паттерны Vitest, Storybook, D-29 spy-тесты
- [CONFIGURATION.md](CONFIGURATION.md) — все настраиваемые параметры
- [SECURITY.md](SECURITY.md) — threat model и политика disclosure

Дублировать их здесь не будем.

## Политика веток

- **`master` — read-only.** Никаких коммитов и merge'ев напрямую в `master`
  без явного запроса maintainer'а.
- Релизный поезд — ветки вида `release/tt-win-X.Y.Z`. На момент записи активна
  `release/tt-win-3.0.0` (Pro 3.0.0 / Light 2.7.0, см. `gui-pro/package.json`).
- Внутри команды работа часто идёт в git **worktree** под ветками
  `claude/*` (см. `git worktree list`) и сливается в активную `release/*`.
- Pull request от внешнего контрибьютора таргетится **в активную release-ветку**,
  а не в `master`. Если не уверены — откройте issue и спросите перед PR.

## Сообщить о баге

Используйте [GitHub Issues](https://github.com/ialexbond/TrustTunnelClientForWindows/issues)
и шаблон **🐞 Bug report** — он сам попросит нужные поля.

Минимальный чеклист перед отправкой:

- [ ] Версия Windows (10 / 11, build number)
- [ ] Редакция и версия приложения (Pro / Light, видна в «О программе»)
- [ ] Шаги воспроизведения (1, 2, 3…)
- [ ] Что ожидалось и что произошло
- [ ] Логи: `%APPDATA%\TrustTunnel\logs\` (прикрепите или вставьте под `<details>`)
- [ ] Скриншоты, если баг визуальный

Вопросы по использованию — в **GitHub Discussions**, не в Issues.

## Сообщить о security-проблеме

**Не открывайте public issue для уязвимостей.** Полная политика — в
[SECURITY.md](SECURITY.md). Кратко:

1. Напишите на `you@example.com` с темой
   `[SECURITY] TrustTunnel Client — <краткое описание>`.
2. Ответ — в течение 72 часов; coordinated disclosure после фикса.
3. **Не публикуйте детали в публичных vuln-базах** до выхода патча.

Знайте про известные ограничения (`RUSTSEC-2023-0071` — Marvin attack в `rsa`)
до того как репортить — они задокументированы в SECURITY.md как accepted risk.

## Предложить фичу

Шаблон **🚀 Feature request** в Issues. Опишите проблему, предлагаемое решение
и альтернативы. Для крупных идей сначала Discussions — у проекта свой
roadmap (`.planning/ROADMAP.md`), фича может уже планироваться или сознательно
быть отложена.

## Pull request

### Workflow

1. **Fork** репозитория на GitHub.
2. Создайте ветку от **активной** `release/tt-win-X.Y.Z` (не от `master`):

   ```bash
   git fetch upstream
   git checkout -b my-fix upstream/release/tt-win-3.0.0
   ```

3. Внесите изменения. Для worktree без sidecar-бинарей см.
   [CLAUDE.md → Worktree Setup](CLAUDE.md#worktree-setup) — нужно скопировать
   `trusttunnel_client-x86_64-pc-windows-msvc.exe` + DLL до `cargo check`.
4. Запустите полную проверку **из `gui-pro/`** — должна быть зелёной:

   ```bash
   npm run prerelease   # typecheck + lint + test + clippy + build
   ```

   > Замечание: `.github/pull_request_template.md` упоминает `make test` — это
   > артефакт из шаблона; для этого репозитория канонический pipeline это
   > `npm run prerelease` из `gui-pro/`. Maintainer применит соответствующие
   > чеки в CI (см. `.github/workflows/frontend.yml` и `lint-rust.yml`).
5. Откройте PR в `release/tt-win-X.Y.Z` (не в `master`). PR-шаблон попросит:
   Related Issue, Summary, Changes, Tests, Checklist.
6. **Один PR = одно логическое изменение.** Рефакторинг и фичу — разными PR.

### Code review checklist

Перед запросом review убедитесь, что:

- [ ] `npm run typecheck` — без ошибок (TypeScript strict mode)
- [ ] `npm run lint` — без ошибок и warning'ов (`--max-warnings 0`)
- [ ] `npm run test` — все тесты зелёные
- [ ] `npm run rust:check` — `cargo clippy -D warnings` чист
- [ ] Для нового/изменённого UI-компонента — **Storybook story** рядом
      (`*.stories.tsx`, см. [TESTING.md](TESTING.md))
- [ ] Если менялись токены / экраны / UI-поведение — обновлены соответствующие
      файлы в `memory/v3/` (граф знаний, см. CLAUDE.md → Memory Documentation)
- [ ] Если менялось `gui-pro/src-tauri/src/ssh/sanitize.rs` или появился новый
      user-input — добавлен char-whitelist validator + unit-тесты на отказ
- [ ] Если касались паролей или credentials — добавлен D-29 spy-тест
      (`expect(activityLog).not.toHaveBeenCalledWith(expect.stringContaining(password))`)
- [ ] **Никакие AI-артефакты не попали в diff** — ни в код, ни в комментарии,
      ни в commit-сообщения (см. ниже)

## Phase / planning workflow

Проект использует GSD-методологию: вся работа фазируется и трекается в
`.planning/` (`ROADMAP.md`, `STATE.md`, `milestones/`, `phases/`). Внешний
контрибьютор **не обязан** ничего туда писать — этот слой ведут maintainer'ы.
Однако:

- Если ваш PR ломает уже спланированную работу или конфликтует с активной
  фазой — maintainer попросит подождать либо переоформить под нужную фазу.
- Большие изменения (новая фича, рефакторинг архитектуры) сначала обсудите
  в issue, чтобы их можно было включить в milestone — иначе риск, что PR будет
  отложен или закрыт.
- Файлы внутри `.planning/` и `memory/` менять не нужно, если вас явно не
  попросили: они синхронизируются maintainer'ами с актуальным состоянием.

Скиллы и команды GSD-агентов лежат в `.claude/` (gitignored для большинства
артефактов) — для внешнего контрибьютора это noise, можно игнорировать.

## Стиль кода

Коротко — подробности в [CLAUDE.md → Design System Rules](CLAUDE.md#design-system-rules):

- TypeScript **strict mode**, `npm run typecheck` без ошибок.
- ESLint с `--max-warnings 0` — ни одного warning'а.
- Все цвета — через CSS-токены из `gui-pro/src/shared/styles/tokens.css`.
  **Никаких хардкод-hex** в компонентах.
- Типографика v2 (Phase 14.2): предпочитайте семантические композитные классы —
  `text-body`, `text-title`, `text-button`, `text-mono`, ... — а не ручную
  комбинацию `text-sm font-medium leading-snug` (полный список — в CLAUDE.md
  и [`memory/v3/design-system/typography.md`](memory/v3/design-system/typography.md)).
- Для склейки классов — `cn()` из `shared/lib/cn.ts`.
- Иконки — только **Lucide React** (не микшировать наборы).
- Rust: `cargo clippy -D warnings` должен быть чистым (`npm run rust:check`).

### Никаких AI-артефактов в коде и коммитах

Это **продакшен-код, не AI-эксперимент**. Не оставляйте в репозитории:

- комментариев вида `// Generated by Claude / ChatGPT / Copilot`,
- маркеров вроде `🤖 Generated with Claude Code` в commit-сообщениях,
- `Co-Authored-By: Claude <…>` или аналогичных trailer'ов в коммитах,
- AI-сгенерированных placeholder'ов (`TODO: rewrite this`, lorem ipsum,
  «здесь должна быть логика»).

Если использовали AI для генерации — review результат сами, перепишите так,
чтобы он был неотличим от написанного человеком, и удалите следы инструмента.
Maintainer оставляет за собой право отклонить PR с такими артефактами.

## Локализация (i18n)

Приложение переведено на **русский и английский**. Любой пользовательский текст
должен иметь записи **в обоих** файлах локалей:

- `gui-pro/src/shared/i18n/locales/ru.json`
- `gui-pro/src/shared/i18n/locales/en.json`
- Аналогично для Light: `gui-light/src/shared/i18n/locales/{ru,en}.json`

Правила:

- Никаких строковых литералов в JSX — всегда `useTranslation()` + ключ.
- Добавили ключ в `ru.json` — сразу добавьте в `en.json` (и наоборот).
- Ключи именуются через точки по смыслу: `server.tabs.overview`,
  `wizard.steps.ssh.title` и т. п.
- Existing i18n parity тест (`src/shared/i18n/i18n.test.ts`) упадёт, если
  ключи разъехались — это feature, не баг.

## Тестирование

Паттерны (visibility vs DOM, RAF mock, i18n в `beforeEach`, D-29 spy-тесты) —
в [TESTING.md](TESTING.md) и [CLAUDE.md → Testing Patterns](CLAUDE.md#testing-patterns).

Команды из `gui-pro/`:

```bash
npm run test           # Vitest: все тесты (режим run)
npm run test:watch     # Vitest в watch-режиме
npx vitest run path/to/File.test.tsx   # отдельный файл
```

Требования к PR:

- Изменения в логике — покрыть тестами (поведение и aria, **не** CSS-классы).
- Новый или изменённый UI-компонент — **обязательно Storybook story**
  (`npm run storybook`, файл `*.stories.tsx` рядом с компонентом).
- Все существующие тесты должны остаться зелёными.

## Стиль коммитов

**Conventional Commits со scope фазы/плана**, когда работа идёт в рамках
активной фазы. Скоуп — номер фазы и (если есть) плана. Примеры из
`git log --oneline`:

```
feat(19-04): cascade UI + ServiceTabSection wire-up + tab rename utilities → service
fix(19): GitHub rate-limit resilience — cache + dropdown fallback
docs(19-05): Phase 19 closeout — ROADMAP/STATE/CLAUDE.md
test(14-06): rewrite UsersSection.test.tsx for new 2-icon surface
chore(19-05): delete UpdateBanner trio + memory docs rename
refactor(19-04): rename server.utilities.* → server.service.* in 7 consumer files
```

Типы: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `style`.

Для внешнего контрибьютора, не знающего номер фазы, допустим просто тип без
скоупа — maintainer перепишет сообщение при сквоше, если нужно:

```
fix: guard against null SSH session on reconnect
feat: add copy-to-clipboard button to QR modal
```

Правила:

- Одна строка заголовка ≤ 72 символов, без точки в конце.
- Детали — в теле коммита.
- Атомарность приоритетнее идеологии: maintainer'ы используют как squash, так
  и serial-of-atomic-commits — выбирайте то, что лучше читается в истории.
- **Никаких AI trailer'ов** (`Co-Authored-By: Claude/Copilot`,
  `🤖 Generated with …`). См. раздел «Никаких AI-артефактов» выше.

## CI

Активные workflow'ы для этого репозитория:

- **`.github/workflows/frontend.yml`** — `typecheck + lint + test` для `gui-pro/`
  и `gui-light/` на Node 22 (Ubuntu).
- **`.github/workflows/lint-rust.yml`** — `make lint-rust` на toolchain
  `RUST_CHANNEL=1.88`.

Workflow'ы `run-tests.yml` и `lint-md.yml` пришли из upstream-репозитория
сайдкара (`TrustTunnel/TrustTunnel`) и в этом репозитории не запускаются на
изменениях клиента (см. `paths-ignore` / отсутствие триггеров для
`gui-*/**`). Это известное состояние, не баг.

Запускайте `npm run prerelease` локально перед PR — это полностью покрывает
то, что проверит CI плюс ещё `cargo clippy` и `vite build`.

## Ссылки

- Issues: <https://github.com/ialexbond/TrustTunnelClientForWindows/issues>
- Releases: <https://github.com/ialexbond/TrustTunnelClientForWindows/releases>
- Лицензия: [Apache 2.0](LICENSE) — позволяет переиспользование исходников,
  но дистрибуция бинарей TrustTunnel Client остаётся за командой проекта.
- Security policy: [SECURITY.md](SECURITY.md)
- Правила разработки: [CLAUDE.md](CLAUDE.md)
- Архитектура: [ARCHITECTURE.md](ARCHITECTURE.md)
- Конфигурация: [CONFIGURATION.md](CONFIGURATION.md)
- Тестирование: [TESTING.md](TESTING.md)
