import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useServerGeoIp, type GeoIpInfo } from "./useServerGeoIp";

const mockInvoke = vi.mocked(invoke) as unknown as Mock;

const mockGeo: GeoIpInfo = {
  country: "United States",
  country_code: "US",
  flag_emoji: "🇺🇸",
};

const CACHE_KEY = "tt_geoip_10.0.0.1";

describe("useServerGeoIp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // ─── D-06: Cache hit ───
  it("cache hit: does not call invoke when cached and not expired", () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        ...mockGeo,
        fetched_at: new Date().toISOString(), // fresh
      }),
    );

    const { result } = renderHook(() =>
      useServerGeoIp({ host: "10.0.0.1" }),
    );

    expect(result.current.geo).toEqual(mockGeo);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ─── D-06: Cache miss → invoke + save ───
  it("cache miss: invokes get_server_geoip and saves to localStorage with fetched_at", async () => {
    mockInvoke.mockResolvedValue(mockGeo as never);

    const { result } = renderHook(() =>
      useServerGeoIp({ host: "10.0.0.1" }),
    );

    await vi.waitFor(() => {
      expect(result.current.geo).toEqual(mockGeo);
    });

    expect(mockInvoke).toHaveBeenCalledWith("get_server_geoip", {
      host: "10.0.0.1",
    });

    const stored = localStorage.getItem(CACHE_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as GeoIpInfo & { fetched_at: string };
    expect(parsed.country).toBe("United States");
    expect(parsed.country_code).toBe("US");
    expect(parsed.flag_emoji).toBe("🇺🇸");
    expect(parsed.fetched_at).toBeTruthy();
    // fetched_at должен парситься как валидная ISO-дата
    expect(Number.isNaN(new Date(parsed.fetched_at).getTime())).toBe(false);
  });

  // ─── D-06: Cache expired (>30 days) → re-fetch ───
  it("cache expired (>30 days): re-fetches and updates", async () => {
    const oldDate = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 день назад
    ).toISOString();
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        country: "Germany",
        country_code: "DE",
        flag_emoji: "🇩🇪",
        fetched_at: oldDate,
      }),
    );
    mockInvoke.mockResolvedValue(mockGeo as never);

    const { result } = renderHook(() =>
      useServerGeoIp({ host: "10.0.0.1" }),
    );

    await vi.waitFor(() => {
      expect(result.current.geo).toEqual(mockGeo);
    });

    expect(mockInvoke).toHaveBeenCalled();
    // Новый cache с fresh fetched_at:
    const stored = localStorage.getItem(CACHE_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as GeoIpInfo & { fetched_at: string };
    const ageMs = Date.now() - new Date(parsed.fetched_at).getTime();
    expect(ageMs).toBeLessThan(5_000); // только что записано
  });

  // ─── D-14: Partial data on invoke error ───
  it("returns null geo on invoke error, sets error string", async () => {
    mockInvoke.mockRejectedValue("GEOIP_TIMEOUT");

    const { result } = renderHook(() =>
      useServerGeoIp({ host: "10.0.0.1" }),
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.geo).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(String(result.current.error)).toContain("GEOIP_TIMEOUT");
  });

  // ─── Pitfall 5: Corrupt JSON в localStorage ───
  it("corrupt localStorage JSON is treated as cache miss (refetches)", async () => {
    localStorage.setItem(CACHE_KEY, "not-valid-json{");
    mockInvoke.mockResolvedValue(mockGeo as never);

    const { result } = renderHook(() =>
      useServerGeoIp({ host: "10.0.0.1" }),
    );

    await vi.waitFor(() => {
      expect(result.current.geo).toEqual(mockGeo);
    });

    expect(mockInvoke).toHaveBeenCalled();
  });
});
