import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Input } from "../../shared/ui/Input";
import { IconButton } from "../../shared/ui/IconButton";
import { GeoAutocomplete } from "./GeoAutocomplete";
import type { RouteAction, GeoDataIndex, GeoDataStatus, IplistGroup } from "./useRoutingState";

interface AddRuleInputProps {
  action: RouteAction;
  geodataStatus: GeoDataStatus;
  geodataCategories: GeoDataIndex;
  // D-03: the available iplist groups feed the `iplist_group:` autocomplete AND are the whitelist
  // validateEntry checks a typed id against (Security V5). Optional so blocks that don't wire it
  // (or tests) still render; an empty list simply rejects every iplist_group id.
  iplistGroups?: IplistGroup[];
  onAdd: (action: RouteAction, value: string) => string | null;
  // Pitfall #2: after a group is added, fetch its domains to cache so it resolves to real traffic.
  // Optional — the Wave-0 contract test asserts the add path without wiring this.
  onEnsureGroupCache?: (groupId: string) => void | Promise<void>;
}

function detectAutocomplete(
  value: string,
): { prefix: "geoip" | "geosite" | "iplist_group"; query: string } | null {
  const lower = value.toLowerCase();
  if (lower.startsWith("geoip:")) {
    return { prefix: "geoip", query: value.slice(6) };
  }
  if (lower.startsWith("geosite:")) {
    return { prefix: "geosite", query: value.slice(8) };
  }
  // "iplist_group:".length === 13 — the query is the id typed after the prefix (D-03).
  if (lower.startsWith("iplist_group:")) {
    return { prefix: "iplist_group", query: value.slice(13) };
  }
  return null;
}

/** Validate user input — returns error i18n key or null if valid. `groupIds` is the iplist-group
 *  whitelist (Security V5): a typed `iplist_group:<id>` is accepted ONLY when the id is in it. */
function validateEntry(value: string, groupIds: string[]): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // iplist_group:<id> — whitelist against the known group ids (T-22-01). An unknown or
  // traversal id (e.g. `iplist_group:../etc`) is REJECTED here before it can become a rule;
  // this is the frontend suspenders to the backend is_valid_group_id belt.
  const groupMatch = trimmed.match(/^iplist_group:(.*)$/i);
  if (groupMatch) {
    return groupIds.includes(groupMatch[1]) ? null : "routing.validation.invalidGroup";
  }

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

export function AddRuleInput({
  action,
  geodataStatus,
  geodataCategories,
  iplistGroups = [],
  onAdd,
  onEnsureGroupCache,
}: AddRuleInputProps) {
  const { t } = useTranslation();
  // Stable reference so it can sit in handleAdd's dep array without recreating it every render.
  const groupIds = useMemo(() => iplistGroups.map((g) => g.id), [iplistGroups]);
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

  // Close the portaled autocomplete when the main tab changes. The geo dropdown is a fixed
  // createPortal on document.body and the tab panels are hidden-not-unmounted (App.tsx IN-11), so
  // hiding the Routing panel does NOT tear it down. A mouse click on the tab bar happens to fire the
  // outside-mousedown above, but keyboard (Ctrl+1..5) / tray / deep-link navigation emit no such DOM
  // event — the dropdown would then float over the newly shown tab. App dispatches `app:tabchange`
  // on every activeTab change (all nav channels funnel through setActiveTab); run the same reset here.
  useEffect(() => {
    function closeOnTabChange() {
      setShowAutocomplete(false);
      setDismissedForInput(true);
    }
    window.addEventListener("app:tabchange", closeOnTabChange);
    return () => window.removeEventListener("app:tabchange", closeOnTabChange);
  }, []);

  const dismissAutocomplete = useCallback(() => {
    setShowAutocomplete(false);
    setDismissedForInput(true);
  }, []);

  const handleAdd = useCallback(
    (value?: string) => {
      const val = (value ?? input).trim();
      if (!val) return;

      // Validate input format (iplist_group ids are whitelisted against the passed group set)
      const validationError = validateEntry(val, groupIds);
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

      // Pitfall #2: a freshly-added iplist group must be fetched to cache so it resolves to real
      // domains instead of silently routing nothing. The id was already whitelisted above.
      const addedGroup = val.match(/^iplist_group:(.+)$/i);
      if (addedGroup && onEnsureGroupCache) {
        onEnsureGroupCache(addedGroup[1]);
      }

      setInput("");
      setShowAutocomplete(false);
      setDismissedForInput(false);
      setErrorMsg("");
      inputRef.current?.focus();
    },
    [input, action, onAdd, t, groupIds, onEnsureGroupCache]
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
      // Anchor the dropdown flush to the input box: same left edge, same width. The old
      // "sidebar clamp" (force left ≥ 56, shrink width by 56 − rect.left) was written for a
      // pre-v3 layout where a ~56px left sidebar could overlap a viewport-fixed dropdown. The
      // v3 Routing tab is a centered max-w-1000 / mx-auto / px-4 column with NO left sidebar, so
      // on the narrow windows this client runs at rect.left is only ~16px < 56 — the clamp then
      // inset the dropdown right and narrowed it, so it no longer matched the field. inputContainerRef
      // sits on the flex-1 wrapper of the w-full Input, so rect IS the visible field box.
      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, [showAutocomplete, input]);

  return (
    <div className="relative mt-2">
      <div className="flex gap-2">
        {/* Explicit wrapper ref MUST stay OUTSIDE the shared Input (on this div, not the inner
            <input>): the createPortal geo-dropdown positions off inputContainerRef.getBoundingClientRect()
            and the outside-click guard checks inputContainerRef.contains(target). Input wraps its field in
            its own <div class="w-full"><div class="relative">…</div></div>, so anchoring the ref here keeps
            the box == the field box (portal position + contains()) exactly as before the primitive swap. */}
        <div ref={inputContainerRef} className="relative flex-1">
          <Input
            ref={inputRef}
            fullWidth
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showAutocomplete}
            value={input}
            placeholder={t("routing.addRulePlaceholder")}
            // Input.clearable replaces the hand-rolled X. Its built-in clear fires onChange("");
            // we route the empty-value onChange through handleClear so the SAME full reset runs
            // (input + showAutocomplete + dismissedForInput + errorMsg + refocus) as the old clear button.
            clearable
            // Input.error draws the single danger border + FieldError message. Do NOT also add a manual
            // red border/`<p>` — that stacks two borders. The 3s auto-clear timer stays in handleAdd.
            error={errorMsg || undefined}
            onChange={(e) => {
              const val = e.target.value;
              if (val === "") {
                handleClear();
              } else {
                handleInputChange(val);
              }
            }}
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
          />
        </div>
        <IconButton
          aria-label={t("routing.addRule")}
          tooltip={t("routing.addRule")}
          className="shrink-0 border"
          disabled={!input.trim()}
          icon={<Plus className="w-4 h-4" />}
          onClick={() => handleAdd()}
        />
      </div>

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
                  : autocompleteInfo.prefix === "geosite"
                    ? geodataCategories.geosite
                    : groupIds
              }
              // iplist_group ids come from the backend list (get_iplist_groups), not geodata files,
              // so the group dropdown must NOT be gated behind the geodata "downloaded" flag.
              downloaded={
                autocompleteInfo.prefix === "iplist_group" ? true : geodataStatus.downloaded
              }
              onSelect={handleGeoSelect}
              onClose={dismissAutocomplete}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
