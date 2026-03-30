import { useTranslation } from "react-i18next";
import { Upload, Download } from "lucide-react";
import { Card, Button } from "../../shared/ui";

interface ExportImportButtonsProps {
  onExport: () => Promise<void>;
  onImport: () => Promise<void>;
  disabled?: boolean;
}

export function ExportImportButtons({
  onExport,
  onImport,
  disabled,
}: ExportImportButtonsProps) {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download className="w-3.5 h-3.5" />}
          onClick={onExport}
          disabled={disabled}
        >
          {t("routing.export")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload className="w-3.5 h-3.5" />}
          onClick={onImport}
          disabled={disabled}
        >
          {t("routing.import")}
        </Button>
      </div>
    </Card>
  );
}
