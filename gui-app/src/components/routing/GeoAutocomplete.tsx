import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Globe, FileText, Download } from "lucide-react";

interface GeoAutocompleteProps {
  prefix: "geoip" | "geosite";
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

  // Reset index when query changes
  useEffect(() => {
    setActiveIndex(0);
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
        setActiveIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        onSelect(`${prefix}:${filtered[activeIndex]}`);
        onClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, activeIndex, onSelect, onClose, prefix]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const Icon = prefix === "geoip" ? Globe : FileText;

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
          <Download className="w-4 h-4" style={{ color: "var(--color-warning-400)" }} />
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
