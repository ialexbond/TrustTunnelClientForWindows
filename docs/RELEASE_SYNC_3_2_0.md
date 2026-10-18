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

The package requires Pro 3.2.0 and a core built from this fork at version 1.1.11 with routing policy capability 1 and endpoint probe capability 1. A stock official executable omits the fork's process/routing extensions. The previously copied installed 1.1.7 resource is a build-time placeholder only and must not ship.

Both Tauri build and bundle hooks check the real x64 PE, `--version`, safe help advertisement, `--routing-policy-version`, and `--endpoint-probe-version`. Runtime startup also validates routing compatibility before reading numeric core errors; ping independently checks its probe capability before invoking it. Only the explicitly non-distributed installer-rendering CI fixture overrides these hooks because it intentionally contains empty files.

Native dependency family:

- `dns-libs/2.10.2-6-gc68d7dde@adguard/oss` (source commit `c68d7dde`).
- `native_libs_common/8.1.54@adguard/oss` (tag `v8.1.54`).
- Windows `openssl/boring-2026-05-08@adguard/oss`.

Use `TT_CLIENT_VERSION=1.1.11` explicitly; GUI release tags must not determine the core version.

## Initial verification ledger

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

## Initial candidate (before user acceptance)

The real Tauri/NSIS build finished successfully. The verified installer was copied to the user's Desktop, together with its `.exe.sha256` checksum file. Nothing was installed or published.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TrustTunnel Client Pro_3.2.0_x64-setup.exe` | 9,781,196 | `cafa78476272a7b12b94ac00c068f25cadfea6b20e9e94918d51e7be728eee91` |
| Packaged `trusttunnel.exe` | 18,967,040 | `8cf5c7cf2eb41acb2619ea60dfb6318f0846564dfa1c0d67a230659f2b53b3fc` |
| Packaged `trusttunnel_client.exe` | 15,571,456 | `a9cd7c8fee256a1ed18386f4b5f2f952b506861bd2b0d125a41aa01934f8f1e8` |
| Packaged `wintun.dll` | 427,552 | `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` |

The actual package was extracted without running it. The core and WinTUN payloads match the measured inputs exactly. The GUI differs from the restored Cargo output only by [Tauri 2.10.1's documented bundle marker](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.10.1/crates/tauri-bundler/src/bundle.rs) (`UNK` to `NSS`); comparison accounts for exactly those three bytes and no others. The executable embeds the current `main-e5sF8Fo8.js` frontend and has no test build label.

Actual core compatibility, raw-artifact privacy, extracted-payload privacy, build-label, post-build NSIS and checksum gates all pass. The neutral native sources match 648 files at `147b094a9`; the final GUI matches 717 tracked files at `eecf3c993`, allowing only Tauri's Cargo manifest line-ending normalization. The core/GUI package is unsigned by the existing signing configuration; no certificate or signing identity was configured by this work.

At creation of this initial candidate, the installed 3.1.0 GUI and 1.1.7 core retained their original SHA-256 values. It was ready for controlled acceptance, without a claim of device-wide network acceptance. The user subsequently installed this candidate and reported the results below.

## User acceptance follow-up

The user confirmed retained settings, changed public IP with VPN, explicit site priority over Russian DIRECT groups, different routes in one browser, process priority over site rules, persistence, and their WebRTC check. Gosuslugi and its login page opened; completed authentication was not reported. A browser-custom DNS resolver location is not independent proof of DNS transport. Physical internet disconnection, forced core crash and IPv6 acceptance remain untested.

Stopping the test server protocol exercised both failover settings. With automatic failover enabled, another server restored service. With it disabled, the application displayed bounded retries; both tested websites were unavailable until the protocol was restarted. Application logs corroborate the retry/recovery sequence. This is consistent with ordinary DNS being blocked before exclusion matching while the endpoint is disconnected and Kill Switch is enabled (`core/src/dns_handler.cpp`), plus old-core shutdown and DNS-cache clearing during GUI reconnect. Explicit DIRECT connections are otherwise allowed by `core/src/vpn_fsm.cpp`. The original checklist incorrectly promised uninterrupted DIRECT websites during this interval; that expectation is withdrawn. These observations are not a complete leak test.

### Ping correction

The user found realistic server latency while disconnected, but 1–3 ms for inactive servers while connected. The routing fix's early TCP acknowledgement was accepted as a remote TCP response by the old connect-only timer. The active endpoint's protected route did not exhibit the same shortcut. The routing fix itself is retained.

Both GUI ping paths now use a one-shot mode in the matched core executable. It selects a physical adapter/source and binds the socket to that interface before measuring the remote TCP handshake. It has no unbound fallback and exits before configuration, VPN-session, DNS, route or firewall initialization. The installed executable path already has the core application's firewall permission; no new firewall exception is added. Process launch and route-selection time are excluded from the reported latency. Safe help/capability checks precede the fork-only flag, with bounded child lifetime and strict versioned JSON. Missing capability, resolution failure or incomplete measurement yields no data; only a completed native connection failure declares the peer unreachable.

A read-only comparison against the active server returned 73–79 ms from the new helper and approximately 73–77 ms from ordinary TCP. The helper was still in the neutral build path, so correct inactive-server measurement under the installed core's application identity requires a user retest after installing the updated pair.

### Routing list correction

DIRECT, VPN and saved-process lists reuse the existing visible-scrollbar styling, with a bounded list height and a theme-aware thumb. A successful explicit addition reveals its new row in that list; preset and process-picker additions are included. Passive updates, duplicate additions and removals do not jump. The page, unrelated lists and keyboard focus remain unchanged. Isolated browser checks cover dark/light themes and 900/1280 px widths without opening the installed application or invoking real VPN commands.

### Follow-up verification

| Check | Observed result |
| --- | --- |
| Frontend | 254 files / 4,099 tests pass; typecheck, lint and production Vite build pass |
| Ping backend | 26 self-contained Rust tests pass, none ignored; includes delayed real measurement versus synthetic fast accept, DNS failure and helper deadlines |
| Rust static checks | Final `cargo check --locked --all-targets` and `cargo clippy --locked --all-targets -- -D warnings` pass with unchanged source hashes |
| Core compatibility gate | 19 fixture cases pass; actual new core reports 1.1.11 / policy 1 / endpoint probe 1; previous candidate core is rejected for missing probe support |
| Native probe | 6 native cases and 9 real CLI checks pass; neutral resource SHA-256 `5a31893b84daeec241e1718b2e8f1632c7ed14d207020c8fbe5d43305cf09183` |
| Visual acceptance | Visible scrollbars and new-row reveal observed in a mocked browser; target-only scroll, focus retention and duplicate no-jump checked |
| UI detector | One final scoped detector run, no findings |
| Translation/source checks | Translation-key check and source privacy gate pass; new native units pass strict clang-format checking |

User acceptance of these ping/scroll corrections remains pending installation and retest. Passing automated checks do not overwrite the user's original issue reports. The standalone checklist is maintained privately in `.planning/uat/pro-3.2.0-UAT.md`, without inventing a development phase.

## Candidate after ping and scrolling UAT fixes

Source fix: `35e2852fd30fba70a8a55ba167fe94f0785d0b5c`. The neutral build inputs match the tested Rust, GUI, gate and native sources; only Tauri's expected Cargo manifest line-ending normalization is accepted. Release documentation is not a compiler or packaging input.

The rebuilt NSIS installer replaces the initial candidate on the Desktop under the same 3.2.0 filename, with an updated adjacent `.exe.sha256`. The known initial installer and its checksum were archived privately before replacement. The installed initial 3.2.0 GUI/core pair retains the pre-fix hashes above; the agent has not installed this replacement or interrupted the connection.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TrustTunnel Client Pro_3.2.0_x64-setup.exe` | 9,794,263 | `02c5a0ef9feaac8987050e7ac184cbcdc0aa48afd266677f1703bec049351f0f` |
| `trusttunnel.exe` | 18,990,592 | `5dda0d2b104035158294e48f924172aa41f52189eed364cdc5233012f375ca7d` |
| `trusttunnel_client.exe` | 15,623,680 | `5a31893b84daeec241e1718b2e8f1632c7ed14d207020c8fbe5d43305cf09183` |
| `wintun.dll` | 427,552 | `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` |

Actual core compatibility, raw and extracted artifact privacy, build label, post-build NSIS, generated checksums and checksum verification all pass. The installer was extracted without running it; core and WinTUN payloads match their build inputs exactly, and the GUI comparison allows only Tauri's expected `UNK` to `NSS` bundle marker. The executable contains the current `main-CSU5UFox.js` frontend. The existing unsigned configuration is unchanged. No push, tag, public release or installation was performed.

Connected/disconnected measurements for inactive servers from the newly installed core path, plus the user's scrollbar/new-row checks, remain pending. The previous UDP environment limitation, development-tool advisories, Rust formatting debt and broader crash/IPv6 acceptance limits remain unchanged.

## MTU default alignment

Source fix: `ca9a81dc6d715edc028f5034b7cddd847907fc72`. Official core 1.1.5 already changed its default from 1280 to 1350; the fork's Pro configuration generator and absent-value display fallbacks still carried the older value. The native core is reused unchanged at SHA-256 `5a31893b84daeec241e1718b2e8f1632c7ed14d207020c8fbe5d43305cf09183`.

New configurations generated by setup, server configuration retrieval or binary deep links now explicitly use 1350. A newly synthesized TUN block also uses 1350. The connection editor, tunnel settings and dashboard display 1350 when MTU is absent. Explicit saved values remain authoritative, including 1280 and custom values; an existing TUN block with MTU omitted stays omitted on an unrelated save. Existing imports, save/normalization behavior and fallback operators are otherwise unchanged. No startup migration or new automatic write is introduced.

| Check | Observed result |
| --- | --- |
| Backend regressions | 48 library tests pass: 33 configuration and 15 SSH tests; new generated/synthesized default and preservation of 1280 / 1350 / 1400 / omitted MTU covered |
| Frontend regressions | 57 targeted tests and all 4,109 tests in 254 files pass; missing-value display and saved-value preservation covered, including no write when opening the editor |
| Frontend static checks | Typecheck and lint pass; release notes included in the tested snapshot |
| Rust static checks | Final locked all-target check and strict Clippy pass; reviewed production changes are exactly two backend defaults and three frontend fallback literals |
| Build source integrity | All 742 tracked GUI/script inputs match the neutral snapshot, allowing only Tauri's Cargo manifest line-ending normalization |

### Rebuilt MTU candidate

The verified 3.2.0 installer and its adjacent `.exe.sha256` replace the previous Desktop candidate. That known prior installer (`02c5a0ef...`) and checksum were archived privately before replacement. The installed application was not upgraded or started by the build process. All six saved configuration files retain their exact bytes and modification times; installed executable and dependency-lock hashes also remain unchanged.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TrustTunnel Client Pro_3.2.0_x64-setup.exe` | 9,798,228 | `2b34ef76f358bc3e67976810f1496c91c3cba7362097bc52ea07167466e01c60` |
| `trusttunnel.exe` | 18,990,592 | `0ab5e7957b92ecbdbe7393ef187493937c9b74719b014e643a6e6f604034813a` |
| `trusttunnel_client.exe` | 15,623,680 | `5a31893b84daeec241e1718b2e8f1632c7ed14d207020c8fbe5d43305cf09183` |
| `wintun.dll` | 427,552 | `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` |

Actual core compatibility, raw/extracted artifact privacy, build-label, post-build NSIS and checksum gates pass. The installer was extracted without execution: its core and WinTUN match the unchanged inputs, and GUI comparison allows only Tauri's expected three-byte bundle marker. It embeds the current `main-RLTiybYC.js` frontend. The existing unsigned configuration remains unchanged. No installation, public release, tag or push was performed. Private build/check receipts are in `release-3.2.0/mtu-fix` under this task's visualization directory. Earlier live ping/scroll retests and broader acceptance limits remain pending; the MTU default correction does not change their status.

## Scrollbar color refinement

Source fix: `ba6e53de36f07f2fedb7b2bfc10d7a146e21f14c`. The user's light-theme screenshot showed an overly dark scrollbar. A single CSS change removes the stronger routing-specific text-color overrides and reuses the existing softer, theme-aware scrollbar colors. Stable gutter, width, list bounds, scrolling and new-row reveal are unchanged. One native-browser inspection covers all three lists in dark/light themes; one scoped UI detector run has no findings. No new behavior tests were added for this color-only change.

The actual production Tauri/NSIS build and all core compatibility, raw/extracted privacy, build-label, post-build NSIS and checksum gates pass. Extracted GUI payload SHA-256 is `42d89c3743811d1f9473c725605faced804d3c57abfc9a8d7491424bf7509eb8`; the expected Tauri bundle-marker normalization is verified. Core and WinTUN retain their prior hashes. The embedded frontend is `main-DrvEol4k.js`.

The updated Desktop `TrustTunnel Client Pro_3.2.0_x64-setup.exe` is 9,799,008 bytes, SHA-256 `0470bdbe047a8cb579a728973d8d425471ef74ee0e9b1f10fe59a8412c275762`, with a verified adjacent `.exe.sha256`. The previous MTU candidate and checksum are privately archived. All six saved configuration files and installed binaries remain unchanged. No installation or publication was performed. Private receipts and both-theme previews are under `release-3.2.0/scrollbar-tone` in the task's visualization directory.

## Scrollbar hover correction

Source fix: `cfccd6d1319e5ff133bc23de4193aa85aada3b5e`. The user accepted the resting scrollbar colors in both themes but reported an excessively strong hover. A real pointer-hover capture reproduced Chromium's native hover paint overriding the intended subtle pseudo-element appearance. Routing/process lists now use scoped WebKit thumb styling in supporting browsers, with standard styling retained as fallback. The existing gutter remains 10 px and the visible grip remains 6 px. The prior global rule hiding scrollbar arrow buttons now takes effect in these scoped Chromium lists; no custom arrows were introduced.

Resting pixels are unchanged: light `(204, 204, 202)` and dark `(60, 60, 60)`. Hover changes to `(202, 202, 200)` and `(62, 62, 62)`, instead of the previously observed `(90, 90, 90)` and `(192, 192, 193)`. One bounded before/after dark/light capture confirms the result; wheel and thumb dragging work, and one final CSS detector run has no findings. No behavioral code or network rules changed.

The real Tauri/NSIS build and all compatibility, raw/extracted privacy, build-label, NSIS and checksum gates pass. New Desktop `TrustTunnel Client Pro_3.2.0_x64-setup.exe`: 9,797,545 bytes, SHA-256 `5381bc52f838743a32816ac2405002e90f3a2f99c6500ce312474f0261b70a7d`, with a verified adjacent checksum. Extracted GUI SHA-256 `bc03601048e1a32017d4ef9ca27c8255067be574d018a526bb043be41d62915a` matches the build output after the expected Tauri bundle-marker normalization; the frontend is `main-F85d2wz-.js`. Core/WinTUN retain their previous hashes. The prior `0470bdbe...` installer is privately archived. Six saved profiles and installed executable hashes are unchanged; no installation or publication was performed. Private pixel evidence and package receipts are under `release-3.2.0/scrollbar-hover`.

## IPv6 and process-crash protection follow-up

The persistent crash-protection candidate in this subsection was superseded by the user's explicit choice in [GUI session lifetime correction](#gui-session-lifetime-correction). Its hashes and test records are historical; it is not the current recommended installer.

Source fix: `f1d82c50b`. This candidate adds a Windows filtering barrier with a lifetime independent of the GUI and VPN child process. It applies when Kill Switch is enabled; existing profiles that explicitly disable it are not rewritten or silently enabled. The source changes do not claim that every saved profile is protected.

For a conventional full IPv4 TUN configuration without explicit IPv6 scope, effective runtime configuration adds both IPv6 half-space routes and local IPv6 exclusions. This covers the entire IPv6 address space rather than the older global-unicast subset. Explicit custom scopes and exclusions remain authoritative. New configuration templates include these routes; existing profile bytes and MTU values are preserved. If the endpoint cannot carry IPv6, protected IPv6 is blocked rather than sent through the physical uplink.

The persistent Windows barrier protects the configured capture scopes in both address families. A temporary permit is limited to the current tunnel interface and its exact address and is installed before exposing TUN routes/DNS. Core termination removes that permit but retains the persistent deny rules. The matched core executable has its own narrowly scoped transport identity; protected transport must bind both its physical source address and interface. Endpoint addresses no longer become blanket physical-route exceptions while this guard is active. Approved process/site DIRECT forwarding continues through the healthy core. Local and explicit public-route exclusions retain their intended scope; local-router DNS cannot bypass the protected DNS path.

Reconnection bootstrap uses bounded DNS queries issued by the matched core on a selected physical interface. Numeric endpoint addresses are written only to a temporary runtime copy; saved endpoint names, TLS identity and credentials remain unchanged. Capability checks precede helper flags. A serialized operation lease, confirmed helper termination and connection-generation checks prevent a cancelled/late arm or stale disconnect from changing a newer session's protection. A retained guard prevents automatic downgrade to a profile with Kill Switch disabled.

Unexpected child/GUI termination, retry exhaustion and ordinary startup do not release the guard. Explicit Disconnect, explicit Quit and confirmed uninstall can release it after the owned core stops. A global recovery banner offers the existing Disconnect path through the localized release button when protection remains active without a connected session. Failed release stays visible; uninstall aborts before deleting the recovery executable. No blanket GUI or endpoint-IP firewall permission was added.

### Verification and remaining acceptance

| Check | Observed result |
| --- | --- |
| Native core | 111 cases pass: guard planning/fake transaction tests 15, configuration 7, IPv6 tunnel 3, matcher 67, certificates 13, endpoint probe 6 |
| Native protocol | Version/help, guard capability, both safe composite-version argument orders and invalid resolver requests pass without mutating WFP |
| Rust | Guard module 17, lifecycle 70, sidecar 46, VPN commands 75 and reconnect supervisor 38 pass; overlapping guard-filtered run 43 passes |
| Configuration preservation | Final post-annotation configuration/template rerun 37 passes; existing custom/omitted MTU and explicit route scopes covered |
| Rust static checks | Locked all-target check and strict all-target Clippy pass |
| Frontend | 4,128 tests in 255 files pass; typecheck, lint and translation checks pass; final production frontend builds |
| Recovery UI | Busy, failure, duplicate-click and event races covered; light/dark and narrow/wide mocked-browser previews inspected; one scoped detector run has no findings |
| Compatibility/privacy | 23 core-gate fixtures pass; source privacy gate passes with explicit annotations for the required IPv6 half-space literal |
| Build inputs | 745 GUI/script inputs match the neutral build snapshot, allowing only Cargo manifest line endings; all 12 changed native input hashes match the final native receipt |
| Current installation/data | Nine saved configuration/routing/application/settings files retain bytes, sizes and modification times; installed GUI/core hashes remain unchanged |

The final neutral native core is SHA-256 `18b3aba1b86b6f403ad0af0afc00f5443596908b6f788f9b805f515061bfed5d`. Both the production GUI resource and the package verifier are pinned to that tested native receipt. Private evidence is under `release-3.2.0/fail-closed` in the task's visualization directory.

No destructive crash, live WFP mutation, independent packet-containment capture or cold-DNS reconnect acceptance was performed on this user's active connection. An isolated Windows VM was unavailable to the effective execution token. Established-flow behavior during abrupt process death, live dual-stack routing, and recovery therefore still require controlled Windows acceptance after installation. Persistence across BFE service restart or OS reboot is not claimed by this run. Automated/fake-API tests are not substitutes for those network observations. Earlier user acceptance applies to the older installed candidate, not to this new security build.

### Rebuilt security candidate

The production Tauri/NSIS build succeeds. Actual core compatibility, raw and extracted artifact privacy, build-label, post-build NSIS and checksum gates pass. The package verifier independently rechecks the 745 GUI/script inputs, 12 changed native inputs and exact tested core hash. Extracted core and WinTUN match their inputs byte for byte; the GUI comparison permits only the expected Tauri `UNK` to `NSS` bundle marker. The embedded frontend is `main-DTZcF_g3.js`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TrustTunnel Client Pro_3.2.0_x64-setup.exe` | 9,884,393 | `73e8c6db55ed1ae97565a16c324d6d76f1caaa77775288bdc8a4257714a8c77e` |
| Packaged `trusttunnel.exe` | 19,111,936 | `fcaa3fd2548aa6f295dc4879fe6511f385e96c081572e6b33252a1a667dde316` |
| Packaged `trusttunnel_client.exe` | 15,872,000 | `18b3aba1b86b6f403ad0af0afc00f5443596908b6f788f9b805f515061bfed5d` |
| Packaged `wintun.dll` | 427,552 | `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` |

The verified installer and adjacent `.exe.sha256` replace the known previous `5381bc52...` candidate on the Desktop. That predecessor and checksum were privately archived before replacement. The existing unsigned GUI/core/installer configuration remains unchanged; WinTUN retains its vendor signature. No installation, active VPN change, push, tag or publication was performed. This same-version candidate requires the controlled acceptance cases above before a general leak-containment claim.

## GUI session lifetime correction

Source fix: `36bddfde02e1bfe10c88ad66d780668b5b4538b8`.

The user rejected persistent blocking as unsuitable for a nontechnical audience and explicitly chose protection only while the GUI is running. A VPN-core failure must retain protection while that GUI session remains open. Closing or crashing the entire GUI must remove the blocking rules automatically. Ordinary internet access after complete GUI termination can expose the ISP address; this is the approved product tradeoff, not an all-state privacy guarantee.

The native capability is now 2. A resident `--network-guard-session` helper owns all new base filters through a dynamic WFP session. Its provider and sublayer are static, nonblocking metadata, created through a separate nondynamic engine so the normal core's dynamic TUN permits can reference them across sessions. All new actual filters have zero persistence flags. Helper input closure or process termination removes its base filters; Windows/BFE restart removes the remaining harmless metadata. No persistent blocking policy, background service or recovery task is created.

The GUI must assign the helper to an owned kill-on-close Windows Job before it can send an arm request. The same helper processes bounded status/arm/release commands across server changes, with atomic rearm and the existing operation lease/generation checks. The VPN core runs in its own owned job and additionally waits for the exact GUI startup token before reading configuration or touching networking. The token is sent only after successful job assignment. GUI death before assignment closes the input without starting networking; GUI death afterwards closes the owning job handles. Windows GUI sessions now reject job-assignment failure rather than accepting the old PID-file-only cleanup fallback.

A generation- and helper-identity-checked backend handler stops a protected connection if its resident helper unexpectedly dies. An idle, unarmed helper's termination is harmless and must not show a protection failure. Normal Quit attempts bounded Disconnect cleanup and then honors exit even on IPC failure; job lifetime provides the final automatic cleanup. The in-app recovery button is named Continue without VPN and explains that protection lasts while the app is open. IPv6 coverage, existing route/process priority, MTU and saved-profile preservation remain unchanged.

The new executable retains a separate legacy cleanup command that can delete only fully verified version 1 objects, including recognized disabled legacy filters after reboot. The installer runs this cleanup after copying the new core to its installed identity and before optional GUI launch, so migration does not depend on a working GUI. Startup also performs migration before connection preparation. Current session filters use distinct identifiers and are never removed through that legacy command. Uninstall supports both capability versions, bounds cleanup retries, and requires a confirmed unarmed result before deleting the recovery executable.

Validation covers the dynamic-rule plan and transactions, native startup-token rejection before configuration, resident protocol/rearm/release and cancellation races, real Windows kill-on-close behavior using an innocuous test process, stale helper-failure events, and the existing routing/IPv6 regressions. Live WFP mutation, real VPN crash packet capture, and installed dual-stack/reboot acceptance remain unperformed in this environment. A kernel job fixture is evidence of process ownership, not a substitute for those complete network tests.

| Check | Observed result |
| --- | --- |
| Native core | 113 tests pass, including 17 guard/protocol/lifetime cases and the existing IPv6, configuration, routing, certificate and probe selections |
| Real safe native handshake | Closed input, wrong token and oversized input all exit before configuration/network setup |
| Rust guard | 27 cases pass, including real Windows owner termination without Rust cleanup, resident EOF/rearm, cancellation and harmless idle-helper death |
| Rust lifecycle | Sidecar 46, lifecycle 70, VPN 77, supervisor 38 and job handle 2 pass; counts overlap with other selected runs |
| Rust static checks | Final locked all-target check and strict Clippy pass |
| Frontend | 4,128 tests / 255 files pass, with final wording; typecheck, lint and translations pass |
| Build capability gate | 28 fixtures pass; capability 1 and missing or similarly named startup/session flags are rejected; probes never invoke mutating modes |
| Source checks | Source privacy and diff checks pass; four changed native units pass strict clang-format checking |

The final matched native core is SHA-256 `a7f90161a523838b086c50a5d1506192b22353b96acbdfb6596b92c1b8a000bd`. Both build resources match that receipt. Private source snapshots, logs and receipts are under `release-3.2.0/session-guard` in the task's visualization directory. No live VPN state, firewall policy, installed binary or saved profile was changed for these checks.

### Rebuilt session-protection candidate

The real production Tauri/NSIS build and all measured core compatibility, raw/extracted privacy, build-label, post-build NSIS and checksum gates pass. All 745 GUI/script inputs and 12 changed native inputs match the tested source snapshot, allowing only Tauri's Cargo manifest line-ending normalization. Extracted core and WinTUN match exactly; the GUI differs only by the expected Tauri `UNK` to `NSS` bundle marker. The embedded frontend is `main-Bcuew-y4.js`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TrustTunnel Client Pro_3.2.0_x64-setup.exe` | 9,936,330 | `5838694f72bf69809802d5b633c348a285be180a59009056999b90b83fe1327e` |
| Packaged `trusttunnel.exe` | 19,215,872 | `c9d9fc93b732ace5b57cba72bb7af34433c9bcc95dc6ae3a93297a56269dc2db` |
| Packaged `trusttunnel_client.exe` | 15,872,000 | `a7f90161a523838b086c50a5d1506192b22353b96acbdfb6596b92c1b8a000bd` |
| Packaged `wintun.dll` | 427,552 | `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` |

The verified installer and adjacent checksum replace the known `73e8c6db...` persistent-protection candidate on the Desktop. That previous installer/checksum are privately archived. The existing unsigned application/installer configuration is unchanged. No installation, publication, push or tag was performed. The pending live network acceptance above remains separate from automated/package verification.

Final preservation comparison confirms all nine saved settings/configuration files retain exact bytes, sizes and modification times, and both installed executable hashes remain unchanged. The actual generated NSIS script copies the core before the post-install legacy cleanup; optional GUI launch occurs afterwards on the finish page. Desktop installer/checksum and archived predecessor/checksum are independently verified.

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
