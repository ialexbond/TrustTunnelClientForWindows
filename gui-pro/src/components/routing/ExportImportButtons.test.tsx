import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { ExportImportButtons } from "./ExportImportButtons";

describe("ExportImportButtons", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onExport: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onImport: any;

  // The component reshaped to icon-only IconButtons (Phase-21 port). Buttons carry no text —
  // query by their aria-label (routing.exportRules / routing.importRules) instead of text labels.
  const exportName = "Экспорт маршрутизации";
  const importName = "Импорт маршрутизации";

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onExport = vi.fn().mockResolvedValue(undefined);
    onImport = vi.fn().mockResolvedValue(undefined);
  });

  it("renders without crashing", () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} />);
    expect(screen.getByRole("button", { name: exportName })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: importName })).toBeInTheDocument();
  });

  it("calls onExport when export button is clicked", async () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} />);
    await userEvent.click(screen.getByRole("button", { name: exportName }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("calls onImport when import button is clicked", async () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} />);
    await userEvent.click(screen.getByRole("button", { name: importName }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons when disabled prop is true", () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} disabled />);
    expect(screen.getByRole("button", { name: exportName })).toBeDisabled();
    expect(screen.getByRole("button", { name: importName })).toBeDisabled();
  });

  it("buttons are enabled by default", () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} />);
    expect(screen.getByRole("button", { name: exportName })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: importName })).not.toBeDisabled();
  });

  it("does not call handlers when disabled", async () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} disabled />);
    await userEvent.click(screen.getByRole("button", { name: exportName }));
    await userEvent.click(screen.getByRole("button", { name: importName }));
    expect(onExport).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });
});
