# TrustTunnel Client for Windows — Roadmap

## v2.0.0 (Released)

Two editions sharing the same design language and VPN core:

-   **TrustTunnel Pro** — full-featured server management and VPN client
-   **TrustTunnel Light** — minimalist "import config, connect, go" client

### Completed

-   Shared UI component library (Button, Card, Badge, Toggle, Input, Modal, etc.)
-   CSS Variables design system with dark and light themes
-   Internationalization (Russian, English) with on-the-fly switching
-   Collapsible sidebar navigation (Pro), bottom icon bar (Light)
-   Global StatusPanel on all pages
-   GeoIP and GeoSite routing (v2ray databases)
-   Dashboard with ping, server stats, speed test
-   Enhanced log viewer with filtering and search
-   Server management via SSH (deploy, update, diagnostics, users, certs)
-   Keyboard shortcuts
-   SOCKS5 proxy mode toggle
-   Config file watcher with auto-detection
-   Global SnackBar notification system
-   NSIS installer with Russian localization
-   Portable builds for both editions

---

## v2.1.0 (Planned)

-   Server profiles (multiple configs with quick switching)
-   Per-process routing UI
-   Connection history and session statistics
-   Extended system tray (quick profile switch, status display)
-   `client_random_prefix` support for anti-detection
-   Improved error handling for auth failures (HTTP 407)
