import { useTranslation } from "react-i18next";
import { Network } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import type { ServerState } from "./useServerState";
import { useSecurityState } from "./useSecurityState";
import { SshPortSection } from "./SshPortSection";
import { VersionSection } from "./VersionSection";
import { useVpnTomlState } from "./useVpnTomlState";
import { QuickSettingsSection } from "./QuickSettingsSection";
import { AdvancedConfigAccordion } from "./AdvancedConfigAccordion";
import { AllowedSniEditor } from "./AllowedSniEditor";

interface Props {
  state: ServerState;
}

/**
 * Phase 15 — «Конфигурация» tab orchestrator (REWRITE of Phase 13 version).
 *
 * Layout (top → bottom):
 *   1. **Quick Settings** (Plan 04) — 6 most-used vpn.toml fields with inline
 *      restart-required badges, dirty banner, и explicit save flow.
 *   2. **SSH Port** — separate concern (sshd_config + firewall, NOT vpn.toml)
 *      kept as standalone Card. Phase 11 carry-over.
 *   3. **Advanced Accordion** (Plan 05) — sectioned per-field editors,
 *      AllowedSniEditor (Plan 06) wired через `allowedSniSlot`, и Raw TOML.
 *   4. **Version** (Phase 11 carry-over) — sidecar version section, separate
 *      concern, NOT vpn.toml.
 *
 * **Single hook instance:** `useVpnTomlState` runs once here at the top, и
 * shared state передаётся в:
 *   - `<QuickSettingsSection state={vpnState} />` — bypasses internal hook
 *     (Task 1 refactor — `state` prop precedence above internal call).
 *   - `<AdvancedConfigAccordion vpnTomlContent={vpnState.vpnTomlRaw} ... />` —
 *     reads raw TOML и hosts.toml from same bundle.
 *   - `<AllowedSniEditor hosts={vpnState.allowedSni} ... />` — reads
 *     allowed_sni list from bundle. After mutation, `onHostsChange` triggers
 *     `vpnState.loadBundle()` to resync server state.
 *
 * Pitfall 4 (SSH stampede on tab mount) mitigated — only one
 * `server_get_config_bundle` IPC call per Configuration tab activation.
 *
 * **Removed from Phase 13 version:**
 *   - `parseTomlConfig` regex helper — replaced by typed serde parsing in
 *     `useVpnTomlState` (Plan 04 + backend Plan 01 `VpnConfigKnown` struct).
 *   - Feature toggle UI for `ping_enable` / `speedtest_enable` / `ipv6_available` —
 *     per D-1 those toggles живут в Overview tab (Phase 13 G-01..G-08), не
 *     дублируются здесь.
 *   - `handleSaveSettings` (server_apply_config invoke) — каждая секция теперь
 *     управляет своим save flow (per-field typed mutations vs raw TOML write).
 *   - Bottom Save CTA — заменена per-section apply buttons и dirty banner.
 *   - Loading warning banner — replaced QuickSettingsSection's own Skeleton
 *     loading state (3 cards × 120px placeholders).
 */
export function ServerSettingsSection({ state }: Props) {
  const { t } = useTranslation();
  const { sshParams } = state;

  // Sub-hooks — single instance owned by this component
  const security = useSecurityState(sshParams, state.pushSuccess, state.onPortChanged);
  const vpnState = useVpnTomlState(sshParams);

  return (
    <div className="space-y-4" data-testid="server-settings-section">
      {/* 1. Quick Settings — top, owns vpn.toml mutations */}
      <QuickSettingsSection sshParams={sshParams} state={vpnState} />

      {/* 2. SSH Port — separate concern (sshd_config), NOT vpn.toml */}
      <Card>
        <CardHeader
          title={t("server.config.port_title")}
          icon={<Network className="w-3.5 h-3.5" />}
        />
        <SshPortSection state={security} />
      </Card>

      {/* 3. Advanced Accordion — closed by default; opens per-section modals.
           AllowedSniEditor получает hosts из shared vpnState; после успешной
           mutation reload bundle через `onHostsChange` callback. */}
      <AdvancedConfigAccordion
        vpnTomlContent={vpnState.vpnTomlRaw}
        hostsTomlContent={vpnState.hostsTomlRaw}
        allowedSniSlot={
          <AllowedSniEditor
            hosts={vpnState.allowedSni}
            sshParams={sshParams}
            onHostsChange={() => {
              // Resync useVpnTomlState с server state — после optimistic
              // update + persist, refetch confirms backend wrote the file
              // и AllowedSniEditor receives fresh prop reference (its
              // length-guarded sync logic absorbs the update).
              void vpnState.loadBundle();
            }}
          />
        }
      />

      {/* 4. Version — separate concern, sidecar binary management */}
      <VersionSection state={state} />
    </div>
  );
}
