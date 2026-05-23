<!-- generated-by: gsd-doc-writer -->
# Тестирование

Руководство для разработчиков, которые пишут или запускают тесты в TrustTunnel
Client. Базовые команды запуска — в `GETTING-STARTED.md`. Канонический чек-лист
паттернов — в `CLAUDE.md` → раздел **Testing Patterns**. Точная инвентаризация
тестов с разбивкой по файлам — в `.planning/codebase/TESTING.md`.

Документ актуален для Phase 17.1 (telemt rewrite), Phase 18 (Update flow) и
Phase 19 (Service tab + Protocol Update). Версия Pro `3.0.0` / Light `2.7.0`.

## Стек тестирования

| Слой | Инструмент | Версия | Где |
|---|---|---|---|
| Frontend runner | Vitest | ^4.1.0 | `gui-pro/vite.config.ts:31-52` |
| Coverage | @vitest/coverage-v8 | ^4.1.2 | опциональный, не входит в `prerelease` |
| DOM env | jsdom | ^29.0.1 | `vite.config.ts:33` |
| React rendering | @testing-library/react | ^16.3.2 | |
| DOM testing | @testing-library/dom | ^10.4.1 | |
| Matchers | @testing-library/jest-dom | ^6.9.1 | импорт в `setup.ts:1` |
| User interaction | @testing-library/user-event | ^14.6.1 | |
| Visual / interactive | Storybook | ^10.3.5 | `gui-pro/.storybook/` |
| Storybook play | `storybook/test` | (встроен) | `userEvent` / `within` / `waitFor` |
| Backend | cargo test | Rust 1.88 | `gui-pro/src-tauri/` |

Конфигурация Vitest — в `gui-pro/vite.config.ts` (секция `test:`):
`globals: true`, `setupFiles: ["./src/test/setup.ts"]`,
`include: ["src/**/*.test.{ts,tsx}"]`. `globals: true` автоматически
инжектит `describe` / `it` / `expect` / `vi` / `beforeEach` — но большинство
файлов всё равно делает явный импорт для читабельности.

**Объём тестов (верифицировано 2026-05-23):**

| Слой | Файлы | Тесты |
|---|---|---|
| Frontend `*.test.{ts,tsx}` | **143** (111 `.test.tsx` + 32 `.test.ts`) | **1891** `it()` / `test()` |
| Storybook `*.stories.tsx` | **65** | ~270 stories |
| Storybook MDX docs | **6** (`Colors.mdx`, `Shadows.mdx`, `Spacing.mdx`, `Typography.mdx`, `Fail2banModal.mdx`, `FirewallModal.mdx`) | n/a |
| Rust `#[test]` / `#[tokio::test]` | **313** в **19** файлах | `gui-pro/src-tauri/src/` |

**В Light-редакции тестов нет** — `gui-light/package.json` не содержит скрипта
`test` и `*.test.*` файлов. Light CI прогоняет только typecheck + lint.

Глобальный setup `gui-pro/src/test/setup.ts` (28 строк) импортирует
`@testing-library/jest-dom`, `./tauri-mock`, `../shared/i18n` и подменяет
`requestAnimationFrame` на синхронный колбэк + добавляет `matchMedia` stub
для jsdom (см. «Паттерны»).

## Команды запуска

Все команды — из `gui-pro/`, если не указано иное.

```bash
# Frontend
npm run test                                          # Vitest run (CI mode)
npm run test:watch                                    # Vitest watch
npx vitest run src/shared/ui/Button.test.tsx          # один файл
npx vitest run -t "renders primary variant"           # по substring имени
npx vitest run --coverage                             # v8 HTML coverage report

# Storybook
npm run storybook                                     # dev на :6006 (HMR :6007 fallback)
npm run build-storybook                               # static → storybook-static/

# Backend
cd src-tauri && cargo test                            # 313 #[test] / #[tokio::test]

# Полный пререлизный прогон (локальный эквивалент CI)
npm run prerelease
# = typecheck && lint && test && rust:check && build
```

`cargo audit` **не входит** в `prerelease` — запускается вручную перед
релизом (см. CLAUDE.md → Security Rules). Ожидаемый вывод: 1 уязвимость
(`RUSTSEC-2023-0071 rsa Marvin attack`, accepted risk через russh dep),
23 warnings (gtk-rs Linux-path).

## Паттерны

### Visibility вместо DOM-existence

Cross-fade табов и Accordion-коллапс используют `visibility: hidden +
opacity: 0`, **не** `display: none` — элемент остаётся в DOM. Поэтому:

```tsx
// ❌ Неправильно — элемент в DOM, тест упадёт
expect(hiddenPanel).not.toBeInTheDocument();

// ✅ Правильно
expect(hiddenPanel).not.toBeVisible();
```

Reference: `gui-pro/src/shared/ui/Accordion.test.tsx`.

### Синхронный RAF

`setup.ts` заменяет `requestAnimationFrame` на синхронный колбэк. Это
критично для Modal / pill-индикатора / cross-fade табов — анимации
выполняются мгновенно, `waitFor` для RAF-эффектов не нужен.

### `matchMedia` stub

`setup.ts` добавляет `window.matchMedia` stub если jsdom не содержит его
(`useTheme` использует его для `prefers-color-scheme: dark`). Stub всегда
возвращает `matches: false` (light theme) — достаточно для большинства
тестов, не переключающих тему.

### i18n в `beforeEach`

Для компонентов с `useTranslation()` язык фиксируется перед каждым тестом —
без явного reset порядок тестов может давать flaky-результаты на переводимых
строках:

```ts
import i18n from "../../shared/i18n";

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage("ru");
});
```

### Поведение, aria, visibility — не CSS-классы

```tsx
// ✅ Поведение + ARIA
expect(button).toHaveAttribute("aria-expanded", "true");
expect(panel).toBeVisible();
expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();

// ❌ CSS-класс (хрупко, ломается при смене стилей)
expect(div).toHaveClass("open");
```

Исключение — когда класс единственный наблюдаемый признак (например,
`animate-spin` на SVG-спиннере). Предпочитайте `getByRole` / `getByLabelText` /
`getByText` / `toBeVisible()` / `toBeDisabled()` над `getByTestId` и
`querySelector`.

### Modal: mousedown + mouseup (FIX-J)

Modal закрывается только когда полный жест mousedown + mouseup приходится
на backdrop (drag-select внутри Modal **не** должен его закрывать):

```tsx
fireEvent.mouseDown(overlay);
fireEvent.mouseUp(overlay);
expect(onClose).toHaveBeenCalledTimes(1);
```

`fireEvent.click(overlay)` close не триггерит. Reference:
`gui-pro/src/shared/ui/Modal.test.tsx`.

### Async-тесты

```ts
await waitFor(() => {
  expect(invoke).toHaveBeenCalledWith("vpn_connect", expect.any(Object));
});

const confirmBtn = await screen.findByRole("button", {
  name: i18n.t("buttons.confirm_delete"),
});
```

`findByRole` / `findByText` — асинхронные варианты с встроенным `waitFor`.

### Hook-тесты с провайдерами

```ts
import { renderHook } from "@testing-library/react";
import { hookWrapper } from "../../test/test-utils";

renderHook(() => useServerState(props), { wrapper: hookWrapper });
```

Если хук не использует `SnackBar` / `Confirm`, `wrapper` можно опустить.

### Section-divider + decision IDs

В больших test-suites используется `// ═════` long-line дивайдер; в именах
тестов цитируются ID решений (`D-03`, `D-29`, `B-08`). Это связывает тест с
memory-документом и упрощает regression triage.

## Tauri-моки (Vitest)

Глобальные моки Tauri API — `gui-pro/src/test/tauri-mock.ts` (46 строк,
подгружается через `setup.ts`). По умолчанию `invoke` возвращает `null`:

| Модуль | Default mock |
|---|---|
| `@tauri-apps/api/core` | `invoke: vi.fn().mockResolvedValue(null)` |
| `@tauri-apps/api/event` | `listen → () => {}` (unlisten), `emit → undefined` |
| `@tauri-apps/api/app` | `getVersion → "1.5.0"` |
| `@tauri-apps/api/window` | `getCurrentWindow()` возвращает объект с `minimize` / `toggleMaximize` / `close` / `setTitle` / `show` / `hide` / `onCloseRequested` / `listen` (все `vi.fn()`) |
| `@tauri-apps/plugin-dialog` | `open → null` |
| `@tauri-apps/plugin-shell` | `open → undefined` |

**Per-test override:**

```ts
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValueOnce({ users: ["alice"] });
});
```

### Симуляция Tauri events (Phase 18-19 pattern)

`UpdateProgressModal.test.tsx` и `BenchmarkModal.test.tsx` используют
`listeners` Map + локальный `emit()` хелпер чтобы дёргать events
(`update-protocol-step` / `benchmark-progress` / `benchmark-stdout-chunk`)
руками:

```ts
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, cb) => {
    listeners.set(name, cb);
    return vi.fn(() => listeners.delete(name));
  }),
}));
function emit(name: string, payload: unknown) {
  const h = listeners.get(name);
  if (h) h({ payload });
}
```

### `renderWithProviders` для секций

Если компонент использует `SnackBarProvider` / `ConfirmDialogProvider`
(`useSnackBar()` / `useConfirm()`) — рендерьте через `renderWithProviders`
из `gui-pro/src/test/test-utils.tsx`:

```tsx
import { renderWithProviders } from "../../test/test-utils";
renderWithProviders(<UsersSection state={state} />);
```

Обязательно для большинства файлов в `gui-pro/src/components/server/`.

## D-29 инвариант: spy на activity log

D-29 — пароли НИКОГДА не попадают в `activity.log`. Любой компонент с
password-handling обязан иметь spy-тест:

```ts
const activityLogSpy = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

// после теста — итерация по mock.calls
for (const call of activityLogSpy.mock.calls) {
  const [, message] = call;
  expect(String(message ?? "")).not.toContain("password=");
}
```

**Phase 19 расширение** — `ProtocolUpdateSection.test.tsx` добавил 3 варианта
spy:

1. Нет пароля в DOM
2. Нет `.bak` / путей файловой системы в DOM
3. Нет GitHub asset URL в `console.warn` (emit-path защита)

**D-29 покрытие** (15 файлов с spy-pattern, верифицировано 2026-05-23):

`UsersSection`, `UserModal`, `UserConfigModal`, `SecuritySection`,
`PasswordRotationPrompt`, `MtProtoModal`, `MtProtoSection`, `LogsViewerModal`,
`LogsSection`, `Fail2banModal`, `ConfigurationTab`,
`CertificateFingerprintCard`, `BenchmarkSection`, `BenchmarkModal`,
`ProtocolUpdateSection` (Phase 19).

## Storybook

### Конфигурация

**`gui-pro/.storybook/main.ts` (51 строка):**

- Framework: `@storybook/react-vite`
- Pattern: `../src/**/*.mdx` + `../src/**/*.stories.@(js|jsx|ts|tsx)`
- Addons: `@storybook/addon-docs` (с `remark-gfm` для MDX-таблиц),
  `@storybook/addon-themes`
- Vite alias overrides для Tauri API → `./tauri-mocks/`

**`gui-pro/.storybook/preview.ts` (33 строки):**

- Декораторы: `SnackBarProvider` + `withThemeByDataAttribute`
- Default theme: `dark`
- Layout: `padded` (16px global)
- CSS: `tokens.css`, `index.css`, `storybook-overrides.css` (light-theme
  токены для scope `.sbdocs` — без этого MDX-страницы теряют контраст,
  см. CLAUDE.md → Gotchas)

### Tauri mocks в Storybook

`gui-pro/.storybook/tauri-mocks/` — 6 файлов (отдельный набор от Vitest):
`api-core.ts`, `api-event.ts`, `api-app.ts`, `api-window.ts`,
`plugin-dialog.ts`, `plugin-shell.ts`.

`api-core.ts` (≈250 строк) имеет per-command switch с реалистичными
ответами для screen-level stories. Покрывает
`server_export_config_deeplink`, `fetch_server_config`,
`server_get_allowed_sni_list`, `server_fetch_endpoint_cert`,
`server_get_config_bundle`, `security_get_status`, `server_get_cert_info`,
`server_get_certbot_timer_status`, **`list_sidecar_versions`** (Phase 19,
3 fake releases).

**Per-story override** через `setStorybookInvokeOverride({ <command>: <response> })`.
Sentinel `STORYBOOK_NEVER_RESOLVE` — для loading-state stories.

### CSF3 + title-иерархия

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./Button";

const meta = {
  title: "Primitives/Button",
  component: Button,
  tags: ["autodocs"],
  args: { children: "Button", variant: "primary" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
```

- `Foundations/*` — MDX docs (Colors / Shadows / Spacing / Typography);
  для foundation-stories `tags: ["autodocs"]` **опущен** (Docs-tab заменён
  на MDX, см. `memory/v3/design-system/storybook.md` § Foundations pattern)
- `Layout/*` — AppShell, ServerSidebar, TabNavigation, TitleBar, WindowControls
- `Primitives/*` — компоненты `shared/ui/`
- `Screens/*` — ControlPanelPage, ServerTabs, SshConnectForm, StatusPanel,
  ProtocolUpdateSection (Phase 19), UpdateProgressModal (Phase 18),
  WelcomeTour (Phase 18)

### Interactive `play()` stories

Интерактивные сценарии используют `play:`-функцию + `userEvent` / `within` /
`waitFor` из `storybook/test`. Пример — `WithUserConfigModal` в
`UsersSection.stories.tsx`:

```tsx
import { userEvent, within, waitFor } from "storybook/test";

export const WithUserConfigModal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const buttons = await canvas.findAllByLabelText(/показать конфиг/i);
    if (buttons.length > 0) await userEvent.click(buttons[0]);
    await waitFor(() => {
      const modal = document.body.querySelector('[aria-label*="скопировать"i]');
      expect(modal).not.toBeNull();
    });
  },
};
```

Файлы с `play()` (верифицировано 2026-05-23):

- `gui-pro/src/components/server/UsersSection.stories.tsx`
- `gui-pro/src/components/server/LogsViewerModal.stories.tsx`
- `gui-pro/src/components/welcome/WelcomeTour.stories.tsx` (Phase 18)

### Обязательные артефакты при создании компонента

При создании или существенном изменении компонента в `shared/ui/` либо
non-trivial панели:

1. **Story** (`*.stories.tsx`) — минимум один вариант; интерактивные stories
   используют `useState` внутри `render()` либо `play()`
2. **Тест** (`*.test.tsx`) — CVA-варианты, состояния (disabled, loading,
   error), a11y-атрибуты
3. **Интеграционный тест** в фиче-потребителе — если компонент встроен в
   `ServerPanel` / `ControlPanelPage`

См. CLAUDE.md → Testing Patterns и DEVELOPMENT.md.

## Бэкенд (Rust)

**313 `#[test]` / `#[tokio::test]` блоков в 19 файлах** под
`gui-pro/src-tauri/src/` (верифицировано 2026-05-23):

| Файл | Тестов | Фокус |
|---|---|---|
| `ssh/sanitize.rs` | **63** | Все 22 input-валидатора (whitelist) — каждый валидатор имеет трио `accepts_normal` / `rejects_injection` / `rejects_empty_and_long` |
| `ssh/server/server_mtproto.rs` | **41** (Phase 17.1) | telemt rewrite — 8 чистых хелперов (`render_telemt_toml` / `parse_telemt_toml_minimal` / `parse_proxy_link_*` / `render_telemt_systemd_unit` / `detect_legacy_mtproxy` / `extract_process_name_from_ss` / `is_valid_hex_secret`) + UUID heredoc |
| `ssh/server/server_config.rs` | **30** | TOML inject/preserve, DER↔PEM, vpn.toml mutations Phase 15 |
| `ssh/server/users_advanced.rs` | **23** | TLV serialization + advanced user config |
| `ssh/server/server_security.rs` | **22** | UFW + Fail2Ban command output parsing |
| `ssh/server/server_rules.rs` | **19** | Per-user `rules.toml` CRUD |
| `ssh/server/tlv_encoder.rs` | **19** | TLV wire format encode/decode |
| `commands/updater.rs` | **16** (Phase 18) | `parse_version_from_output` / `validate_download_url` + GitHub asset URL whitelist (`github.com` + `objects.githubusercontent.com`) + SemVer extraction |
| `ssh/server/server_benchmark.rs` | **14** (вкл. **3 `#[tokio::test]`**) | Pure parse helpers + single-flight invariant (`rejects_concurrent`, `can_rerun_after_cancel`) + B8 watchdog `cancel_watchdog_fires_after_5s` |
| `logging.rs` | **10** | Activity log + file logging |
| `commands/config.rs` | **10** (вкл. **2 `#[tokio::test]`**) | ClientConfig validate + serialize roundtrip + async file I/O |
| `ssh/server/server_update.rs` | **9** (Phase 18) | Atomic-swap pipeline — surgical invariant static-grep + tarball-extract path validation + backup/rollback flow + 7-step `UpdateStep` emission contract |
| `ssh/server/cert_probe.rs` | **9** | DER base64 codec + cert info |
| `ssh/server/server_hosts.rs` | **8** | `hosts.toml` `update_hosts_in_toml` + allowed_sni mutation |
| `ssh/server/server_ssh_key.rs` | **6** (Phase 16) | Ed25519 keypair generation + PEM-armored validation + keyring path conventions |
| `ssh/deploy.rs` | **5** | Deploy script construction |
| `ssh/server/server_monitoring.rs` | **4** | `parsed.as_object()` metric extraction |
| `commands/geoip.rs` | **3** | ipwho.is response parsing |
| `ssh/server/server_install.rs` | **2** | systemd unit construction |

Все тесты живут в `#[cfg(test)] mod tests { ... }` блоках в конце файла —
отдельной директории `tests/` нет. `regex = "1"` — в `[dev-dependencies]`
(только для regex-sanity тестов).

### Async-тесты (`#[tokio::test]`)

5 async-блоков добавлено в Phase 17 + 18:

- `server_benchmark.rs` — single-flight + watchdog (3 теста)
- `commands/config.rs` — async file I/O для ClientConfig roundtrip (2 теста)

Остальные тесты — sync (parsers, validators, serializers, regex).

### Стиль sanitize-тестов

Для каждого валидатора в `ssh/sanitize.rs` — трио:

- `xxx_accepts_normal` — валидные inputs проходят
- `xxx_rejects_injection` — shell metacharacters не проходят: `$()`, `` ` ``,
  `;`, `|`, `&`, `'`, `"`, `\`
- `xxx_rejects_empty_and_long` — boundary: empty + > max length

22 валидатора × ~3 теста + edge cases = 63 теста.

## Покрытие

| Область | Расположение | Покрытие |
|---|---|---|
| **UI-примитивы** | `gui-pro/src/shared/ui/*.test.tsx` (~25 файлов) | Высокое — CVA-варианты, a11y, state transitions |
| **Shared hooks** | `gui-pro/src/shared/hooks/*.test.ts` (7 файлов: `useFeatureToggles`, `useFileDrop`, `useKeyboardShortcuts`, `useLanguage`, `useSuccessQueue`, `useUpdateChecker`, `useWelcomeTour`) | Целевое — остальные тестируются integration-style в панелях |
| **Server panels & sections** | `gui-pro/src/components/server/*.test.tsx` (~30 файлов) | Высокое — D-29 spy coverage у 15 sensitive-компонентов, section-divider pattern с decision IDs |
| **Server hooks** | `gui-pro/src/components/server/use*.test.ts` (8 хуков по domain) | Высокое — `useSecurityState`, `useServerState`, `useSidecarVersions` (Phase 19) |
| **Settings panels** | `gui-pro/src/components/settings/*.test.tsx` (7 секций + `useSettingsState`) | Высокое |
| **Wizard steps** | `gui-pro/src/components/wizard/*.test.tsx` (9 шагов + `useWizardState`) | Высокое |
| **Routing UI** | `gui-pro/src/components/routing/*.test.tsx` (8 файлов + `useRoutingState`) | Высокое |
| **Welcome / Update flow** | `welcome/WelcomeTour.test.tsx` (Phase 18), `update/UpdateProgressModal.test.tsx` + `useUpdateProgress.test.ts` (Phase 18) | Высокое — listener-map pattern для `update-protocol-step` |
| **Utilities** | `gui-pro/src/shared/utils/*.test.ts` (7 файлов: `cidr`, `credentialGenerator`, `dirtyTracker`, `translateSshError`, `uptime`, `userAdvanced`, `validators`) | Целевое |
| **Rust pure logic** | sanitize, server_config, server_rules, tlv_encoder, server_mtproto, server_update, updater | Высокое — 313 тестов покрывают все критические парсеры / валидаторы |

**Автоматического coverage-gate нет** — `npm run prerelease` не запускает
`--coverage`. `@vitest/coverage-v8` подключён, отчёт генерируется через
`npx vitest run --coverage` (HTML).

## Известные пробелы

- **Нет async/SSH integration-тестов на unit-уровне** — SSH connection pool,
  channel gate (`CHANNEL_OPEN_GATE`), retry-логика (`open_session_with_retry`),
  deploy flow проверяются только ручным UAT + Storybook
- **Нет тестов `tray.rs`** — построение трей-меню не покрыто
- **Нет тестов `connectivity.rs`** — gateway-ping monitor не покрыт
- **Нет тестов `routing_rules.rs`** — hosts-file editing на Rust-уровне не
  покрыто (frontend `useRoutingState.test.ts` покрывает UI-часть)
- **Нет тестов `geodata.rs` / `geodata_v2ray.rs`** — protobuf-парсер не покрыт
- **Нет тестов `commands/vpn.rs`** — sidecar lifecycle не покрыт на unit-уровне
- **Нет тестов `commands/network.rs`** — DNS / adapter detection не покрыто
- **Нет тестов `processes.rs`** — process picker не покрыт на Rust-уровне
- **Storybook `play()` покрытие ограничено** — только 3 stories используют
  `play()` (UsersSection, LogsViewerModal, WelcomeTour)
- **E2E через все фазы не автоматизированы** — Phase 17 fix-marathon
  (post-ship UAT на real VPS) подтвердил, что ручной UAT остаётся safety net
  для SSH-side регрессий

## Пререлизный gate

```json
"prerelease": "npm run typecheck && npm run lint && npm run test && npm run rust:check && npm run build"
```

Проходит перед любым релизом и сборкой NSIS-инсталляторов. Покрывает всё
что делает CI (минус C++ ctest).

### GitHub Actions (`.github/workflows/`)

| Workflow | Триггер | Jobs |
|---|---|---|
| `frontend.yml` | Push/PR в `gui-{pro,light}/src/**` или config | `gui-pro`: typecheck + lint + vitest. `gui-light`: typecheck + lint (тестов нет). Node 22, `ubuntu-latest`, `npm ci --legacy-peer-deps` |
| `lint-rust.yml` | Push/PR в `**.rs` или `Cargo.{toml,lock}` | `cargo clippy -D warnings` + `cargo fmt --check` (Rust 1.88) через `make lint-rust` |
| `lint-md.yml` | Markdown-изменения | markdownlint |
| `run-tests.yml` | Source / Cargo changes | C++ + Rust workspace tests на Linux / macOS / Windows через `make test-rust` + ctest для C++ |

**Skip CI:** префиксуйте commit-message `skipci:` чтобы обойти все workflow.

**Bamboo specs** (`bamboo-specs/`) — отдельный внутренний пайплайн AdGuard
для C++ core.

## Quick reference

| Паттерн | Когда | Пример |
|---|---|---|
| `getByRole("button", { name })` | Запрос кнопок | `Button.test.tsx` |
| `getByText` / `findByText` | Text content (sync / async) | `Modal.test.tsx` |
| `getAllByRole` | Множественные совпадения | `UsersSection.test.tsx` |
| `not.toBeVisible()` | Скрыто через visibility / opacity | `Accordion.test.tsx` |
| `not.toBeInTheDocument()` | Действительно unmounted | `Modal.test.tsx` |
| `toHaveAttribute("aria-...")` | A11y-атрибуты | `Accordion.test.tsx` |
| `toBeDisabled()` | Disabled кнопки | `Button.test.tsx` |
| `expect.stringContaining` | Substring-assertion | `UsersSection.test.tsx` |
| `expect.objectContaining` | Partial object match | `UsersSection.test.tsx` |
| `vi.mocked(invoke).mockResolvedValueOnce(x)` | Per-test invoke override | `UsersSection.test.tsx` |
| `await waitFor(() => expect(...))` | Wait for async assertion | `UsersSection.test.tsx` |
| `renderWithProviders(<X />)` | Нужен SnackBar / Confirm | `UsersSection.test.tsx` |
| `renderHook(() => useX(args), { wrapper: hookWrapper })` | Hook с провайдерами | `useServerState.test.ts` |
| Listener-map + `emit(payload)` helper | Симуляция Tauri events | `UpdateProgressModal.test.tsx` |
| `activityLogSpy` + iterate `mock.calls` | D-29 password-leak check | `UsersSection.test.tsx` |

## Пример (из `Button.test.tsx`)

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "./Button";

describe("Button", () => {
  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Press</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled state: button has disabled attr, onClick not called", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>No</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

`getByRole("button")` вместо селекторов по классу, `toBeDisabled()` вместо
`toHaveClass("disabled")`.

## См. также

- `CLAUDE.md` → **Testing Patterns** + **Gotchas** — канонический чек-лист
- `GETTING-STARTED.md` — первый запуск и базовые команды
- `DEVELOPMENT.md` — линт, форматирование, PR-процесс
- `ARCHITECTURE.md` — модули, IPC events, sidecar
- `CONFIGURATION.md` — env-флаги, токены, конфигурация Tauri / Vitest
- `.planning/codebase/TESTING.md` — точная инвентаризация тестов
  (verified 2026-05-23)
- `memory/v3/design-system/storybook.md` — инвентаризация story-файлов +
  Tauri mock детали
- `memory/security-posture.md` — D-29 ground truth + threat model
- `memory/v3/screens/control-panel-service.md` — Phase 19 test plan
- `memory/v3/screens/update-flow.md` — Phase 18 update test plan +
  Phase 19 cascade
- `gui-pro/src/test/setup.ts` — test environment (28 строк)
- `gui-pro/src/test/tauri-mock.ts` — Tauri API mocks (45 строк)
- `gui-pro/src/test/test-utils.tsx` — `renderWithProviders` (28 строк)
- `gui-pro/.storybook/tauri-mocks/api-core.ts` — Storybook invoke-mock
