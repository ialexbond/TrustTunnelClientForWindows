import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { GeoAutocomplete } from "./GeoAutocomplete";
import type { RouteAction, GeoDataIndex, GeoDataStatus } from "./useRoutingState";

interface AddRuleInputProps {
  action: RouteAction;
  geodataStatus: GeoDataStatus;
  geodataCategories: GeoDataIndex;
  onAdd: (action: RouteAction, value: string) => string | null;
}

function detectAutocomplete(value: string): { prefix: "geoip" | "geosite"; query: string } | null {
  const lower = value.toLowerCase();
  if (lower.startsWith("geoip:")) {
    return { prefix: "geoip", query: value.slice(6) };
  }
  if (lower.startsWith("geosite:")) {
    return { prefix: "geosite", query: value.slice(8) };
  }
  return null;
}

export function AddRuleInput({ action, geodataStatus, geodataCategories, onAdd }: AddRuleInputProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const autocompleteInfo = detectAutocomplete(input);

  // Show autocomplete when prefix is detected
  useEffect(() => {
    setShowAutocomplete(autocompleteInfo !== null);
  }, [autocompleteInfo]);

  // Close autocomplete on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowAutocomplete(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleAdd = useCallback(
    (value?: string) => {
      const val = (value ?? input).trim();
      if (!val) return;

      const result = onAdd(action, val);
      if (result === "duplicate") {
        setErrorMsg(t("routing.duplicateEntry"));
        setTimeout(() => setErrorMsg(""), 3000);
        return;
      }
      if (result === "empty") {
        return;
      }

      setInput("");
      setShowAutocomplete(false);
      setErrorMsg("");
      inputRef.current?.focus();
    },
    [input, action, onAdd, t]
  );

  const handleGeoSelect = useCallback(
    (value: string) => {
      handleAdd(value);
    },
    [handleAdd]
  );

  // Calculate dropdown position using portal (avoids overflow:hidden on Card)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (showAutocomplete && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, [showAutocomplete, input]);

  return (
    <div ref={wrapperRef} className="relative mt-2">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !showAutocomplete) {
              handleAdd();
            }
          }}
          placeholder={t("routing.addRulePlaceholder")}
          className="flex-1 px-3 py-2 rounded-[var(--radius-lg)] text-xs font-mono transition-colors outline-none placeholder:opacity-40"
          style={{
            backgroundColor: "var(--color-input-bg)",
            border: `1px solid ${errorMsg ? "var(--color-danger-500)" : "var(--color-input-border)"}`,
            color: "var(--color-text-primary)",
          }}
        />
        <button
          onClick={() => handleAdd()}
          disabled={!input.trim()}
          className="px-3 py-2 rounded-[var(--radius-lg)] transition-colors disabled:opacity-40 disabled:cursor-default"
          style={{
            backgroundColor: "rgba(99, 102, 241, 0.15)",
            color: "var(--color-accent-400)",
          }}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {errorMsg && (
        <p className="text-[10px] mt-1" style={{ color: "var(--color-danger-400)" }}>
          {errorMsg}
        </p>
      )}

      {showAutocomplete && autocompleteInfo && dropdownPos &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              zIndex: 9999,
            }}
          >
            <GeoAutocomplete
              prefix={autocompleteInfo.prefix}
              query={autocompleteInfo.query}
              categories={
                autocompleteInfo.prefix === "geoip"
                  ? geodataCategories.geoip
                  : geodataCategories.geosite
              }
              downloaded={geodataStatus.downloaded}
              onSelect={handleGeoSelect}
              onClose={() => setShowAutocomplete(false)}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
