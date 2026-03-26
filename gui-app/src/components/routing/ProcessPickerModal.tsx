import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Loader2, Cpu, Check } from "lucide-react";
import { Modal, Button } from "../../shared/ui";
import type { ProcessInfo } from "./useRoutingState";

interface ProcessPickerModalProps {
  open: boolean;
  processes: ProcessInfo[];
  loading: boolean;
  alreadyAdded: string[];
  onConfirm: (selected: string[]) => void;
  onClose: () => void;
}

export function ProcessPickerModal({
  open,
  processes,
  loading,
  alreadyAdded,
  onConfirm,
  onClose,
}: ProcessPickerModalProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const alreadySet = useMemo(() => new Set(alreadyAdded), [alreadyAdded]);

  const filtered = useMemo(() => {
    const seen = new Set<string>();
    const unique: ProcessInfo[] = [];
    for (const p of processes) {
      if (!seen.has(p.name)) {
        seen.add(p.name);
        unique.push(p);
      }
    }

    if (!search.trim()) return unique;
    const q = search.toLowerCase();
    return unique.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.path && p.path.toLowerCase().includes(q))
    );
  }, [processes, search]);

  const toggleProcess = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    onConfirm([...selected]);
    setSelected(new Set());
    setSearch("");
  };

  const handleClose = () => {
    setSelected(new Set());
    setSearch("");
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <div
        className="w-[420px] max-h-[520px] flex flex-col rounded-2xl shadow-2xl overflow-hidden"
        style={{
          backgroundColor: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
        }}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <h3
            className="text-sm font-semibold mb-3"
            style={{ color: "var(--color-text-primary)" }}
          >
            {t("routing.selectProcesses")}
          </h3>

          {/* Search */}
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
              style={{ color: "var(--color-text-muted)" }}
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("routing.searchProcess")}
              className="w-full pl-9 pr-3 py-2 rounded-[var(--radius-lg)] text-xs outline-none transition-colors placeholder:opacity-40"
              style={{
                backgroundColor: "var(--color-input-bg)",
                border: "1px solid var(--color-input-border)",
                color: "var(--color-text-primary)",
              }}
              autoFocus
            />
          </div>
        </div>

        {/* Process list */}
        <div
          className="flex-1 overflow-y-auto px-3 pb-2"
          style={{ minHeight: "200px", maxHeight: "320px" }}
        >
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2
                className="w-5 h-5 animate-spin"
                style={{ color: "var(--color-accent-400)" }}
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {t("routing.noProcessesFound")}
              </span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((proc) => {
                const isAdded = alreadySet.has(proc.name);
                const isSelected = selected.has(proc.name);
                const checked = isSelected || isAdded;

                return (
                  <button
                    key={proc.name}
                    type="button"
                    disabled={isAdded}
                    onClick={() => toggleProcess(proc.name)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors disabled:opacity-40"
                    style={{
                      backgroundColor: isSelected
                        ? "rgba(99, 102, 241, 0.08)"
                        : "transparent",
                    }}
                  >
                    {/* Checkbox */}
                    <div
                      className="w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors"
                      style={{
                        borderColor: checked
                          ? "var(--color-accent-500)"
                          : "var(--color-border)",
                        backgroundColor: checked
                          ? "var(--color-accent-500)"
                          : "var(--color-input-bg)",
                      }}
                    >
                      {checked && <Check className="w-3 h-3 text-white" />}
                    </div>

                    <div
                      className="w-6 h-6 rounded flex items-center justify-center shrink-0"
                      style={{ backgroundColor: "var(--color-bg-hover)" }}
                    >
                      <Cpu className="w-3 h-3" style={{ color: "var(--color-text-muted)" }} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <span
                        className="text-xs block truncate"
                        style={{ color: "var(--color-text-primary)" }}
                      >
                        {proc.name}
                      </span>
                      {proc.path && (
                        <span
                          className="text-[10px] block truncate"
                          style={{ color: "var(--color-text-muted)" }}
                        >
                          {proc.path}
                        </span>
                      )}
                    </div>

                    {isAdded && (
                      <span
                        className="text-[10px] shrink-0 px-1.5 py-0.5 rounded"
                        style={{
                          color: "var(--color-text-muted)",
                          backgroundColor: "var(--color-bg-hover)",
                        }}
                      >
                        {t("routing.alreadyAdded")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3 border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {t("buttons.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={selected.size === 0}
            onClick={handleConfirm}
          >
            {t("routing.addSelected")}
            {selected.size > 0 && ` (${selected.size})`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
