# Phase 3: Credential Generator - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Add random username/password generator icons inside VPN user form inputs. Icons appear in the deploy wizard (AddUserForm/ServerStep) and server panel (UsersSection). Applies to gui-app primarily, with shared utility in gui-light for future use.

</domain>

<decisions>
## Implementation Decisions

### Icon Placement
- **D-01:** Generator icon placed **inside the input field on the right side**
- **D-02:** For username field: generator icon on the right (field has no other icons)
- **D-03:** For password field: generator icon on the right, **before** the existing Eye/EyeOff toggle. Two icons on the right: [generate] [eye]
- **D-04:** Icon from lucide-react (consistent with existing codebase). Suggested: `Shuffle` or `Dices` icon.

### Generation Format
- **D-05:** Username format: **readable word-based** — use a small hardcoded adjective+noun wordlist (e.g., "swift-fox", "bold-eagle", "fast-wolf") + optional 2-digit suffix for uniqueness. Must produce valid VPN usernames (a-zA-Z0-9._- charset).
- **D-06:** Password format: **random chars** — 16 characters, mix of a-zA-Z0-9 and special chars (!@#$%^&*). Strong random password.
- **D-07:** Generation logic is pure TypeScript (no external libs, no Rust backend needed). Use `crypto.getRandomValues()` for secure randomness.

### Scope
- **D-08:** Changes apply to **both gui-app and gui-light**. Create shared generator utility that both editions can import. gui-light doesn't have user forms yet but will have the utility ready.
- **D-09:** In gui-app, generator icons appear in:
  - `gui-app/src/components/wizard/AddUserForm.tsx` (deploy wizard)
  - `gui-app/src/components/server/UsersSection.tsx` (server panel add-user form)

### Claude's Discretion
- Exact wordlist for username generation (keep small — 20-30 adjective+noun pairs)
- Password generation function signature and placement (suggested: shared/utils/credentialGenerator.ts)
- i18n tooltip text for the generator icon
- Visual styling (size, color, hover effect) — follow existing Eye icon pattern

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Code (modification targets)
- `gui-app/src/components/wizard/AddUserForm.tsx` — Wizard user form (username + password inputs)
- `gui-app/src/components/server/UsersSection.tsx` — Server panel add-user form
- `gui-app/src/components/wizard/useWizardState.ts` — Wizard state (newUsername, newPassword setters)

### Patterns to follow
- `gui-app/src/components/wizard/AddUserForm.tsx:46-51` — Eye/EyeOff icon pattern in password field (absolute positioning, styling)

</canonical_refs>

<specifics>
## User Specifics

- Username must contain "more or less understandable words" — not random gibberish
- Password must be random chars/letters/digits mix — not word-based
- Both editions get the utility, even though gui-light currently has no user forms

</specifics>

<deferred>
## Deferred Ideas

None.
</deferred>
