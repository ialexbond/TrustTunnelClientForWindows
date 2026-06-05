import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTomlConfigState } from "./useTomlConfigState";
import type { ConfigBundle, VpnConfigKnown } from "./types";
import { makeBundle } from "../../../test/fixtures";

// Mock @tauri-apps/api/core invoke
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock activity log to spy on calls (D-29 invariant proof)
const mockActivityLog = vi.fn();
vi.mock("../../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: mockActivityLog }),
}));

const SSH_PARAMS = { host: "test", port: "22", user: "u", password: "p" };
const EMPTY_DEFAULTS = {
  vpn: {},
  hosts: {},
  rules: {},
  credentials: {},
} as const;
const EMPTY_DISRUPT = {
  vpn: new Set<string>(),
  hosts: new Set<string>(),
  rules: new Set<string>(),
  credentials: new Set<string>(),
} as const;

// [Phase 3] Deduped from the inlined literal into the Wave-0 makeBundle()
// factory. This hook's literal used `typed: {}` and a 2-entry rules.toml (the
// second carries a Users-owned client_random_prefix the merge test relies on),
// so we recover that exact shape via overrides. Everything else — including the
// D-29 probe secret TOPSECRET123 — matches the factory defaults byte-for-byte.
const MOCK_BUNDLE: ConfigBundle = makeBundle({
  typed: {} as unknown as VpnConfigKnown,
  rulesToml: `[[rule]]\ncidr = "10.0.0.0/8"\naction = "allow"\n[[rule]]\nclient_random_prefix = "abc"\naction = "allow"\n`,
});

describe("useTomlConfigState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
  });

  it("loads bundle via single server_get_config_bundle invoke (Pitfall 4)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    const { result } = renderHook(() =>
      useTomlConfigState(SSH_PARAMS, {
        defaultsMaps: EMPTY_DEFAULTS,
        disruptSets: EMPTY_DISRUPT,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockInvoke).toHaveBeenCalledWith(
      "server_get_config_bundle",
      expect.objectContaining(SSH_PARAMS),
    );
    // Only 1 invoke на mount (single channel invariant)
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(result.current.bundle).toEqual(MOCK_BUNDLE);
  });

  it("activity.log NEVER receives raw credentials.toml content (D-29)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    const { result } = renderHook(() =>
      useTomlConfigState(SSH_PARAMS, {
        defaultsMaps: EMPTY_DEFAULTS,
        disruptSets: EMPTY_DISRUPT,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Walk all activity log calls — ensure password substring NEVER appears
    for (const call of mockActivityLog.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") {
          expect(arg).not.toContain("TOPSECRET123");
        }
      }
    }
  });

  it("rules.toml save: pre-merge preserves Users-owned client_random_prefix entries (REQ-15.8)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE); // initial load
    const { result } = renderHook(() =>
      useTomlConfigState(SSH_PARAMS, {
        defaultsMaps: EMPTY_DEFAULTS,
        disruptSets: EMPTY_DISRUPT,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Simulate user adds new cidr-based rule → dirty
    act(() => {
      result.current.setFieldValue("rules", ["rule"], [
        { cidr: "192.168.1.0/24", action: "deny" },
        { client_random_prefix: "abc", action: "allow" }, // Users-owned (preserved)
      ]);
    });

    // Save: mock fresh-read + save invoke + restart
    mockInvoke
      .mockResolvedValueOnce(MOCK_BUNDLE) // fresh re-read для rules merge
      .mockResolvedValueOnce(undefined) // save_config_file
      .mockResolvedValueOnce(undefined) // server_restart_service
      .mockResolvedValueOnce(MOCK_BUNDLE); // post-save reload

    await act(async () => {
      await result.current.saveAll();
    });

    // Verify save_config_file was invoked with rawContent containing both Users + new Config rules
    const saveCall = mockInvoke.mock.calls.find(
      (call) =>
        call[0] === "server_save_config_file" &&
        (call[1] as { fileName?: string })?.fileName === "rules",
    );
    expect(saveCall).toBeDefined();
    const rawContent = (saveCall![1] as { rawContent: string }).rawContent;
    expect(rawContent).toContain("client_random_prefix"); // Users-owned preserved
    expect(rawContent).toContain("192.168.1.0/24"); // new Config-owned
  });

  it("WR-03 cancelledRef guards stale invoke result (no post-unmount state warning)", async () => {
    // [Phase 3 FG-4] Previously ended in `expect(true).toBe(true)` (WR-03
    // tautology) — a green that proved nothing. The real invariant: when the
    // initial-load invoke resolves AFTER unmount, the cancelled ref must
    // short-circuit the state setters so React never logs the
    // "Can't perform a React state update on an unmounted component" warning.
    // We spy on console.error and assert it is NEVER called with that warning.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      let resolveLoad: (value: ConfigBundle) => void = () => {};
      mockInvoke.mockImplementationOnce(
        () =>
          new Promise<ConfigBundle>((resolve) => {
            resolveLoad = resolve;
          }),
      );
      const { unmount } = renderHook(() =>
        useTomlConfigState(SSH_PARAMS, {
          defaultsMaps: EMPTY_DEFAULTS,
          disruptSets: EMPTY_DISRUPT,
        }),
      );
      // Unmount before the invoke resolves.
      unmount();
      // Resolve invoke now — the cancelled ref must drop the result.
      await act(async () => {
        resolveLoad(MOCK_BUNDLE);
        await Promise.resolve();
      });

      // No React unmounted-state-update warning was emitted.
      const sawUnmountWarning = consoleErrorSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("state update on an unmounted component"),
        ),
      );
      expect(sawUnmountWarning).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("save batch stop-on-first-failure (D-8.1)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE); // initial load
    const { result } = renderHook(() =>
      useTomlConfigState(SSH_PARAMS, {
        defaultsMaps: EMPTY_DEFAULTS,
        disruptSets: EMPTY_DISRUPT,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Edit vpn + hosts (2 dirty files)
    act(() => {
      result.current.setFieldValue("vpn", ["listen_address"], "0.0.0.0:8443");
      result.current.setFieldValue(
        "hosts",
        ["main_hosts", "0", "hostname"],
        "b.com",
      );
    });

    // First save (vpn) succeeds, second (hosts) fails
    mockInvoke
      .mockResolvedValueOnce(undefined) // vpn save OK
      .mockRejectedValueOnce(new Error("WRITE_FAILED")); // hosts save fails

    let saveResult: {
      success: boolean;
      failedFile?: string;
      savedFiles: string[];
    } | null = null;
    await act(async () => {
      saveResult = await result.current.saveAll();
    });

    expect(saveResult!.success).toBe(false);
    expect(saveResult!.savedFiles.length).toBe(1);
    // Service restart NEVER called when partial failure
    const restartCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "server_restart_service",
    );
    expect(restartCalls.length).toBe(0);
  });

  it("discardAll resets dirty fields", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    const { result } = renderHook(() =>
      useTomlConfigState(SSH_PARAMS, {
        defaultsMaps: EMPTY_DEFAULTS,
        disruptSets: EMPTY_DISRUPT,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFieldValue("vpn", ["listen_address"], "0.0.0.0:8443");
    });
    expect(result.current.dirtyCount).toBe(1);

    act(() => {
      result.current.discardAll();
    });
    expect(result.current.dirtyCount).toBe(0);
  });

  it("D-2.1: setFieldValue early-returns for credentials (read-only guard)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    const { result } = renderHook(() =>
      useTomlConfigState(SSH_PARAMS, {
        defaultsMaps: EMPTY_DEFAULTS,
        disruptSets: EMPTY_DISRUPT,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFieldValue(
        "credentials",
        ["client", "0", "password"],
        "NEWPASS",
      );
    });
    // Dirty count must remain 0 — credentials writes ignored at type-guard layer
    expect(result.current.dirtyCount).toBe(0);
  });

  it("D-6.1: buildSchemaFromBundle Pass 2 — defaults-only fields appear with isExplicit=false", async () => {
    // Inject defaults map с полем "y" не присутствующим в parsed bundle
    const DEFAULTS_WITH_Y = {
      vpn: { listen_address: "0.0.0.0:443", y: 2 } as Record<string, unknown>,
      hosts: {} as Record<string, unknown>,
      rules: {} as Record<string, unknown>,
      credentials: {} as Record<string, unknown>,
    };
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    const { result } = renderHook(() =>
      useTomlConfigState(SSH_PARAMS, {
        defaultsMaps: DEFAULTS_WITH_Y,
        disruptSets: EMPTY_DISRUPT,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const vpnTree = result.current.trees!.vpn;
    // "listen_address" present in parsed → isExplicit=true
    const explicit = vpnTree.flatMap.get("listen_address");
    expect(explicit).toBeDefined();
    expect(explicit!.isExplicit).toBe(true);
    // "y" present only in defaults → synthetic schema isExplicit=false (D-6.1)
    const defaultOnly = vpnTree.flatMap.get("y");
    expect(defaultOnly).toBeDefined();
    expect(defaultOnly!.isExplicit).toBe(false);
  });
});
