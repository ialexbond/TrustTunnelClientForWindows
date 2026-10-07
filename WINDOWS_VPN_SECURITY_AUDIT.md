# Windows VPN Security Audit and Independent Review Casebook

Audit date: 2026-10-07 (Asia/Yekaterinburg).

**Post-audit synchronization:** On 2026-10-07, after this read-only audit, the user separately authorized updating local `master` to published Pro 3.1.0. The release was merged while retaining local history, and missing Windows/core build sources were restored. See [synchronization and verification notes](docs/RELEASE_SYNC_3_1_0.md). The original working-tree identifier below remains the historical audit baseline, not the current branch tip. PRI-02 and the master-only updater launcher regressions described below are cleared in the synchronized working tree because their release fixes are now present. The other release findings were not repaired by this synchronization.

This is a catalogue of the security and anonymity issues discovered in the reviewed Windows Pro client, with reproducible investigation plans and explicit ways to challenge each conclusion. It is an investigation artifact, not an implementation plan or a claim that every possible vulnerability has been found. No VPN configuration, routing table, firewall policy, certificate, credential, installer, or application source was changed during the audit. The only intended repository change is this report.

## Result and evidence standard

**Verdict: FAIL for the strict network privacy requirement.** Source analysis identifies reachable cases in which user traffic is not continuously constrained to an authenticated VPN tunnel. Several additional findings depend on configuration, local access, or runtime conditions and must not be presented as experimentally demonstrated exploits.

The required privacy contract is: user traffic either leaves through an authenticated VPN tunnel or is blocked, including during startup, reconnection, server switching, and process failure. Necessary transport to establish the VPN and tightly scoped local network configuration traffic are distinct from permission for arbitrary application traffic. Intentional split tunneling does not satisfy a whole-computer no-direct-egress contract.

Status labels used in this report:

| Label | Meaning |
| --- | --- |
| STATIC-CONFIRMED | The stated behavior and reachable call path are supported by source. Packet-level exploitation has not been demonstrated. |
| CONDITIONAL | The unsafe path exists, but practical exploitation depends on the listed configuration, socket availability, privileges, or network conditions. |
| POLICY-LIMITATION | An intentional feature or compatibility choice conflicts with the strict privacy contract. It is not necessarily an accidental implementation defect. |
| HYPOTHESIS | A concrete concern requires missing runtime or platform evidence. It must not be counted as a confirmed vulnerability. |
| CLEARED / REJECTED | A suspected issue was contradicted by evidence, fixed in the reviewed release, or did not establish a meaningful trust-boundary violation. |

P1 means high-priority loss of the required security guarantee; P2 means a material but conditional or narrower exposure; P3 means a lower-impact issue. These are engineering priorities for this client, not CVSS scores. No P0 or assigned CVE is asserted.

## Finding index

There are 24 review entries, including conditional scenarios, policy limits, unverified candidates and one finding cleared for the installed release. This is not a claim of 24 proven exploitable vulnerabilities. APP-05 contains two distinct unverified SSH subcases; NET-02 contains several lifecycle triggers. Priorities below concern review order, not an assertion that every listed attack has occurred.

| ID and case | Priority | Evidence status / limitation | Baseline |
| --- | --- | --- | --- |
| [NET-01: IPv6 absent from both routing and general blocking](#net-01-ipv6-absent-from-both-routing-and-general-blocking) | P1 | STATIC-CONFIRMED; conditional leakage | Working + release |
| [NET-02: The traffic barrier shares the core process lifetime](#net-02-the-traffic-barrier-shares-the-core-process-lifetime) | P1 | STATIC-CONFIRMED; conditional leakage | Working GUI + release core |
| [NET-03: DHCP port allowances are blanket transport exceptions](#net-03-dhcp-port-allowances-are-blanket-transport-exceptions) | P1/P2 | CONDITIONAL | Working + release |
| [NET-04: Endpoint IP exemption applies to every process and port](#net-04-endpoint-ip-exemption-applies-to-every-process-and-port) | P2 | STATIC-CONFIRMED; conditional disclosure | Release core |
| [NET-05: Process identification is incomplete and uncertainty can select direct egress](#net-05-process-identification-is-incomplete-and-uncertainty-can-select-direct-egress) | P1 | CONDITIONAL; selective mode | Working GUI + release core |
| [NET-06: Initial protection is installed after DNS and route changes](#net-06-initial-protection-is-installed-after-dns-and-route-changes) | P2 | CONDITIONAL | Release core |
| [NET-07: Source-address trust instead of interface identity](#net-07-source-address-trust-instead-of-interface-identity) | P3 candidate | HYPOTHESIS | Release dependency |
| [TLS-01: Certificate-probe failure persists disabled VPN authentication](#tls-01-certificate-probe-failure-persists-disabled-vpn-authentication) | P1 | STATIC-CONFIRMED | Working + release |
| [TLS-02: An unauthenticated fetched certificate becomes persistent VPN trust](#tls-02-an-unauthenticated-fetched-certificate-becomes-persistent-vpn-trust) | P1 | CONDITIONAL | Working + release |
| [TLS-03: Malformed custom PEM silently falls back to system trust](#tls-03-malformed-custom-pem-silently-falls-back-to-system-trust) | P2 | CONDITIONAL; custom-trust intent | Release core + GUI import |
| [POL-01: Read errors turn an existing rules file into empty defaults](#pol-01-read-errors-turn-an-existing-rules-file-into-empty-defaults) | P1 | STATIC-CONFIRMED; selective impact | Working + release |
| [POL-02: Preparation/write failures do not stop a spawn using stale or mixed rules](#pol-02-preparationwrite-failures-do-not-stop-a-spawn-using-stale-or-mixed-rules) | P1 | STATIC-CONFIRMED; conditional impact | Working + release |
| [POL-03: Unresolved protected groups are discarded while preparation succeeds](#pol-03-unresolved-protected-groups-are-discarded-while-preparation-succeeds) | P1 | POLICY-LIMITATION; selective impact | Working + release |
| [POL-04: Implicit LAN bypass and exact-string override violate strict coverage](#pol-04-implicit-lan-bypass-and-exact-string-override-violate-strict-coverage) | P2 | POLICY-LIMITATION | Working + release |
| [POL-05: Unknown process mode is interpreted as direct exclusion](#pol-05-unknown-process-mode-is-interpreted-as-direct-exclusion) | P3 | STATIC-CONFIRMED; invalid input | Working + release |
| [LOC-01: Same-user plaintext config access reveals server address and credentials](#loc-01-same-user-plaintext-config-access-reveals-server-address-and-credentials) | P2 | POLICY-LIMITATION; local secrets | Working + release |
| [PRI-01: Application-originated third-party requests are not gated on protected connectivity](#pri-01-application-originated-third-party-requests-are-not-gated-on-protected-connectivity) | P2 | POLICY-LIMITATION; startup requests | Working + release |
| [PRI-02: The local working tree reintroduces an external font request fixed in release 3.1.0](#pri-02-the-local-working-tree-reintroduces-an-external-font-request-fixed-in-release-310) | P3 | Working regression; CLEARED in release | Working only |
| [UX-01: Connected status is emitted after failed traffic-readiness probes](#ux-01-connected-status-is-emitted-after-failed-traffic-readiness-probes) | P2 | STATIC-CONFIRMED; status only | Release |
| [APP-01: A matching checksum is accepted without an independent publisher check](#app-01-a-matching-checksum-is-accepted-without-an-independent-publisher-check) | P2 | STATIC-CONFIRMED trust gap; conditional attack | Working + release |
| [APP-02: A random TEMP name does not establish protection against replacement after verification](#app-02-a-random-temp-name-does-not-establish-protection-against-replacement-after-verification) | P2 candidate | CONDITIONAL; privileges/race untested | Working + release |
| [APP-03: An existing destination symlink bypasses the export write's root check](#app-03-an-existing-destination-symlink-bypasses-the-export-writes-root-check) | P2 | STATIC-CONFIRMED validation; conditional attack | Working + release |
| [APP-04: Copying a VPN link also copies its credential into diagnostic history](#app-04-copying-a-vpn-link-also-copies-its-credential-into-diagnostic-history) | P2 | STATIC-CONFIRMED secret data flow | Working + release |
| [APP-05: SSH protection is substantial; two additional boundaries need controlled tests](#app-05-ssh-protection-is-substantial-two-additional-boundaries-need-controlled-tests) | Unassigned | HYPOTHESIS; two separate candidates | Working + release |

Review first: family coverage and protection lifetime (NET-01/02/03), selective-policy fail-open behavior (NET-05, POL-01/02/03), server identity (TLS-01/02), and diagnostics containing usable credentials (APP-04). A minimal intervention for each case is described as desired behavior; no intervention was applied.

## Scope, revisions, and provenance

The scope is the active Windows **TrustTunnel Client Pro**, its C++ VPN core, Windows filtering dependency, certificate policy, routing policy, lifecycle, elevated application commands, updater/installer boundary, SSH trust, and local secret exposure. Android, Apple adapters, server software internals, and a complete independent audit of the legacy `gui-app` and `gui-light` editions are excluded. Legacy files are discussed only where they affect provenance or show a regression in the current working tree.

| Baseline | Exact identifier | Role |
| --- | --- | --- |
| Working checkout | `master`, `0843800b8940e7b2e337f21d2c60e067aa0a1be2` | The user's local application source at audit time. Its package manifest reports 3.0.0 and much of the core was trimmed out. |
| Published Windows release | `origin/release/tt-win-3.1.0`, `19179709045dc2fa533eac388563fc3e830328ab` | Primary release baseline for the installed Pro 3.1.0. Findings distinguish it from the working checkout. |
| Remote application master | `origin/master`, `2d86f47dacea1ebac6fa0d425fd43a831bfa6011` | Fetched application remote; already an ancestor of the working checkout. |
| Refreshed official upstream | `upstream/master`, `5719c6ee1d49d3d3f97af7087c6770af9d027ca6` | Reference for upstream state, not silently merged into the fork. |
| Core release version | 1.1.7 | Installed executable version; release source contains fork-specific process filtering, so official upstream source alone is insufficient for that feature. |
| Filtering dependency | NativeLibsCommon 8.1.52 | Version declared by the release's `conanfile.py`; its official WFP implementation was inspected. |
| DNS dependency | DnsLibs 2.10.2 | Official proxy failure behavior was inspected for the installed core generation. |

The application origin is [ialexbond/TrustTunnelClientForWindows](https://github.com/ialexbond/TrustTunnelClientForWindows). Its upstream is [TrustTunnel/TrustTunnelClient](https://github.com/TrustTunnel/TrustTunnelClient). Core 1.1.7's official release documents the dependency update to NativeLibsCommon 8.1.52 and DnsLibs 2.10.2: [release v1.1.7](https://github.com/TrustTunnel/TrustTunnelClient/releases/tag/v1.1.7).

Read-only inspection of the installed files under `C:\Program Files\TrustTunnel Client Pro` found:

| File | Version | SHA-256 |
| --- | --- | --- |
| `trusttunnel.exe` | 3.1.0 | `10C1B7A196370889E86AD9E6E41BC16ADDC72E751CFC1BDA98DCC5A5C8381AAD` |
| `trusttunnel_client.exe` | 1.1.7 | `4FC5B18C9A0CCBF4BD0BAB27396D4EBFD55C201B05E11D4755BB11EF94BD42C9` |

The installed core contains the strings `process_direct_file`, `process_proxy_file`, and `process_block_file`, consistent with the fork's process-filter feature. File version strings and feature strings are provenance evidence, not proof of a reproducible source-to-binary build. The exact running elevated processes' image paths were not readable through the initial process inventory. Do not silently equate any older local executable with the installed binary.

The existing local core copies of `net/src/os_tunnel.cpp`, `net/src/os_tunnel_win.cpp`, `trusttunnel/src/client.cpp`, and `core/src/tunnel.cpp` were checked against the published release and are byte-identical for the inspected source. They reside under `.claude/worktrees/ecstatic-aryabhata-e631a1`, but that worktree's other files and executable are older. Immutable release references below take precedence over a convenient local copy.

### Synchronization performed

The audit ran `git fetch --no-tags origin`, followed by `git fetch --no-tags upstream`. No remote repository was modified. After fetching, `git rev-list --left-right --count HEAD...origin/master` returned `391 0`: 391 commits unique to the local checkout and no remote-master commits missing locally. `git merge --ff-only origin/master` returned `Already up to date.` The checkout stayed at `0843800b8940e7b2e337f21d2c60e067aa0a1be2`.

This is a synchronization of remote knowledge and confirmation that local master already incorporates remote master. It is not a reset to the release branch, publication of the 391 local commits, or a merge of official upstream into the application fork. Those would be different operations and are not necessary to produce this report.

### Reading the exact code without changing the checkout

Use immutable Git objects rather than switching branches or restoring missing C++ sources:

```powershell
$auditRelease = '19179709045dc2fa533eac388563fc3e830328ab'
git show ($auditRelease + ':trusttunnel/src/client.cpp')
git show ($auditRelease + ':net/src/os_tunnel_win.cpp')
git show ($auditRelease + ':gui-pro/src-tauri/src/sidecar.rs')
git diff 0843800b8940e7b2e337f21d2c60e067aa0a1be2 $auditRelease -- gui-pro/src-tauri/src
```

A GitHub permalink to a local-only commit may be unavailable. For working-tree findings, the exact local Git object and path are the authoritative evidence. For release findings, published commit permalinks are provided. Line numbers are one-based source lines; web extractors can remove blank lines, so their display line numbers must not be substituted for Git source line numbers.

## Threat model and interpretation

- An external website, DNS service, STUN server, or controlled test receiver must not receive ordinary user traffic directly from the user's physical public IPv4 or IPv6 while strict protection is engaged.
- An untrusted Wi-Fi/Ethernet network can control routing/DHCP and may intercept initial unauthenticated certificate discovery. Such control must not be assumed to defeat TLS authentication when authentication remains enabled.
- An ordinary local application may select an interface or bind a socket to an available port. It is not automatically assumed to have administrator privileges, permission to inject arbitrary raw packets, or permission to modify Windows filtering policy.
- A same-user local process shares some Windows security boundaries with the client. Readable files, user-scoped credentials, and attacker-writable updater inputs need separate analysis from remote traffic leaks.
- A local administrator or a compromised kernel can change the protection itself. This audit does not claim a client can conceal network state from those actors.
- The physical network must know enough to deliver packets, and the VPN endpoint necessarily receives the user's connection. Hiding the real address from that endpoint, hiding a LAN MAC address, and preventing identification through browser accounts are different goals from preventing direct user-traffic egress.

The article motivating the first investigation concerns Android applications entering an excluded tunnel and discovering its exit/server address. That is different from exposing a user's physical public address. This Windows report keeps both directions of disclosure distinct: [Habr article](https://habr.com/ru/articles/1089082/).

## Common laboratory protocol

These are proposed tests, not tests performed on the user's computer. Use a disposable Windows VM or a dedicated test machine and controlled receivers. Do not disable a production firewall, kill the user's active VPN, install rogue routes, replace credentials, or send real browsing data to a third party.

1. Record application/core file hashes, exact source revision, effective listener routes, endpoint address, VPN mode, process rules, DNS mode, and other active firewall/VPN products. Redact passwords, private keys, access tokens, and personally identifying addresses from shared artifacts.
2. Use dual-stack connectivity and receivers you control. Record the physical IPv4/IPv6 and VPN exit addresses separately. If the physical and VPN exit addresses are indistinguishable in the laboratory topology, fix that topology before interpreting results.
3. Capture continuously on every physical interface and, separately, on the TUN interface. Record receiver-side source addresses and timestamps. Packet capture privileges must not be confused with the privileges of the application generating the tested traffic.
4. Send distinct run IDs in continuous TCP and UDP traffic to a receiver that is not the VPN endpoint and is not in a deliberate exclusion. Use fresh controlled DNS names when DNS behavior is under test; cached answers can hide the absence of new queries.
5. Establish a no-VPN baseline and a steady protected baseline. Then trigger exactly one fault or policy condition per case. Capture before, during, and after it; a single successful request after reconnection cannot establish continuous protection.
6. Record two separate outcomes. **HOST-EGRESS-ESCAPE** requires a physical capture of non-encapsulated user traffic outside the permitted VPN transport. **REMOTE-PUBLIC-IP-DISCLOSURE** requires the controlled receiver to receive the run ID with `DIRECT_SOURCE`, corroborated by the uplink capture. A locally captured packet may be dropped later; it does not by itself prove a website received the user's public IP. A direct global-source packet can still expose that source to a local network observer. TLS encryption does not hide the source IP from a receiver that actually receives the direct request.
7. An ordinary outer connection from the client to its real VPN server is expected and is not itself a user-traffic leak. A third-party DNS resolver address is also not, by itself, proof of DNS bypass: determine whether the request reached it inside the VPN.
8. Keep black-holed traffic, intentional direct traffic, DNS disclosure, local metadata exposure, false UI status, and successful attack traffic as separate results. Absence of packets can demonstrate blocking for a tested case; it does not prove all possible paths safe.
9. Restore the VM snapshot after each configuration/route/certificate/installer experiment. Retain sanitized receiver logs and captures with a manifest of the test's actual preconditions.

Each finding below supplies the additional trigger and a specific falsification criterion. If a case cannot establish the required preconditions, mark it **inconclusive**, not reproduced or disproved.

## Network enforcement

### Baseline, evidence and verification limits

This section covers C++ tunnel setup, Windows Filtering Platform (WFP), transport exceptions and process attribution. No VPN state, route, firewall rule or system setting was changed; no reproduction traffic was sent. Findings distinguish confirmed code behavior from an unexecuted leakage scenario.

The application baseline is `0843800b8940e7b2e337f21d2c60e067aa0a1be2`; the Pro 3.1.0 release/core baseline is `19179709045dc2fa533eac388563fc3e830328ab`. The installed core identified in the audit inventory reports 1.1.7 and SHA256 `4FC5B18C9A0CCBF4BD0BAB27396D4EBFD55C201B05E11D4755BB11EF94BD42C9`. A version/hash identification is not a packet-level demonstration or a reproducible-build proof.

The release requires NativeLibsCommon 8.1.52 ([dependency declaration][dependency]). Its annotated tag resolves to commit `58cef252031e2cc1f540ecaec2952f5f32afa3a1`. The official WFP source was read; it is textually identical, ignoring CRLF/LF line endings, to the accessible local 8.1.49 WFP source. Four accessible core source copies have Git blob hashes identical to the release baseline: `net/src/os_tunnel.cpp`, `net/src/os_tunnel_win.cpp`, `trusttunnel/src/client.cpp`, and `core/src/tunnel.cpp`.

Existing core tests include `core/test/test_tunnel.cpp`, `core/test/test_dns_routing.cpp`, `core/test/test_vpn_dns_resolver.cpp`, and `net/test/test_network_manager.cpp`. A targeted search of release `core/test`, `net/test`, and `trusttunnel/test` found no references to `killswitch`, `block_untunneled`, `find_pid_by_port`, `block_ipv6`, `included_routes`, or `excluded_routes`. That demonstrates a coverage gap in those directories, not the absence of every possible external test. Existing GUI lifecycle tests cannot establish actual Windows packet containment.

### Shared isolated-VM verification protocol

Execute the following only in a disposable Windows VM with a snapshot, a dedicated lab VPN server, and a controlled TCP/UDP sink. Keep the user's current VPN and network untouched. The sink should provide a public IPv4 and globally routable IPv6, distinct from the VPN endpoint unless testing NET-04. The VM must have independent egress; a host-wide VPN or NAT policy must not silently tunnel the VM's traffic.

Record Windows/core versions and hash, effective configuration, IPv4/IPv6 addresses and routes, tunnel identity, active WFP filters, and other installed network filters. Establish the sink's observed source with VPN off (`DIRECT_SOURCE`) and through the VPN (`VPN_SOURCE`). Capture the VM's physical uplink, TUN, and sink concurrently. Physical-uplink capture should include the controlled sink and endpoint addresses; encrypted endpoint traffic is expected and is not a leak.

Send only unique harmless markers: one TCP connection to the controlled listener on port 44443 and one UDP datagram to port 44444, separately for each address family. Log every bind/connect/send error. A public-IP leak requires the sink to receive the marker with `DIRECT_SOURCE`, corroborated by direct traffic on the physical uplink. A local packet containing a private address proves LAN exposure only. A timeout alone proves neither containment nor leakage. For each exception test, repeat an ordinary ephemeral-port IPv4 request explicitly bound to the physical interface as a negative control: a correctly active Kill Switch should block it for a covered destination.

### NET-01: IPv6 absent from both routing and general blocking

**Severity:** P1. **Status:** STATIC-CONFIRMED configuration/code mismatch; actual public-IP leakage is conditional and has not been reproduced.

**Trace:** The GUI's [generated configuration][gui-config] enables Kill Switch but supplies only `0.0.0.0/0` at line 878, identically in both reviewed application and release baselines. [Client setup][client-routes] forwards the supplied route list rather than the defaults. [Route preparation][route-preparation] does not add an IPv6 route when none is supplied. The [Windows default][windows-default] leaves `block_ipv6` false, and [client Windows setup][client-windows] changes only the Kill Switch and port-exclusion fields. The [WFP IPv6 branch][wfp-ipv6] is skipped when the resulting IPv6 route list is empty. DNS-specific filters do not substitute for a general TCP/UDP IPv6 block.

**Trigger and impact:** A newly generated or similarly configured profile is used on an uplink with working public IPv6. IPv6-capable applications may choose a direct path without entering TUN. This can expose the user's global IPv6 even with Kill Switch enabled. `endpoint.has_ipv6` describes server capability; it does not fill the missing OS routes.

**VM verification:** Use the generated IPv4-only profile in General mode with Kill Switch on. Confirm an IPv6 default route and successful off-VPN IPv6 control. Send TCP and UDP markers to the sink's IPv6 literal, first with normal socket selection, then explicitly selecting the physical interface. Predicted vulnerable result: physical IPv6 packets and `DIRECT_SOURCE` at the sink. Compare IPv4, which should tunnel or block. Add IPv6 coverage only in a separate VM control profile, then repeat.

**Falsification/counter-evidence:** An effective config containing an appropriate IPv6 route, an independently installed IPv6 firewall block, or no IPv6 connectivity prevents this particular scenario. Captured IPv6 rejected because the endpoint lacks IPv6 is a different, safe failure. Browser IPv4 success is insufficient evidence either way.

**Response/remediation/tests:** Current setup can succeed without a general IPv6 barrier. Require an explicit per-family decision: tunnel supported IPv6 or block unsupported IPv6 before declaring full protection. Add configuration-to-filter coverage tests and a dual-stack Windows sink/capture test; test endpoint capability independently from host capture.

### NET-02: The traffic barrier shares the core process lifetime

**Severity:** P1. **Status:** STATIC-CONFIRMED filter-lifetime behavior; subsequent public-IP leakage depends on post-exit routes and other policy.

**Trace:** [WFP session][wfp-session] is dynamic. [Destructor][wfp-destructor] closes it normally; Windows also terminates its session when the owning process dies. [Microsoft's object-lifetime documentation][ms-lifetime] confirms that dynamic objects are then deleted. There is no persistent barrier in this implementation independent of the core.

**Trigger and impact:** Core crash, forced process termination, or teardown/recreation during recovery removes this barrier. Once ordinary routing becomes available, unrelated applications can resume direct connections. Keeping a dead-tunnel core alive can preserve its filters; a server outage alone therefore does not prove a leak.

**VM verification:** While connected, have the controlled client emit uniquely sequenced TCP/UDP markers for both families. Verify the normal path, then forcibly terminate only the core in the VM. Record process exit, WFP object deletion, TUN/route transitions, and the GUI's eventual state. Continue markers briefly. A transition to `DIRECT_SOURCE` demonstrates leakage; a restart interval may be sufficient. Separately compare a server transport outage with the core kept alive.

**Falsification/counter-evidence:** Filters may disappear while surviving routes still black-hole traffic; another filter may keep blocking. Such an outcome falsifies immediate leakage in that run, not loss of the core-owned barrier. Filter persistence alone must be checked rather than inferred from a GUI checkbox.

**Reachable GUI lifecycle variants:** Release `gui-pro/src/shared/hooks/useVpnActions.ts:390` invokes disconnect before the replacement connect at `:454`, and waits for teardown to settle. Release `gui-pro/src-tauri/src/commands/vpn.rs:2279` terminates the old core during respawn, restores pre-VPN DNS at `:2293`, and only later spawns the replacement at `:2415`. After unsuccessful recovery, `gui-pro/src-tauri/src/connectivity.rs:2505` deliberately tears down the remaining core, releasing a state that the nearby comment describes as blocking all traffic. The application's Windows job object also ties child termination to application lifetime (`sidecar.rs:433`, `job_object.rs:123`). These are variants of the same protection-lifetime issue, not four unrelated vulnerabilities.

In separate VM runs, test an ordinary server switch, recovery followed by an unavailable replacement, recovery-budget exhaustion, and forced GUI termination. Keep the marker producer independent of the VPN GUI and capture through the entire transition. Expected application reactions differ: switching/reconnecting UI, eventual Error, or no surviving GUI. None of those reactions is a substitute for a still-active traffic barrier. Release fixes that wait for teardown and prevent overlapping cores improve lifecycle correctness but do not establish continuous containment. A deliberate user action to release strict protection is a separate case; it must not be silently inferred from selecting another server.

**Response/remediation/tests:** Core protection ceases with its process; the GUI cannot preserve it merely by changing status. Keep the safety barrier independently managed across crashes/restarts, with narrowly defined explicit release semantics. Add Windows process-kill, failed-respawn, repeated-reconnect, and GUI/core lifetime tests with sink evidence.

### NET-03: DHCP port allowances are blanket transport exceptions

**Severity:** P1 for deliberate bypass; P2 for accidental exposure. **Status:** CONDITIONAL; overbroad filter conditions are statically confirmed, but exploitation requires a bindable allowed local port and direct physical routing.

**Trace:** [Generated profile][gui-config] permits 67/68; GUI [defaulting/validation][gui-dhcp] preserves or adds them. [Client setup][client-windows] passes these ports to [Windows setup][windows-setup]. [IPv4 port rules][wfp-ports4] and [IPv6 port rules][wfp-ports6] allow the specified local ports at both connect and receive/accept layers. They do not constrain the protocol, destination port, DHCP service, or physical adapter. Their permit priority exceeds the untunneled block. This is substantially broader than DHCP renewal traffic.

**VM verification:** Choose a covered sink distinct from exclusions. Establish that an ephemeral local port explicitly using the physical interface is denied. Then attempt TCP and UDP sockets using available local ports 67 and 68 with that same physical interface, sending to sink ports 44443/44444 rather than DHCP destinations. Repeat IPv6 with a profile that actually has IPv6 capture/blocking, so NET-01 cannot explain success. Verify the sink observes `DIRECT_SOURCE` before calling it a leak.

**Falsification/counter-evidence:** DHCP may already own the port; a failed bind is not a successful containment test. Other firewall policies may deny the request. Do not assume privileged ports have Unix semantics on Windows, or claim unprivileged success without testing. A packet sent through TUN despite the permission is not a direct leak.

**Response/remediation/tests:** The application treats these as generic permitted ports; it has no reason to report non-DHCP use. Replace the blanket exception with the smallest service/protocol/destination/interface policy needed for DHCP. Test renewal success alongside denied non-DHCP TCP/UDP use of the same local ports, inbound and outbound.

### NET-04: Endpoint IP exemption applies to every process and port

**Severity:** P2. **Status:** STATIC-CONFIRMED broad destination exemption; an attacker-controlled addressing scenario remains conditional and no DNS attack was executed.

**Trace:** [Client endpoint exclusion][client-routes] resolves every endpoint address and appends its host IP, dropping port context, to `complete_excluded_routes`. [Route preparation][route-preparation] subtracts these destinations. The remaining routes also delimit [WFP blocking][windows-setup]. An unrelated process therefore shares an exception intended for VPN transport.

**Trigger and impact:** An application accesses another service on the VPN server's IP or a co-hosted service. The remote service can see direct user egress. Seeing the user's source at the VPN transport endpoint itself is expected; the defect is the unrelated application's unprotected connection. A ServerIP/DNS-redirection attack additionally requires a credible address-mapping scenario and must not be asserted from the exemption alone.

**VM verification:** Host a benign TCP/UDP echo service on separate ports of the controlled VPN endpoint. From a non-core test process, send markers to it while connected and compare with an equivalent service on a non-excluded sink. Test both families where available. Endpoint-service `DIRECT_SOURCE` plus a tunneled/denied distinct-IP control demonstrates the breadth of the exemption.

**Falsification/counter-evidence:** A same-IP connection may still choose TUN due to an independent route; endpoint service reachability or firewall configuration may prevent the test. TLS certificate failures do not themselves prove application traffic went directly to the intended remote service.

**Response/remediation/tests:** The exemption is intentional and produces no warning. Scope transport permission to the core identity and necessary endpoint tuples, retaining bootstrap/reconnect support. Add same-IP/different-process/different-port and endpoint-address-change tests; assess DNS authenticity separately.

### NET-05: Process identification is incomplete and uncertainty can select direct egress

**Severity:** P1 for promised per-application protection in Selective mode. **Status:** CONDITIONAL; attribution/fallback weaknesses are statically confirmed, but misattribution and leakage scenarios require runtime verification.

**Trace:** [Owner lookup][owner-lookup] reads only AF_INET TCP/UDP tables and selects the first matching local port, without the complete connection tuple. [PID cache][pid-cache] is static, caches failed lookups, and lacks a process-generation check. [Routing decision][process-decision] leaves unknown owners at DEFAULT and labels them `trusttunnel_client`. [Mode selection][mode-selection] maps Selective DEFAULT to direct upstream. [Direct transport][direct-transport] invokes socket protection for physical-interface egress; the [core-wide self-permit][wfp-self] means those relayed sockets are not stopped by its Kill Switch.

**Trigger and impact:** An IPv6 connection after capture is enabled, lookup/access failure, process exit/reused PID, shared port, or another executable performing work for the selected app can miss its intended rule. In General mode an unknown owner normally remains tunneled. Plain DNS DEFAULT has separate handling; this finding does not establish universal DNS leakage.

**VM verification:** Configure only the controlled client executable as proxy in Selective mode. Supply IPv6 coverage to isolate attribution from NET-01; test its IPv4/IPv6 TCP/UDP. Use a separately instrumented core test harness to force owner lookup failure and verify the resulting action; clearly label that as a component test, not an installed-binary reproduction. Exercise process exit/PID reuse and same-local-port cases only when Windows permits them, logging true ownership and the chosen rule. Sink `DIRECT_SOURCE` from the selected client proves impact.

**Falsification/counter-evidence:** A domain/IP proxy rule may independently tunnel the request. Correctly identifying the selected process on the tested connection does not validate untested helpers or IPv6. A deliberately unselected helper's direct traffic may be intended split routing, but contradicts an unqualified claim to protect every action of the selected app.

**Response/remediation/tests:** Default fallback is silent apart from technical logs. Prefer reliable WFP owner identity; handle unknown attribution explicitly, tunnel or deny protected-policy uncertainty, and invalidate reused PID identities. Test both families, lookup errors, helpers, process generations, cache failure recovery and full tuples.

### NET-06: Initial protection is installed after DNS and route changes

**Severity:** P2; potentially P1 if connection/recovery promises protection from the first action. **Status:** CONDITIONAL; ordering is statically confirmed, but interval duration and packet impact are unmeasured.

**Trace:** [Client runner][client-runner] starts connection preparation before creating TUN. [Windows initialization][windows-setup] configures its interface, DNS restrictions, optional IPv6 block and routes before the general untunneled block at line 255. Transactions make individual filter batches atomic, not the whole startup transition.

**VM verification:** Emit low-rate unique markers before, during and after Connect, recording precise GUI/core/filter/route timestamps. Repeat initialization failures using a disposable fault-injection build or VM-specific denied setup step; distinguish those experiments from stock success behavior. Check physical packets and sink source against the moment a protection promise is shown. Repeat reconnect/core replacement and both families/protocols.

**Falsification/counter-evidence:** Pre-connect direct traffic can be expected if protection is explicitly session-only. Routes may already black-hole traffic before filters finish, and DNS restriction failures abort setup rather than being silently ignored. Neither ordering alone nor an initialization error proves a leaked packet.

**Response/remediation/tests:** Core can return setup errors after earlier system changes; teardown/recovery then governs availability. Establish the independent barrier before beginning a protected transition, and publish readiness only after all required routes/filters are verified. Add transition/failure tests with assertions on emitted packets and displayed status, not only function completion.

### NET-07: Source-address trust instead of interface identity

**Severity:** P3 investigation candidate, not a confirmed vulnerability. **Status:** HYPOTHESIS; no bypass has been demonstrated.

The [tunneled-source allowance][wfp-source] checks local TUN/loopback addresses rather than the actual outgoing adapter. A candidate is a socket using a TUN source address while an altered weak-host/virtual-network configuration permits physical egress. Default Windows strong-host behavior is material counter-evidence: [Microsoft][ms-stronghost] documents strong-host mode as the default. This does not establish ordinary physical-interface binding as a bypass.

In the isolated VM, first verify default weak-host settings and require denial of the ordinary physical-source control. Then separately test binding the TUN source address and selecting the physical interface, logging OS rejection, uplink capture, router forwarding/NAT, and sink receipt. A modified weak-host configuration is a separate prerequisite and must be reported as such. A physical packet with a private TUN source proves only local escape unless the public sink receives a correlated marker with direct egress identity. No result has been obtained here.

If supported deployments make the hypothesis reproducible, bind allowance to interface identity as well as permitted transport/owner properties. Add that deployment to the Windows containment matrix. Otherwise retain this as a falsified or environment-specific hypothesis, not a confirmed leak.

[dependency]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/conanfile.py#L43
[gui-config]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/ssh/mod.rs#L861-L880
[gui-dhcp]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/config.rs#L41-L68
[client-routes]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/trusttunnel/src/client.cpp#L488-L521
[client-windows]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/trusttunnel/src/client.cpp#L536-L559
[route-preparation]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/net/src/os_tunnel.cpp#L71-L97
[windows-default]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/net/src/os_tunnel.cpp#L243-L251
[windows-setup]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/net/src/os_tunnel_win.cpp#L222-L259
[wfp-ipv6]: https://github.com/AdguardTeam/NativeLibsCommon/blob/58cef252031e2cc1f540ecaec2952f5f32afa3a1/common/wfp_firewall.cpp#L511-L556
[wfp-session]: https://github.com/AdguardTeam/NativeLibsCommon/blob/58cef252031e2cc1f540ecaec2952f5f32afa3a1/common/wfp_firewall.cpp#L51-L70
[wfp-destructor]: https://github.com/AdguardTeam/NativeLibsCommon/blob/58cef252031e2cc1f540ecaec2952f5f32afa3a1/common/wfp_firewall.cpp#L186-L190
[wfp-ports4]: https://github.com/AdguardTeam/NativeLibsCommon/blob/58cef252031e2cc1f540ecaec2952f5f32afa3a1/common/wfp_firewall.cpp#L480-L507
[wfp-ports6]: https://github.com/AdguardTeam/NativeLibsCommon/blob/58cef252031e2cc1f540ecaec2952f5f32afa3a1/common/wfp_firewall.cpp#L597-L625
[owner-lookup]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/trusttunnel/src/client.cpp#L63-L137
[pid-cache]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/trusttunnel/src/client.cpp#L30-L58
[process-decision]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/trusttunnel/src/client.cpp#L675-L729
[mode-selection]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/core/src/tunnel.cpp#L875-L930
[direct-transport]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/core/src/direct_upstream.cpp#L170-L186
[wfp-self]: https://github.com/AdguardTeam/NativeLibsCommon/blob/58cef252031e2cc1f540ecaec2952f5f32afa3a1/common/wfp_firewall.cpp#L103-L168
[client-runner]: https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/trusttunnel/src/client.cpp#L286-L297
[wfp-source]: https://github.com/AdguardTeam/NativeLibsCommon/blob/58cef252031e2cc1f540ecaec2952f5f32afa3a1/common/wfp_firewall.cpp#L441-L478
[ms-lifetime]: https://learn.microsoft.com/en-us/windows/win32/fwp/object-management
[ms-stronghost]: https://learn.microsoft.com/en-us/windows-hardware/drivers/network/mib-ipinterface-row

## Server authentication, routing policy, and local exposure

### Scope and evidence baseline

This section covers the Windows Pro GUI's routing-policy preparation, VPN endpoint trust establishment, and config storage. It is a static, read-only review, not an exhaustive audit of the repository. No exploit, tunnel, firewall, route, certificate-store change, or reproduction below was executed. Reproductions are proposals for an independent reviewer in a disposable checkout or isolated Windows VM with synthetic credentials and documentation/example addresses only.

Verified repository: `https://github.com/ialexbond/TrustTunnelClientForWindows`. GUI baselines: master `0843800b8940e7b2e337f21d2c60e067aa0a1be2` (M) and release 3.1 `19179709045dc2fa533eac388563fc3e830328ab` (R). Installed-version identification recorded in the audit inventory is Pro 3.1.0 with core 1.1.7. Core evidence below was read from R, which contains the core sources; most core sources are absent from M. Source agreement does not independently prove that a particular installed executable was built byte-for-byte from R. A master permalink may be unavailable remotely because M is a local commit; the exact fallback for every cited path is `git show 0843800b8940e7b2e337f21d2c60e067aa0a1be2:<repository-relative-path>` with the stated one-based line numbers.

All findings below remain in R. `server_config.rs`, `cert_probe.rs`, `commands/config.rs`, and `commands/deeplink.rs` are identical between M and R. Differences in `routing_rules.rs` are two documentation paths. Changes in `ssh/mod.rs` do not touch config generation or the data-root functions. The relevant certificate-policy code in `deploy.rs` is unchanged. Connect/respawn/tray line numbers differ; both sets are given below. This section does not assert that DHCP or IPv6 packet bypass has been dynamically demonstrated; those are covered separately by the network-core audit.

### TLS-01: Certificate-probe failure persists disabled VPN authentication

**Priority:** P1.

**Status:** STATIC-CONFIRMED.

**Classification:** High-impact authentication policy weakness; automatic compatibility fallback. Static path verified. Not an assertion that every generated config disables verification.

**Evidence:** [R server_config.rs L556-L588](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/ssh/server/server_config.rs#L556-L588), [M same lines](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/ssh/server/server_config.rs#L556-L588). Decision: same file L1301-L1311 and L1388-L1417. Install path: `ssh/deploy.rs` L1466-L1521, unchanged in both commits. Live transport: [R config.cpp L122-L127](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/trusttunnel/src/config.cpp#L122-L127), `client.cpp` L618-L638, `core/src/vpn_manager.cpp` L700-L734.

**Trace and prerequisites:** A normal server-config fetch calls `fetch_endpoint_cert`. A timeout, blocked connection, rejected input, handshake error, or unusable certificate produces `None`/an unproven pin. `apply_fetched_self_signed_policy` maps this to `pin_verifiable=false`; `install_cert_policy_for` sets `skip_verification=true`. The config is saved successfully at `server_config.rs` L622-L631. The install/export path has the equivalent fallback. Later core config parsing ignores an embedded certificate when skip is true. The live verification callback returns `VPN_SKIP_VERIFICATION_FLAG`; the core accepts it before hostname/IP checking. A network attacker needs interception/redirection of the subsequent endpoint connection and an endpoint capable of completing the necessary TrustTunnel exchange to turn absent authentication into useful interception. This is not merely an unchecked health probe.

**Current response:** A warning in the export/fetch log, followed by success and a usable persistent config. No strict-protection state requires authenticated transport. Existing legacy self-signed certificates can intentionally remain unverified.

**Safe reproduction:** In a disposable checkout, call the pure `apply_fetched_self_signed_policy` with a synthetic endpoint TOML and `None`, or inject a failing probe into a test-only fetch harness. Inspect output for `skip_verification=true` and missing certificate. An isolated TLS-callback fixture should then show that skip accepts a certificate whose SAN differs from the configured hostname; no adapter or route creation is needed. A VM end-to-end test requires a toy TrustTunnel endpoint with a deliberately mismatched cert.

**Confirmation/refutation:** Confirm the saved flag, the skip callback result, and absence of hostname verification. Refute by demonstrating that any probe error prevents saving/connecting, or that the actual shipped core still verifies the peer despite the flag. Counter-evidence: default `skip_verification` is false; proven fresh self-signed pins clear the flag, and normal CA/name mismatch is rejected.

**Desired policy and test gap:** Never convert inability to establish trust into trust. Keep the last authenticated config or refuse activation; obtain/reissue a verifiable cert via trusted administration. Existing tests `fetch_probe_failure_degrades_to_skip_verification_only` (L2409) and `an_unproven_endpoint_keeps_skipping_verification` (L1346) explicitly preserve the insecure compatibility policy. Strict-mode tests should reverse those outcomes while retaining the proven-pin success case.

### TLS-02: An unauthenticated fetched certificate becomes persistent VPN trust

**Priority:** P1.

**Status:** CONDITIONAL; trust-source gap is statically confirmed, attack outcome is not runtime-confirmed.

**Classification:** High-impact bootstrap/replacement trust weakness under an active path attacker. Static trust-source gap verified; successful credential theft or VPN traffic interception was not reproduced.

**Evidence:** [R cert_probe.rs L124-L151](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/ssh/server/cert_probe.rs#L124-L151), [M same lines](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/ssh/server/cert_probe.rs#L124-L151); connector L232-L264, certificate checks L303-L350. Policy persistence is `server_config.rs` L1304-L1311, L1400-L1406, L622-L623, identical in M/R; deploy also uses it at L1469-L1521.

**Trace and prerequisites:** `NoopVerifier` accepts arbitrary certificate/signature verification results during the initial network handshake. The fetched leaf is subsequently placed in an otherwise empty trust store and checked against itself, its intermediates, time, and SNI. That establishes whether the certificate can be used as a trust anchor, not that it belongs to the SSH-managed server. The code in L329-L350 performs a verifier call on certificate bytes; contrary to wording about proving a handshake, this is not a second authenticated network handshake. A later real VPN handshake proves possession of the adopted certificate's private key, but the attacker can own that key.

An attacker must intercept the actual dial address/port during fetch or re-export, supply a suitable self-signed SAN certificate and possess its private key, and remain on the subsequent VPN path or redirect it. Merely spoofing DNS is insufficient when the config uses a literal IP. Merely presenting a cert copied from a legitimate server without its private key will not defeat the later real handshake. A toy TLS listener proves certificate adoption, not a functioning rogue VPN: useful interception additionally requires implementing or relaying the TrustTunnel application protocol.

**Current response:** The self-signed certificate is automatically embedded and verification can be marked enabled. No comparison to a leaf retrieved through the authenticated SSH channel, previously accepted fingerprint, or independent trust source appears in this reviewed chain. Re-export can replace the config's trust material.

**Safe reproduction:** Use a local test TLS server with a fresh self-signed cert containing the toy expected SAN. Point only the certificate-probe harness at it. Verify `is_system_verifiable=false`, `pin_verifiable=true`, then apply the pure policy and compare the saved cert fingerprint to the toy server. To test replacement, begin with a synthetic config carrying cert A and have the probe return cert B. This requires no routing changes.

**Confirmation/refutation:** Confirm adoption of B without independent authentication or replacement approval. Refute if an additional production check binds the fetched bytes to the authenticated server/previous identity, or the installed path rejects replacement. Normal CA verification of an already configured endpoint is counter-evidence against claiming a universal MITM.

**Desired policy/tests:** Transfer the expected certificate through the already authenticated SSH session, use a separately authenticated fingerprint, and refuse unapproved identity replacement. Existing tests check PEM/SNI/policy shaping and verifiability; they do not establish trusted provenance or replacement resistance.

### TLS-03: Malformed custom PEM silently falls back to system trust

**Priority:** P2.

**Status:** CONDITIONAL.

**Classification:** Conditional weakening of a requested custom trust policy; medium/informational unless custom-only trust is a documented requirement. It does not disable all certificate checks.

**Evidence:** [R config.cpp L48-L82](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/trusttunnel/src/config.cpp#L48-L82), L122-L127; `client.cpp` L624-L634. M does not contain these core files, so this is a verified R core finding, not a master-core claim. The permissive GUI import boundary exists in both: [M deeplink.rs L174-L180](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/commands/deeplink.rs#L174-L180), [R counterpart](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/deeplink.rs#L174-L180).

**Trace/preconditions:** A syntactically valid imported TOML contains a nonempty but invalid `certificate` and verification is enabled. `load_certificate` returns null when no cert loads, but config parsing succeeds. The client sees no custom CA store and invokes platform verification. The documented field acts as a custom CA store, not an exact fingerprint pin; do not assume exact-pin semantics. A relevant bypass requires a peer certificate accepted by system roots and satisfying the normal name/IP check when a valid custom anchor would have excluded it.

**Response/reproduction:** A warning is logged; ordinary system trust is used. Offline parser tests can assert that malformed PEM yields a successfully parsed config with null custom store. In a disposable TLS-only VM fixture, install a synthetic test CA in that VM's trust store, use its valid named server cert, and compare malformed custom PEM against a different valid custom anchor. Never install a toy CA in the host machine.

**Confirmation/refutation:** Confirm acceptance only in the malformed/system-trust case. A self-signed untrusted peer should still fail; that falsifies any claim of universally disabled authentication. No dynamic result is claimed.

**Policy/tests:** Reject malformed explicitly supplied custom trust material rather than silently select a different trust policy. Parser tests need malformed PEM plus a CA-trusted substitute scenario. Keep separate from TLS-01.

### POL-01: Read errors turn an existing rules file into empty defaults

**Priority:** P1.

**Status:** STATIC-CONFIRMED.

**Classification:** High privacy impact in selective mode; verified fail-open policy load.

**Evidence:** [R routing_rules.rs L236-L251](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/routing_rules.rs#L236-L251), [M same lines](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/routing_rules.rs#L236-L251). M connect load L1871-L1882; R same flow precedes resolve L1954. Defaults L172-L179; selective exclusions L508-L515. [R core tunnel.cpp L875-L927](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/core/src/tunnel.cpp#L875-L927).

**Trace/preconditions:** `read_to_string` handles every error as absent and returns empty defaults. The higher-level refusal handles only returned errors, so access denied, sharing violation, or I/O failure does not reach it. Selective mode writes an empty protected-destination list. The core's selective default action is bypass. This applies to connect and other policy consumers; missing policy files also lose intended rules, but a genuinely fresh install has no previous policy to recover.

**Current response:** A console message claiming no rules file, followed by normal processing/connection. In general mode default tunnel routing usually remains protective, so read failure does not automatically imply an Internet IP leak there.

**Safe reproduction:** Copy the loader into an offline unit fixture or invoke it in a disposable checkout. On Windows hold a synthetic rules file with an exclusive/no-share handle, then load it. Compare existing-unreadable, absent, valid, and invalid-JSON cases. Assert returned defaults, then use the pure selective preparation/core decision logic to show bypass; no packet sending is necessary.

**Confirmation/refutation:** Existing unreadable file returning `Ok(default)` confirms the defect. Returning an error for sharing/access failures would refute it. Counter-evidence: malformed JSON does return an error and blocks connection.

**Policy/tests:** Only `ErrorKind::NotFound` for a genuinely new installation may select defaults; other failures must refuse activation and preserve protection. Existing `an_unreadable_rules_file_refuses_the_connect_and_a_healthy_one_does_not` tests bad JSON, healthy JSON, and absence, not actual read errors.

### POL-02: Preparation/write failures do not stop a spawn using stale or mixed rules

**Priority:** P1.

**Status:** STATIC-CONFIRMED; privacy consequence depends on policy and failure stage.

**Classification:** High conditional privacy impact; verified error-handling weakness.

**Evidence:** [M vpn.rs L1887-L1898](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/commands/vpn.rs#L1887-L1898), [R L1954-L1965](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/vpn.rs#L1954-L1965). Spawn M L2018/R L2087. Respawn M L2265-L2279/R L2341-L2355, spawn R L2415. Tray M L501-L508/R L567-L574, spawn M L567/R L646. Resolver, identical M/R: `routing_rules.rs` L770-L773, L535-L568, L905-L909.

**Trace/preconditions:** Newly saved rules differ from the last prepared generation. A corrupt group cache, failed read, or filesystem write error makes preparation fail. Every spawn door logs the error and continues. The core then reads the previous config/files or, if some writes completed, a mixture. In selective mode a newly protected destination/app absent from the previous generation can bypass. Impact depends on which write failed and which pointers already existed; not every write failure produces a leak.

**Current response:** Warning only; tray error is printed to stderr. Atomically writing each file prevents a truncated individual file but does not make the whole multi-file policy update transactional.

**Safe reproduction:** Use a disposable fixture directory with generation A, save generation B, then inject a read/write failure at each preparation stage. A test-only spawn stub should capture whether spawn would occur and which generation each opened file belongs to. Do not invoke the real sidecar or alter the live data directory.

**Confirmation/refutation:** Spawn after a failed required preparation, with protected B traffic missing, confirms. Refute by proving an authenticated last-good policy with equivalent protection is selected or spawn cannot proceed. Atomic single-file writer success alone is not a refutation.

**Policy/tests:** Treat policy preparation as a required precondition. Stage a complete generation, commit one generation pointer only after success, and retain blocking until a valid generation is active. Current source guards cover parse refusal and atomic writes, not injected failure across all preparation stages and all spawn doors.

### POL-03: Unresolved protected groups are discarded while preparation succeeds

**Priority:** P1.

**Status:** POLICY-LIMITATION; the successful skip path is statically confirmed.

**Classification:** Deliberate availability policy incompatible with no-leak selective protection.

**Evidence:** [R routing_rules.rs L730-L790](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/routing_rules.rs#L730-L790), [M same lines](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/routing_rules.rs#L730-L790); successful return L820, warning L479-L486, selective list L508-L515. Core default bypass is R `tunnel.cpp` L882-L883/L925-L927.

**Trace/preconditions:** A protected geoip/geosite group cannot resolve, or an iplist cache is absent. The resolver records an identifier but contributes zero destinations. Preparation succeeds and selective mode routes those unmatched destinations directly. This may occur after data loss/update or when an imported rule references unavailable data. Ordinary nonselective missing direct exclusions generally increase tunnel coverage instead; distinguish that case.

**Current response:** Connect can warn in its log and report success. Pure/GUI `resolve_and_apply_inner` paths have no app handle for the warning and still succeed.

**Safe reproduction:** Existing offline resolver test already supplies unloaded geodata/missing cache. Extend only a disposable checkout fixture with a selective policy protecting that group. Inspect the generated list and the pure default-action decision. Confirm that the rule remains in user-facing source data while it is absent from the applied set.

**Refutation/policy/tests:** Refute if unavailable protected rules select fail-closed behavior rather than bypass. A warning does not refute loss of protection. `an_entry_that_will_not_resolve_is_collected_instead_of_discarded` L1715-L1758 explicitly expects success. Strict policy should refuse or block affected traffic; tests must discriminate missing protected rules from missing direct exceptions.

### POL-04: Implicit LAN bypass and exact-string override violate strict coverage

**Priority:** P2.

**Status:** POLICY-LIMITATION.

**Classification:** Intentional policy exception, not by itself a generic public-IP vulnerability.

**Evidence:** [R routing_rules.rs L113-L165](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/routing_rules.rs#L113-L165), [M counterpart](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/routing_rules.rs#L113-L165); general preparation L500-L515. R core address matching/inversion: `tunnel.cpp` L1073-L1086, bypass selection L926-L927.

**Trace/preconditions:** General mode automatically bypasses RFC1918, loopback, IPv4 link-local, IPv6 ULA/link-local. Only a proxy entry exactly equal to each baseline CIDR suppresses it. A protected `192.168.1.0/24` does not suppress the automatic direct `192.168.0.0/16`; nor does `0.0.0.0/0`. This supports Docker/WSL/LAN intentionally. LAN peers can observe local addresses/activity. Public-IP disclosure additionally requires a local forwarding/proxy/application path to an external recipient; ordinary LAN access alone is not proof.

**Response/reproduction:** Implicit exceptions operate without per-connection strict-coverage refusal. Offline `build_general_exclusions` fixtures with no rules, a narrower CIDR, and the exact baseline CIDR demonstrate the outcome. A separate isolated VM can use a toy LAN proxy to establish any external-forwarding consequence.

**Confirmation/refutation:** Generated broad direct CIDR despite a narrower protected CIDR confirms policy precedence. Exact override is counter-evidence against claiming no override exists. Ordinary selective/direct rules are user-declared exceptions and should not be reported as accidental leaks.

**Policy/tests:** Strict mode should block nonessential local IP traffic or require explicit visible consent; necessary ARP/DHCP exchanges need narrow rules, not arbitrary application-data permission. Tests `general_mode_adds_default_private_exclusions` and `general_mode_override_is_exact_match_only` intentionally preserve this policy. A strict-mode test matrix must cover CIDR containment and precedence.

### POL-05: Unknown process mode is interpreted as direct exclusion

**Priority:** P3.

**Status:** STATIC-CONFIRMED.

**Classification:** Lower-priority input-validation gap, conditional on imported/edited invalid policy.

**Evidence:** [R routing_rules.rs L45-L57](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/routing_rules.rs#L45-L57), [M counterpart](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/routing_rules.rs#L45-L57); parser L332-L336, fallback L833-L844, process-file emission L548-L568/L883-L897.

**Trace/preconditions:** `process_mode` is an arbitrary string. Valid JSON with a typo/future value passes import, then the resolver places its nonempty process list in the direct file. In a context where these applications were intended to be protected, that creates explicit bypass instead of rejecting the undecidable policy. No remote exploit is established; the input must arrive by import, file editing, or another authorized policy producer.

**Current response/reproduction:** Console warning then successful application. An offline fixture with `process_mode="onyl"` and a synthetic executable name should deserialize and generate a nonempty direct list. Confirm payload-to-file classification; packet-level app ownership problems belong to the separate core audit.

**Refutation/policy/tests:** Normal UI offers only known modes, reducing reachability. Refute by a production boundary that rejects unknown strings before this resolver. Use a strict enum or explicit validation and reject unknown values; add import/resolve tests for invalid modes and retain both valid modes.

### LOC-01: Same-user plaintext config access reveals server address and credentials

**Priority:** P2.

**Status:** POLICY-LIMITATION; storage path/write behavior are statically confirmed, effective ACLs were not measured.

**Classification:** Local trust-boundary limitation and credential-at-rest risk; not a remote website IP leak or proof that other Windows accounts can read the files.

**Evidence:** [R manifest.rs L341-L363](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/manifest.rs#L341-L363), [M same writer](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/0843800b8940e7b2e337f21d2c60e067aa0a1be2/gui-pro/src-tauri/src/commands/manifest.rs#L341-L363). `ssh/mod.rs` data-root/ensure-dir L487-L565 is relevant and unchanged; `server_config.rs` L594-L623 explicitly writes the password-bearing config. Import writes: M `manifest.rs` L2128/L2137; R L2158/L2167.

**Trace/preconditions:** Complete endpoint TOML, including address and password, is written with ordinary `File::create`; no app-specific ACL/encryption appears in this writer. The per-user `%LOCALAPPDATA%\TrustTunnel Client Pro` location inherits Windows folder permissions. Another process acting as the same Windows user can normally inspect these files. A compromised same-user process often already has broader power, so this does not create a guarantee against hostile code executing inside that identity. Cross-user read permissions were not measured. Exported config sharing, readable backups, and disk compromise are additional conditional exposures.

**Response/reproduction:** Storage succeeds without a local-confidentiality warning. In a disposable VM with a synthetic config, read it from a separate unelevated process under the same user; inspect ACLs and separately test a second account. Report contents only as toy-field presence, never real values. Also inspect temp/backup lifetime without using live credentials.

**Confirmation/refutation:** Same-user readability confirms this narrow boundary; a demonstrated access-denial/encrypted-storage scheme would refute it. Per-user storage refutes an assumption of automatic world-readability. Public VPN exit IP is supposed to be visible to visited sites; physical endpoint/dial IP and original subscriber IP are different concepts and can differ.

**Policy/tests:** Define the local attacker model honestly. Restrict files to the intended user/system identities, minimize plaintext lifetime/exports, and consider OS-protected credential storage for at-rest threats. Encryption tied to the same user does not promise secrecy from arbitrary code under that user. Existing writer tests establish atomicity and credential preservation, not ACL, backup, or local-confidentiality guarantees.

## Startup privacy and status correctness

### PRI-01: Application-originated third-party requests are not gated on protected connectivity

**Priority/status:** P2 / POLICY-LIMITATION, with STATIC-CONFIRMED request paths. This is an exposure before or outside protected connectivity, not evidence that an established full tunnel is automatically bypassed.

**Scope and evidence:** Present in both the working checkout and release 3.1.0. `gui-pro/src/App.tsx:243` mounts `useUpdateChecker`; `gui-pro/src/shared/hooks/useUpdateChecker.ts:367-370` checks on startup and then every 24 hours; `:173` calls `check_app_update_info`. In release `gui-pro/src-tauri/src/commands/updater.rs:1146-1166`, the command makes a normal HTTPS request to the application's GitHub release API, without waiting for a protected VPN state. `gui-pro/src/components/server/useServerGeoIp.ts:167` invokes GeoIP automatically on a cache miss; `gui-pro/src-tauri/src/commands/geoip.rs:40-48` requests `https://ipwho.is/{host}`. Release `gui-pro/src-tauri/src/connectivity.rs:2985` has a fallback HTTP request to Google's connectivity-check service before the tunnel is established.

Release references: [startup update hook](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src/shared/hooks/useUpdateChecker.ts#L367), [update request](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/updater.rs#L1146), [GeoIP request](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/geoip.rs#L40), [connectivity fallback](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/connectivity.rs#L2985).

**Trigger and consequence:** Launching the application without an independent permanent block may disclose the physical source IP to a contacted service before VPN protection exists. A GeoIP cache miss additionally submits the selected server/SSH host as the lookup target; merely routing that lookup through the VPN does not hide that submitted host from the GeoIP provider. A configured OS proxy may change who sees the source address, so the direct-IP result depends on the effective environment.

**Current response:** Requests are ordinary startup/background/overview features. Error handling manages availability; it does not assert a strict privacy gate. The initial Google request is a fallback and will not necessarily fire on every launch.

**Proposed isolated reproduction:** Start from a clean test-profile cache with auto-connect delayed and the VPN endpoint temporarily unreachable. Capture physical egress from application launch through connection failure. Identify the update API requests and, when the server overview is shown, a GeoIP request for a synthetic lab host. To test the Google fallback, arrange for the earlier local/gateway readiness probe to fail in the VM while the controlled path to that service can still be observed. Do not infer that a request occurred solely from its source code being present. Verify the target host submitted to GeoIP in a controlled replacement endpoint or an instrumented lab build; encrypted packet capture alone cannot reveal the HTTPS URL path.

**Confirmation/refutation:** Confirm only the actually observed service requests and their timing relative to active protection. If all requests wait until the tunnel is active or an independent block prevents physical egress, the physical-IP reproduction is refuted for that configuration. That does not refute submission of the server host to the GeoIP provider when the feature runs.

**Desired behavior:** A strict mode defers nonessential external requests until protected connectivity is proven, removes unnecessary third-party disclosure of server addresses, and exposes any deliberate direct startup request as an explicit exception. Offline GeoIP data or user-initiated lookup are possible alternatives.

**Existing checks/gap:** Unit tests mock the IPC/network result and update UI behavior. No verified packet test in this audit establishes startup request confinement. HTTPS authentication and update digest verification address different properties from source-IP privacy.

### PRI-02: The local working tree reintroduces an external font request fixed in release 3.1.0

**Priority/status:** P3 / STATIC-CONFIRMED working-tree privacy regression; CLEARED for the installed release.

**Evidence:** Working `0843800b8` imports Google Fonts in `gui-pro/src/shared/styles/tokens.css:12`; `gui-pro/src/main.tsx:8` imports that stylesheet. The production frontend build performed in the first audit retained this external import. `git diff 0843800b8 191797090 -- gui-pro/src/shared/styles/tokens.css` shows that release 3.1.0 removed the import and uses a bundled `Outfit-Variable.woff2`. The Tauri content policy permits the font hosts in the old source configuration.

**Trigger/current response:** A build from the local old stylesheet can contact the font service while the application UI loads, subject to caching, browser behavior, and available connectivity. No protection state is checked by CSS. The installed release's bundled font does not have this particular request.

**Proposed reproduction:** Build the working-tree UI in an isolated environment, clear only the VM's font/browser cache, capture application-load requests, and compare with a build from `191797090`. Inspect the emitted CSS for the import as a source/build check, but use actual network evidence to establish runtime egress. A cached font is not a refutation of the reachable request path.

**Falsification/desired behavior:** If the exact release artifact has no external font reference, clear this finding for that artifact, as done here. Retain the bundled font when reconciling branches. Do not present this old-tree regression as an installed Pro 3.1.0 leak.

### UX-01: Connected status is emitted after failed traffic-readiness probes

**Priority/status:** P2 / STATIC-CONFIRMED misleading protection indicator. This is not independently a packet-leak vulnerability.

**Release evidence:** `gui-pro/src-tauri/src/sidecar.rs:1700-1705` receives the unsuccessful readiness result and logs that Connected will still be emitted; `:1737` emits it if the session is current. [Release call path](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/sidecar.rs#L1700). `connectivity.rs:2847` checks general HTTPS reachability. The source uses ordinary OS-selected routes rather than proving the reported external source address or the physical-interface confinement of every flow.

**Counter-evidence:** Pro 3.1.0 now requires both the core endpoint-connection marker and the TUN-listener readiness marker before the probe phase (`sidecar.rs:1574-1596`, `:1642`, `:1664`). Stale/cancelled sessions are suppressed. Do not revive the fixed claim that any ordinary request can turn an uninitialized TUN green.

**Trigger/current response:** The core reports endpoint/TUN readiness but all permitted readiness probes fail until their budget expires. The live session can still become green. Alternatively, where another finding supplies a direct route, an ordinary successful probe does not prove that the probe used the VPN. A blocked probe and a bypassed probe are different tests.

**Proposed isolated reproduction:** In a lab, allow the core's authenticated control connection and TUN startup while preventing the configured probe endpoints from completing. Record the core markers, repeated probe failures, elapsed budget, and UI event. Separately test one known bypass case with a receiver that records the source address; determine whether a direct result satisfies the readiness check. Do not call a probe timeout an IP leak unless packet evidence also demonstrates leakage.

**Confirmation/refutation:** A Connected event following all failed probes confirms the status finding. If a release suppresses Connected until a successful tunnel-bound check, refute it for that release. A healthy successful connection does not test this fault path.

**Desired behavior:** Describe endpoint/TUN initialization separately from traffic readiness and verified protection. Preserve the block on uncertainty, show a bounded explanatory failure/degraded state, and validate actual tunnel egress for the probe. No connectivity probe can independently prove the absence of every leak; it should supplement enforcement verification.

**Existing checks/gap:** The code has time-budget and stale-session guards; they validate lifecycle timing and event freshness. The unsafe fallback is intentional behavior and needs a changed product contract, not a test that merely repeats the implementation.

## Elevated application, update, and SSH boundaries

This section covers the active Windows Pro application, not the legacy GUI or mobile adapters. The installed baseline is Pro 3.1.0 with core 1.1.7, represented by release commit `19179709045dc2fa533eac388563fc3e830328ab` (R). Local master is `0843800b8940e7b2e337f21d2c60e067aa0a1be2` (M). Release permalinks below refer to R. M was inspected with `git show` and local files; its availability on public GitHub was not assumed.

Only source review, revision comparisons, public official documentation, and a read-only check of the current temporary directory's access rules were performed. No exploit, SSH connection, installer, elevated test, firewall change, project edit, or real credential inspection was performed. The reproduction procedures below are plans for an isolated disposable Windows VM using dummy credentials and inert marker files. They are not completed test results.

The application embeds `requireAdministrator` in [its manifest](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/trusttunnel.exe.manifest#L18), through `build.rs:7-12`. Consequently, errors in file export, update launch, and IPC handling can have administrator-level consequences. This does not establish an exploit by itself. In particular, a hypothetical attacker already running as administrator is not a meaningful privilege-escalation finding.

| ID | Release finding | Status | Impact if prerequisites hold |
| --- | --- | --- | --- |
| APP-01 | Installer publisher authenticity is not checked | Static-confirmed trust gap; conditional exploitation | High: elevated execution of an attacker-controlled update |
| APP-02 | Verified installer and launch scripts are later reopened by pathname in TEMP | Conditional; OS access and race not tested | High: local privilege escalation |
| APP-03 | Export write checks the parent but misses an existing linked leaf | Static-confirmed validation defect; conditional exploitation | High: elevated overwrite outside the allowed roots |
| APP-04 | SSH deeplink export also sends the credential-bearing link to diagnostics | Static-confirmed data flow | Medium: accidental credential disclosure when sharing diagnostics |
| APP-05 | SSH host approval lacks request identity; exported port lacks validation | Unverified attack candidates; strong protection also present | Potentially high only if additional prerequisites are demonstrated |

### APP-01: A matching checksum is accepted without an independent publisher check

**Priority:** P2.

**Trace.** The update UI passes `downloadUrl` and `expectedSha256` to `self_update` in [UpdateCard.tsx:447-452](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src/components/about/UpdateCard.tsx#L447). The backend checks HTTPS and GitHub-related hostnames (`updater.rs:29-42`), rejects missing hashes (`:1459`), downloads the installer, and verifies SHA-256 (`:1555`). It then constructs an installer launch, starts the wrapper (`:1629`), and exits. The batch executes the downloaded executable with `/S` (`:202`). The same release's [comment at :1623-1628](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/updater.rs#L1623) explicitly records that `WinVerifyTrust` is not implemented.

The hash comes from the same release channel as the executable, via `check_app_update_info` and `resolve_release_sha256`; it is not signed metadata validated with an independently pinned key. The downloader's host allow-list does not restrict a direct IPC argument to the application's repository. An attacker controlling both the approved release content and its hash can satisfy the integrity gate. A matching hash confirms correspondence to the expected digest delivered through the authenticated release channel; it does not add an independent publisher authentication check.

**Preconditions and counter-evidence.** Exploitation requires release-account/infrastructure compromise, or execution of attacker-controlled JavaScript in the trusted app webview. Neither was demonstrated. A normal network attacker cannot simply change the hash through the existing HTTPS channel. Empty, malformed, and mismatching hashes are rejected. URL user-info tricks such as a trusted hostname before `@` are correctly rejected by structured URL parsing. R also protects launcher paths and command-processor AutoRun as described below.

Signing is optional at build time: [sign-windows-artifact.cjs:175-182](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/scripts/sign-windows-artifact.cjs#L175) returns success while explicitly reporting unsigned artifacts when no certificate is configured. Its PE detector checks signature presence, not certificate trust. This review does not claim the installed executable is unsigned; the installed signature was not measured in this sub-audit.

**Safe verification plan.** In a VM-only updater harness, substitute an inert fixture installer that writes one marker in the VM audit directory, and pair it with its correct hash. Intercept launch before installing or exiting. An unsigned fixture reaching the launch decision confirms the missing authenticity gate; a pinned publisher or signed-metadata rejection falsifies that path. Repeat with an incorrect, empty, and malformed hash: all must stop before launch. Do not publish a test release or substitute assets in the user's repository.

**Desired response and tests.** Refuse unknown publishers or invalid signed update metadata before stopping the VPN. Bind artifact identity, version, URL and digest to the authenticated update decision. Test an unsigned matching-hash payload, a wrong publisher, tampered signed metadata, and rollback policy separately from checksum correctness. Existing checksum tests address integrity, not this authority boundary.

### APP-02: A random TEMP name does not establish protection against replacement after verification

**Priority:** P2 candidate.

**Trace.** [updater.rs:1483-1486](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/updater.rs#L1483) creates `tt_update_<uuid>` under `std::env::temp_dir()`. The code downloads to a named file, closes it, reads it for checksum verification (`:1553-1555`), and later creates separate BAT/VBS/PowerShell files there (`:1573-1621`). The launcher subsequently opens those paths; the batch waits for the application to exit before opening the installer. There is no held executable handle, explicit directory security descriptor, or launch-time revalidation in this path.

The UUID defeats advance guessing of a particular filename. It does not stop a process that can enumerate TEMP and observe the directory appearing from trying to replace its contents after the hash check. The same issue applies to replacing a launch script rather than the installer.

**Status and prerequisites.** This is a conditional candidate, not a proven local privilege escalation. The attacker must have less privilege than the VPN app and actual write/delete/rename access to a run artifact or a containing directory, then win the relevant timing window. A read-only check found an inheritable Everyone FullControl entry on this machine's current TEMP directory. No personal identifiers or raw security descriptor are retained in this report. That observation alone is insufficient: newly created objects may carry integrity labels that restrict lower-integrity writes. [Microsoft's mandatory integrity documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control) distinguishes discretionary permissions from the object's integrity level. The run directory and artifacts created by the actual elevated updater were not tested.

**Safe verification plan.** In a disposable VM, run a dummy updater harness with the same creation and launch sequence. Record the run directory's owner, ACL and integrity label. From a separate medium-integrity process, attempt an inert replacement only within the VM audit directory after a test barrier following checksum verification. Capture both the verified file's digest and the launched marker identity. A different fixture being launched under the elevated token confirms exploitation. Access denied to all replacement operations, or an immutable handle-bound launch, falsifies this reproduction. Repeat with scripts and directory rename, not only the EXE, while using no real installer.

**Desired response and tests.** Create staging under a protected directory with explicit ownership, access rules and integrity requirements; refuse existing/reparse-point staging objects; avoid interpreting user-controlled files after verification. Add Windows integration tests crossing high/medium integrity levels. Existing UUID uniqueness tests and checksum tests do not exercise the operating-system boundary.

### APP-03: An existing destination symlink bypasses the export write's root check

**Priority:** P2.

**Trace.** `write_string_to_path` is a registered IPC command (`lib.rs:970`). Its [validator](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/config.rs#L88) canonicalizes only the destination's parent (`:99`), appends the unexamined filename (`:104`), and checks the parent's symlink metadata (`:116`). It compares that constructed path with the application data root, user profile, and TEMP roots. Then [the actual write](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/config.rs#L158) uses the original destination string (`:163-165`). An existing linked file in an ordinary allowed directory is not rejected or resolved for the confinement decision. Writing through it can target a different location with the application's elevated authority. This case needs no check/use race.

`copy_file` has a separate larger residual: it validates its source, but [copies to the caller's destination directly](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/commands/config.rs#L205). The source file explicitly acknowledges and accepts arbitrary copy destinations. Treating an OS Save As dialog as consent is a frontend convention; the command does not attest that selection. According to [Tauri's capability documentation](https://v2.tauri.app/security/capabilities/), app commands registered with `invoke_handler` are callable by the app's windows by default unless enrolled in a narrower command ACL.

**Attack boundary and limits.** A less privileged local actor must be able to plant an allowed-directory leaf link and induce the user to select it for export, or obtain script execution in the trusted webview. Windows symlink-creation policy and Developer Mode affect feasibility. No remote-to-JavaScript injection was found: R has `script-src 'self'`, no remote capability in the inspected default capability, and reviewed untrusted output is rendered as React text. This is therefore a confirmed validation defect with conditional exploitation, not a demonstrated one-click remote compromise.

**Safe verification plan.** Create a VM audit target outside allowed roots, protected against medium-integrity writes, containing a harmless marker. Create a file symlink inside the VM user's allowed export folder pointing to that target, using only permissions a proposed attacker really has. Save dummy logs through the actual command. A changed protected target confirms the boundary failure; rejection of the linked leaf or denied opening falsifies it. Run direct-outside, linked-parent, ordinary-file and new-file controls. Test `copy_file` separately with inert source bytes and the protected audit target. Never use startup folders, system executables, or real files.

**Desired response and tests.** Enforce the actual final object's location and link policy at opening, with handle-based identity checks and safe replacement semantics. A returned canonical string still is not a held file object and does not itself prevent later filesystem changes. Tests should include an existing linked leaf, intermediate junctions, alternate path forms, and cross-integrity callers. Current parent/root checks provide useful protection but do not cover the demonstrated leaf omission.

### APP-04: Copying a VPN link also copies its credential into diagnostic history

**Priority:** P2.

**Trace.** The wizard's existing-server screen [calls `server_export_config_deeplink`](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src/components/wizard/FoundStep.tsx#L77) for QR or Copy Link. The registered SSH wrapper (`ssh_commands.rs:212`) calls `server_config.rs:658-719`. It runs the endpoint's `--format deeplink` command through [the ordinary logging executor at :705](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/ssh/server/server_config.rs#L705), before extracting and returning the link. The advanced export also uses that executor (`:918`).

`ssh/mod.rs:1243-1247` echoes each stdout line to `emit_log`; `:930-949` sanitizes it and forwards it to stderr and the `deploy-log` event. [logging.rs:46-104](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/logging.rs#L46) redacts certain assignment keys, private-key blocks and bare IPv4 addresses, but not a base64-encoded `tt://` or `trusttunnel://` credential. Encoding is not encryption: the link contains the endpoint password, as the local forward mapping also explicitly shows (`deeplink_local.rs:111`).

The mounted wizard [collects these events](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src/components/wizard/useWizardState.ts#L770), saves the last 200 entries in localStorage (`:605`, using `saveField` at `:247-252`), and [copies the diagnostic text](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src/components/wizard/useWizardState.ts#L610) on the logs action. Operation-generation gates reject stale operations, but accepted events still take this path. The risk is unintentionally giving support or a third party a usable VPN credential when sharing logs. This review does not assume stderr or `deploy-log` is always persisted in `app.log`; the reachable persistent sink is wizard localStorage when the mounted listener accepts the event. This is source evidence, not an observed credential leak from a running application.

**Safe verification plan.** With a disposable endpoint and recognizable dummy password, use the existing-server wizard's QR/Copy Link action, then inspect only the test profile's diagnostic history and copied logs. Decode any captured link locally and compare with the dummy password. A surviving valid credential confirms the finding; absence from both events and stored/copied history falsifies it. Also test with no wizard mounted to distinguish conditional collection from backend emission. Do not copy or decode real user links.

**Current/desired response and tests.** Successful export should return the link solely to its intended QR/clipboard consumer and keep it out of diagnostics. A quiet SSH executor already exists (`ssh/mod.rs:1280`), showing a suitable established pattern. Add an end-to-end dummy-secret test for the export-to-diagnostics path. Assignment-redaction tests do not cover credential-bearing URLs. Also test SSH packet splits inside password lines: the current executor splits each received packet into lines independently, so a continuation fragment can reach the sanitizer without its sensitive key. This second exposure is a test gap, not an observed production leak.

### APP-05: SSH protection is substantial; two additional boundaries need controlled tests

**Priority:** Unassigned.

**Confirmed protections.** `ssh_connect` validates hostname, username and auth-method before connecting (`ssh/mod.rs:985-987`). Production direct and pooled callers pass an application handle, so an unknown host requests explicit first-use approval. Timeout/channel failure rejects approval (`:796-807`); a changed stored fingerprint is rejected (`:824-849`) before authentication. The no-UI auto-accept branch exists, but no production caller of `SshParams::connect()` was found; it must not be presented as an installed-client bypass. Explicit key-only authentication does not fall back to passwords. Credentials are saved in the OS keyring while `ssh_credentials.json` records metadata (`ssh_commands.rs:933-956`), despite older comments claiming plaintext password storage. Remote raw-TOML writes use a quoted UUID-randomized heredoc delimiter (`server_config.rs:1507`, `:1628`), which defeats the ordinary fixed-EOF injection attempt. These are passes, not findings.

**Unverified approval correlation candidate.** [A single global pending sender](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src-tauri/src/ssh/mod.rs#L569) is replaced for each unknown host (`:785-786`). `confirm_host_key` accepts only a boolean (`:731-739`), and the frontend [sends no host, fingerprint or request ID](https://github.com/ialexbond/TrustTunnelClientForWindows/blob/19179709045dc2fa533eac388563fc3e830328ab/gui-pro/src/shared/hooks/useHostKeyVerification.ts#L21). Two overlapping unknown-host checks could associate a click from the older dialog with the newer connection. However, the pooled path serializes connection creation, normal UI flows limit overlap, and the frontend replaces the displayed prompt when the new event arrives. No complete ordinary-user interleaving was established, so severity remains unassigned pending reproduction. Test two independent dummy SSH connections with deterministic event barriers. Log only request identity and acceptance, never passwords. Confirm whether approval of A can authenticate B before B's fingerprint is displayed; inability to create that interleaving falsifies this candidate. Desired behavior is request-bound approval and a queue or explicit rejection of overlapping verification requests.

**Unverified data-to-shell candidate.** Three export paths extract a port from server-returned `listen_address` with string splitting (`server_config.rs:361`, `:673`, `:817`), then interpolate it into an unquoted shell address argument (`:703`, `:915`). The hostname and stored anti-DPI prefix are validated, but that port is not parsed as `u16`. The raw VPN-TOML validator validates syntax and size only (`sanitize.rs:614-624`). A VM test should first capture the exact generated command for a synthetic invalid port containing shell syntax, without executing it. The dangerous text must remain data or be rejected. Only after identifying an attacker-controlled, lower-privilege producer of that value should a shell test with an inert marker be considered. Control of an already root-owned server config by an attacker who already has root is not a new root-compromise finding. No such independent producer was established here, so this is explicitly an unverified candidate, not a confirmed critical vulnerability.

### Revision separation and remaining gaps

R improves updater safety relative to M: R uses absolute System32 launcher paths (`updater.rs:371`, `:383`, `:1629`, `:1695`), an explicit `cmd.exe /d /c` VBS launcher (`:415-420`), and validates a registry-selected restart directory against the Program Files root (`:300-325`). M still uses bare `wscript.exe`/`powershell` (`:1381`, `:1447`) and a bare BAT association (`:1365-1373`), and lacks that restart-root narrowing. Those are master-only regression risks and must not be reported as installed Pro 3.1 defects. Their exploitability still requires lower-privilege control of the applicable lookup/registry input and a triggering update; no live test was run.

General path confinement rejects non-absolute allowed roots and resolves existing paths (`paths.rs:72-106`). Import filenames derived from config labels are slugified; country prefixes accept only two ASCII letters (`manifest.rs:1959`). Deep links do not auto-connect and undergo structured decoding/config-shape checks. The reviewed CSP, escaping and capability configuration provide counter-evidence against an automatic deeplink-to-script-execution claim. Comprehensive WebView2 profile tampering, every SSH command builder, installed signature/ACL measurements, and every race interleaving remain outside completed verification.

This sub-audit inspected relevant test coverage. The overall audit's executed checks are recorded in the final verification section; none establishes runtime exploitation of these cases. The highest-value additional tests are the high/medium-integrity update and export checks, credential-bearing deeplink diagnostic checks, and request-bound SSH host approval checks. Findings above distinguish confirmed source behavior from conditional exploit feasibility and from missing evidence.

## Comparable public cases and their limits

These cases motivate targeted tests. They do not prove that this client has the same vulnerability, and their CVEs must not be assigned to this repository by analogy.

| Public case | Established mechanism | Relevant review here | Necessary qualification |
| --- | --- | --- | --- |
| [ExpressVPN Windows TCP 3389 exception, disclosed July 2025](https://www.expressvpn.com/blog/expressvpn-rdp-leak-fixed/) | A production port exception let unrelated traffic bypass the tunnel. | NET-03: test application traffic using permitted DHCP local ports. | Different ports and different filter conditions; port availability and actual egress must be measured here. |
| [ExpressVPN selective-mode DNS issue, February 2024; remediation update April 2024](https://www.expressvpn.com/blog/windows-app-dns-requests/) | A selected-app mode could send DNS to an unintended third-party resolver. | Test DNS separately from ordinary selected-app data and attribution. | This client's DNS failure path has protective counter-evidence below; the other product's bug is not evidence of ours. |
| [TunnelVision / CVE-2024-3661 research](https://github.com/leviathansecurity/TunnelVision) | DHCP-provided more-specific routes can divert traffic while the tunnel stays connected. | VM route-injection tests for both families, plus exceptions and lifetime. | An effective independent filter may block diverted packets. A hostile route alone does not prove this client's leak. |
| [TunnelCrack / LocalNet and ServerIP research, August 2023](https://tunnelcrack.mathyvanhoef.com/) | Local-network and endpoint-IP exemptions can be broader than intended transport. | POL-04 and NET-04; keep authentication and address mapping separate. | This client's listed private ranges are not a demonstrated automatic exemption of any public DHCP subnet. ServerIP requires a workable redirection path. |

[Mullvad's Windows TunnelVision analysis](https://mullvad.net/en/blog/evaluating-the-impact-of-tunnelvision) provides useful counter-evidence to the claim that every route-based VPN must leak: operating-system filtering can stop traffic diverted by hostile routes. The conclusion for this client depends on its effective filters, their exceptions and their lifetime. Blocking and resulting loss of connectivity must be recorded separately from traffic disclosure.

## Cleared suspicions and protections that must survive review

An independent reviewer should try to invalidate findings and preserve these established protections rather than assume every suspicious code pattern is exploitable.

- **No generic DNS proxy-to-direct fallback established.** Release `core/src/dns_proxy_accessor.cpp:72-83` configures SOCKS-mediated resolution when the tunnel provides its SOCKS listener; `core/src/tunnel.cpp:894-918` handles DNS specially and drops it when Kill Switch policy requires that. The inspected DnsLibs 2.10.2 socket-factory/proxied-socket failure path closes failed proxied connections rather than retrying them directly. Explicitly excluded domains remain a policy exception. A system-wide DNS leak still needs captured requests and a complete route/filter trace; do not infer it merely because a third-party resolver is configured. See the official v2.10.2 commit's [socket factory](https://github.com/AdguardTeam/DnsLibs/blob/0c6e855b12eee2f696e7cc30719532fda4fdd512/net/socket_factory.cpp#L44-L45) and [proxied socket](https://github.com/AdguardTeam/DnsLibs/blob/0c6e855b12eee2f696e7cc30719532fda4fdd512/net/proxied_socket.cpp#L143-L150).
- **Unsupported captured IPv6 can fail safely.** Release `core/src/tunnel.cpp:1265` and `:1306` reject captured IPv6 when the endpoint lacks support. This does not cover IPv6 that never enters TUN, which is NET-01.
- **Normal certificate verification exists.** The default skip flag is false, and ordinary trusted-certificate/name verification rejects mismatches when enabled. TLS-01 and TLS-02 concern specific trust-establishment decisions; they are not claims that every connection is unauthenticated.
- **Release readiness is stricter than old code.** Endpoint and TUN markers are both required, stale sessions are suppressed, and teardown is awaited. UX-01 concerns the failed-probe fallback after those markers, not the previously fixed early-ready bug.
- **The installed release bundles its font.** PRI-02 remains a working-tree regression, not an installed Pro 3.1.0 request.
- **Release update launch is hardened.** Absolute System32 paths, `cmd.exe /d`, and a constrained restart directory address older launcher weaknesses. Do not count those fixed paths as installed-release exploits. Check branch reconciliation for their reintroduction.
- **SSH identity and secret handling have real safeguards.** Changed known host keys are rejected; first-use UI approval can time out safely; credentials use the OS keyring; ordinary command fields are validated. APP-05 does not establish a no-UI production bypass or a new root-compromise path.
- **Frontend trust boundaries were not shown to be broken.** Reviewed output uses React text rendering, the script policy is restrictive, and remote capabilities were not found in the inspected default configuration. APP-01/03 cannot silently assume remote JavaScript execution in the privileged webview.
- **Per-user config is not automatically world-readable.** LOC-01 concerns normally available same-user access and conditional backup/disk disclosure. Effective cross-user permissions and a hostile local-administrator guarantee were not established.
- **Encrypted outer transport is expected.** Packets from the core to its authenticated VPN endpoint, DNS resolver identity without a path measurement, private LAN addresses, and a normal visible VPN exit address are not interchangeable with disclosure of the user's physical public address to a website.

## Windows acceptance matrix still requiring runtime evidence

Run the common laboratory protocol for the rows relevant to each finding. Tests are proposed; this audit did not run them. Passing a public "IP leak test" website during one steady connection does not satisfy this matrix.

| Dimension | Required cases | Pass condition under strict protection |
| --- | --- | --- |
| Address family | IPv4-only, IPv6-only, dual stack; endpoint with and without IPv6 support | Every family is tunneled or blocked explicitly. |
| Application transport | New and existing TCP, UDP including QUIC, ICMP; browser STUN/WebRTC and secure DNS | Receiver sees VPN egress or nothing; application encryption does not count as IP concealment. |
| DNS and discovery | Fresh names, UDP/TCP DNS, encrypted DNS, DNS cache expiry, OS multihomed resolution; LLMNR/mDNS/NetBIOS if allowed | Protected DNS stays protected; local discovery is blocked or an explicit local exception with separately stated scope. |
| Lifecycle | Launch/auto-connect, connecting, switching, reconnecting, failed start, recovery exhaustion, core/GUI crash, exit, update handoff | Blocking persists across protected transitions until explicit release; expected transport bootstrap remains possible. |
| Network changes | Wi-Fi to Ethernet, both adapters active, USB/hotspot, DHCP renewal/hostile routes, sleep/resume, route metric changes, captive portal | A new path cannot silently bypass enforcement; portal access has a deliberate limited policy. |
| Process routing | General/selective/direct modes; protected process, helper, unknown owner, IPv6 owner, reused PID, shared port | No silent direct fallback for traffic promised protected; deliberate exclusions are visible policy limitations. |
| Existing traffic | Sockets established before connection, long-lived TCP, UDP without connect, traffic continuing through switch | Enforcement covers existing and newly created flows, not only fresh sockets. |
| Windows environment | Supported Windows versions; clean installation and other security/VPN filters; WSL/Docker/Hyper-V as supported | Claimed coverage names actual supported origins; virtual/forwarded traffic cannot be assumed equivalent to local app sockets. |
| Elevated local boundaries | Medium/high integrity, real ACLs, export links, update staging replacement | Lower-privilege input cannot control an elevated file target or executed payload. |
| Data exposure | Dummy credentials in diagnostic copy, local storage, backups and exports | Secrets remain confined to their intended consumer; exported diagnostics do not contain usable credentials. |

This list intentionally marks unfinished coverage instead of inventing a confirmed WebRTC, raw-packet, WSL or DHCP-121 exploit. L2 delivery metadata and the VPN provider's own knowledge cannot be made invisible by a host VPN; the product must state the precise audience and protection interval of its anonymity claim.

## Independent review instructions

Give the next reviewer this report and the repository's Git objects. Ask for a skeptical re-analysis, not implementation. The release and working-tree baselines must be checked separately.

```text
Review WINDOWS_VPN_SECURITY_AUDIT.md critically against the exact source revisions
listed in its baseline table. Do not change application code or the host VPN,
routes, firewall, certificate store, updater, or credentials. For each finding:
1. Trace the reachable caller, unsafe decision, and relevant sink.
2. Identify real attacker control and the privileges/network prerequisites.
3. Search for an omitted guard, alternative safe branch, or release-only fix.
4. Decide whether the source claim stands independently of packet exploitation.
5. Evaluate whether the proposed experiment could confirm and refute the claim.
6. Return AGREE, NARROW, REFUTE, or INCONCLUSIVE with exact revision/path/lines.
   A passing UI/unit test or an unexecuted attack is not packet-level proof.
Only perform runtime reproduction in a separately authorized disposable lab.
Use dummy secrets and inert receivers/files. Keep local egress, remote public-IP
disclosure, deliberate direct routing, authentication loss, credential disclosure,
and privilege escalation as distinct outcomes.
```

Use one result row per ID, with an additional subcase row where needed:

| Finding/subcase | Verdict | Exact revision and evidence | Preconditions actually verified | Observation and negative control | Counter-evidence / missing evidence |
| --- | --- | --- | --- | --- | --- |
| Example: NET-01 / normal IPv6 socket | AGREE, NARROW, REFUTE or INCONCLUSIVE | Commit, path, source lines; artifact hash if tested | Address family, effective config, filters, receiver identity | Marker and source, physical/TUN path; protected control | Explain why the conclusion follows or fails |

Rules for disagreement:

- Refuting an installed reproduction does not necessarily refute a confirmed source defect; establish whether artifact behavior, configuration, platform policy or the source-to-binary assumption differs.
- A failed bind, cached request, missing IPv6 uplink, indistinguishable VPN/direct source, or unreachable sink makes that trial inconclusive unless it specifically tests a stated blocking property.
- Finding another reachable production guard can refute a claimed call path. Name the guard and show it applies to this exact revision and trigger.
- A warning or UI error does not prove containment. A visible Connected status does not prove authentication, correct routes, or absence of direct packets.
- Keep policy choices separate from bugs. General-mode whole-host guarantees and selective-mode selected-application guarantees are different contracts.
- Do not combine a collection of hypotheses into a proven exploit chain. Every additional step needs evidence, including useful TrustTunnel protocol behavior, attacker privileges, and access to staging objects.

## Verification performed and completion boundary

The report is based on read-only source tracing, release comparisons, official dependency/platform documentation, installed-file inventory and hash/version identification. Network reproductions, exploit delivery, privileged boundary tests, packet capture and installer execution were not performed. All reproduction sections are review plans.

The first audit already ran the following on the same working commit `0843800b8940e7b2e337f21d2c60e067aa0a1be2`; this report does not change that source and does not re-label these tests as security proofs:

| Check | Result | What it establishes / limitation |
| --- | --- | --- |
| `npm.cmd run typecheck` in `gui-pro` | PASS | TypeScript compilation checks for the working UI. |
| `npm.cmd run lint` in `gui-pro` | PASS | Existing ESLint checks for the working UI. |
| `npm.cmd test -- --reporter=dot` in `gui-pro` | PASS: 251 files, 3,955 tests | Existing mocked application tests pass; no actual Windows packet containment or elevation proof. |
| `npm.cmd run build` in `gui-pro` | PASS | Working UI production build; retained old external font reference is relevant to PRI-02. |
| `npx.cmd --yes --package markdownlint-cli@0.49.1 markdownlint --config .markdownlint.json WINDOWS_VPN_SECURITY_AUDIT.md` | PASS | The new report passes the repository's Markdown rules; no application dependency manifest was changed. |
| Report evidence-reference validation | PASS | 24 unique review IDs, 64 immutable source citations across 36 source files, 23 reference definitions, and valid internal finding links. Referenced Git objects/paths and source-line bounds were checked; this does not replace semantic review or runtime proof. |
| `make`, `make test`, `make lint`, `make clang-format` | UNAVAILABLE | `make` is absent and the trimmed root checkout has no Makefile. The released C++ core was not built/tested in this audit. |
| `npm.cmd run rust:fmt`, `npm.cmd run rust:check` | UNAVAILABLE | `cargo` is absent; no Rust compile/format success is claimed. |
| `make lint-fix` | NOT RUN | It would automatically alter project files; no source changes were requested. |

No changed application code requires new unit tests. Formatting validation for the report itself and evidence-reference checks passed during report assembly. Independent source challenges of the network, policy/TLS, privacy/status and elevated-application sections found no blocking evidence error after corrections; those reviews also did not run attacks. No commit, push, application refactor, branch reset, deployment, or vulnerability repair is included.

Remaining limits are explicit: no reproducible binary build, no controlled Windows receiver captures, no high/medium-integrity exploit results, no complete audit of every third-party library or installer script, and no complete audit of Android, server internals or legacy editions. The reviewed threat-model areas have an evidence-backed casebook, not a mathematical proof that all vulnerabilities have been found. The most urgent independent tests are NET-01/02/03, selective policy/attribution fail-open cases, TLS-01/02 and APP-04.
