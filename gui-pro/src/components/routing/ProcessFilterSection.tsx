import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Filter, AppWindow, Loader2 } from "lucide-react";
import { Card, CardHeader, Toggle, Button } from "../../shared/ui";
import { IconButton } from "../../shared/ui/IconButton";
import { ProcessIcon } from "./ProcessIcon";
import { useProcessIcons } from "./useProcessIcons";
import { ProcessPickerModal } from "./ProcessPickerModal";
import type { ProcessInfo } from "./useRoutingState";

interface ProcessFilterSectionProps {
  processMode: "exclude" | "only";
  processes: string[];
  processList: ProcessInfo[];
  processListLoading: boolean;
  /**
   * Translated message when the running-process enumeration failed; empty or absent otherwise.
   * Optional so this section can still be mounted (in tests and in the showcase) without one.
   */
  processListError?: string;
  onModeChange: (mode: "exclude" | "only") => void;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onLoadProcesses: () => Promise<void>;
}

export function ProcessFilterSection({
  processMode,
  processes,
  processList,
  processListLoading,
  processListError,
  onModeChange,
  onAdd,
  onRemove,
  onLoadProcesses,
}: ProcessFilterSectionProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Declare the saved names to the shared icon cache up front. Each row's ProcessIcon would declare
  // itself anyway, so this is not what makes the icons appear — it is what makes them appear in ONE
  // batched command instead of relying on the debounce to happen to catch every row's own request.
  // The same cache serves the picker, so a program saved here is already resolved when the picker
  // lists it, and vice versa (D-01: icons in both places, resolved once per session).
  useProcessIcons(processes);

  /**
   * Open the picker FIRST, then fetch the list into it.
   *
   * The other way round — await, then open — meant the enumeration was already finished by the time
   * the modal mounted, so `processListLoading` was back to `false` and the picker's own loading
   * branch could never be reached outside a test. Meanwhile the button that started the work showed
   * nothing at all: the user clicked «Добавить процесс», got a frozen frame for the length of a
   * full process-table walk, and then a modal. Opening first makes the modal's skeleton the real
   * feedback for the real wait, which is what that branch was written for.
   */
  const handleOpenPicker = async () => {
    setPickerOpen(true);
    await onLoadProcesses();
  };

  const handlePickerConfirm = (selected: string[]) => {
    for (const name of selected) {
      onAdd(name);
    }
    setPickerOpen(false);
  };

  return (
    <>
      <Card padding="md">
        <CardHeader
          title={t("routing.processFilterTitle")}
          description={t("routing.processFilterDescription")}
          icon={<Filter className="w-4 h-4" />}
        />

        {/* Mode toggle */}
        <Toggle
          value={processMode === "only"}
          onChange={(val) => onModeChange(val ? "only" : "exclude")}
          label={
            processMode === "exclude"
              ? t("routing.processExcludeMode")
              : t("routing.processOnlyMode")
          }
          description={
            processMode === "exclude"
              ? t("routing.processExcludeDescription")
              : t("routing.processOnlyDescription")
          }
          icon={<AppWindow className="w-3.5 h-3.5" />}
        />

        {/* Process list */}
        {processes.length > 0 && (
          <div className="mt-3 rounded-[var(--radius-lg)] overflow-hidden border" style={{ borderColor: "var(--color-border)" }}>
            {processes.map((proc, idx) => (
              <div
                key={proc}
                className="flex items-center gap-3 px-3 py-2.5 group transition-colors"
                style={{
                  backgroundColor: idx % 2 === 0 ? "transparent" : "var(--color-bg-hover)",
                  borderBottom: idx < processes.length - 1 ? "1px solid var(--color-border)" : "none",
                }}
              >
                {/* D-01: the real Windows application icon, so the list reads like the Windows
                    apps list instead of a column of filenames. The slot holds its size in all
                    three of its states, so the row never reflows while icons fill in. */}
                <ProcessIcon name={proc} />
                <span
                  className="flex-1 text-xs font-mono truncate"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  {proc}
                </span>
                {/* Delete — shared IconButton, ALWAYS visible (D-06). The old raw button sat
                    behind a zero-opacity hover-reveal wrapper, which left it INVISIBLE while a
                    keyboard user had it focused: operable but unusable, written up in
                    22-VERIFICATION.md:172 and widened to every occurrence on the tab. Deleting
                    that wrapper IS the fix — IconButton already renders muted at rest,
                    strengthens on hover and draws the focus ring, so nothing was added to
                    replace it. The glyph moved from X to Trash2 so the Routing tab has exactly
                    one delete glyph (routing.md), and naming moved from a title attribute to
                    aria-label: a title is an unreliable accessible name and invisible to
                    keyboard users. Same shape as RuleEntryRow's delete, which never carried the
                    wrapper. onRemove unchanged.
                    Note for the next author: do not quote the two Tailwind class names of that
                    wrapper here. hover-reveal-guard.sh cannot tell a JSX block comment from code,
                    so writing them out would keep the gate red forever. */}
                <IconButton
                  aria-label={t("routing.removeProcess")}
                  tooltip={t("routing.removeProcess")}
                  icon={<Trash2 className="w-3.5 h-3.5" style={{ color: "var(--color-danger-fg)" }} />}
                  onClick={() => onRemove(proc)}
                  className="hover:bg-[var(--color-danger-tint-10)]"
                />
              </div>
            ))}
          </div>
        )}

        {/* ONE add control, and that is the point of this row (D-04).
            A second button used to stand beside it and open the OS file chooser by itself, with
            its own handler, its own duplicate test and its own silent failure. Two entry points
            into the same list drift apart — the same defect the export/import surfaces had to be
            merged out of in an earlier phase. Choosing a program from disk now happens INSIDE the
            picker below, so both ways of adding share one add path, one duplicate rule and one
            error surface. Do not restore a second button here.
            Its handler also carried a conditional whose two branches were the same expression — a
            leftover from the first-generation dialog API, which could hand back objects; today it
            resolves to plain strings, so the conditional neither narrowed the type nor changed the
            value. It went with the handler. */}
        <div className="mt-3 flex gap-2">
          {/* Disabled while the enumeration runs, with a spinner in place of the ＋: the click is
              acknowledged, and a second click cannot launch a second walk of the whole process
              table on top of the first. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={processListLoading}
            icon={
              processListLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )
            }
            onClick={handleOpenPicker}
          >
            {t("routing.addProcess")}
          </Button>
        </div>
      </Card>

      <ProcessPickerModal
        open={pickerOpen}
        processes={processList}
        loading={processListLoading}
        error={processListError}
        alreadyAdded={processes}
        onConfirm={handlePickerConfirm}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}
