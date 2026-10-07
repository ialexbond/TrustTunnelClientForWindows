# Master synchronization with Pro 3.1.0

Date: 2026-10-07 (Asia/Yekaterinburg).

The `master` branch now incorporates the published Pro 3.1.0 release and includes the Windows C++ core and build sources. The initial local synchronization was completed in `b360059eb6ec65a366b47bbedff522e1be295fb3`, retaining the previous local history and legacy application directories. The user subsequently authorized publishing the synchronized branch to `origin/master`. This operation does not install an application.

## Source and recovery point

| Item | Identifier |
| --- | --- |
| Previous local master | `0843800b8940e7b2e337f21d2c60e067aa0a1be2` |
| Recovery branch | `codex/pre-sync-pro-3-1-0-20261007` |
| Original history before publication cleanup | `codex/pre-publish-pro-3-1-0-20261007`, `122eccbf004aa6f812bae3e07324317513e416a1` |
| Published-history audit baseline | `140763450cb3b35e44d4e5514a1a87e9c4e0b78c` |
| Published-history release merge | `ae8064e225680236c9cbe6f7607bda909d7f5014` |
| Published release merged | `origin/release/tt-win-3.1.0`, `19179709045dc2fa533eac388563fc3e830328ab` |
| Latest published application | [Pro v3.1.0](https://github.com/ialexbond/TrustTunnelClientForWindows/releases/tag/v3.1.0-pro) |
| Core generation | Upstream 1.1.7 plus the fork's released changes |
| Restored lint configuration | Official upstream v1.1.7, `170609c24ca865819fed68437b01c013049bc3fa` |

The release and local branch diverged after `63537d27878c8bc291377a0cf3852041817f60c7`. A merge, rather than a reset, retains both histories. Six conflicts were resolved in `NOTICE`, the root and Pro READMEs, `gui-pro/package.json`, `conanfile.py`, and `net/src/quic_connector.cpp`. Released functionality and dependencies take precedence; the README retains the existing accurate statement about currently downloadable installers.

### Publication privacy cleanup

A check of outgoing Git objects found a previously deleted VPN profile with nonempty credentials at `TrustTunnel-v1.2.1-portable-win64/trusttunnel_client.toml`. Its historical content was not reachable from the inspected `origin` remote refs. Publishing the original local history would have exposed that profile even though the current checkout no longer contains it.

An isolated bare clone was used to remove only that path from unpublished history. No commits or merge relationships were pruned. Existing published master `2d86f47dacea1ebac6fa0d425fd43a831bfa6011` and the Pro 3.1.0 release commit remain unchanged ancestors, allowing a normal fast-forward push. The original local history is retained in the two local recovery branches above; those recovery branches and local milestone tags are not included in publication.

Before documentation updates, the sanitized tip `bd5844fc54f695d9eaffa7a894535caea06251c8` had exactly the same Git tree as the original tip `122eccbf004aa6f812bae3e07324317513e416a1`. Audit source files at the mapped baseline are identical to the original baseline. The report's public source links use the mapped commit while retaining the original identifiers as historical test provenance. No credential value is reproduced in these notes.

## Integrated changes

- All Pro version metadata, runtime labels and lockfile entries now identify 3.1.0. The Apache-2.0 license is retained.
- Pro functionality, update launch protections, connection readiness, cleanup, self-hosted fonts and the release's regression tests match the published release. Existing local functional Pro additions were not lost; the earlier Pro divergence consisted of documentation and license metadata.
- The 654 Windows/core/build files absent from the trimmed checkout are restored. This includes the C++ modules, Windows adapter, vendored dependencies, CMake/Conan files, build helpers and core tests. The existing core tests and setup-wizard version source are updated together with the released API.
- The stale source header containing core version 1.0.49 is removed. The released build now generates that header from its template.
- CMake presets and the released build/version documentation and workflows are restored. The restored core workflow remains restricted to the official upstream repository; its presence does not mean this fork automatically runs C++ CI.
- The official core 1.1.7 formatting/static-analysis configurations are restored to avoid checking the returned C++ sources with unrelated default settings.
- A required public XML namespace in a retained Light icon carries an explicit personal-data-scanner exception. This resolves a false positive without changing the namespace or icon behavior; XML parsing was checked.
- The local project guide's directory table is updated for the retained GUI editions and installer. That local guide is ignored by Git, as it was before synchronization.
- The [security audit](../WINDOWS_VPN_SECURITY_AUDIT.md) retains its immutable historical baseline and explicitly identifies this later synchronization. The old external-font and launcher regressions are cleared in the current tree. Remaining findings applicable to the published release were not repaired by this merge.

The scope of restoration is Windows and its shared core/build support. Retained Android, Apple, Flutter, Light and legacy GUI work is preserved; those editions are not declared synchronized or independently validated by this operation. The pre-existing untracked Android Gradle cache was left untouched.

## Verification

| Check | Result |
| --- | --- |
| Exact functional Pro source/config/packaging comparison to release | PASS; only intentional Pro README changes differ |
| Windows core, Conan, CMake, build-helper and test-source comparison to release | PASS; no missing required release source files |
| Pro versions and license agreement | PASS |
| Merge conflict entries and conflict-marker scan | PASS; none remain |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd test -- --reporter=dot` | PASS: 254 files, 4,089 tests |
| `npm.cmd run build` | PASS; self-hosted font included in production output |
| `npm.cmd run i18n:check`, `nsis:check`, `sign:test` | PASS |
| `npm.cmd run pii:test`, `pii:check`, `artifact:test`, `checksum:test`, `label:test` | PASS |
| Direct `clang-format -n -Werror` equivalent of the Makefile target | PASS: 230 tracked C/C++ files, using clang-format 21.1.8 |
| CMake preset loading and explicit core-version resolution | PASS |
| Markdown checks on the new/updated English investigation documents | PASS |
| `make`, `make test`, `make lint`, `make lint-fix`, `make clang-format` | UNAVAILABLE: GNU Make is absent |
| `npm.cmd run rust:fmt`, `npm.cmd run rust:check` | UNAVAILABLE: Cargo/Rust is absent |
| Offline Conan dependency resolution for core 1.1.7 | BLOCKED: `dns-libs/2.10.2@adguard/oss` is not in the local cache |
| Native C++/Tauri compilation, native unit tests and installer packaging | NOT PERFORMED; no success is claimed |

The lockfile's only dependency-tree changes are application version labels, so the existing frontend dependencies were reused. Checks for a real compiled EXE or installer (`artifact:check`, `label:check`, `checksum:check`, `nsis:check:post`) require newly built artifacts and were not substituted with empty files. Ignored tests that alter the real Windows AutoRun registry value were not enabled. Docker/TUN integration tests and leak experiments were not run against the host VPN.

Imported release/vendor files retain their original bytes. Full merge whitespace checks report existing whitespace in vendored lwIP files and a few released scripts/license texts; those are not reformatted during synchronization. Newly authored investigation documentation is checked separately.

## Building the matching core later

The GUI version is 3.1.0 and the core version is 1.1.7. They are separate version numbers. The core's new automatic version logic can otherwise derive the application's `v3.1.0-pro` tag. Use an explicit core version and the exact released dependency set.

With a suitable MSVC developer environment, Rust, GNU Make or equivalent direct CMake commands, and bootstrapped Conan dependencies:

```powershell
cmake --preset msvc-relwithdebinfo -DTT_CLIENT_VERSION=1.1.7 -DVPNLIBS_ENABLE_LIVE_TESTS=OFF
cmake --build cmake-build-msvc-relwithdebinfo --target trusttunnel_client setup_wizard tests
ctest --test-dir cmake-build-msvc-relwithdebinfo --output-on-failure -LE live
```

Building the desktop EXE additionally requires the genuine sidecar and Windows resources described in the Pro build documentation. A successful frontend build does not produce a working VPN executable. No installed binary, firewall policy, route, credential, or application data was replaced during this synchronization.
