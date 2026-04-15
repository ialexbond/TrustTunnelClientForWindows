---
phase: 02
slug: ssh-port-change-core-engine
status: verified
threats_open: 0
asvs_level: 1
created: 2026-04-14
---

# Phase 02 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| npm registry → package.json | Third-party packages installed from npm | Code execution |
| User className prop → component rendering | Consumer can inject arbitrary Tailwind classes | CSS classes (visual only) |
| User input → Input component | Text input values rendered in DOM | String values |
| children prop → Modal content | Arbitrary React content rendered inside modal | React nodes |
| Tooltip content → DOM | User-provided tooltip text rendered | String content |
| Select options → DOM rendering | Options array rendered as dropdown items | String labels |
| SnackBar message → DOM | Consumer message displayed to user | String messages |
| StatusBadge variant → visual state | Variant prop determines displayed VPN status | Enum value |
| value prop → width style | Numeric value converted to percentage width | Number 0-100 |
| index.ts barrel export → consumers | Public API surface for all UI components | Module re-exports |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-02-01-01 | Tampering | npm packages (CVA, tailwind-merge, clsx) | mitigate | Pinned in package.json + package-lock.json; >10M weekly downloads | closed |
| T-02-01-02 | Information Disclosure | className prop injection | accept | className only affects CSS classes (visual), no data exposure; standard React pattern | closed |
| T-02-02-01 | Spoofing | Input clearable callback | accept | Clearable triggers consumer's onChange with empty string; consumer controls behavior | closed |
| T-02-02-02 | Information Disclosure | PasswordInput show/hide | accept | Standard pattern; toggle is local state, not API-exposed | closed |
| T-02-03-01 | Tampering | Modal overlay click bypass | accept | Standard modal pattern; escape key + overlay click to close | closed |
| T-02-03-02 | Denial of Service | Tooltip rapid hover | accept | Standard CSS transition; no API calls triggered by hover | closed |
| T-02-04-01 | Spoofing | Select keyboard events | accept | Keyboard handlers only navigate options list; no data mutation | closed |
| T-02-04-02 | Information Disclosure | SnackBar auto-dismiss | accept | Consumer-provided messages, no secrets exposed | closed |
| T-02-04-03 | Tampering | PanelErrorBoundary error display | accept | Error boundary catches React errors; componentStack shown only in dev mode | closed |
| T-02-05-01 | Spoofing | StatusBadge variant mismatch | accept | Display-only component; actual VPN state comes from Rust backend | closed |
| T-02-05-02 | Tampering | Section collapsible state | accept | Local UI state only; no backend data affected by collapse/expand | closed |
| T-02-06-01 | Tampering | ProgressBar value overflow | mitigate | Math.min(100, Math.max(0, value)) clamping verified in ProgressBar.tsx:17 | closed |
| T-02-06-02 | Tampering | Separator label XSS | accept | React auto-escapes string content; label is a string prop, not dangerouslySetInnerHTML | closed |
| T-02-07-01 | Tampering | index.ts re-exports | accept | Barrel exports only re-export; no logic, no data flow | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-02-01-02 | className — standard React pattern, visual only | Claude audit | 2026-04-14 |
| AR-02 | T-02-02-01 | Input clearable — consumer-controlled callback | Claude audit | 2026-04-14 |
| AR-03 | T-02-02-02 | Password toggle — standard UX, local state | Claude audit | 2026-04-14 |
| AR-04 | T-02-03-01 | Modal overlay — standard pattern | Claude audit | 2026-04-14 |
| AR-05 | T-02-03-02 | Tooltip hover — CSS only, no API calls | Claude audit | 2026-04-14 |
| AR-06 | T-02-04-01 | Select keyboard — navigation only | Claude audit | 2026-04-14 |
| AR-07 | T-02-04-02 | SnackBar — consumer messages | Claude audit | 2026-04-14 |
| AR-08 | T-02-04-03 | ErrorBoundary — dev mode only | Claude audit | 2026-04-14 |
| AR-09 | T-02-05-01 | StatusBadge — display only, state from Rust | Claude audit | 2026-04-14 |
| AR-10 | T-02-05-02 | Section collapse — local UI state | Claude audit | 2026-04-14 |
| AR-11 | T-02-06-02 | Separator label — React auto-escaping | Claude audit | 2026-04-14 |
| AR-12 | T-02-07-01 | Barrel exports — no logic | Claude audit | 2026-04-14 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-04-14 | 14 | 14 | 0 | Claude gsd-secure-phase |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-04-14
