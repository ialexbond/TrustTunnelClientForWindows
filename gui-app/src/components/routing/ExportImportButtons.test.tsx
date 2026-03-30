import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { ExportImportButtons } from "./ExportImportButtons";

describe("ExportImportButtons", () => {
  let onExport: ReturnType<typeof vi.fn>;
  let onImport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onExport = vi.fn().mockResolvedValue(undefined);
    onImport = vi.fn().mockResolvedValue(undefined);
  });

  it("renders without crashing", () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} />);
    expect(screen.getByText("Экспортировать")).toBeInTheDocument();
    expect(screen.getByText("Импортировать")).toBeInTheDocument();
  });

  it("calls onExport when export button is clicked", async () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} />);
    await userEvent.click(screen.getByText("Экспортировать"));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("calls onImport when import button is clicked", async () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} />);
    await userEvent.click(screen.getByText("Импортировать"));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons when disabled prop is true", () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} disabled />);
    const exportBtn = screen.getByText("Экспортировать").closest("button");
    const importBtn = screen.getByText("Импортировать").closest("button");
    expect(exportBtn).toBeDisabled();
    expect(importBtn).toBeDisabled();
  });

  it("buttons are enabled by default", () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} />);
    const exportBtn = screen.getByText("Экспортировать").closest("button");
    const importBtn = screen.getByText("Импортировать").closest("button");
    expect(exportBtn).not.toBeDisabled();
    expect(importBtn).not.toBeDisabled();
  });

  it("does not call handlers when disabled", async () => {
    render(<ExportImportButtons onExport={onExport} onImport={onImport} disabled />);
    await userEvent.click(screen.getByText("Экспортировать"));
    await userEvent.click(screen.getByText("Импортировать"));
    expect(onExport).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });
});
