import type { ServerState } from "./useServerState";
import { SecuritySection } from "./SecuritySection";
import { CertSection } from "./CertSection";

interface Props {
  state: ServerState;
}

export function SecurityTabSection({ state }: Props) {
  return (
    <div className="space-y-4">
      {/* aria-live: SecuritySection делает SSH-запросы, результат объявляется screen reader */}
      <div aria-live="polite">
        <SecuritySection state={state} />
      </div>
      <CertSection state={state} />
    </div>
  );
}
