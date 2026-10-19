# Installer maintenance incident and recovery

## Observed impact

The user reported that installation, reinstallation and removal of the 3.2.0 test candidate failed. Ordinary Internet access continued to work. The unavailable VPN client was the user's only VPN, and a Windows restore point was needed to recover maintenance access. No system-wide Internet block is inferred from this incident.

The two screenshots show the network-protection cleanup error after payload extraction and creation of `uninstall.exe`. The captured candidate was SHA-256 `5838694f72bf69809802d5b633c348a285be180a59009056999b90b83fe1327e`. The earlier persistent-protection candidate and this GUI-session-protection candidate are withdrawn.

## Reproduced root cause

The Unicode NSIS script used `nsExec::ExecToStack` without `/MBCS` to capture the native core's narrow output. A compiled, isolated fixture returned exactly `32 0D 0A` (`2\r\n`) with exit code zero. NSIS captured `?`, so the version comparison failed before the cleanup command was reached.

The failure handler called `Abort` after copying program files, writing the new uninstaller and registering it. The same macro ran in the uninstaller before file deletion. The generated installer and uninstaller both returned error 2 and did not reach their completion markers. This explains the maintenance trap without assuming a live WFP error or Internet outage.

A counterfactual with `/MBCS` decoded the response correctly. It did not fix the broader design flaw: native failure or an equivalent JSON object in another key order still aborted maintenance. The correction therefore removes the dependency rather than merely adjusting text decoding.

Earlier tests validated source structure and explicitly allowed the two captured-output calls and their abort handler. They did not execute the Unicode plug-in boundary. Those exceptions and the withdrawn guard tests have been removed; compiled NSIS failure fixtures now cover this boundary.

## Corrections

- Installation and removal never parse cleanup output and never abort, display a blocking cleanup dialog, or retain the installation solely because cleanup failed. The optional command's return code only produces a localized detail-log warning.
- Setup always replaces files after stopping the client. It does not run the recorded old uninstaller first. A broken old uninstaller cannot block same-version repair, upgrade, downgrade, silent/passive setup or update mode. Actual removal uses the newly installed standalone uninstaller.
- The setup template is pinned to Tauri CLI 2.10.1. Only maintenance-page behavior, a provenance comment and two public-documentation annotations differ from upstream. Installation, standalone removal and user-data retention sections remain unchanged. The source gate rejects ten mutations that restore the old dependency or weaken maintenance safety.
- The external network guardian, resident helper, startup migration dependency, GUI handshake, heartbeat and recovery banner have been removed. The GUI neither arms nor waits for an external network barrier. Existing in-core Kill Switch behavior during a VPN connection remains, alongside the IPv6 routing correction, MTU defaults, routing priority and ping fix.
- A cleanup-only native helper can remove obsolete product-owned rules from the two withdrawn namespaces. It cannot create a filter, provider, sublayer or tunnel. Ownership uses the fixed namespace identifiers and product markers; it does not depend on a matching executable path, complete old policy or enabled-filter state.
- Cleanup removes blocks first and verifies both namespaces before removing any permits. Failed deletion, an incomplete inspection or a remaining block preserves permits and metadata. Independent committed deletions cannot be rolled back by a later metadata failure. A failed attempt cannot make surviving rules more restrictive by deleting their permits first.
- The cleanup-only command has a seven-second watchdog in addition to its cooperative budget. A stuck operation terminates only that helper. Read-only queries and the normal VPN process do not have this watchdog. The installer does not depend on the helper's success.
- The installer uses the exact safe composite `--version --network-guard-release`. New cores perform cleanup; supported older cores process `--version` and exit without starting a default VPN configuration. No captured output is required.

The new executable has cleanup capability 1 and retains legacy result format 2. The build gate rejects executables advertising the withdrawn arm/session/GUI-handshake modes. Saved profiles and settings are not migrated or silently rewritten.

## Executed verification

| Check | Result |
| --- | --- |
| Historical Unicode boundary | Actual compiled NSIS installer and generated uninstaller both reproduce exit 2; payload is left in place and removal is not reached |
| New optional cleanup | Five cases each for installation and removal: success, native error, absent helper, malformed output, timeout; all ten reach completion/file deletion |
| Maintenance recovery | Default, same-version, upgrade, downgrade, silent, passive and update mode all reach new payload without invoking a dummy broken old uninstaller |
| Negative oracle | Reintroducing an old-uninstaller call invokes its marker and is detected |
| Native cleanup | Four ordering regressions fail before the correction; final 21 ownership/failure/ordering/deadline tests pass |
| Full native selection | 117 tests pass, including configuration/IPv6, 67 routing matcher cases, certificates and endpoint probes |
| GUI backend | 266 selected Rust tests pass; locked all-target check and strict all-target Clippy pass after the template/config change |
| Frontend | 4,109 tests in 254 files pass; typecheck, lint and translations pass; final release-note parser rerun passes 11 cases |
| Packaging contracts | 29 core-gate fixtures pass; NSIS source gates and ten maintenance mutations pass; source privacy passes, including separate inspection of the new template |

The NSIS fixtures run under a private test directory with dummy executables and file markers. They do not change the installed application, its registry entries, network adapters or WFP rules. The final native core is SHA-256 `bb8923643c34c97c17df5387637b4f7264a3f68461a7f51a475655c7cc3eefff`.

## Source and acceptance limits

The tested working tree is based on `cdb51354fef1b07663f7c5b6d83963846d7e799d`. Its 743 GUI/script inputs, including the new template, have manifest SHA-256 `e449a1540a7e36755410e87d81e6e136a10d37411c2478241c97104bb8de31f4`; twelve native inputs are recorded separately. Removed guardian files are also removed from the neutral build staging directory. This is a working-tree snapshot, not a claim that the fix is in the base commit. Protected stale Git index metadata was left untouched; no fix commit was created.

The current installed client and active connection are preserved. No real legacy-rule cleanup or production installation/uninstallation has been run on the user's Windows session. Live WFP cleanup, complete VPN crash testing and installed dual-stack acceptance are not claimed. The compiled synthetic maintenance tests establish the formerly missing installer boundary and failure behavior without risking the user's working VPN.

Private evidence is in `release-3.2.0/installer-recovery-audit` under the task's visualization directory, including native red/green logs, NSIS plug-in and maintenance fixtures, template provenance, source manifests and package receipts. Final installer provenance is recorded in the [release ledger](RELEASE_SYNC_3_2_0.md).

The completed replacement installer is SHA-256 `bd1adf067b70daabd6cdb1acb2fdf00512b49011777419dd3d1e5d8b9cddf860`, 9,818,090 bytes, with a verified Desktop checksum. All seven measured package gates pass, including all sixteen emitted NSIS checks. Independent final comparison confirms nine settings files and both installed executables remain unchanged. The actual emitted maintenance functions match the compiled fixture and contain no old-uninstaller dependency or cleanup abort.
