import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { GeoDataStatusCard } from "./GeoDataStatus";
import type { GeoDataStatus } from "./useRoutingState";

function makeStatus(overrides: Partial<GeoDataStatus> = {}): GeoDataStatus {
  return {
    downloaded: false,
    geoip_exists: false,
    geosite_exists: false,
    geoip_categories_count: 0,
    geosite_categories_count: 0,
    ...overrides,
  };
}

describe("GeoDataStatusCard", () => {
  let onDownload: any;

  beforeEach(() => {
    vi.useFakeTimers();
    i18n.changeLanguage("ru");
    onDownload = vi.fn().mockResolvedValue(undefined);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders without crashing", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText("Геоданные")).toBeInTheDocument();
  });

  it("shows description text", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText(/GeoIP и GeoSite базы/)).toBeInTheDocument();
  });

  it("shows 'Не загружено' badge when not downloaded", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText("Не загружено")).toBeInTheDocument();
  });

  it("shows download button when not downloaded", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText("Скачать геоданные")).toBeInTheDocument();
  });

  it("calls onDownload when download button is clicked", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    fireEvent.click(screen.getByText("Скачать геоданные"));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("shows 'Загружено' badge when downloaded", () => {
    render(
      <GeoDataStatusCard
        status={makeStatus({ downloaded: true, geoip_exists: true, geosite_exists: true })}
        downloading={false}
        onDownload={onDownload}
      />,
    );
    expect(screen.getByText("Загружено")).toBeInTheDocument();
  });

  it("shows GeoIP and GeoSite labels", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText("GeoIP")).toBeInTheDocument();
    expect(screen.getByText("GeoSite")).toBeInTheDocument();
  });

  it("shows category counts when available", () => {
    render(
      <GeoDataStatusCard
        status={makeStatus({
          downloaded: true,
          geoip_exists: true,
          geosite_exists: true,
          geoip_categories_count: 42,
          geosite_categories_count: 100,
        })}
        downloading={false}
        onDownload={onDownload}
      />,
    );
    expect(screen.getByText("(42)")).toBeInTheDocument();
    expect(screen.getByText("(100)")).toBeInTheDocument();
  });

  it("shows loading state when downloading", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={true} onDownload={onDownload} />);
    expect(screen.getByText("Загрузка...")).toBeInTheDocument();
  });

  it("download button is disabled during downloading", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={true} onDownload={onDownload} />);
    const btn = screen.getByText("Загрузка...").closest("button");
    expect(btn).toBeDisabled();
  });

  it("shows release tag formatted as date", () => {
    render(
      <GeoDataStatusCard
        status={makeStatus({
          downloaded: true,
          geoip_exists: true,
          geosite_exists: true,
          release_tag: "202603260521",
        })}
        downloading={false}
        onDownload={onDownload}
      />,
    );
    expect(screen.getByText("v26.03.2026")).toBeInTheDocument();
  });
});
