import type { TFunction } from "i18next";

export interface DeployStep {
  step: string;
  status: string;
  message: string;
}

export interface DeployLog {
  message: string;
  level: string;
}

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
  | "error";

export interface ServerInfo {
  installed: boolean;
  version: string;
  serviceActive: boolean;
  users: string[];
}

export interface SetupWizardProps {
  onSetupComplete: (configPath: string) => void;
  resetToWelcomeRef?: React.MutableRefObject<(() => void) | null>;
}

export const STEPS_ORDER = [
  "connect", "auth", "check", "update", "install", "configure", "service", "export", "save", "done",
];

export const getStepLabels = (t: TFunction): Record<string, string> => ({
  connect: t('wizard.steps.connect'),
  auth: t('wizard.steps.auth'),
  check: t('wizard.steps.check'),
  update: t('wizard.steps.update'),
  install: t('wizard.steps.install'),
  configure: t('wizard.steps.configure'),
  service: t('wizard.steps.service'),
  export: t('wizard.steps.export'),
  save: t('wizard.steps.save'),
  done: t('wizard.steps.done'),
});

export const FETCH_STEPS_ORDER = ["connect", "auth", "check", "export", "save", "done"];

export const getFetchStepLabels = (t: TFunction): Record<string, string> => ({
  connect: t('wizard.steps.connect'),
  auth: t('wizard.steps.auth'),
  check: t('wizard.steps.check_tt'),
  export: t('wizard.steps.export'),
  save: t('wizard.steps.save'),
  done: t('wizard.steps.done'),
});
