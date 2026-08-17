import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Loader2, Cpu } from "lucide-react";
import { Modal, Button, Checkbox } from "../../shared/ui";
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
    // UAT-F04: render directly on the shared Modal surface. Modal already owns
    // the surface/border/radius/shadow/padding — the old nested rounded-2xl +
    // shadow-2xl + border box drew a SECOND frame (double border). We keep only
    // an inner flex column for layout (no frame of its own) and let Modal supply
    // the corner X (showCloseButton) + title. size="md" replaces the hardcoded
    // w-[420px] so the width follows the shared sizing scale.
    <Modal
      isOpen={open}
      onClose={handleClose}
      size="md"
      title={t("routing.selectProcesses")}
      showCloseButton
    >
      <div className="flex flex-col overflow-hidden">
        {/* Search */}
        <div className="pb-3">
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
              className="w-full pl-9 pr-3 h-8 rounded-[var(--radius-lg)] text-xs outline-none focus-visible:shadow-[var(--focus-ring)] transition-colors placeholder:opacity-40"
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
          className="flex-1 overflow-y-auto -mx-2 px-2 pb-2"
          style={{ minHeight: "200px", maxHeight: "320px" }}
        >
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2
                className="w-5 h-5 animate-spin"
                style={{ color: "var(--color-accent-fg)" }}
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
                  // 21-06 (D-01): the row is a <div>, NOT a <button>. The shared
                  // Checkbox is itself a <button role="checkbox">, so nesting it
                  // inside a row <button> would be invalid HTML/a11y and break the
                  // tests' .closest("button") selectors. The Checkbox is the single
                  // interactive control; a SIBLING clickable region carries the
                  // whole-row click. Because that region is a sibling (not an
                  // ancestor) of the Checkbox, each click fires exactly one toggle
                  // — no double-fire. Selection tint + already-added muting move
                  // onto this container; behaviour is unchanged.
                  <div
                    key={proc.name}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors${
                      isAdded ? " opacity-40" : ""
                    }`}
                    style={{
                      backgroundColor: isSelected
                        ? "var(--color-accent-tint-08)"
                        : "transparent",
                    }}
                  >
                    {/* Selection indicator — shared Checkbox primitive (D-01).
                        checked = isSelected || isAdded, disabled when already
                        added; toggling runs the same toggleProcess. aria-label
                        names the icon-only control with the process name. */}
                    <Checkbox
                      checked={checked}
                      disabled={isAdded}
                      onChange={() => toggleProcess(proc.name)}
                      aria-label={proc.name}
                      className="shrink-0"
                    />

                    {/* Sibling clickable info region — preserves whole-row click
                        without nesting under the Checkbox. Guarded by isAdded so
                        already-added rows stay inert, mirroring the old disabled
                        row button. */}
                    <div
                      onClick={() => {
                        if (!isAdded) toggleProcess(proc.name);
                      }}
                      className={`flex-1 min-w-0 flex items-center gap-3${
                        isAdded ? "" : " cursor-pointer"
                      }`}
                    >
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
                            className="text-xs block truncate"
                            style={{ color: "var(--color-text-muted)" }}
                          >
                            {proc.path}
                          </span>
                        )}
                      </div>

                      {isAdded && (
                        <span
                          className="text-xs shrink-0 px-1.5 py-0.5 rounded"
                          style={{
                            color: "var(--color-text-muted)",
                            backgroundColor: "var(--color-bg-hover)",
                          }}
                        >
                          {t("routing.alreadyAdded")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer — Cancel (left) / AddSelected (primary, right) matches the
            modal action standard. Border-top + top padding only; horizontal
            padding now comes from the shared Modal surface (UAT-F04). */}
        <div
          className="flex items-center justify-end gap-2 pt-3 mt-1 border-t"
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
