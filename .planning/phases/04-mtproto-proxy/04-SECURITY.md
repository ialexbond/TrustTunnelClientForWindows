---
phase: 04
slug: mtproto-proxy
status: verified
threats_open: 0
asvs_level: 1
created: 2026-04-15
---

# Phase 04 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| User input → Tab navigation | Tab click handler receives only typed AppTab values | AppTab union type (5 string literals) |
| Title bar → Window actions | WindowControls calls Tauri API (minimize/maximize/close) | Window management commands (no user data) |
| localStorage → AppTab state | Startup reads config presence, not tab state | Boolean (config exists or not) |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-04-01 | Tampering | i18n JSON files | accept | JSON bundled at build time, no runtime loading from untrusted sources | closed |
| T-04-02 | Information Disclosure | Header.tsx deletion | accept | Dead code removal reduces attack surface | closed |
| T-04-03 | Spoofing | TabNavigation disabled tabs | accept | hasConfig removed during execution — all tabs always accessible by design, no disabled state to spoof | closed |
| T-04-04 | Denial of Service | data-tauri-drag-region | accept | Drag region on non-interactive elements only; WindowControls has WebkitAppRegion: "no-drag" | closed |
| T-04-05 | Tampering | WindowControls close | accept | close() calls Tauri API for OS-level window close | closed |
| T-04-06 | Spoofing | localStorage tabMap migration | accept | AppTab is TypeScript union type preventing arbitrary values; startup ignores localStorage tab state entirely | closed |
| T-04-07 | Tampering | activeTab state | accept | Internal React state typed as AppTab — cannot be set to arbitrary values from outside | closed |
| T-04-08 | Information Disclosure | ServerSidebar disconnect | accept | Pre-existing functionality, no new exposure | closed |
| T-04-09 | Information Disclosure | memory/v3/ docs | accept | Documentation files are gitignored, not exposed in production builds | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-04-01 | T-04-03 | Original mitigate→accept: hasConfig removed, all tabs always accessible — no spoofing vector | gsd-secure-phase | 2026-04-15 |
| AR-04-02 | T-04-06 | Original mitigate→accept: startup ignores localStorage tab, AppTab union type enforces valid values | gsd-secure-phase | 2026-04-15 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-04-15 | 9 | 9 | 0 | gsd-secure-phase (inline) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-04-15
