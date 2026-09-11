/**
 * shouldActivateConfig — pure gate for promoting a wizard-produced config to the
 * ACTIVE «Подключение» (Connection) tab config (UAT 2026-06-19, R2/R3).
 *
 * Background: finishing the install wizard used to UNCONDITIONALLY set the newly
 * created config as the Connection tab's active config (App.tsx onSetupComplete
 * wrote `tt_config_path` + config.configPath every time). The product owner
 * reported this as a bug — finishing an install silently REPLACED whatever config
 * the user was already connected to / had added, even when clicking «Перейти к
 * панели управления».
 *
 * The new rule: the freshly-created config becomes the active config ONLY IF BOTH
 * are true —
 *   1. there is currently NO active config on the Connection tab
 *      (`hasActiveConfig === false`, i.e. tt_config_path / config.configPath empty), AND
 *   2. the VPN is NOT currently connected (`vpnConnected === false`).
 *
 * In every other case (an active config already exists OR the VPN is connected) the
 * existing active config / connection is left completely untouched — the new
 * `<username>.toml` is still written to disk by the backend (R1), it is just not
 * promoted. A future Connection-tab redesign will add a multi-config switcher so the
 * user can pick the new one manually (R5 — out of scope here).
 *
 * Kept as a tiny pure function so the gating decision is unit-testable in isolation
 * (App.test.tsx fully mocks SetupWizard, so onSetupComplete is not exercised there).
 */
export interface ConfigActivationContext {
  /** True when the Connection tab already has an active/added config. */
  hasActiveConfig: boolean;
  /** True when a VPN session is active (connected or any in-progress state). */
  vpnConnected: boolean;
}

export function shouldActivateConfig({
  hasActiveConfig,
  vpnConnected,
}: ConfigActivationContext): boolean {
  return !hasActiveConfig && !vpnConnected;
}
