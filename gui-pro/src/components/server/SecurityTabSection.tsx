import type { ServerState } from "./useServerState";
import { SecuritySection } from "./SecuritySection";

interface Props {
  state: ServerState;
}

/**
 * Phase 16 Plan 05 — Security tab выбор всех 4 функциональных блоков теперь
 * живёт внутри `SecuritySection.tsx` (4-cards layout с Modal triggers + inline
 * CertSection). SecurityTabSection остаётся как тонкая wrapping shell для
 * route-level integration (`ServerTabs.tsx` rendering selector).
 *
 * `aria-live="polite"` уже встроен в SecuritySection root — SSH-driven status
 * changes будут announce'ены screen-reader'у.
 */
export function SecurityTabSection({ state }: Props) {
  return <SecuritySection state={state} />;
}
