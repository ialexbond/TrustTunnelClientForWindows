# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TrustTunnel Client for Windows — VPN client with two GUI editions sharing a common C++ VPN core:

- **gui-app/** — Pro edition (8-panel sidebar, SSH deployment, full routing UI)
- **gui-light/** — Light edition (4-screen bottom-nav, simplified UI)

Both editions are Tauri v2 apps (Rust backend + React frontend) that spawn a C++ sidecar (`trusttunnel_client.exe`) for VPN operations.

## Architecture

```
┌──────────────┐  ┌──────────────┐
│   gui-app    │  │  gui-light   │   React 19 + TypeScript + Tailwind
│  (Tauri v2)  │  │  (Tauri v2)  │   Vite bundler
└──────┬───────┘  └──────┬───────┘
       │                 │
       └────────┬────────┘
                │ Tauri Commands (Rust)
       ┌────────┴────────┐
       │   src-tauri/    │   VPN lifecycle, config, routing, SSH
       └────────┬────────┘
                │ Sidecar spawn (stdio)
       ┌────────┴────────┐
       │ trusttunnel/    │   C++ wrapper: config parsing, process filters
       ├─────────────────┤
       │    core/        │   VPN state machine, tunnel, DNS proxy
       ├─────────────────┤
       │    net/         │   TLS, HTTP/2, QUIC, WinTUN, WFP firewall
       ├─────────────────┤
       │    tcpip/       │   lwip TCP/IP stack
       └─────────────────┘
```

## Build Commands

### C++ Core (sidecar)

```bash
# Full build (requires MSVC Developer Command Prompt)
make init              # Install Conan deps + setup CMake
make build_trusttunnel_client

# Or manually:
cd build && cmake --build . --target trusttunnel_client --config RelWithDebInfo
```

### Tauri GUI (both editions)

```bash
cd gui-app && npm install --legacy-peer-deps
cd gui-app && npm run tauri build -- --bundles nsis    # NSIS installer
cd gui-app && npm run tauri dev                        # Dev mode

cd gui-light && npm install --legacy-peer-deps
cd gui-light && npm run tauri build -- --bundles nsis
cd gui-light && npm run tauri dev
```

### Custom Installer (optional, in `installer/`)

```bash
cd installer && cargo build --release
```

## Testing

```bash
# Rust (Tauri backend)
cd gui-app/src-tauri && cargo check
cd gui-light/src-tauri && cargo check

# TypeScript type checking
cd gui-app && node_modules/.bin/tsc --noEmit
cd gui-light && node_modules/.bin/tsc --noEmit

# Frontend unit tests (Vitest)
cd gui-app && npx vitest run
cd gui-light && npx vitest run

# Run specific test file
cd gui-app && npx vitest run src/components/routing/ProcessFilterSection.test.tsx

# Linting (all)
make lint
make lint-cpp          # clang-format + clangd-tidy
make lint-rust         # cargo clippy
make lint-md           # markdownlint
```

## Key Patterns

### Sidecar Integration

The C++ VPN engine runs as a separate process (`trusttunnel_client.exe`), bundled via Tauri's `externalBin`. Communication is through TOML config files, not IPC:

- `gui-app/src-tauri/src/sidecar.rs` — spawn/kill management
- `gui-app/src-tauri/src/commands/vpn.rs` — `resolve_and_apply()` writes config BEFORE spawning sidecar

### Routing Rules Engine

Three-tier routing: domains/IPs → process filters → DNS-level blocking.

- **Domain routing** (`routing_rules.rs`): resolves GeoIP/GeoSite databases, writes `exclusions.txt` + `blocked.txt`
- **Process filtering** (`trusttunnel/src/client.cpp`): resolves PID via `GetExtendedTcpTable`, applies `VPN_CA_FORCE_BYPASS` / `VPN_CA_FORCE_REDIRECT`
- **DNS blocking** (`core/src/dns_handler.cpp`): drops queries for blocked domains

### Portable Data Directory

`portable_data_dir()` returns the exe's parent directory. All config/data stored alongside the binary:

- `trusttunnel_client.toml` — VPN server config
- `routing_rules.json` — user routing rules (direct/proxy/block/processes)
- `resolved/` — pre-resolved exclusion/process filter files for C++ core
- `geodata/` — GeoIP/GeoSite v2ray databases

### VPN Modes

- **General**: all traffic through VPN, `direct` entries bypass
- **Selective**: all traffic direct, `proxy` entries go through VPN
- Process filters override both modes independently

### Feature Toggles

Experimental features hidden behind localStorage flags (`useFeatureToggles.ts`):

- `blockRouting` — DNS-level site blocking section

### Dual Edition Differences

| Feature | Pro (gui-app) | Light (gui-light) |
|---------|--------------|-------------------|
| Window | 1020×640, sidebar | 420×680, bottom nav |
| SSH Deploy | Yes | No |
| Dashboard | Yes | No |
| Process Filter | Yes | Yes |
| Custom Titlebar | Yes (`decorations: false`) | Yes |

## Important Files

### Rust Backend (both editions share structure)

- `src-tauri/src/lib.rs` — module registration, tray icon, window lifecycle
- `src-tauri/src/commands/vpn.rs` — VPN connect/disconnect/status
- `src-tauri/src/commands/config.rs` — config file management + fs watcher
- `src-tauri/src/routing_rules.rs` — routing engine (resolve, apply, TOML update)
- `src-tauri/src/processes.rs` — `list_running_processes` via Win32 API
- `src-tauri/src/sidecar.rs` — sidecar spawn with stdio logging
- `src-tauri/src/commands/updater.rs` — GitHub releases auto-update

### C++ Core

- `trusttunnel/src/client.cpp` — VPN event handler, process-based routing
- `trusttunnel/src/config.cpp` — TOML config parser, loads process filter files
- `core/src/dns_handler.cpp` — DNS routing decision (general/selective mode)
- `core/src/tunnel.cpp` — connection lifecycle, `finalize_connect_action()`
- `net/src/os_tunnel_win.cpp` — WinTUN adapter + WFP firewall

### Frontend

- `src/App.tsx` — root component, VPN state management
- `src/components/routing/useRoutingState.ts` — routing rules CRUD + dirty tracking
- `src/components/routing/ProcessFilterSection.tsx` — process filter UI
- `src/shared/hooks/useVpnActions.ts` — VPN connect/disconnect logic
- `src/shared/i18n/locales/{ru,en}.json` — translations

### Installer

- `src-tauri/nsis/installer-hooks.nsh` — pre/post-uninstall cleanup (kill sidecar, registry, data)
- `src-tauri/nsis/{Russian,English}.nsh` — NSIS UI strings
- `src-tauri/tauri.conf.json` — bundle config (resources, sidecar, NSIS settings)

## Configuration

- **Rust toolchain**: `rust-toolchain.toml` → channel 1.88
- **C++ standard**: C++20 (MSVC)
- **C++ deps**: Conan 2 (`conanfile.py`) — OpenSSL, libev, fmt, nghttp2/3, ngtcp2, etc.
- **NSIS languages**: Russian (default), English

## Version Management

Version must be updated in 6 files simultaneously:

1. `gui-app/package.json`
2. `gui-app/src-tauri/Cargo.toml`
3. `gui-app/src-tauri/tauri.conf.json` (version + window title)
4. `gui-light/package.json`
5. `gui-light/src-tauri/Cargo.toml`
6. `gui-light/src-tauri/tauri.conf.json` (version + window title)

## Language

All user-facing text in Russian. Code comments and variable names in English. Communicate with the developer in Russian (`feedback_language.md`).
