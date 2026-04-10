# Phase 2: Update UX - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Render formatted release notes in the update dialog. Users see markdown headers, lists, bold/italic instead of raw text. Long changelogs scroll, not truncate. Applies to both gui-app and gui-light.

</domain>

<decisions>
## Implementation Decisions

### Markdown Rendering
- **D-01:** Use `react-markdown` library for rendering. Standard React approach, supports custom component styling, good React 19 compatibility.
- **D-02:** Install `react-markdown` in both gui-app and gui-light `package.json`.

### Visual Presentation
- **D-03:** Changelog displayed in a **modal dialog** — separate overlay window with full markdown rendering, not inline in AboutPanel.
- **D-04:** Trigger: a "What's new" / "Что нового" button next to the update/download button. Click opens the modal with full changelog.
- **D-05:** Modal has scrollable content area (overflow-y: auto) with max-height to fit within the window.

### Styling
- **D-06:** Markdown styling follows existing app design tokens — use CSS variables (--color-text-*, --color-surface-*) for consistency.
- **D-07:** Compact typography — text-sm base, text-xs for secondary. Headers scaled appropriately within the compact space.

### Scope
- **D-08:** Changes apply to both gui-app (AboutPanel.tsx) and gui-light (AboutScreen.tsx).
- **D-09:** The existing single-line truncated preview remains in the main panel. Modal shows the full formatted changelog on demand.

### Claude's Discretion
- Modal component implementation (new component or reuse existing pattern)
- Close behavior (X button, backdrop click, Escape key)
- i18n keys for "What's new" button label

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Code (modification targets)
- `gui-app/src/components/AboutPanel.tsx` — Current update section with truncated releaseNotes
- `gui-light/src/components/AboutScreen.tsx` — Light equivalent, same pattern
- `gui-app/src/shared/types.ts` — UpdateInfo type with releaseNotes: string
- `gui-light/src/shared/types.ts` — Same type definition
- `gui-app/src/shared/hooks/useUpdateChecker.ts` — Fetches releaseNotes from GitHub API (data.body)

### i18n
- `gui-app/src/shared/i18n/locales/ru.json` — Russian translations
- `gui-app/src/shared/i18n/locales/en.json` — English translations
- `gui-light/src/shared/i18n/locales/ru.json` — Light Russian
- `gui-light/src/shared/i18n/locales/en.json` — Light English

</canonical_refs>

<specifics>
## User Specifics

- Modal approach chosen to keep the main AboutPanel clean while allowing full changelog viewing
- react-markdown preferred over marked (more React-idiomatic, no innerHTML/sanitization concerns)

</specifics>

<deferred>
## Deferred Ideas

None.
</deferred>
