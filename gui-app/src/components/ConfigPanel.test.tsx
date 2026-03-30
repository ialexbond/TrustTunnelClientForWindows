import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import ConfigPanel from "./ConfigPanel";
import type { VpnConfig } from "../shared/types";

describe("ConfigPanel", () => {
  const defaultConfig: VpnConfig = {
    configPath: "/test/config.toml",
    logLevel: "info",
  };
  const onConfigChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders section title", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    expect(screen.getByText("Настройки")).toBeInTheDocument();
  });

  it("renders config path input with current value", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    const input = screen.getByPlaceholderText("trusttunnel_client.toml");
    expect(input).toHaveValue("/test/config.toml");
  });

  it("calls onConfigChange when config path input changes", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    const input = screen.getByPlaceholderText("trusttunnel_client.toml");
    fireEvent.change(input, { target: { value: "/new/path.toml" } });
    expect(onConfigChange).toHaveBeenCalledWith({
      ...defaultConfig,
      configPath: "/new/path.toml",
    });
  });

  it("renders log level select with current value", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    const select = screen.getByDisplayValue("INFO");
    expect(select).toBeInTheDocument();
  });

  it("renders all log level options", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(5);
    expect(options.map((o) => o.textContent)).toEqual([
      "ERROR",
      "WARN",
      "INFO",
      "DEBUG",
      "TRACE",
    ]);
  });

  it("calls onConfigChange when log level changes", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    const select = screen.getByDisplayValue("INFO");
    fireEvent.change(select, { target: { value: "debug" } });
    expect(onConfigChange).toHaveBeenCalledWith({
      ...defaultConfig,
      logLevel: "debug",
    });
  });

  it("renders file labels", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    expect(screen.getByText("Файл конфигурации")).toBeInTheDocument();
    expect(screen.getByText("Уровень логирования")).toBeInTheDocument();
  });

  it("renders sidecar info text", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    expect(
      screen.getByText("Sidecar: trusttunnel_client • TOML")
    ).toBeInTheDocument();
  });

  it("renders browse button with title", () => {
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    expect(screen.getByTitle("Выбрать файл")).toBeInTheDocument();
  });

  it("opens file dialog when browse button clicked", async () => {
    vi.mocked(open).mockResolvedValue(null);
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    fireEvent.click(screen.getByTitle("Выбрать файл"));
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith({
        multiple: false,
        filters: [{ name: "TOML Config", extensions: ["toml"] }],
      });
    });
  });

  it("updates config path when file selected from dialog", async () => {
    vi.mocked(open).mockResolvedValue("/selected/file.toml");
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    fireEvent.click(screen.getByTitle("Выбрать файл"));
    await waitFor(() => {
      expect(onConfigChange).toHaveBeenCalledWith({
        ...defaultConfig,
        configPath: "/selected/file.toml",
      });
    });
  });

  it("does not update config when file dialog cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    render(
      <ConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />
    );
    fireEvent.click(screen.getByTitle("Выбрать файл"));
    await waitFor(() => {
      expect(open).toHaveBeenCalled();
    });
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("renders with empty config path", () => {
    render(
      <ConfigPanel
        config={{ configPath: "", logLevel: "info" }}
        onConfigChange={onConfigChange}
      />
    );
    const input = screen.getByPlaceholderText("trusttunnel_client.toml");
    expect(input).toHaveValue("");
  });

  it("renders with different log levels", () => {
    for (const level of ["error", "warn", "debug", "trace"]) {
      const { unmount } = render(
        <ConfigPanel
          config={{ configPath: "", logLevel: level }}
          onConfigChange={onConfigChange}
        />
      );
      expect(screen.getByDisplayValue(level.toUpperCase())).toBeInTheDocument();
      unmount();
    }
  });
});
