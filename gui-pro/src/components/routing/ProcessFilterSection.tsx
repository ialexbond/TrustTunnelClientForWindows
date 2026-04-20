import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus, X, FolderOpen, Filter, AppWindow } from "lucide-react";
import { Card, CardHeader, Toggle, Button } from "../../shared/ui";
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

  const handleBrowse = async () => {
    const files = await open({
      filters: [{ name: "Executable", extensions: ["exe"] }],
      multiple: true,
    });
    if (files) {
      const paths = Array.isArray(files) ? files : [files];
      for (const filePath of paths) {
        const p = typeof filePath === "string" ? filePath : filePath;
        const sep = p.includes("/") ? "/" : "\\";
        const filename = p.split(sep).pop() || p;
        if (filename && !processes.includes(filename)) {
          onAdd(filename);
        }
      }
    }
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
                <span
                  className="flex-1 text-xs font-mono truncate"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  {proc}
                </span>
                <button
                  onClick={() => onRemove(proc)}
                  className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                  style={{ color: "var(--color-danger-400)" }}
                  title={t("routing.removeProcess")}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="mt-3 flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={handleOpenPicker}
          >
            {t("routing.addProcess")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<FolderOpen className="w-3.5 h-3.5" />}
            onClick={handleBrowse}
          >
            {t("routing.browseExe", "Обзор")}
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
