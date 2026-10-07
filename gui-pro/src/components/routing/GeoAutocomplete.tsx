import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Globe, FileText, Folder, Download } from "lucide-react";

interface GeoAutocompleteProps {
  prefix: "geoip" | "geosite" | "iplist_group";
  query: string;
  categories: string[];
  downloaded: boolean;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export function GeoAutocomplete({
  prefix,
  query,
  categories,
  downloaded,
  onSelect,
  onClose,
}: GeoAutocompleteProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Sort alphabetically + smart word-boundary search
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const sorted = [...categories].sort((a, b) => a.localeCompare(b));
    if (!q) return sorted.slice(0, 50);

    return sorted.filter((cat) => cat.toLowerCase().startsWith(q)).slice(0, 50);
  }, [categories, query]);

  // D-18: mirrors of the latest props/state that `handleKeyDown`'s Enter branch reads instead of
  // its own closure — even if a STALE `handleKeyDown` (bound to a PREVIOUS render's `filtered`)
  // is still attached to `document` because the effect that re-attaches it on every render has
  // not run yet, it reads these refs, which are current. useLayoutEffect (not a render-body
  // assignment — refs must not be written during render, react-hooks/refs) runs synchronously
  // right after commit and BEFORE the passive `handleKeyDown`-reattach effect below (layout
  // effects always run before passive effects in the same commit), so the refs are never behind
  // the listener. Without this, a keydown landing in that window reads the previous query's list
  // (the likely `uk` -> `ua` mechanism).
  const queryRef = useRef(query);
  const categoriesRef = useRef(categories);
  const filteredRef = useRef(filtered);
  const prefixRef = useRef(prefix);
  const activeIndexRef = useRef(activeIndex);
  useLayoutEffect(() => {
    queryRef.current = query;
    categoriesRef.current = categories;
    filteredRef.current = filtered;
    prefixRef.current = prefix;
    activeIndexRef.current = activeIndex;
  });

  // D-18: an ArrowUp/ArrowDown pick is the person's EXPLICIT choice and beats the exact-typed-
  // value rule below; but it must not survive past the keystroke that made it. The dependency
  // array does the "did the query change" check; useLayoutEffect (not a setTimeout) resets it
  // synchronously, before any keydown the browser could dispatch next.
  const navigatedRef = useRef(false);
  useLayoutEffect(() => {
    navigatedRef.current = false;
  }, [query]);

  // Reset index when query changes
  useEffect(() => {
    setTimeout(() => setActiveIndex(0), 0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[activeIndex] as HTMLElement;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        navigatedRef.current = true;
        // IN-02 (03-REVIEW.md): clamp at 0 — if `filtered` is empty at this moment,
        // `filteredRef.current.length - 1` is -1, and without the outer Math.max(0, …) a
        // later change to `categories`/`downloaded` (without `query` changing, so the
        // query-keyed reset effect below never fires) that makes `filtered` non-empty again
        // would leave activeIndex stuck at -1.
        setActiveIndex((prev) => Math.max(0, Math.min(prev + 1, filteredRef.current.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        navigatedRef.current = true;
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        // D-18: the exact typed value beats the automatic highlight; an explicit arrow choice
        // made after the last keystroke beats the typed value. Always reads the refs above —
        // never the `filtered`/`activeIndex`/`prefix` this closure captured at creation time.
        const currentQuery = queryRef.current;
        const currentFiltered = filteredRef.current;
        let valueToSelect: string | undefined;
        if (currentQuery !== "" && !navigatedRef.current) {
          valueToSelect = categoriesRef.current.find(
            (c) => c.toLowerCase() === currentQuery.toLowerCase()
          );
        }
        if (valueToSelect === undefined && currentFiltered.length > 0) {
          // IN-02 (03-REVIEW.md): clamp at 0 too — belt-and-braces with the ArrowDown clamp
          // above, in case activeIndex ever reaches this read while still negative.
          const idx = Math.max(0, Math.min(activeIndexRef.current, currentFiltered.length - 1));
          valueToSelect = currentFiltered[idx];
        }
        if (valueToSelect !== undefined) {
          e.preventDefault();
          onSelect(`${prefixRef.current}:${valueToSelect}`);
          onClose();
        }
        // else: no exact match and nothing filtered — leave Enter to the input, as today.
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [onSelect, onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // geoip → Globe (countries), geosite → FileText (site categories), iplist_group → Folder
  // (a named group of sites, D-03). Lucide-only, soft style; color stays neutral via token.
  const Icon = prefix === "geoip" ? Globe : prefix === "iplist_group" ? Folder : FileText;

  if (!downloaded) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border shadow-xl overflow-hidden"
        style={{
          backgroundColor: "var(--color-bg-elevated)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <Download className="w-4 h-4" style={{ color: "var(--color-warning-fg)" }} />
          <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {t("routing.downloadGeoDataFirst")}
          </span>
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border shadow-xl overflow-hidden"
        style={{
          backgroundColor: "var(--color-bg-elevated)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="px-4 py-3">
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("routing.noMatchingCategories")}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="rounded-[var(--radius-lg)] border shadow-xl overflow-y-auto"
      style={{
        backgroundColor: "var(--color-bg-elevated)",
        borderColor: "var(--color-border)",
        maxHeight: "280px",
      }}
    >
      {filtered.map((cat, idx) => (
        <div
          key={cat}
          role="option"
          aria-selected={idx === activeIndex}
          className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer select-none transition-colors"
          style={{
            backgroundColor: idx === activeIndex ? "var(--color-bg-hover)" : "transparent",
            color: "var(--color-text-primary)",
          }}
          onMouseEnter={() => setActiveIndex(idx)}
          onMouseDown={(e) => {
            // Use mousedown instead of click to fire before input blur
            e.preventDefault();
            e.stopPropagation();
            onSelect(`${prefix}:${cat}`);
            onClose();
          }}
        >
          <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--color-text-muted)" }} />
          <span className="text-xs font-mono truncate">{cat}</span>
        </div>
      ))}
    </div>
  );
}
