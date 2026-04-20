import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
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

/** Validate user input — returns error i18n key or null if valid */
function validateEntry(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // geoip:/geosite: — always valid (autocomplete handles validation)
  if (/^geo(ip|site):/i.test(trimmed)) return null;

  // IP address (v4)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return null;

  // CIDR (v4)
  if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(trimmed)) return null;

  // IPv6
  if (/^[0-9a-fA-F:]+$/.test(trimmed) && trimmed.includes(":")) return null;

  // Domain validation:
  // Latin domains: a-z, 0-9, hyphens, dots, wildcards
  // Cyrillic domains (.рф etc): cyrillic letters + dots + hyphens
  // Must have at least one dot and a valid TLD-like part

  // Pure latin domain
  if (/^[a-zA-Z0-9*._-]+$/.test(trimmed)) {
    // Must have at least one dot (e.g. "example.com", not just "example")
    if (!trimmed.includes(".") && !trimmed.includes("*")) {
      return "routing.validation.needsDot";
    }
    return null;
  }

  // Cyrillic domain (must have a dot + valid structure like "сайт.рф")
  if (/^[\u0400-\u04FFa-zA-Z0-9._-]+$/.test(trimmed)) {
    if (!trimmed.includes(".")) {
      return "routing.validation.invalidCyrillic";
    }
    // Check TLD part after last dot
    const parts = trimmed.split(".");
    const tld = parts[parts.length - 1];
    if (tld.length < 2) {
      return "routing.validation.invalidDomain";
    }
    return null;
  }

  // Everything else is invalid
  return "routing.validation.invalidFormat";
}

export function AddRuleInput({ action, geodataStatus, geodataCategories, onAdd }: AddRuleInputProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [dismissedForInput, setDismissedForInput] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);

  const autocompleteInfo = detectAutocomplete(input);

  // Show autocomplete when prefix is detected, but not if user dismissed it
  useEffect(() => {
    if (autocompleteInfo !== null && !dismissedForInput) {
      setTimeout(() => setShowAutocomplete(true), 0);
    } else if (autocompleteInfo === null) {
      setTimeout(() => {
        setShowAutocomplete(false);
        setDismissedForInput(false);
      }, 0);
    }
  }, [autocompleteInfo, dismissedForInput]);

  // Close autocomplete on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      // Don't close if clicking inside the portal dropdown
      const target = e.target as HTMLElement;
      if (target.closest("[data-geo-dropdown]")) return;
      if (inputContainerRef.current && !inputContainerRef.current.contains(target)) {
        setShowAutocomplete(false);
        setDismissedForInput(true);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const dismissAutocomplete = useCallback(() => {
    setShowAutocomplete(false);
    setDismissedForInput(true);
  }, []);

  const handleAdd = useCallback(
    (value?: string) => {
      const val = (value ?? input).trim();
      if (!val) return;

      // Validate input format
      const validationError = validateEntry(val);
      if (validationError) {
        setErrorMsg(t(validationError));
        setTimeout(() => setErrorMsg(""), 3000);
        return;
      }

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
      setDismissedForInput(false);
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

  const handleClear = useCallback(() => {
    setInput("");
    setShowAutocomplete(false);
    setDismissedForInput(false);
    setErrorMsg("");
    inputRef.current?.focus();
  }, []);

  // Reopen autocomplete when user types more after dismissing
  const handleInputChange = useCallback((val: string) => {
    setInput(val);
    setDismissedForInput(false);
  }, []);

  // Calculate dropdown position — width matches input field only
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (showAutocomplete && inputContainerRef.current) {
      const rect = inputContainerRef.current.getBoundingClientRect();
      // Clamp: don't let dropdown extend under the sidebar (≈56px)
      const sidebarWidth = 56;
      const left = Math.max(rect.left, sidebarWidth);
      const width = rect.width - Math.max(0, sidebarWidth - rect.left);
      setDropdownPos({ top: rect.bottom + 4, left, width: Math.max(width, 200) });
    }
  }, [showAutocomplete, input]);

  return (
    <div className="relative mt-2">
      <div className="flex gap-2">
        <div ref={inputContainerRef} className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !showAutocomplete) {
                handleAdd();
              }
              if (e.key === "Escape" && showAutocomplete) {
                e.preventDefault();
                dismissAutocomplete();
              }
            }}
            onFocus={() => {
              // Reopen if prefix is present
              if (autocompleteInfo && !showAutocomplete) {
                setDismissedForInput(false);
              }
            }}
            placeholder={t("routing.addRulePlaceholder")}
            className="w-full px-3 h-8 pr-8 rounded-[var(--radius-lg)] text-xs font-mono transition-colors outline-none focus-visible:shadow-[var(--focus-ring)] placeholder:opacity-40"
            style={{
              backgroundColor: "var(--color-input-bg)",
              border: `1px solid ${errorMsg ? "var(--color-danger-500)" : "var(--color-input-border)"}`,
              color: "var(--color-text-primary)",
            }}
          />
          {input && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-full transition-colors hover:bg-white/10"
              style={{ color: "var(--color-text-muted)" }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          onClick={() => handleAdd()}
          disabled={!input.trim()}
          className="px-3 py-2 rounded-[var(--radius-lg)] transition-colors disabled:opacity-40 disabled:cursor-default"
          style={{
            backgroundColor: "none",
            color: "var(--color-accent-400)",
          }}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {errorMsg && (
        <p className="text-xs mt-1" style={{ color: "var(--color-danger-400)" }}>
          {errorMsg}
        </p>
      )}

      {showAutocomplete && autocompleteInfo && dropdownPos &&
        createPortal(
          <div
            data-geo-dropdown
            style={{
              position: "fixed",
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              zIndex: 40,
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
              onClose={dismissAutocomplete}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
