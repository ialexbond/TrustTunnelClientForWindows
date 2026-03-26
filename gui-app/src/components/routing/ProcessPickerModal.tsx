import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Loader2, Cpu } from "lucide-react";
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
    // Deduplicate by name
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
        className="w-[400px] max-h-[500px] flex flex-col rounded-2xl shadow-2xl overflow-hidden"
        style={{ backgroundColor: "var(--color-bg-elevated)" }}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <h3
            className="text-base font-semibold mb-3"
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
              className="w-full pl-9 pr-3 py-2.5 rounded-[var(--radius-lg)] text-sm outline-none transition-colors placeholder:opacity-40"
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
          style={{ minHeight: "200px", maxHeight: "300px" }}
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
                const isDisabled = isAdded;

                return (
                  <button
                    key={proc.name}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => toggleProcess(proc.name)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors disabled:opacity-40"
                    style={{
                      backgroundColor: isSelected
                        ? "rgba(99, 102, 241, 0.1)"
                        : "transparent",
                    }}
                  >
                    {/* Checkbox */}
                    <div
                      className="w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors"
                      style={{
                        borderColor: isSelected || isAdded
                          ? "var(--color-accent-500)"
                          : "var(--color-border-strong)",
                        backgroundColor: isSelected || isAdded
                          ? "var(--color-accent-500)"
                          : "transparent",
                      }}
                    >
                      {(isSelected || isAdded) && (
                        <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none">
                          <path
                            d="M2 6l3 3 5-5"
                            stroke="white"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>

                    <Cpu
                      className="w-3.5 h-3.5 shrink-0"
                      style={{ color: "var(--color-text-muted)" }}
                    />

                    <div className="flex-1 min-w-0">
                      <span
                        className="text-xs font-medium block truncate"
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
                        className="text-[10px] shrink-0"
                        style={{ color: "var(--color-text-muted)" }}
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
          className="flex items-center justify-between px-5 py-3 border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
            {selected.size > 0
              ? t("routing.selectedCount", { count: selected.size })
              : ""}
          </span>
          <div className="flex gap-2">
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
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
