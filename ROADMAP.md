# TrustTunnel Client for Windows — Roadmap v2.0

## Vision

Version 2.0 transforms TrustTunnel Client from a simple VPN connector into a **server management dashboard** with advanced routing, real-time statistics, and a fresh redesigned interface.

Two products will share the same design language:

- **TrustTunnel Pro** — full-featured server management & VPN client
- **TrustTunnel Light** — minimalist "import config → connect → go" client for end users

---

## v2.0-alpha — Foundation

> New architecture, design system, and core UX improvements

- [ ] **Shared UI Component Library** (`shared/ui/`)
    - Reusable components: Button, Toggle, Card, Input, Badge, Select, Modal, PasswordInput, ErrorBanner, Tooltip
    - Shared between Pro and Light versions
- [ ] **New Design System**
    - CSS Variables instead of hardcoded Tailwind classes
    - Dark + Light theme support out of the box
    - Fresh color palette (departing from v1.x indigo/glass-morphism)
- [ ] **Internationalization (i18n)**
    - `react-i18next` with Russian and English locales
    - On-the-fly language switching (RU ↔ EN)
    - Auto-detection via `navigator.language`
- [ ] **Collapsible Sidebar Navigation**
    - Windows 11-style: collapsed = icons only, expanded = icons + labels
    - Menu order: Server → VPN Settings → Dashboard → Routing → Logs → About
    - Smooth transition animation
- [ ] **Global StatusPanel**
    - Connection status visible on ALL pages (not just Settings tab)
    - Protocol badge (H2 / H3), uptime counter, speed indicators
- [ ] **Component Decomposition**
    - Split SetupWizard (56KB) into 6 step components
    - Split SettingsPanel (30KB) into section components
    - Extract DangerZone into standalone component
- [ ] **Fix Reconnect Race Condition**
    - Replace `setTimeout(500ms)` with proper async: await disconnect → wait for `vpn-status: disconnected` event → connect

---

## v2.0-beta — Features

> Advanced routing, dashboard, and power-user features

- [ ] **Per-Process Routing**
    - Route traffic by application (e.g., browser through VPN, Steam direct)
    - C++ `ProcessFilter` class using existing `app_name` data in `VpnConnection`
    - UI: process list with VPN / Direct / Block actions
- [ ] **GeoIP Routing**
    - MaxMind GeoLite2 / DB-IP integration
    - Route by country code (e.g., RU → bypass, CN → tunnel)
    - UI: country list with toggle actions
- [ ] **Dashboard**
    - Real-time download/upload speed charts
    - Total session traffic (bytes in/out)
    - Latency to endpoint
    - Server load (CPU, RAM) via SSH
    - Session history
- [ ] **Enhanced Log Viewer**
    - Filter by level (Error / Warn / Info / Debug / All)
    - Text search
    - Export to file
    - Auto-scroll toggle with timestamps
- [ ] **Server Management Panel**
    - Server status (online/offline, version, uptime)
    - Deploy / update via SSH
    - Diagnostics (`diagnose_server`)
    - Certificate management
- [ ] **Extended System Tray**
    - Connect / Disconnect actions
    - Status display with protocol and uptime
    - Quick profile switching
- [ ] **Keyboard Shortcuts**
    - `Ctrl+Shift+C` — Connect / Disconnect toggle
    - `Ctrl+1..6` — Navigate sidebar sections
    - `Escape` — Minimize to tray
- [ ] **Server Profiles**
    - Multiple .toml configs with friendly names
    - Quick switching via dropdown
- [ ] **SOCKS5 Proxy UI**
    - Toggle + port configuration in settings
- [ ] **Server Health Check**
    - TCP ping to endpoint before connecting
    - Indicator: 🟢 reachable / 🔴 unreachable / latency

---

## v2.0-light — Light Version

> Separate app for non-technical users

- [ ] **Create `gui-light/` application**
    - Built on shared UI component library
    - Compact window (400-500px width)
- [ ] **Connect Screen**
    - Import .toml config (file picker or deep-link)
    - Large connect/disconnect button
    - Basic speed + uptime display
- [ ] **Simplified Routing**
    - Domain-based split tunneling only
    - No per-process or GeoIP rules
- [ ] **Essential Features**
    - Auto-update
    - System tray (connect/disconnect + status)
    - i18n (RU / EN)
    - Dark / Light theme

---

## v2.0-release — Polish

> Final testing, consistency, and quality

- [ ] Cross-app design consistency (Pro ↔ Light)
- [ ] Dark + Light theme polish
- [ ] Edge case handling and error recovery
- [ ] Performance optimization
- [ ] Documentation update

---

## Architecture

```text
trusttunnel/
├── shared/                 ← Shared library (Pro + Light)
│   ├── ui/                 ← Reusable UI components
│   ├── hooks/              ← Shared React hooks
│   ├── i18n/               ← Translations (ru.json, en.json)
│   └── types/              ← TypeScript types
├── gui-app/                ← Pro version
│   ├── src/components/     ← Pro-specific components
│   └── src-tauri/          ← Full Rust backend (incl. SSH)
├── gui-light/              ← Light version
│   ├── src/components/     ← Simple components
│   └── src-tauri/          ← Reduced backend (no SSH)
└── core/                   ← C++ VPN engine (shared)
```

---

## Technical Highlights

| Feature | Status in v1.x | Plan for v2.0 |
|---------|---------------|---------------|
| Per-process routing | `app_name` captured but unused | New `ProcessFilter` class in C++ core |
| GeoIP routing | Not implemented | MaxMind integration in `tunnel.cpp` |
| Connection stats | Not shown | Parse sidecar output + Windows API |
| i18n | Hardcoded Russian | `react-i18next` with RU/EN |
| Theme | Dark only | CSS Variables, dark + light |
| Navigation | Horizontal tabs | Collapsible sidebar |
| StatusPanel | Settings tab only | Global, always visible |
| Reconnect | `setTimeout(500ms)` | Proper async event-driven flow |
