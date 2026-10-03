import { useTranslation } from "react-i18next";
import { Route, RotateCcw } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { PanelHeader } from "../../shared/ui/PanelHeader";
import { Button } from "../../shared/ui/Button";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";

/**
 * The «Маршрутизация» tab when `routing_rules.json` exists and cannot be parsed
 * (D-02, 30.1 milestone review blocker 2).
 *
 * WHY THIS IS A SEPARATE STATE AT ALL. Before it, the panel fell through to its ordinary body
 * with zero entries in every block — byte-for-byte what somebody who has no rules sees. A user
 * whose file was merely damaged was told «у вас нет правил», and the natural response (start
 * typing the rules again) would have overwritten the list they still had on disk. «Пусто» and
 * «сломано» are different facts and only one of them asks the user to do something.
 *
 * WHY «Сбросить» AND NOT «Повторить». Re-reading a file that will not parse changes nothing.
 * `ConfigEditView` records the same reasoning for a corrupt config: it offers «Закрыть» and
 * deliberately no retry.
 *
 * WHY THE ACTION IS A SIBLING OF THE BANNER. `ErrorBanner` takes `message`/`variant`/`onDismiss`
 * and has no action slot; adding one is a shared-kit change with `role="alert"` consequences for
 * every other caller. Rendering the action beside the banner is what the one existing composition
 * of this shape already does.
 *
 * The confirmation is the CALLER's (`RoutingPanel`): this component only reports the click. The
 * split keeps the destructive dialog with the screen that owns the flow and leaves this piece
 * renderable in Storybook without a dialog provider.
 */
export interface RoutingRulesUnreadableProps {
  /** Open the confirmation, then throw the rule list away. Never resets on its own. */
  onReset: () => void;
}

export function RoutingRulesUnreadable({ onReset }: RoutingRulesUnreadableProps) {
  const { t } = useTranslation();

  return (
    <div className="flex-1 scroll-overlay py-3 px-4">
      <Card padding="md">
        <PanelHeader
          icon={<Route className="w-4 h-4" />}
          title={t("routing.unreadable.title")}
        />
        <div className="flex flex-col gap-[var(--space-4)]">
          {/* The message names the CAUSE — the rules file — and never interpolates the parser's
              own error, which is English, unbounded and can quote the file's bytes (D-29). */}
          <ErrorBanner variant="error" message={t("routing.unreadable.body")} />
          <div className="flex justify-end">
            {/* `danger` because the click behind the confirmation is irreversible. */}
            <Button
              variant="danger"
              size="sm"
              icon={<RotateCcw className="w-3.5 h-3.5" />}
              onClick={onReset}
            >
              {t("routing.unreadable.reset")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
