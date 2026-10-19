# Scoped security and stability corrections for Pro 3.2.0

Date: 2026-10-18.

Result: **DELIVERED** for the bounded source corrections and independently verified test candidate.
Checklist: **8/8 scoped change boundaries implemented and checked**. Live deployment and
packet-level acceptance are **UNPROVEN**, not claimed as passed.

## Change contract

The user authorized necessary, bounded corrections after the read-only security re-audit.
The active Internet connection and VPN must remain untouched. The installed application,
saved profiles, recovery kit and existing Desktop installer are preserved. This change
introduces no firewall owner, persistent block, service, installation prerequisite or migration.

The baseline is `cdb51354fef1b07663f7c5b6d83963846d7e799d` plus the previously verified
installer-recovery working tree. Existing incident fixes must not be reverted or folded
into a claim that the following corrections solve every item in the historical audit.

## Implemented boundaries

| Audit ID | Owning correction | Acceptance evidence | Result |
| --- | --- | --- | --- |
| POL-01 | Only a missing rules file yields defaults. Other read and parse failures propagate. | Private-directory, invalid UTF-8 and invalid JSON regression cases. | Corrected. |
| POL-05 | One process-mode validator covers deserialization, saving and policy generation. | Both historical modes and absent-key compatibility; invalid input cannot overwrite saved rules or select DIRECT. | Corrected. |
| APP-04 | Secret-bearing exports and reads use the existing quiet SSH executor. Export failures contain numeric codes only. Encoded connection links are redacted. | Fake-password/PEM/link failure cases and log-redaction tests. | Corrected for the identified paths. |
| TLS-01/02 | Use the endpoint certificate already exported over confirmed SSH. Remove unauthenticated automatic probes and automatic verification opt-out. | Ten pure export-policy/parser cases, including legacy CN-only PEM, chains and explicit advanced settings. | Corrected for newly generated/re-exported profiles. |
| TLS-03 | Reject a nonempty unusable custom certificate instead of silently substituting system trust. | The malformed-certificate regression fails against the old parser and passes after correction. Valid/empty/absent/explicit-opt-out cases remain covered. | Corrected. |
| Certificate compatibility | Explicit custom certificates may anchor incomplete chains. Their TLS-server purpose, dates and hostname remain checked. | Ten native partial-chain cases; six fail before the correction and all pass afterward. Foreign issuers, bad signatures, wrong names/purposes and expired/future certificates are covered. | Corrected within the existing custom-CA-store contract. |
| NET-05 | Match IPv4/IPv6 socket tables, prefer exact TCP endpoints, reject ambiguous owners and remove the permanent PID-name cache. Preserve explicit SOCKS versus TUN context and the unique-owner source-address fallback. | 26 deterministic matching tests. Independent review caught and corrected a SOCKS destination regression before packaging. | Partial: snapshot ownership remains an inference. |
| APP-03 | Open final export destinations without following leaf reparse points or truncating first. Check the open Windows handle for links. Reject copy-to-self before truncation. | Ordinary create/overwrite/copy tests; real private NTFS hardlinks and an explicitly executed leaf-symlink test verify target preservation. | The existing leaf-link defect is corrected. Concurrent directory/link replacement races remain outside this increment. |

## Compatibility and limits

- The pinned managed endpoint CLI exports the configured certificate through authenticated SSH.
  An empty certificate selects system verification. No new public certificate-fetch operation is added.
- Existing profiles are not automatically rewritten. Existing explicit verification opt-outs remain explicit opt-outs.
- The native verifier retains legacy CN support. Rust prevalidation checks structure, not an incompatible SAN requirement.
- A custom PEM remains a set of trusted certificates, not an exact comparison against one leaf.
  `PARTIAL_CHAIN` applies only to that explicit store; system trust and ordinary empty-certificate behavior are unchanged.
- A missing/ambiguous process owner still uses existing routing policy. IPv4-mapped dual-stack sockets,
  helpers and ownership races do not receive an isolation guarantee from these tests.
- NET-02 remains open for core-process failure while the GUI survives. Closing the complete client
  still permits ordinary Internet under the user's accepted policy. No external blocker is restored.
- Publisher signing, speculative updater/SSH attacks and narrowing Windows network exceptions are separate work.
  They are not resolved by this increment and must not be silently addressed with new installation blockers.

## Verification and artifact scope

All tests use synthetic inputs or private filesystem fixtures. Cargo dependency resolution is offline.
Native CMake/Conan package resolution explicitly disables remotes. No real endpoint probe, SSH request,
packet capture, route/adapter/firewall operation, product installation or VPN session is performed.
Packaging checks may query early-return version/capability flags; these do not initialize a VPN session.

Observed checks: 179 selected Rust tests, all-target Rust checking and strict Clippy;
4,110 frontend tests plus type/lint/translation/build checks; 21 native configuration/certificate
tests and 26 native process-matching tests. The filesystem symlink test is explicitly run,
not counted from its normally ignored declaration.

The exact tested GUI/script inputs and 16 relevant native inputs are recorded with SHA-256 in
the private `security-stability-fixes` receipts. Packaging must verify those inputs and the
extracted payload before publishing an additional, distinctly named Desktop candidate.
The previous Desktop installer must not be overwritten.

The additional Desktop installer is `TrustTunnel Client Pro_3.2.0_security-candidate_x64-setup.exe`,
9,817,142 bytes, SHA-256 `5ca03594794e6fe2385b6d40d211f66c9bbf49fa90e3fb09dbedf636ae947743`.
Its extracted core is SHA-256 `ed44123abae84992f431755a4e0dff302892d96dcdd306e329b036b45c543699`.
All seven actual-package gates passed, including emitted NSIS inspection and extracted-payload privacy.
The source build resource is updated to that same tested core; its previous bytes are archived privately.
Tauri normalized only the staged `Cargo.toml` line endings; source comparisons explicitly account for this.
This is an unsigned test candidate, consistent with the existing signing configuration.
Independent artifact review confirmed all payload hashes, the expected Tauri bundle-marker
change, 16/16 emitted NSIS checks and preservation of the installed binaries and previous setup.
All nine existing settings files also retain their previous hashes, sizes and modification times.

Scope checklist: rules, diagnostic secrecy, authenticated export, certificate compatibility,
process attribution correction, leaf-file protection, focused regression checks and source freeze
are implemented. Live installation and packet-level acceptance remain **UNPROVEN** and require
an isolated Windows test environment. A successful build does not establish absence of real IP leaks.
