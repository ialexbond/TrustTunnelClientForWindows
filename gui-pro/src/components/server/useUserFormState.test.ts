import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  useUserFormState,
  DEFAULT_DEEPLINK,
  type UseUserFormStateArgs,
} from "./useUserFormState";

// Phase 04 Plan 10 (PANEL-02 / D-04): characterization harness for the lifted
// form-state container hook. These tests pin the CURRENT observable behavior
// (typing updates state, validators gate canSubmit, dirty flag flips) so the
// VERBATIM extraction from UserModal is provably transparent. They do NOT assert
// the dirty-tracking BUGS Users H-01/H-02 — those are fixed regression-test-first
// in Plan 12 (Pitfall 2: never combine lift + fix).

const mockInvoke = vi.mocked(invoke) as unknown as Mock;

// Spy on the activity-log sink so we can assert no secret ever flows through it
// (D-29) and that the open event fires — without coupling to the real hook.
const activityLog = vi.fn();

const sshParams = {
  host: "1.2.3.4",
  port: 22,
  user: "root",
  password: "sshpass",
  keyPath: "",
};

function baseArgs(overrides?: Partial<UseUserFormStateArgs>): UseUserFormStateArgs {
  return {
    isOpen: true,
    mode: "add",
    editUsername: undefined,
    existingUsers: [],
    sshParams,
    activityLog,
    // _storybook=true skips the open-time server fetches so Add-mode tests stay
    // synchronous and don't depend on invoke ordering.
    _storybook: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(null);
  sessionStorage.clear();
});

describe("useUserFormState — open lifecycle (Add)", () => {
  it("logs a modal.opened USER event on open", () => {
    renderHook(() => useUserFormState(baseArgs()));
    expect(activityLog).toHaveBeenCalledWith("USER", "user.modal.opened mode=add");
  });

  it("auto-generates a username + password on a fresh Add open (no draft)", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    expect(result.current.username.length).toBeGreaterThan(0);
    expect(result.current.password.length).toBeGreaterThan(0);
    // Deeplink starts at defaults.
    expect(result.current.deeplink).toEqual(DEFAULT_DEEPLINK);
    expect(result.current.isEditMode).toBe(false);
  });

  it("composes serverId from the full host:port:user identity (C-03)", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    expect(result.current.serverId).toBe("1.2.3.4:22:root");
  });
});

describe("useUserFormState — typing updates state", () => {
  it("setUsername updates username and feeds the validator", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    act(() => result.current.setUsername("alice"));
    expect(result.current.username).toBe("alice");
    expect(result.current.localUsernameError).toBe("");
  });

  it("setPassword updates password and feeds the validator", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    act(() => result.current.setPassword("Str0ng-Pass!word"));
    expect(result.current.password).toBe("Str0ng-Pass!word");
    expect(result.current.localPasswordError).toBe("");
  });

  it("updateDeeplink patches a single field immutably", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    act(() => result.current.updateDeeplink("displayName", "Phone"));
    expect(result.current.deeplink.displayName).toBe("Phone");
    // Other fields untouched.
    expect(result.current.deeplink.antiDpi).toBe(DEFAULT_DEEPLINK.antiDpi);
  });
});

describe("useUserFormState — canSubmit gate (Add)", () => {
  it("gates submit on a valid username AND password", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    act(() => {
      result.current.setUsername("alice");
      result.current.setPassword("Str0ng-Pass!word");
    });
    expect(result.current.canSubmit).toBe(true);
  });

  it("blocks submit when the username is emptied", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    act(() => {
      result.current.setUsername("");
      result.current.setPassword("Str0ng-Pass!word");
    });
    expect(result.current.canSubmit).toBe(false);
  });

  it("blocks submit when a DNS error is reported", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    act(() => {
      result.current.setUsername("alice");
      result.current.setPassword("Str0ng-Pass!word");
      result.current.setDnsError(true);
    });
    expect(result.current.canSubmit).toBe(false);
  });

  it("blocks submit while a submit is in flight", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    act(() => {
      result.current.setUsername("alice");
      result.current.setPassword("Str0ng-Pass!word");
      result.current.setIsSubmitting(true);
    });
    expect(result.current.canSubmit).toBe(false);
  });
});

describe("useUserFormState — dirty tracking (Edit)", () => {
  it("isDeeplinkDirty is false at rest and flips when a field changes", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_config") return { client_random_prefix: null, cidr: null };
      if (cmd === "server_get_user_advanced") return null;
      return null;
    });
    const { result } = renderHook(() =>
      useUserFormState(baseArgs({ mode: "edit", editUsername: "bob", _storybook: false })),
    );
    // After the Edit load resolves, the snapshot is taken — not dirty yet.
    await waitFor(() => expect(result.current.configLoading).toBe(false));
    expect(result.current.isDeeplinkDirty).toBe(false);

    act(() => result.current.updateDeeplink("displayName", "Changed"));
    expect(result.current.isDeeplinkDirty).toBe(true);
  });

  it("Edit-mode submit needs an actual change (deeplink dirty or password rotation)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_config") return { client_random_prefix: null, cidr: null };
      if (cmd === "server_get_user_advanced") return null;
      return null;
    });
    const { result } = renderHook(() =>
      useUserFormState(baseArgs({ mode: "edit", editUsername: "bob", _storybook: false })),
    );
    await waitFor(() => expect(result.current.configLoading).toBe(false));
    // Nothing changed → cannot submit. (The loaded config has no
    // client_random_prefix, so antiDpi snapshots to false.)
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.deeplink.antiDpi).toBe(false);
    // Change a deeplink field to a genuinely different value → now submittable.
    act(() => result.current.updateDeeplink("antiDpi", true));
    expect(result.current.isDeeplinkDirty).toBe(true);
    expect(result.current.canSubmit).toBe(true);
  });

  it("opening the password rotator with an empty value blocks submit", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_config") return { client_random_prefix: null, cidr: null };
      if (cmd === "server_get_user_advanced") return null;
      return null;
    });
    const { result } = renderHook(() =>
      useUserFormState(baseArgs({ mode: "edit", editUsername: "bob", _storybook: false })),
    );
    await waitFor(() => expect(result.current.configLoading).toBe(false));
    act(() => result.current.setPasswordEditing(true));
    // Editor open, empty value → required error + blocked.
    expect(result.current.isPasswordDirty).toBe(false);
    expect(result.current.canSubmit).toBe(false);

    act(() => result.current.setNewPassword("Str0ng-Pass!word"));
    expect(result.current.isPasswordDirty).toBe(true);
    expect(result.current.canSubmit).toBe(true);
  });
});

describe("useUserFormState — D-29 secret safety", () => {
  it("never logs the password through the activity-log sink", () => {
    const { result } = renderHook(() => useUserFormState(baseArgs()));
    act(() => {
      result.current.setUsername("alice");
      result.current.setPassword("SuperSecret123!");
      result.current.updateDeeplink("displayName", "Phone");
    });
    for (const call of activityLog.mock.calls) {
      const joined = call.join(" ");
      expect(joined).not.toContain("SuperSecret123!");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 04 Plan 15 — dirty-tracking regression tests (Users H-01 / H-02).
// Bug cluster 3/3 of the 04-12 split. Each test reproduces the audit symptom
// (audit/02-users.md H-01 + H-02) and FAILS on the pre-fix verbatim hook
// (Plan 10), then PASSES after the fix here. D-02 rail / success criterion 3.
// ─────────────────────────────────────────────────────────────────────────────

describe("useUserFormState — H-01: stale initialDeeplinkRef on close (dirty leak)", () => {
  // H-01 (audit/02-users.md): after an Edit load resolves, `initialDeeplinkRef`
  // holds that user's loaded snapshot. On modal close the 200ms cleanup resets
  // the visible `deeplink` state back to DEFAULT_DEEPLINK — but it did NOT reset
  // the snapshot ref. So during the close→reopen window the dirty comparison runs
  // `isDirty(<previous user's snapshot>, <DEFAULT_DEEPLINK>)` → a FALSE dirty
  // banner that does not correspond to any user edit. The fix resets the snapshot
  // ref in the cleanup so the baseline tracks the visible (reset) deeplink.
  it("resets the snapshot baseline on close so no false dirty survives into reopen", async () => {
    // Edit load: a server user whose rule has anti-DPI ON (client_random_prefix
    // present) → the loaded snapshot differs from DEFAULT_DEEPLINK (antiDpi=true
    // vs the post-reset deeplink). This is the exact state that leaks a false
    // dirty if the ref is not reset alongside the deeplink.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_config")
        return { client_random_prefix: "p", cidr: "10.0.0.0/8" };
      if (cmd === "server_get_user_advanced") return null;
      return null;
    });

    const { result, rerender } = renderHook(
      (props: UseUserFormStateArgs) => useUserFormState(props),
      { initialProps: baseArgs({ mode: "edit", editUsername: "bob", _storybook: false }) },
    );

    await waitFor(() => expect(result.current.configLoading).toBe(false));
    // Baseline matches the loaded server state → not dirty.
    expect(result.current.isDeeplinkDirty).toBe(false);
    expect(result.current.deeplink.antiDpi).toBe(true);

    // Close the modal. The visible deeplink resets to DEFAULT_DEEPLINK after the
    // 200ms cleanup timer.
    rerender(baseArgs({ mode: "edit", editUsername: "bob", isOpen: false, _storybook: false }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    // After cleanup, the visible deeplink is back to defaults. The dirty baseline
    // MUST track that reset — otherwise isDeeplinkDirty compares bob's stale
    // (antiDpi=true) snapshot against the default (antiDpi=true ⇒ different cidr)
    // deeplink and reports a false dirty for a closed, edit-free form.
    expect(result.current.deeplink).toEqual(DEFAULT_DEEPLINK);
    expect(result.current.isDeeplinkDirty).toBe(false);
  });
});

describe("useUserFormState — H-02: refresh baseline on external config change", () => {
  // H-02 (audit/02-users.md): the Save pre-check fetches the CURRENT server rule
  // to detect external edits. If an admin changed cidr/anti-DPI on the server
  // while the modal was open, the in-memory `initialDeeplinkRef` baseline is now
  // stale — a form that already matches the new server state would still read as
  // dirty (or a genuine clobber goes unflagged). The hook must expose a way to
  // refresh the baseline from the freshly-fetched server values so dirty-tracking
  // compares against reality, not the open-time snapshot.
  it("exposes refreshInitialDeeplink so a re-fetched baseline clears a stale dirty", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_config")
        return { client_random_prefix: null, cidr: "10.0.0.0/8" };
      if (cmd === "server_get_user_advanced") return null;
      return null;
    });

    const { result } = renderHook(() =>
      useUserFormState(baseArgs({ mode: "edit", editUsername: "bob", _storybook: false })),
    );
    await waitFor(() => expect(result.current.configLoading).toBe(false));
    expect(result.current.isDeeplinkDirty).toBe(false);

    // The user edits cidr to match what (unknown to them) an admin ALSO set on the
    // server in the meantime. Locally this reads as dirty against the open-time
    // baseline.
    act(() => result.current.updateDeeplink("cidr", "192.168.0.0/16"));
    expect(result.current.isDeeplinkDirty).toBe(true);

    // Save pre-check re-fetches the server rule and finds cidr already 192.168.0.0/16
    // (external change). Refreshing the baseline against the current form makes the
    // dirty flag reflect the true (now-matching) state.
    act(() =>
      result.current.refreshInitialDeeplink({
        ...result.current.deeplink,
      }),
    );
    expect(result.current.isDeeplinkDirty).toBe(false);
  });
});
