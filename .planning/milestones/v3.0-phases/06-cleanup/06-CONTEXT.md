# Phase 6: Cleanup — Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

> Phase 6 is the final milestone phase. Most cleanup was already done during Phase 5 code review session.
> This phase finishes what remains: rgba tokenization, !important removal, todo cleanup.

<domain>
## Phase Boundary

Phase 6 delivers **final quality cleanup** for TrustTunnel v3.0 milestone:

- **rgba() tokenization** — create tint tokens in tokens.css, migrate all 42 inline rgba() values
- **!important cleanup** — remove 2 remaining !important overrides, fix specificity
- **Todo closure** — verify and delete resolved todo files
- **Legacy artifact removal** — surface palette in tailwind.config.js if present

NOT in scope:
- New features or screens
- Visual redesign (done in Phase 5)
- Multi-server functionality (future milestone)
</domain>

<decisions>
## Implementation Decisions

### rgba() Tokenization
- **D-01:** Tokenize ALL 42 inline rgba() values — create ~20 tint tokens in tokens.css
- **D-02:** Token naming: `--color-{status}-tint-{opacity}` (e.g., `--color-success-tint-06`, `--color-danger-tint-25`)
- **D-03:** Overlay tokens: `--color-overlay-40`, `--color-overlay-50` for black overlays
- **D-04:** Each unique rgba() gets its own token — no approximation or consolidation

### !important Cleanup
- **D-05:** Remove 2 remaining !important in index.css — increase selector specificity instead
- **D-06:** Remove legacy `surface.*` palette from tailwind.config.js if present

### Todo Closure
- **D-07:** Check each of 16 todo files against current codebase state
- **D-08:** Delete resolved todos (verified by grep/code inspection)
- **D-09:** Keep only genuinely unresolved todos (if any)

### Already Completed (Phase 5 code review)
These items from known-issues.md are DONE — do not re-do:
- ✅ colors.ts deleted (16 files migrated to CSS tokens)
- ✅ font-semibold → font-[var(--font-weight-semibold)] (24 files)
- ✅ Button/Badge CVA variants fixed (icon prop, secondary, danger-outline, size, default)
- ✅ Dead code removed (SetupWizard import, wizardResetRef, reboot polling dupe)
- ✅ i18n hardcodes replaced (ConfirmDialog, EmptyState, WindowControls)
- ✅ 9 Rust warnings → 0
- ✅ Input font-size consistency (text-sm everywhere)
- ✅ Vite warnings fixed (dynamic import, chunk size limit)
</decisions>

<specifics>
## Specific Requirements

- Tokens must work in BOTH dark and light themes — test with `[data-theme]` toggle
- rgba values with theme-dependent base colors (success/danger/warning) should use the semantic color as base
- After cleanup, `npm run prerelease` must pass cleanly (typecheck + lint + test + clippy + build)
- memory/v3/ documentation updated to reflect final state
</specifics>

<canonical_refs>
## Reference Files

- `gui-app/src/shared/styles/tokens.css` — token definitions (add new tint tokens here)
- `gui-app/src/index.css` — global styles (!important targets)
- `gui-app/tailwind.config.js` — check for legacy surface palette
- `memory/v3/design-system/known-issues.md` — cleanup targets list
- `memory/v3/design-system/tokens.md` — token documentation to update
</canonical_refs>

<deferred>
## Deferred Ideas

- a11y testing via vitest-axe — separate phase
- Playwright E2E regression suite — separate effort
- ~15 dead i18n keys cleanup (tabs.server, tabs.dashboard, sidebar.*) — can be done in this phase if time allows
</deferred>
