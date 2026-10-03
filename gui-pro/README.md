# TrustTunnel Client Pro — dev README

Internal developer README for the **Pro** desktop VPN client (Windows).
Stack: **Tauri 2** + **React 19** + **Rust** (frontend `src/`, backend `src-tauri/`).
This is the development reference (architecture, scripts, build) — not the public/contributor
documentation. For project process and conventions see the repo root `CLAUDE.md`.

## Architecture

```text
gui-pro/
├── src/                       # React 19 frontend (Vite + Tailwind)
│   ├── App.tsx                # App shell: composes layout + the per-tab panels
│   ├── main.tsx               # Entry point
│   ├── components/
│   │   ├── layout/            # Window shell — TitleBar, TabNavigation, WindowControls
│   │   ├── ControlPanelPage.tsx   # «Панель управления» (server management via SSH)
│   │   ├── ConnectionPanel.tsx    # «Подключение» (VPN connect / status / logs)
│   │   ├── RoutingPanel.tsx       # «Маршрутизация»
│   │   ├── AppSettingsPanel.tsx   # «Настройки»
│   │   ├── AboutPanel.tsx         # «О программе» (version + build hash)
│   │   └── server/ routing/ settings/ dashboard/ wizard/ welcome/  # section sub-trees
│   ├── shared/
│   │   ├── ui/                # Shared design-system components (Button, Card, Section, …)
│   │   ├── hooks/             # Shared React hooks (VPN events, theme, language, tabs, …)
│   │   ├── context/          # React contexts (VpnContext, …)
│   │   ├── styles/           # tokens.css — the single source of design tokens
│   │   └── i18n/             # ru.json (primary) + en.json
│   └── docs/                 # In-app docs content
├── src-tauri/                 # Tauri backend (Rust, edition 2021)
│   ├── src/
│   │   ├── lib.rs            # run(): builds the app, registers the invoke_handler
│   │   ├── main.rs           # Binary entry point (calls into lib)
│   │   ├── commands/         # Tauri commands, grouped by domain (see below)
│   │   ├── sidecar.rs        # Spawns / supervises the C++ VPN-core process
│   │   ├── lifecycle.rs      # Process lifecycle (shutdown, kill, recovery)
│   │   ├── ssh/              # SSH client used by «Панель управления»
│   │   └── …                # tray.rs, routing_rules.rs, logging.rs, connectivity.rs, …
│   ├── trusttunnel_client-x86_64-pc-windows-msvc.exe   # prebuilt C++ VPN-core (sidecar)
│   ├── wintun.dll, vcruntime140.dll, vcruntime140_1.dll  # runtime deps; only wintun.dll is bundled
│   ├── capabilities/         # Tauri 2 permissions (default.json)
│   ├── nsis/                 # NSIS installer hooks + RU/EN language files
│   ├── Cargo.toml
│   ├── tauri.conf.json       # Production config
│   └── tauri.dev.conf.json   # Dev overrides (window title «[DEV]», dev identifier)
```

### Tauri commands (`src-tauri/src/commands/`)

Tauri commands are organised by domain inside `commands/` — **not** in `lib.rs`. Each module is
declared in `commands/mod.rs` and every command is wired into the `invoke_handler` in `lib.rs`.

| Module | Responsibility |
|---|---|
| `vpn.rs` | VPN connect/disconnect, status (`vpn_connect`, `vpn_disconnect`, `check_vpn_status_full`, …) |
| `ssh_commands.rs` | Server deploy/diagnose, SSH credentials, host-key handling |
| `config.rs` | Reading/writing the VPN config |
| `network.rs` | Network/connectivity helpers |
| `geoip.rs` | GeoIP lookups |
| `updater.rs` | App update checks |
| `history.rs` | Connection history |
| `deeplink.rs` | `tt://` deep-link import |
| `protocol.rs` | URL-protocol registration + cold-start deep-link capture |
| `activity_log.rs` | Activity log |

## C++ VPN-core via Tauri sidecar

The tunnel, the WinTUN adapter, route interception and the killswitch belong to a separate **C++
core** (`trusttunnel_client-*.exe`). Rust/Tauri only spawns and kills that process — it never
implements tunnelling itself.

**Its sources ARE in this repository**, on the `release/tt-win-3.0.0` branch and in the release tags;
they were removed from `master` when that branch was trimmed to the application. Only the compiled
binary is absent (it is gitignored) — build it with the recipe in the root `CLAUDE.md`. The shipped
core version is `1.1.5`, synced from upstream on 2026-09-04.

> This paragraph used to say the sources were "not in this repository", and the sentence sat on the
> very branch that carries them. It was true before the core sync and has been wrong since.

### Where the sidecar binary lives

The prebuilt binary sits **directly in `src-tauri/`** (next to `Cargo.toml`), with a platform
**target-triple** suffix in its name:

```text
gui-pro/src-tauri/
  trusttunnel_client-x86_64-pc-windows-msvc.exe   # Windows x64 (the shipped target)
```

Three runtime DLLs live alongside it on disk — `wintun.dll`, `vcruntime140.dll`,
`vcruntime140_1.dll` — but **only `wintun.dll` is bundled into the installer** (see the config
below). In a git worktree these files are not duplicated — copy them in from the main checkout before
running Rust commands (see root `CLAUDE.md` § «Критические правила»).

### Configuration in `tauri.conf.json`

The sidecar is declared via `bundle.externalBin`; `wintun.dll` via `bundle.resources`. The shell
plugin only exposes `open` (there is no shell-sidecar scope block):

```json
{
  "bundle": {
    "externalBin": ["trusttunnel_client"],
    "resources": ["wintun.dll"]
  },
  "plugins": {
    "shell": { "open": true }
  }
}
```

### How it works in code

**Rust (`src-tauri/src/sidecar.rs`):**

- Spawns `trusttunnel_client` and supervises the child process.
- Forwards the core's output to the frontend via `app.emit("vpn-log", …)`.
- Reports connection state changes via `vpn-status` events.
- Lifecycle (shutdown / kill / recovery) is coordinated in `lifecycle.rs`.

**React (`src/`):**

- VPN actions go through Tauri commands (e.g. `invoke("vpn_connect", …)`), wrapped by shared hooks.
- The UI subscribes to `vpn-log` / `vpn-status` through the VPN-event hooks and `VpnContext`.

## Development

```bash
cd gui-pro

# Install dependencies
npm install

# Frontend only (Vite dev server)
npm run dev

# Tauri (frontend + Rust backend) — uses src-tauri/tauri.dev.conf.json
npm run tauri:dev

# Production bundle (NSIS installer — see root CLAUDE.md for the build-hash rule)
npx tauri build --bundles nsis
```

### Quality gates

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src --max-warnings 0
npm run test         # vitest run  (test:watch for watch mode)
npm run rust:check   # cargo clippy -- -D warnings  (run from src-tauri/)
npm run storybook    # component gallery on :6006
npm run prerelease   # typecheck + lint + test + rust:check + build
```

## Requirements

- **Node.js** >= 18
- **Rust** stable (1.94) — toolchain inherited from the repo-root pin (no per-crate `rust-toolchain.toml`)
- **Tauri CLI** (installed as a devDependency)
- The prebuilt `trusttunnel_client-*.exe` (plus the runtime DLLs) present in `src-tauri/`
