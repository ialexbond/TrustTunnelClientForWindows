# Phase 03: Control Panel — Research

**Researched:** 2026-04-14
**Domain:** React screen migration — ControlPanelPage + StatusPanel + SshConnectForm to v3 design system
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCR-01 | Control Panel (главный экран) полностью редизайнен с новыми компонентами | Codebase scan complete — migration scope mapped, all source/target APIs verified |
| SCR-02 | StatusPanel использует StatusBadge и status semantic токены | StatusBadge API verified, Button variant gap identified (see Pitfall 1) |
| DOC-03 | memory/v3/screens/ содержит спецификацию поведения каждого экрана | No screens/ subdirectory exists yet — must be created in Wave 0 |
</phase_requirements>

---

## Summary

Phase 3 migrates three tightly coupled components — `ControlPanelPage`, `StatusPanel`, and `SshConnectForm` — to the v3 design system. The work is visual-only: zero behavior changes, zero logic rewrites. All Phase 2 primitive components (`StatusBadge`, `Button`, `FormField`, `Card`, `ErrorBanner`, `Input`, `PasswordInput`, `SnackBar`) are already built and API-stable.

The most important finding is an API mismatch between the current `StatusPanel.tsx` and the Phase 2 `Button` component: StatusPanel uses `variant="warning"`, `variant="success"`, and an `icon` prop that do not exist in the current Button API. These must be resolved before StatusPanel renders correctly. The UI-SPEC addresses this by replacing the `warning` Button with the correct `danger` variant on `connecting` state, and using `ghost` for the reconnect case.

The secondary finding is that `SshConnectForm` still uses `colors.ts` (`colors.accentLogoGlow`) for the server icon background — a clear migration target. The form also has raw `<button>` elements in the key mode toggle that must be replaced by the `Button` component.

**Primary recommendation:** Three-component migration in three sequential waves: (1) SshConnectForm, (2) StatusPanel, (3) ControlPanelPage header + Storybook stories + DOC-03.

---

## Standard Stack

No new packages needed. All dependencies satisfied by Phase 1 + Phase 2 output.

### Core (already installed)
| Library | Version | Purpose | Role in Phase 3 |
|---------|---------|---------|-----------------|
| class-variance-authority | current | CVA variant engine | StatusBadge, Button, ErrorBanner |
| lucide-react | current | Icons | LogOut, Server, Lock, FileKey, ClipboardPaste, Loader2, Clock |
| react-i18next | current | i18n | All copy via `t()` |
| @tauri-apps/api | current | Tauri IPC | `invoke`, `open` (dialog) |

[VERIFIED: codebase scan — package.json + imports in source files]

### Supporting (Phase 2 components to consume)
| Component | Location | Used By |
|-----------|----------|---------|
| StatusBadge | `shared/ui/StatusBadge.tsx` | StatusPanel (replaces Badge) |
| Button | `shared/ui/Button.tsx` | ControlPanelPage header, SshConnectForm, StatusPanel |
| FormField | `shared/ui/FormField.tsx` | SshConnectForm fields |
| Card | `shared/ui/Card.tsx` | SshConnectForm outer container |
| ErrorBanner | `shared/ui/ErrorBanner.tsx` | StatusPanel error display (replaces inline `<p>`) |
| Input | `shared/ui/Input.tsx` | Host, Port, Username fields |
| PasswordInput | `shared/ui/PasswordInput.tsx` | Password field |
| SnackBarProvider / useSnackBar | `shared/ui/SnackBarContext.tsx` | SshConnectForm error toasts (already used) |

[VERIFIED: codebase scan — shared/ui/ directory listing + component APIs read]

---

## Architecture Patterns

### Recommended Project Structure (no changes needed)

```
gui-app/src/
├── components/
│   ├── ControlPanelPage.tsx     ← migrate header styles only
│   ├── StatusPanel.tsx          ← replace Badge+raw styles with StatusBadge+tokens
│   └── server/
│       └── SshConnectForm.tsx   ← wrap fields in FormField, center in Card, replace raw buttons
├── shared/ui/                   ← Phase 2 output, consumed not modified
└── shared/i18n/locales/
    ├── ru.json                  ← add vpnErrors.* keys (see Pitfall 3)
    └── en.json                  ← same
memory/
└── v3/
    └── screens/                 ← must create (DOC-03)
        └── control-panel.md     ← behavior spec for this phase
```

### Pattern 1: Card-Centered Login Form

SshConnectForm uses a login-screen card pattern (centered vertically and horizontally).

```tsx
// Source: 03-UI-SPEC.md — Component Inventory / SshConnectForm layout
// Outer wrapper — replaces current <div className="flex-1 flex items-center justify-center py-8">
<div className="flex-1 flex items-center justify-center py-[var(--space-7)] bg-[var(--color-bg-primary)]">
  <Card padding="lg" className="w-full max-w-[400px] rounded-[var(--radius-xl)]">
    {/* CardHeader: server icon + title + subtitle */}
    {/* FormField-wrapped fields */}
    {/* Connect CTA */}
    {/* Security note */}
  </Card>
</div>
```

Note: Current SshConnectForm uses `<div className="w-full max-w-md">` without Card. Phase 3 wraps it in the `Card` component and adopts `Card padding="lg"` (`p-[var(--space-5)]`).

### Pattern 2: StatusBadge + Token-Based Status Strip

StatusPanel migrates from `Badge` (generic) to `StatusBadge` (VPN-state-aware) and maps VPN states to the correct Button variants.

```tsx
// Source: 03-UI-SPEC.md — VPN state to Button mapping
// Current StatusPanel: Badge + variant="success"/"warning"/"danger" — WRONG
// Correct mapping after migration:
// VPN state        → StatusBadge variant    → Button variant
// connected        → "connected"            → "danger"
// connecting       → "connecting"           → "ghost" (disabled loading)
// disconnecting    → "connecting"           → "ghost" (disabled loading)
// recovering       → "connecting"           → "ghost" (disabled loading)
// error            → "error"               → "ghost"
// disconnected     → "disconnected"         → "ghost"
```

### Pattern 3: ErrorBanner for Persistent VPN Errors

```tsx
// Source: 03-UI-SPEC.md — Error display in StatusPanel
// Current: <p style={{ color: "var(--color-danger-400)" }}>{error}</p>
// After:
{error && (
  <ErrorBanner
    severity="error"
    message={translatedError}
    onDismiss={onDismissError}
    className="mx-4 mb-2"
  />
)}
```

Short transient errors → `useSnackBar()` toast (auto-dismiss).
Persistent VPN errors → `ErrorBanner` (user-dismissable, visible until dismissed).

### Pattern 4: Auth Mode Toggle via Button

```tsx
// Source: 03-UI-SPEC.md — Auth mode toggle style
// Current: raw <button> elements with inline style
// After: Button component, no raw buttons
<div className="grid grid-cols-2 gap-[var(--space-2)]">
  <Button
    variant={authMode === "password" ? "primary" : "ghost"}
    size="sm"
    onClick={() => setAuthMode("password")}
  >
    {t("control.auth_password")}
  </Button>
  <Button
    variant={authMode === "key" ? "primary" : "ghost"}
    size="sm"
    onClick={() => setAuthMode("key")}
  >
    {t("control.auth_key")}
  </Button>
</div>
```

### Pattern 5: ControlPanelPage Header — Tailwind Token Classes

```tsx
// Source: 03-UI-SPEC.md — ControlPanelPage Header
// Current: inline style={{ height: 52, backgroundColor: "var(...)", borderBottom: "..." }}
// After: Tailwind token classes only
<div className="h-[52px] flex items-center justify-end px-[var(--space-4)] shrink-0 bg-[var(--color-bg-primary)] border-b border-[var(--color-border)]">
  <Button variant="ghost" size="sm" onClick={handleDisconnect}>
    <LogOut className="w-3.5 h-3.5 mr-[var(--space-2)]" />
    {t("control.disconnect")}
  </Button>
</div>
```

Note: Button `icon` prop does not exist in Phase 2 API. Icons are placed as children inline with text.

### Pattern 6: UptimeCounter Token Styling

```tsx
// Source: 03-UI-SPEC.md — StatusPanel / uptime counter
// Current: style={{ color: "var(--color-text-muted)", minWidth: "5.5em" }}
// After: Tailwind token classes
<div className="flex items-center gap-[var(--space-1)] text-[var(--font-size-xs)] font-mono tabular-nums text-[var(--color-text-muted)]">
  <Clock className="w-3.5 h-3.5" aria-hidden="true" />
  <UptimeCounter since={connectedSince} />
</div>
```

### Anti-Patterns to Avoid

- **Inline style for token values:** `style={{ backgroundColor: "var(--color-bg-surface)" }}` → use Tailwind `bg-[var(--color-bg-surface)]`
- **Raw `<button>` elements inside form UI:** replace all with `Button` component
- **`colors.ts` imports:** `import { colors } from "../../shared/ui/colors"` → replace with token var inline or token Tailwind class
- **`variant="warning"` / `variant="success"` on Button:** these variants don't exist — use `"ghost"` (inactive/reconnect) and `"danger"` (disconnect)
- **`icon={}` prop on Button:** prop doesn't exist in API — place icon as first child before text
- **Hardcoded `text-[11px]`:** use `text-[var(--font-size-xs)]` via Tailwind mapped alias (`text-xs`)

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Status color semantics | Custom status styles | `StatusBadge` with Phase 2 tokens | Already has connected/connecting/error/disconnected, pulse animation |
| VPN error display | Inline `<p>` with `color-danger-400` | `ErrorBanner severity="error"` | Consistent severity variants, dismissable, role="alert" |
| Form field label/error composition | Manual `<label>` + `<p>` pairs | `FormField` component | Already handles required indicator, error > hint priority, role="alert" |
| SSH connect form container | Ad-hoc `<div>` with inline border/bg | `Card padding="lg"` | Consistent token-based surface/border/radius |
| Toast notifications | Custom error state | `useSnackBar()` | Already connected, SnackBarProvider wraps app |

**Key insight:** Phase 2 built all primitives specifically to handle the complexity these screens need. The only work in Phase 3 is composition, not construction.

---

## Runtime State Inventory

Step 2.5: SKIPPED — Phase 3 is a visual migration, not a rename/refactor/migration phase. No runtime state (stored data, service config, OS registrations, secrets) is affected.

---

## Environment Availability

Step 2.6: All required tools are project dependencies already installed in Phase 1+2.

| Dependency | Required By | Available | Fallback |
|------------|------------|-----------|----------|
| vitest | Test suite | ✓ (package.json) | — |
| Storybook 10 | Stories (SCR-12, DOC-03 adjacent) | ✓ (port 6006) | — |
| @tauri-apps/plugin-dialog | SshConnectForm file picker | ✓ mocked in Storybook | Storybook mock exists |

[VERIFIED: codebase scan — .storybook/tauri-mocks/ contains plugin-dialog.ts]

---

## Common Pitfalls

### Pitfall 1: Button variant mismatch — StatusPanel
**What goes wrong:** Current `StatusPanel.tsx` uses `variant="warning"` and `variant="success"` which are not in the Phase 2 Button API. The component silently renders without variant styles (CVA returns base classes only for unknown variants).
**Why it happens:** StatusPanel was not migrated in Phase 2 — it uses the old API surface.
**How to avoid:** Per UI-SPEC state matrix — `connecting/disconnecting/recovering` → `Button variant="ghost" disabled loading` (not `"warning"`); `disconnected/error` → `Button variant="ghost"` (not `"success"`); `connected` → `Button variant="danger"`.
**Warning signs:** StatusPanel button looks unstyled (no fill color) when in connecting state.

### Pitfall 2: Button `icon` prop doesn't exist in Phase 2 API
**What goes wrong:** Passing `icon={<LogOut .../>}` to Button does nothing — it spreads to `HTMLButtonElement` `...props` which ignores unknown props silently. The icon is never rendered.
**Why it happens:** The old API accepted `icon` as a named prop. Phase 2 Button removed it.
**How to avoid:** Place icon as inline children, before text label: `<Button><LogOut .../> {t("control.disconnect")}</Button>`
**Warning signs:** Button renders text only, no icon visible despite `icon={}` being passed.

### Pitfall 3: `vpnErrors.*` i18n keys do not exist yet
**What goes wrong:** UI-SPEC defines `vpnErrors.tunnelDown`, `vpnErrors.authFailed`, `vpnErrors.generic` keys for ErrorBanner messages, but `ru.json`/`en.json` only have `sshErrors.*` — no `vpnErrors.*` namespace exists.
**Why it happens:** These are new keys required by the Phase 3 ErrorBanner pattern.
**How to avoid:** Add `vpnErrors` namespace to both `ru.json` and `en.json` as part of Phase 3. This is a prerequisite for the ErrorBanner in StatusPanel.
**Warning signs:** `t("vpnErrors.tunnelDown")` returns the key string literally as fallback.

### Pitfall 4: `colors.ts` import in SshConnectForm
**What goes wrong:** `SshConnectForm.tsx` line 11: `import { colors } from "../../shared/ui/colors"`. Used for `colors.accentLogoGlow` on the server icon background. `colors.ts` is deprecated (to be deleted in Phase 6) but not yet removed.
**Why it happens:** SshConnectForm wasn't migrated in Phase 2.
**How to avoid:** Replace `colors.accentLogoGlow` with `bg-[var(--color-bg-elevated)]` (the elevated surface token, consistent with Phase 1 decision to use `bg-elevated` for icon containers). Do NOT import from colors.ts.
**Warning signs:** TypeScript error if colors.ts is deleted; functional regression if icon background loses its style.

### Pitfall 5: StatusPanel test text expectations will break
**What goes wrong:** `StatusPanel.test.tsx` expects `"Отключен"` and `"Подключен"` (short form), but after migration StatusBadge renders `"ОТКЛЮЧЕНО"` / `"ПОДКЛЮЧЕНО"` (uppercase, full form per `defaultLabels` in StatusBadge.tsx).
**Why it happens:** StatusBadge uses its own default labels, different from the current Badge + t() pattern.
**How to avoid:** Update test assertions to match StatusBadge's actual rendered text. OR pass `label` prop explicitly to StatusBadge using `t()` keys so tests and UI use the same string.
**Warning signs:** StatusPanel tests fail with text not found in document.

### Pitfall 6: Textarea (paste mode) inline height style
**What goes wrong:** Textarea in SshConnectForm key-paste mode uses `style={{ height: 100 }}`. This is a hardcoded inline style — UI-SPEC says "no hardcoded inline style" for this element.
**How to avoid:** Use Tailwind arbitrary value: `h-[100px]` (fixed functional constraint — 100px is intentional per UI-SPEC).
**Warning signs:** None functional — purely a style consistency violation against QA-04.

### Pitfall 7: `Button loading` prop renders Loader2 in Button, not the manual icon
**What goes wrong:** `Button` with `loading={true}` renders its OWN `Loader2` before children. If you also pass a `Loader2` as a child, you get double spinners.
**Why it happens:** Phase 2 Button auto-renders `<Loader2>` when loading prop is true.
**How to avoid:** When using `loading={true}` on Button, do NOT also pass Loader2 as child. Pass only text `{t("control.connecting")}`.
**Warning signs:** Two spinning icons side-by-side during connecting state.

---

## Code Examples

### StatusPanel — correct VPN state mapping

```tsx
// Source: 03-UI-SPEC.md VPN state to Button mapping + StatusBadge.tsx API
import { StatusBadge } from "../shared/ui/StatusBadge";
import { ErrorBanner } from "../shared/ui/ErrorBanner";
import { Button } from "../shared/ui/Button";

// StatusBadge variant mapping
const statusBadgeVariant = (status: VpnStatus) => {
  if (status === "connected") return "connected";
  if (status === "connecting" || status === "disconnecting" || status === "recovering") return "connecting";
  if (status === "error") return "error";
  return "disconnected";
};

// StatusPanel render (strip):
<div className="border-b border-[var(--color-border)]">
  <div className="px-[var(--space-4)] flex items-center justify-between h-[52px]">
    <div className="flex items-center gap-[var(--space-3)]">
      <StatusBadge variant={statusBadgeVariant(status)} label={t(`status.${...}`)} />
      {status === "connected" && connectedSince && (
        <div className="flex items-center gap-[var(--space-1)] text-xs font-mono tabular-nums text-[var(--color-text-muted)]">
          <Clock className="w-3.5 h-3.5" aria-hidden="true" />
          <UptimeCounter since={connectedSince} />
        </div>
      )}
    </div>
    <div>
      {status === "connected" && (
        <Button variant="danger" size="sm" onClick={onDisconnect}>
          <Power className="w-3.5 h-3.5" />
          {t("buttons.disconnect")}
        </Button>
      )}
      {status === "connecting" && (
        <Button variant="ghost" size="sm" onClick={onDisconnect}>
          <Power className="w-3.5 h-3.5" />
          {t("buttons.cancel")}
        </Button>
      )}
      {(status === "disconnecting" || status === "recovering") && (
        <Button variant="ghost" size="sm" disabled loading>
          {t(`status.${status}_short`)}
        </Button>
      )}
      {(status === "error" || status === "disconnected") && (
        <Button variant="ghost" size="sm" onClick={onConnect}>
          {t("buttons.connect")}
        </Button>
      )}
    </div>
  </div>
  {error && (
    <ErrorBanner
      severity="error"
      message={error}
      onDismiss={onDismissError}
      className="mx-[var(--space-4)] mb-[var(--space-2)]"
    />
  )}
</div>
```

### SshConnectForm — server icon header (replaces colors.ts)

```tsx
// Source: 03-UI-SPEC.md — Component Inventory / SshConnectForm layout
// Phase 1 decision: icon containers use bg-elevated
<div className="flex flex-col items-center mb-[var(--space-4)]">
  <div className="w-12 h-12 rounded-[var(--radius-lg)] flex items-center justify-center bg-[var(--color-bg-elevated)] mb-[var(--space-3)]">
    <Server className="w-6 h-6 text-[var(--color-accent-interactive)]" />
  </div>
  <h1 className="text-lg font-[var(--font-weight-semibold)] text-[var(--color-text-primary)] tracking-[var(--tracking-tight)]">
    {t("control.ssh_title")}
  </h1>
  <p className="text-xs text-[var(--color-text-muted)] mt-[var(--space-1)]">
    {t("control.ssh_description")}
  </p>
</div>
```

### i18n — vpnErrors namespace (add to both ru.json and en.json)

```json
// Source: 03-UI-SPEC.md — ErrorBanner copy for VPN errors
// Add to ru.json:
"vpnErrors": {
  "tunnelDown": "VPN-соединение потеряно. Проверьте подключение к серверу и нажмите Подключить.",
  "authFailed": "Ошибка аутентификации VPN. Проверьте конфигурацию сервера.",
  "generic": "Не удалось подключиться к VPN. Попробуйте снова."
}
// Add to en.json (mirror):
"vpnErrors": {
  "tunnelDown": "VPN connection lost. Check server connectivity and press Connect.",
  "authFailed": "VPN authentication failed. Check server configuration.",
  "generic": "Failed to connect to VPN. Try again."
}
```

---

## State of the Art

| Old Approach | Current Approach | Impact on Phase 3 |
|--------------|------------------|-------------------|
| `Badge` variant="success/warning/danger" for VPN status | `StatusBadge` variant="connected/connecting/error/disconnected" | StatusPanel must migrate to StatusBadge |
| `style={{ ... }}` inline for token values | Tailwind `bg-[var(--token)]` / `border-[var(--token)]` | All inline styles → Tailwind classes |
| `colors.accentLogoGlow` from colors.ts | `var(--color-bg-elevated)` or `var(--color-accent-interactive)` | Remove colors.ts import |
| Raw `<button>` in key mode toggle | `Button` component | Replace 2 raw buttons in SshConnectForm |
| Error inline `<p style={{ color: "var(--color-danger-400)" }}>` | `ErrorBanner severity="error"` | StatusPanel error area |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `colors.accentLogoGlow` should be replaced with `bg-[var(--color-bg-elevated)]` for the server icon container | Code Examples | Icon background color slightly different from current — minor visual diff, no regression |
| A2 | `StatusPanel` `onDismissError` prop needs to be added to the component interface to wire up ErrorBanner dismiss | Architecture Patterns | Component props interface design — planner must decide if prop is added or managed internally |

---

## Open Questions (RESOLVED)

1. **StatusPanel `onDismissError` prop design** — RESOLVED: Manage dismiss internally with `useState<boolean>(false)` — error resets on next status change. No new prop needed in parent.

2. **`control.connect` i18n value mismatch** — RESOLVED: Keep existing i18n key value (`"Подключиться"`) to preserve test compatibility and existing UX. UI-SPEC copy is aspirational — stored key takes precedence.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest + @testing-library/react |
| Config file | `gui-app/vite.config.ts` (test section, jsdom environment) |
| Quick run command | `cd gui-app && npx vitest run src/components/ControlPanelPage.test.tsx src/components/StatusPanel.test.tsx src/components/server/SshConnectForm.test.tsx` |
| Full suite command | `cd gui-app && npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCR-01 | ControlPanelPage renders SshConnectForm when no creds | unit | `npx vitest run src/components/ControlPanelPage.test.tsx` | ✅ |
| SCR-01 | ControlPanelPage renders header + ServerPanel when creds loaded | unit | same | ✅ |
| SCR-01 | Disconnect clears creds and shows SshConnectForm | unit | same | ✅ |
| SCR-01 | SshConnectForm connect button disabled with empty host | unit | `npx vitest run src/components/server/SshConnectForm.test.tsx` | ✅ |
| SCR-01 | SshConnectForm auth mode toggle switches UI | unit | same | ✅ |
| SCR-02 | StatusPanel renders StatusBadge for each VPN state | unit | `npx vitest run src/components/StatusPanel.test.tsx` | ✅ (needs assertion update — see Pitfall 5) |
| SCR-02 | StatusPanel shows ErrorBanner when error prop set | unit | same | ✅ (test needs update for ErrorBanner instead of `<p>`) |
| DOC-03 | Behavior spec file exists at memory/v3/screens/control-panel.md | manual | — | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd gui-app && npx vitest run src/components/ControlPanelPage.test.tsx src/components/StatusPanel.test.tsx src/components/server/SshConnectForm.test.tsx`
- **Per wave merge:** `cd gui-app && npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `memory/v3/screens/` directory — must be created (DOC-03 requirement)
- [ ] `memory/v3/screens/control-panel.md` — behavior spec file (DOC-03)
- [ ] `gui-app/src/components/StatusPanel.test.tsx` — assertions need updating for StatusBadge text and ErrorBanner presence (Pitfall 5)
- [ ] `gui-app/src/shared/i18n/locales/ru.json` and `en.json` — add `vpnErrors.*` keys before StatusPanel ErrorBanner can render translated text

---

## Security Domain

Phase 3 is visual-only migration. No new data flows, no new API surfaces, no authentication changes.

| ASVS Category | Applies | Note |
|---------------|---------|------|
| V2 Authentication | No | Auth logic unchanged — only visual presentation of auth mode toggle |
| V3 Session Management | No | Credential storage unchanged |
| V4 Access Control | No | No RBAC changes |
| V5 Input Validation | No | Port input strips non-digits — unchanged behavior, only styling |
| V6 Cryptography | No | SSH credential storage via Rust backend unchanged |

QA-04 compliance: all commits in this phase MUST contain only CSS/tokens/className changes — zero logic changes. Tests verify existing behavior is preserved.

---

## Sources

### Primary (HIGH confidence — verified by codebase scan)
- `gui-app/src/components/ControlPanelPage.tsx` — current implementation, 180 lines
- `gui-app/src/components/StatusPanel.tsx` — current implementation, confirms variant mismatch
- `gui-app/src/components/server/SshConnectForm.tsx` — current implementation, colors.ts usage
- `gui-app/src/shared/ui/StatusBadge.tsx` — Phase 2 API, variant names, defaultLabels
- `gui-app/src/shared/ui/Button.tsx` — Phase 2 API, confirmed 4 variants: primary/danger/ghost/icon
- `gui-app/src/shared/ui/Card.tsx` — Phase 2 API, padding lg = `p-[var(--space-5)]`
- `gui-app/src/shared/ui/ErrorBanner.tsx` — Phase 2 API, severity + onDismiss props
- `gui-app/src/shared/ui/FormField.tsx` — Phase 2 API, label/error/hint composition
- `gui-app/src/shared/ui/Input.tsx` — Phase 2 API, clearable + label + error props
- `gui-app/src/shared/ui/SnackBarContext.tsx` — Phase 2 API, useSnackBar() hook
- `gui-app/src/shared/ui/Badge.tsx` — confirmed it is NOT the same as StatusBadge
- `gui-app/src/shared/styles/tokens.css` — warning/destructive/status tokens verified
- `gui-app/src/shared/i18n/locales/ru.json` — confirmed vpnErrors namespace missing
- `gui-app/src/components/ControlPanelPage.test.tsx` — 16 tests covering all state transitions
- `gui-app/src/components/StatusPanel.test.tsx` — 9 tests covering all VPN states
- `gui-app/src/components/server/SshConnectForm.test.tsx` — 20 tests
- `.planning/phases/03-control-panel/03-UI-SPEC.md` — visual + interaction contract
- `memory/v3/design-system/known-issues.md` — Tailwind font-size gotcha, twMerge conflict
- `memory/v3/design-system/components.md` — Phase 2 component catalog

### Secondary (MEDIUM confidence — referenced)
- `.planning/REQUIREMENTS.md` — SCR-01, SCR-02, DOC-03 definitions
- `.planning/STATE.md` — current phase position, governance rules
- `memory/v3/decisions/phase-1-decisions.md` — palette, token architecture, glow deprecation

---

## Metadata

**Confidence breakdown:**
- Migration scope: HIGH — all source files read, all target APIs verified
- API mismatches: HIGH — confirmed by reading both source usage and Phase 2 component code
- i18n gaps: HIGH — confirmed by grep on ru.json
- Test update requirements: HIGH — confirmed by reading test assertions vs StatusBadge defaultLabels
- DOC-03 scope: HIGH — confirmed directory does not exist

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (stable — no fast-moving dependencies, all internal)
