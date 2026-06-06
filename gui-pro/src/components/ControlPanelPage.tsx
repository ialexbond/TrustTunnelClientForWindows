import { useControlPanelOrchestrator } from "./server/useControlPanelOrchestrator";
import { ControlPanelView } from "./server/ControlPanelView";

// ═══════════════════════════════════════════════════════
// Props
// ═══════════════════════════════════════════════════════

interface Props {
  onConfigExported: (configPath: string) => void;
  onSwitchToSetup: () => void;
  onNavigateToSettings?: () => void;
  /**
   * Phase 19 (UI-SPEC §Block 1) — lift sidecar-update flag to `App` so the
   * bottom TabNavigation can render the dot on «Панель управления».
   *
   * Receives `sidecarAvailable && !sidecarDismissed` (already collapsed —
   * caller does not need to apply dismissal logic itself).
   */
  onSidecarUpdateChange?: (hasUpdate: boolean) => void;
}

// ControlPanelPage is a thin connector (PANEL-02/03, D-04): the SSH-state
// machine + sidecar-update detection live in `useControlPanelOrchestrator`, the
// panel JSX lives in `ControlPanelView`. This component only wires the two
// together. See server/useControlPanelOrchestrator.ts + server/ControlPanelView.tsx.
export function ControlPanelPage(props: Props) {
  const s = useControlPanelOrchestrator(props);
  return <ControlPanelView {...s} />;
}
