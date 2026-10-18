# Pro 3.2.0 and official core 1.1.11 integration

Development branch: `codex/release-3.2.0`. This is a development record, not a published release announcement.

## Scope and provenance

- Pro baseline: `d6d239afb25646240230f72ec2778f6e9b1453f2`, application 3.1.0 and fork core 1.1.7.
- Routing investigation patch retained separately in `02c5b429c`.
- Official baseline: `v1.1.7`, `170609c24ca865819fed68437b01c013049bc3fa`.
- Official target: `v1.1.11`, `c0990e174fc75b2e52acd15882c62e69a3022581`.
- Official delta: 9 commits, 23 files, 134 insertions and 51 deletions.
- The upstream 1.1.7 sources had already been imported into this fork without usable common ancestry in this shallow checkout. An explicit ancestry-only merge records that imported baseline; the subsequent ordinary merge `ce9e34c09` applies the real 1.1.7-to-1.1.11 changes. It does not restore removed desktop/mobile directories or replace fork changes with stock files.
- The sole merge conflict was the dependency-family comment and pins in `conanfile.py`; the exact 1.1.11 pins win.
- Integrated Pro/core compatibility and release metadata: `147b094a9`.
- Final GUI failover correction: `eecf3c993`.
- Certificate-date failures stop retries for that server while preserving the bounded walk to healthy backups. Only a local core incompatibility stops the entire walk; the new tests cover both decisions.
- Light and the separate installer-helper version remain unchanged. Rust dependencies are unchanged. One directly used frontend parser receives the bounded security update below.
- No installed program, saved VPN profile, credential, active connection, route or firewall setting is changed by this development work.

## Changes relevant to this Windows GUI

| Official change | Applicability | GUI action |
| --- | --- | --- |
| 1.1.8: MIPS OpenSSL 4.0.2 and ngtcp2 backend | Windows x64 continues to use BoringSSL | No new control or setting |
| 1.1.9: TLS certificate parsing compatibility | Shared code retained; Windows still uses BoringSSL | No new control or setting |
| 1.1.10: stale Linux default-interface selection | Linux only; dependency updates retained | No Windows routing claim |
| 1.1.11: structured not-yet-valid certificate cause | Relevant to failed Windows VPN connection | Preserve and explain the cause in Russian/English |
| New certificate error inserted into enum | Shifts existing numeric error codes 8 through 10 | Update the decoder; prevent mismatched core startup |

The target adds no user TOML or CLI settings. Existing server-editing controls and stored profiles do not need a schema migration. Core 1.1.11 does not itself fix this fork's investigated routing bugs; those remain a separate retained patch.

The official standalone CLI still maps certificate-verifier failures to a generic result. The fork therefore adds structured verification-result propagation for both the system trust store and configured CA store. An invalid certificate remains rejected. The time hint is conditional: the certificate may be incorrectly dated on the server even when the computer's clock is correct.

Certificate identity mismatches override validity-date diagnostics. IP certificate verification uses the address without its port, restoring the intended IP SAN fallback while retaining verification. Generated-certificate regressions cover trust, dates, purpose, signature and hostname/IP identity.

The Windows bootstrap now exports the exact pinned recipes with native Conan commands instead of attempting to execute Unix shell scripts directly. The ring-buffer test fixture uses a process/test-specific file; previously parallel CTest instances corrupted each other's shared file. Production buffer code is unchanged.

## Bounded parser security update

The existing `smol-toml` 1.6.1 runtime dependency is used by the server configuration editor. The registry audit identified two applicable denial-of-service advisories: malformed input could loop indefinitely, and ordinary large input could cause quadratic parsing. The minimum version fixing both is 1.9.0. The package is pinned to exactly 1.9.0 using npm; the lock graph changes no other dependency.

A bounded child-process experiment proves the old version hangs on the malformed input while the new version rejects it. The editor regression also checks loading the invalid document and reloading a corrected one. Full frontend verification and a separate clean production-only install pass. Runtime audit after the change reports zero findings. The final all-dependency audit reports 19 development-tool findings; those dependencies are unchanged and no fix for them is claimed.

## Matched components

The package requires Pro 3.2.0 and a core built from this fork at version 1.1.11 with routing policy capability 1. A stock official executable omits the fork's process/routing extensions. The previously copied installed 1.1.7 resource is a build-time placeholder only and must not ship.

Both Tauri build and bundle hooks check the real x64 PE, `--version`, safe help advertisement, and `--routing-policy-version`. Runtime startup also validates compatibility before reading numeric core errors. Only the explicitly non-distributed installer-rendering CI fixture overrides these hooks because it intentionally contains empty files.

Native dependency family:

- `dns-libs/2.10.2-6-gc68d7dde@adguard/oss` (source commit `c68d7dde`).
- `native_libs_common/8.1.54@adguard/oss` (tag `v8.1.54`).
- Windows `openssl/boring-2026-05-08@adguard/oss`.

Use `TT_CLIENT_VERSION=1.1.11` explicitly; GUI release tags must not determine the core version.

## Verification ledger

| Check | Observed result |
| --- | --- |
| Pro frontend | 254 files / 4,094 tests pass; typecheck, lint, translations and production build pass |
| Rust backend | `cargo check --locked --all-targets` and strict Clippy pass; 151 targeted sidecar/lifecycle/supervisor tests pass |
| Rust formatting | Full check still fails on pre-existing formatting; changed sections introduce no additional formatting debt |
| Exact core dependency family | Real Windows x64 CLI and native test targets build with 1.1.11 pins |
| Matcher and configured routing files | 67 matcher cases and 2 file-loader cases pass against exact new dependencies |
| Certificate verification | 13 chain-verification cases and 8 actual core callback cases pass |
| Ring-buffer test isolation | Unmodified sequential 10/10 pass; repaired fixture parallel 10/10 pass |
| Compatibility gate | 15 fixture tests pass; actual rebuilt core reports 1.1.11 / policy 1; old 1.1.7 rejected |
| Installer/source/privacy gate self-tests | Existing NSIS, signing, PII, artifact, checksum and build-label checks pass |
| Initial compiled artifact privacy | Both initial private-directory builds correctly fail due to embedded compiler/dependency paths; these are not release artifacts |

The broad native run exposed UDP loopback failures. Independent IPv4/IPv6 Python probes also fail to receive plain and DNS-shaped UDP messages on localhost while TCP works. The mock server binds the expected port and does not receive the datagrams. An active Codex sandbox UDP firewall rule was observed, but its user condition was not proven applicable to these processes; the responsible filter is unproven. No firewall rule, execution restriction or VPN state was changed to bypass this condition.

The affected DNS and fake-connection tests remain unverified in this environment. Other native cases passed, apart from the shared-file race repaired above, one pre-disabled test and one host-dependent localhost-resolution skip. There is no claimed device-wide routing, outage, reconnect or dual-stack acceptance run of the new installed application. These require a separate controlled acceptance stage.

## Built candidate

The real Tauri/NSIS build finished successfully. The verified installer was copied to the user's Desktop, together with its `.exe.sha256` checksum file. Nothing was installed or published.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TrustTunnel Client Pro_3.2.0_x64-setup.exe` | 9,781,196 | `cafa78476272a7b12b94ac00c068f25cadfea6b20e9e94918d51e7be728eee91` |
| Packaged `trusttunnel.exe` | 18,967,040 | `8cf5c7cf2eb41acb2619ea60dfb6318f0846564dfa1c0d67a230659f2b53b3fc` |
| Packaged `trusttunnel_client.exe` | 15,571,456 | `a9cd7c8fee256a1ed18386f4b5f2f952b506861bd2b0d125a41aa01934f8f1e8` |
| Packaged `wintun.dll` | 427,552 | `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` |

The actual package was extracted without running it. The core and WinTUN payloads match the measured inputs exactly. The GUI differs from the restored Cargo output only by [Tauri 2.10.1's documented bundle marker](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.10.1/crates/tauri-bundler/src/bundle.rs) (`UNK` to `NSS`); comparison accounts for exactly those three bytes and no others. The executable embeds the current `main-e5sF8Fo8.js` frontend and has no test build label.

Actual core compatibility, raw-artifact privacy, extracted-payload privacy, build-label, post-build NSIS and checksum gates all pass. The neutral native sources match 648 files at `147b094a9`; the final GUI matches 717 tracked files at `eecf3c993`, allowing only Tauri's Cargo manifest line-ending normalization. The core/GUI package is unsigned by the existing signing configuration; no certificate or signing identity was configured by this work.

The installed 3.1.0 GUI and 1.1.7 core retain their original SHA-256 values. The candidate is ready for controlled acceptance, not declared to have passed device-wide network acceptance. Remaining gaps are the host UDP limitation, pre-existing Rust formatting debt, unchanged development-tool advisories and the separate installation/live-routing stage.

## Recovery and run-owned resources

The pre-upgrade routing patch is committed independently, followed by baseline ancestry and official-release merge commits. Reverting only the later release work restores the original development baseline without changing installed files.

Installation is a separate stage: save the currently installed GUI/core pair and a private complete application-data backup, install the matched candidate, then exercise routing/process exceptions and connection failures in a controlled environment. Rollback restores the matched old binaries together with that pre-upgrade data snapshot. Do not start the old core with newly generated policy-prefix files; the old core does not interpret those rules.

Private run output is under this task's visualization directory in `release-3.2.0/`: official dependency source checkouts, build runner and logs. Prior `vpn-investigation/` tools/caches are reused as pre-existing resources and must not be treated as cleanup targets. Conan exports and compiled dependency packages remain in the development cache. The ignored worktree CMake build directory is run-owned. The production rebuild uses the new neutral directory `C:\ttb-pro-3.2.0-codex` with separate Conan/Cargo homes; old compiled dependency archives are not copied into it. No background VPN process is started for build probes.

## Sources

- [Official 1.1.11 release](https://github.com/TrustTunnel/TrustTunnelClient/releases/tag/v1.1.11).
- [Exact official source comparison](https://github.com/TrustTunnel/TrustTunnelClient/compare/v1.1.7...v1.1.11).
- [Upstream 1.1.11 changelog](https://github.com/TrustTunnel/TrustTunnelClient/blob/c0990e174fc75b2e52acd15882c62e69a3022581/CHANGELOG.md).
- [Routing investigation and its limits](VPN_ROUTING_INVESTIGATION_2026_10_18.md).
- [Parser infinite-loop advisory](https://github.com/advisories/GHSA-7w5x-hrqm-74c2).
- [Parser quadratic-time advisory](https://github.com/advisories/GHSA-r4xh-jqrq-34v2).
- [Parser 1.9.0 release](https://github.com/squirrelchat/smol-toml/releases/tag/v1.9.0).
