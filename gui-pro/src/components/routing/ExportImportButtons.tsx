import { useTranslation } from "react-i18next";
import { Upload, Download } from "lucide-react";
import { IconButton } from "../../shared/ui";

interface ExportImportButtonsProps {
  onExport: () => Promise<void>;
  onImport: () => Promise<void>;
  disabled?: boolean;
}

// Canon icon-only export/import strip (Phase-20 flagship parity). Reshaped from the old
// Card + text-Button form: two transparent, token-driven IconButtons that live in RoutingPanel's
// bottom strip. Upload = export, Download = import (the pre-port component had these SWAPPED).
// The onExport/onImport handlers (state.exportRules / state.importRules) are FUNCTIONAL — they do
// real file export/import through the export_routing_rules / import_routing_rules backend commands
// (import shares the 64 KiB cap + localized errors from IN-57). Phase 21's D-03 premise that these
// were "no-op / inert" was mistaken: export/import already worked. This phase reshaped the LOOK
// only — it did not wire or unwire any behavior. Tooltips/aria-labels come from the
// routing.exportRules / routing.importRules i18n keys (added in plan 21-01).
export function ExportImportButtons({
  onExport,
  onImport,
  disabled,
}: ExportImportButtonsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex gap-2">
      <IconButton
        aria-label={t("routing.exportRules")}
        tooltip={t("routing.exportRules")}
        icon={<Upload className="w-3.5 h-3.5" />}
        onClick={onExport}
        disabled={disabled}
        className="border"
      />
      <IconButton
        aria-label={t("routing.importRules")}
        tooltip={t("routing.importRules")}
        icon={<Download className="w-3.5 h-3.5" />}
        onClick={onImport}
        disabled={disabled}
        className="border"
      />
    </div>
  );
}
