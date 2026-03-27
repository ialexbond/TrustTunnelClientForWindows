import { useState, useCallback, useEffect } from "react";

// ═══════════════════════════════════════════════════════
// Feature Toggles — experimental features hidden behind
// Settings toggles. Persisted in localStorage.
// ═══════════════════════════════════════════════════════

const STORAGE_KEY = "tt_feature_toggles";

export interface FeatureToggles {
  /** Show "Block" routing section */
  blockRouting: boolean;
  /** Show "Process Filter" routing section */
  processFilter: boolean;
}

const DEFAULTS: FeatureToggles = {
  blockRouting: false,
  processFilter: false,
};

function load(): FeatureToggles {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(toggles: FeatureToggles) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toggles));
}

/**
 * Hook for reading / writing feature toggles.
 * Both SettingsPanel and RoutingPanel use this —
 * changes in Settings are picked up via a storage event listener.
 */
export function useFeatureToggles() {
  const [toggles, setToggles] = useState<FeatureToggles>(load);

  // Listen for changes from other components (same tab — custom event)
  useEffect(() => {
    const handler = () => setToggles(load());
    window.addEventListener("feature-toggles-changed", handler);
    return () => window.removeEventListener("feature-toggles-changed", handler);
  }, []);

  const update = useCallback((key: keyof FeatureToggles, value: boolean) => {
    setToggles((prev) => {
      const next = { ...prev, [key]: value };
      save(next);
      // Notify other hook instances in the same tab
      window.dispatchEvent(new Event("feature-toggles-changed"));
      return next;
    });
  }, []);

  return { toggles, update };
}
