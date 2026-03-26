import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, Plus, X } from "lucide-react";
import { Card, CardHeader, Toggle, Button, Badge } from "../../shared/ui";
import { ProcessPickerModal } from "./ProcessPickerModal";
import type { ProcessInfo } from "./useRoutingState";

interface ProcessFilterSectionProps {
  processMode: "exclude" | "only";
  processes: string[];
  processList: ProcessInfo[];
  processListLoading: boolean;
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
  onModeChange,
  onAdd,
  onRemove,
  onLoadProcesses,
}: ProcessFilterSectionProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleOpenPicker = async () => {
    await onLoadProcesses();
    setPickerOpen(true);
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
          icon={<Cpu className="w-4 h-4" />}
          action={
            <Badge variant={processes.length > 0 ? "accent" : "default"} size="sm">
              {processes.length}
            </Badge>
          }
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
          icon={<Cpu className="w-3.5 h-3.5" />}
        />

        {/* Process list */}
        {processes.length > 0 && (
          <div className="mt-2 space-y-1">
            {processes.map((proc) => (
              <div
                key={proc}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg group hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <Cpu
                  className="w-3.5 h-3.5 shrink-0"
                  style={{ color: "var(--color-text-muted)" }}
                />
                <span
                  className="flex-1 text-xs font-mono truncate"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  {proc}
                </span>
                <button
                  onClick={() => onRemove(proc)}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,0.1)] transition-all"
                  title={t("routing.removeProcess")}
                >
                  <X className="w-3.5 h-3.5" style={{ color: "var(--color-danger-400)" }} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add button */}
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
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
        alreadyAdded={processes}
        onConfirm={handlePickerConfirm}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}
