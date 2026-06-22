import type { TFunction } from "i18next";

export interface DeployStep {
  step: string;
  status: string;
  message: string;
  // #22 (06-uat): the per-run generation the backend stamps onto every deploy event
  // (ssh/mod.rs CURRENT_DEPLOY_OP_ID). The listener drops any event whose opId does not
  // match the run currently on screen, so a late/stale event from a cancelled run can
  // never bleed into a fresh run's progress map. Optional: legacy/un-stamped events (and
  // test fixtures that omit it) are treated as opId 0 → "accept".
  opId?: number;
}

export interface DeployLog {
  message: string;
  level: string;
  // #22: same per-run generation stamp as DeployStep.opId (see above).
  opId?: number;
}

// WizardStep is kept for the step→screen switch in SetupWizard.tsx. It equals the
// machine `Step` union in machine.ts (the navigation source of truth, D-11). The
// compile-time guard in machine.ts (WizardStep ⊆ Step) still holds: both unions list
// the same members.
//
// 06-uat: `welcome`, `server`, `checking` and `fetching` are RETAINED-BUT-UNREACHABLE.
// The install wizard no longer renders an SSH-login (`server`), a server-probe
// (`checking`) or a fetch-progress (`fetching`) screen, and the welcome menu is gone —
// but these members are intentionally KEPT in the union because the Phase-5 machine
// compile-time guard (machine.ts:_wizardStepIsSubsetOfStep) and machine.test.ts walk
// the full Step set. Removing them would break those invariance suites for no gain.
export type WizardStep =
  | "welcome"
  | "server"
  | "checking"
  | "found"
  | "uninstalling"
  | "endpoint"
  | "deploying"
  | "fetching"
  | "done"
  | "error"
  | "recovery";

export interface ServerInfo {
  installed: boolean;
  version: string;
  serviceActive: boolean;
  users: string[];
}

export interface SetupWizardProps {
  onSetupComplete: (configPath: string) => void;
  // onClose closes the wizard overlay (App's setWizardActive(false)). Install-only
  // wizard (D-01): the first screen's "Назад" and the Done/Found post-install nav
  // exit the overlay instead of navigating to the deleted welcome menu (Pitfall 3).
  onClose?: () => void;
}

// STEPS_ORDER is the RENDER-ONLY deploy progress map (consumed by DeployingStep), NOT a
// machine navigation step (D-11). 06-uat: FETCH_STEPS_ORDER / getFetchStepLabels were
// removed with the wizard's fetch flow (FetchingStep is deleted).
export const STEPS_ORDER = [
  // "security" (post-UAT): the firewall/Fail2ban provisioning step (WIZARD-06). It runs
  // between "service" and "export" and apt-installs ufw/fail2ban — tens of seconds over
  // SSH. Without a step here the wizard showed a silent gap at 70%. The backend always
  // resolves it (ok / warn / skipped) so it never hangs.
  "connect", "auth", "check", "update", "install", "configure", "service", "security", "export", "save", "done",
];

export const getStepLabels = (t: TFunction): Record<string, string> => ({
  connect: t('wizard.steps.connect'),
  auth: t('wizard.steps.auth'),
  check: t('wizard.steps.check'),
  update: t('wizard.steps.update'),
  install: t('wizard.steps.install'),
  configure: t('wizard.steps.configure'),
  service: t('wizard.steps.service'),
  security: t('wizard.steps.security'),
  export: t('wizard.steps.export'),
  save: t('wizard.steps.save'),
  done: t('wizard.steps.done'),
});
