import { vi } from "vitest";
import { createRef } from "react";
import type { WizardState } from "./useWizardState";
import { DEFAULT_DEEPLINK } from "../server/useUserFormState";

/**
 * Creates a mock WizardState with sensible defaults.
 * Override any field by passing partial overrides.
 */
export function makeWizardState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    // 06-uat install-only wizard: default screen is `endpoint` (Settings). The SSH-login
    // (`server`), probe (`checking`) and fetch (`fetching`) screens were removed.
    step: "endpoint",
    setWizardStep: vi.fn(),

    host: "",
    setHost: vi.fn(),
    port: "22",
    setPort: vi.fn(),
    sshUser: "root",
    setSshUser: vi.fn(),
    sshPassword: "",
    setSshPassword: vi.fn(),
    sshKeyPath: "",
    setSshKeyPath: vi.fn(),
    sshKeyData: "",
    setSshKeyData: vi.fn(),
    showSshPassword: false,
    setShowSshPassword: vi.fn(),
    authMode: "password",
    setAuthMode: vi.fn(),
    // D-06: mirror the real buildAuthArgs so callers (FoundStep export path) can
    // exercise the auth-args contract. Default reflects authMode "password".
    buildAuthArgs: () => ({
      password: "",
      keyPath: undefined,
      keyData: undefined,
      authMethod: "password" as const,
    }),

    listenAddress: "0.0.0.0:443",
    setListenAddress: vi.fn(),
    vpnUsername: "",
    setVpnUsername: vi.fn(),
    vpnPassword: "",
    setVpnPassword: vi.fn(),
    showVpnPassword: false,
    setShowVpnPassword: vi.fn(),
    // D-11 (06-13) first-user advanced posture (default = Users-tab DEFAULTS, anti-DPI ON)
    firstUserAdvanced: DEFAULT_DEEPLINK,
    setFirstUserAdvanced: vi.fn(),
    updateFirstUserAdvanced: vi.fn(),
    // C-09 / C-10 (06-15) post-install reachability + resolved-address (defaults: clean)
    // fix_18 (06-uat): dismissReachabilityWarning removed — the warning is info-only now.
    reachabilityWarning: false,
    resolvedEndpointAddress: "",
    selfSignedNoDomain: false,
    certType: "letsencrypt",
    setCertType: vi.fn(),
    domain: "",
    setDomain: vi.fn(),
    email: "",
    setEmail: vi.fn(),
    certChainPath: "",
    setCertChainPath: vi.fn(),
    certKeyPath: "",
    setCertKeyPath: vi.fn(),
    showAdvanced: false,
    setShowAdvanced: vi.fn(),
    // D-10 (06-09) advanced settings — only the 407/405 chooser remains in the wizard.
    // Metrics/SOCKS5/Allow-private were removed; ICMP/IPv6 toggles were hidden.
    authFailureStatusCode: 407,
    setAuthFailureStatusCode: vi.fn(),
    // WIZARD-06 / D-01: install-time server-protection toggles default ON.
    enableFirewall: true,
    setEnableFirewall: vi.fn(),
    enableFail2ban: true,
    setEnableFail2ban: vi.fn(),

    serverInfo: null,
    checkError: "",
    secretMissing: false,
    setSecretMissing: vi.fn(),

    // Recovery fork (slice 3)
    recoveryProbe: null,
    recoveryCause: "",
    recoveryBusy: false,

    newUsername: "",
    setNewUsername: vi.fn(),
    newPassword: "",
    setNewPassword: vi.fn(),
    showNewPassword: false,
    setShowNewPassword: vi.fn(),
    addingUser: false,
    deletingUser: null,
    selectedUser: null,
    setSelectedUser: vi.fn(),
    cameFromFound: false,
    setCameFromFound: vi.fn(),

    deploySteps: {},
    deployLogs: [],
    // fix_16 (06-uat): finalize-phase indicator (default off)
    finalizing: false,
    showLogs: false,
    setShowLogs: vi.fn(),
    errorMessage: "",
    configPath: "",
    copied: false,
    logsEndRef: createRef<HTMLDivElement>(),

    canGoToEndpoint: false,
    // C-02 (06-13) duplicate first-user name on the reinstall path (default no collision)
    isDuplicateVpnUsername: false,
    // isValidEmail is a function `(e: string) => boolean` on the real WizardState,
    // not a boolean. A boolean literal here passed the `as WizardState` cast but threw
    // `TypeError: w.isValidEmail is not a function` in any test calling it. Mirror the
    // real validator signature so the mock stays honest.
    isValidEmail: (e: string) => !e.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()),
    canDeploy: false,
    // D-10 / C-08 (06-09) inline form-gate errors (default no error)
    leDomainError: false,

    resolveResumeOnOpen: vi.fn(),
    handleContinue: vi.fn(),
    handleStartOver: vi.fn(),
    handleApplyConfig: vi.fn(),
    handleTrustNewKey: vi.fn(),
    handleUninstall: vi.fn(),
    handleCancelDeploy: vi.fn(),
    cancellingDeploy: false,
    // fix_B (06-uat): retry-to-endpoint with generation invalidation
    handleRetryToEndpoint: vi.fn(),
    handleDeploy: vi.fn(),
    handleSkip: vi.fn(),
    handleAddUser: vi.fn(),
    handleDeleteUser: vi.fn(),
    handleSaveAs: vi.fn(),
    copyLogsToClipboard: vi.fn(),
    saveField: vi.fn(),
    onSetupComplete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  } as WizardState;
}
