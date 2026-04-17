<!-- generated-by: gsd-doc-writer -->
# Руководство контрибьютора

Спасибо за интерес к TrustTunnel Client for Windows! Это проект, над которым
работает один разработчик, но issues, идеи и pull request'ы от сообщества приветствуются.

Документ короткий — здесь только то, что нужно знать, чтобы внести изменение без
трения. Правила дизайн-системы, архитектура и build-команды подробно описаны в
[CLAUDE.md](CLAUDE.md) — дублировать их здесь не будем.

## Политика веток

- **`master` — read-only.** Никаких коммитов и мержей напрямую в `master`.
- Работа идёт в релизных ветках вида `release/tt-win-X.Y.Z` (см. `git branch -a`:
  активные сейчас — `release/tt-win-2.7.0` и выше; точная версия указана в
  `gui-app/package.json`).
- Pull request'ы таргетятся **в активную release-ветку**, а не в `master`.
- Если вы не уверены, какая ветка активна — откройте issue и спросите перед PR.

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

## Предложить фичу

Шаблон **🚀 Feature request** в Issues. Опишите проблему, предлагаемое решение
и альтернативы, которые уже рассматривали. Для крупных идей сначала обсудите
в Discussions — это дешевле, чем писать код впустую.

## Pull request

1. **Fork** репозитория на GitHub.
2. Создайте ветку от **активной** `release/tt-win-X.Y.Z` (не от `master`):

   ```bash
   git fetch upstream
   git checkout -b my-fix upstream/release/tt-win-X.Y.Z
   ```

3. Внесите изменения. Для worktree без sidecar-бинарей см.
   [CLAUDE.md → Worktree Setup](CLAUDE.md#worktree-setup).
4. Запустите полную проверку **из `gui-app/`** — должна быть зелёной:

   ```bash
   npm run prerelease   # typecheck + lint + test + clippy + build
   ```

5. Откройте PR в `release/tt-win-X.Y.Z` (не в `master`). Шаблон PR подскажет,
   что заполнить: Related Issue, Summary, Changes, Tests, Checklist.
6. Один PR = одно логическое изменение. Рефакторинг и фичу — разными PR.

## Стиль кода

Коротко — подробности в [CLAUDE.md → Design System Rules](CLAUDE.md#design-system-rules):

- TypeScript **strict mode**, `npm run typecheck` без ошибок.
- ESLint с `--max-warnings 0` — ни одного warning'а.
- Все цвета — через CSS-токены из `gui-app/src/shared/styles/tokens.css`.
  **Никаких хардкод-hex** в компонентах.
- Font size: `text-xs/sm/base/lg` (Tailwind), а не `text-[var(--font-size-*)]`.
- Font weight: только `font-[var(--font-weight-semibold)]` или нормальный.
- Для склейки классов — `cn()` из `shared/lib/cn.ts`.
- Иконки — только **Lucide React** (не микшировать наборы).
- Rust: `cargo clippy -D warnings` должен быть чистым (`npm run rust:check`).

## Локализация (i18n)

Приложение переведено на **русский и английский**. Любой пользовательский текст
должен иметь записи **в обоих** файлах локалей:

- `gui-app/src/shared/i18n/locales/ru.json`
- `gui-app/src/shared/i18n/locales/en.json`
- Аналогично для Light: `gui-light/src/shared/i18n/locales/{ru,en}.json`

Правила:

- Никаких строковых литералов в JSX — всегда `useTranslation()` + ключ.
- Добавили ключ в `ru.json` — сразу добавьте в `en.json` (и наоборот).
- Ключи именуются через точки по смыслу: `server.tabs.overview`,
  `wizard.steps.ssh.title` и т. п.

## Тестирование

Подробности по паттернам (visibility vs DOM, RAF mock, i18n в beforeEach) —
в [TESTING.md](TESTING.md) и [CLAUDE.md → Testing Patterns](CLAUDE.md#testing-patterns).

Команды из `gui-app/`:

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

Используются **Conventional Commits со scope фазы/плана**. Скоуп — номер активной
фазы и (если есть) плана. Примеры из `git log --oneline`:

```
feat(14-05): add UsersAddForm redesign
fix(14): WR-04/05/06 dedupe fetchDeeplink via useCallback
fix(13): WR-09 await clear_ssh_credentials to prevent stale-creds resurrection
docs(14-04): add UserConfigModal plan
test(14-06): rewrite UsersSection.test.tsx for new 2-icon surface
chore(14-04): merge executor worktree
```

Типы: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `style`.
Для внешнего контрибьютора, не знающего номер фазы, допустим просто тип без
скоупа — maintainer перепишет сообщение при сквоше, если нужно:

```
fix: guard against null SSH session on reconnect
feat: add copy-to-clipboard button to QR modal
```

Одна строка заголовка ≤ 72 символов, без точки в конце. Детали — в теле коммита.

## Ссылки

- Issues: <https://github.com/ialexbond/TrustTunnelClientForWindows/issues>
- Releases: <https://github.com/ialexbond/TrustTunnelClientForWindows/releases>
- Лицензия: [Apache 2.0](LICENSE)
- Правила разработки: [CLAUDE.md](CLAUDE.md)
- Тестирование: [TESTING.md](TESTING.md)
