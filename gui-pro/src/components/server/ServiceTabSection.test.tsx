/**
 * ServiceTabSection.test.tsx — Phase 17 Plan 06 + Phase 3 safety-net Stream 5 (Plan 03-06).
 *
 * Original Phase-17 cases (block order, anti-presence, accordion-closed, bbr toggle present):
 *   1. renders_6_blocks_in_canonical_order — BBR → MTProto → Benchmark → ProtocolUpdate → Logs → DangerZone
 *   2. restart_button_not_in_service (W5 anti-presence) — data-testid must NOT appear here
 *   3. danger_zone_accordion_closed_by_default — aria-expanded=false
 *   4. bbr_toggle_renders_and_callable — Toggle present (role=switch)
 *   5. no_danger_start_stop_button_at_orchestrator_level — FIXED false green (was :160
 *      `no_handleStopService_local`, whose name promised a danger start/stop absence
 *      assertion it never made; now asserts no start/stop control at the orchestrator level).
 *
 * Phase 3 safety-net Stream 5 ADDED characterization (RESEARCH §3 stream 5):
 *   - danger-zone accordion OPENS on click → aria-expanded flips true, content mounts
 *   - BBR loading state → spinner, NO Toggle (re-mock useBbrState loading=true)
 *   - BBR enabled state → switch aria-checked=true
 *   - BBR toggle invoked → clicking the switch calls bbr.toggle()
 *   - onSidecarUpdateSeen FIRES when an update is available (mock useSidecarVersions returning
 *     a newer release than state.serverInfo.version)
 *   - onSidecarUpdateSeen does NOT fire when installed === latest (no update available)
 *   - handleAppliedWithRefresh → after a successful update the orchestrator calls
 *     state.loadServerInfo(true) TWICE (0ms + 2500ms) — the post-update re-probe window.
 *
 * ## Wiring note (RESEARCH §3 stream 5 + ServiceTabSection.tsx:112-167)
 *
 * ServiceTabSection IGNORES its underscore-prefixed `currentVersion / sidecarAvailable /
 * latestVersion` props. The real version source is `state.serverInfo.version` +
 * the local `useSidecarVersions(sshParams)` GitHub list, which together drive both
 * `onSidecarUpdateSeen` (cascade signal) and `computedSidecarAvailable`. Therefore the
 * update-related cases mock `useSidecarVersions` (the real source) — NOT a blanket mock
 * of `ProtocolUpdateSection`'s update logic.
 *
 * `ProtocolUpdateSection` is mocked to a light stub ONLY to (a) keep its Modal portal /
 * Select listbox / Tauri calls out of these orchestrator tests, and (b) expose the
 * `onSidecarUpdateApplied` prop so the `handleAppliedWithRefresh` 0ms+2500ms timing
 * contract can be asserted deterministically. The stub still carries the real
 * `protocol-update-card` testid so block-order assertions remain meaningful.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
import { makeState } from "../../test/fixtures";
import { ServiceTabSection } from "./ServiceTabSection";
import { useBbrState } from "./useBbrState";
import { useSidecarVersions } from "./useSidecarVersions";
import type { SidecarReleaseInfo } from "./useSidecarVersions";

// ── Mock hooks that make SSH calls on mount ──────────────────────────────────

vi.mock("./useBbrState", () => ({
  useBbrState: vi.fn(() => ({
    enabled: false,
    loading: false,
    toggle: vi.fn(async () => {}),
  })),
}));

vi.mock("./useMtProtoState", () => ({
  useMtProtoState: vi.fn(() => ({
    status: null,
    loading: false,
    error: null,
    install: vi.fn(),
    uninstall: vi.fn(),
    retry: vi.fn(),
    installSteps: [],
    currentStep: 0,
    stepStatus: "pending" as const,
  })),
}));

// Mock leaf section components to keep their effects/portals out of these
// orchestrator tests.
vi.mock("./BenchmarkSection", () => ({
  BenchmarkSection: () => <div data-testid="benchmark-section-card">BenchmarkSection</div>,
}));

vi.mock("./LogsSection", () => ({
  LogsSection: () => <div data-testid="logs-section-card">LogsSection</div>,
}));

vi.mock("./MtProtoSection", () => ({
  MtProtoSection: () => <div data-testid="mtproto-section-card">MtProtoSection</div>,
}));

vi.mock("./DangerZoneSection", () => ({
  DangerZoneSection: () => <div data-testid="danger-zone-section">DangerZoneSection</div>,
}));

// `useSidecarVersions` is the REAL version source for the update cascade (the
// component ignores its update-related props). Mock it so we can drive the
// "update available / not available" branches deterministically without Tauri.
vi.mock("./useSidecarVersions", () => ({
  useSidecarVersions: vi.fn(() => ({
    versions: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  })),
}));

// ProtocolUpdateSection light stub — keeps the real card testid (block-order
// assertions stay meaningful) AND captures the `onSidecarUpdateApplied` prop so
// the orchestrator's `handleAppliedWithRefresh` double-refresh timing can be
// asserted. The stub does NOT replace the update DETECTION logic — that lives in
// ServiceTabSection itself (driven by useSidecarVersions, mocked above).
let capturedOnApplied: (() => void) | undefined;
let capturedLatestVersion: string | undefined;
let capturedSidecarAvailable: boolean | undefined;

vi.mock("./ProtocolUpdateSection", () => ({
  ProtocolUpdateSection: (props: {
    onSidecarUpdateApplied?: () => void;
    latestVersion?: string;
    sidecarAvailable?: boolean;
  }) => {
    capturedOnApplied = props.onSidecarUpdateApplied;
    capturedLatestVersion = props.latestVersion;
    capturedSidecarAvailable = props.sidecarAvailable;
    return <div data-testid="protocol-update-card">ProtocolUpdateSection(stub)</div>;
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockedUseBbrState = vi.mocked(useBbrState);
const mockedUseSidecarVersions = vi.mocked(useSidecarVersions);

function bbr(
  overrides: Partial<{ enabled: boolean; loading: boolean; toggle: () => Promise<void> }> = {},
) {
  return {
    enabled: false,
    loading: false,
    toggle: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ReturnType<typeof useBbrState>;
}

function sidecar(versions: SidecarReleaseInfo[]) {
  return {
    versions,
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  };
}

function release(version: string): SidecarReleaseInfo {
  return {
    version,
    tag: `v${version}`,
    assetDownloadUrl: "",
    assetSizeBytes: 0,
    publishedAt: "",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ServiceTabSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    void i18n.changeLanguage("ru");
    capturedOnApplied = undefined;
    capturedLatestVersion = undefined;
    capturedSidecarAvailable = undefined;
    // Restore sane defaults after clearAllMocks wiped the implementations.
    mockedUseBbrState.mockImplementation(() => bbr());
    mockedUseSidecarVersions.mockImplementation(() => sidecar([]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders_6_blocks_in_canonical_order — BBR → MTProto → Benchmark → ProtocolUpdate → Logs → DangerZone (Phase 19 Plan 19-04)", () => {
    render(<ServiceTabSection state={makeState()} />);

    const bbrCard = document.querySelector('[data-testid="bbr-card"]');
    const mtprotoCard = document.querySelector('[data-testid="mtproto-section-card"]');
    const benchmarkCard = document.querySelector('[data-testid="benchmark-section-card"]');
    const protocolUpdateCard = document.querySelector('[data-testid="protocol-update-card"]');
    const logsCard = document.querySelector('[data-testid="logs-section-card"]');

    expect(bbrCard).not.toBeNull();
    expect(mtprotoCard).not.toBeNull();
    expect(benchmarkCard).not.toBeNull();
    expect(protocolUpdateCard).not.toBeNull();
    expect(logsCard).not.toBeNull();

    // Verify document order: BBR → MTProto → Benchmark → ProtocolUpdate → Logs
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(bbrCard!.compareDocumentPosition(mtprotoCard!) & FOLLOWING).toBeTruthy();
    expect(mtprotoCard!.compareDocumentPosition(benchmarkCard!) & FOLLOWING).toBeTruthy();
    expect(benchmarkCard!.compareDocumentPosition(protocolUpdateCard!) & FOLLOWING).toBeTruthy();
    expect(protocolUpdateCard!.compareDocumentPosition(logsCard!) & FOLLOWING).toBeTruthy();

    // Danger Zone Accordion present (title text)
    expect(screen.getByText(i18n.t("server.danger.title"))).toBeInTheDocument();
  });

  it("restart_button_not_in_service (W5 explicit anti-presence) — overview-restart-service-button MUST NOT be in Utilities", () => {
    render(<ServiceTabSection state={makeState()} />);
    expect(document.querySelector('[data-testid="overview-restart-service-button"]')).toBeNull();
    expect(document.querySelector('[data-testid="service-restart-service-button"]')).toBeNull();
  });

  it("danger_zone_accordion_closed_by_default — DangerZone content not expanded", () => {
    render(<ServiceTabSection state={makeState()} />);
    const accordionButtons = document.querySelectorAll("[aria-expanded]");
    const dangerAccordion = Array.from(accordionButtons).find((btn) =>
      btn.textContent?.includes(i18n.t("server.danger.title")),
    );
    expect(dangerAccordion).not.toBeUndefined();
    expect(dangerAccordion?.getAttribute("aria-expanded")).toBe("false");
    // Closed → the region is always mounted (Accordion keeps content for the
    // open/close transition) but marked aria-hidden so AT skips it.
    const region = document.getElementById(
      dangerAccordion!.getAttribute("aria-controls") ?? "",
    );
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-hidden")).toBe("true");
  });

  it("danger_zone_accordion_opens_on_click — aria-expanded flips true and content mounts", async () => {
    const user = userEvent.setup();
    render(<ServiceTabSection state={makeState()} />);

    const dangerAccordion = Array.from(
      document.querySelectorAll<HTMLElement>("[aria-expanded]"),
    ).find((btn) => btn.textContent?.includes(i18n.t("server.danger.title")));
    expect(dangerAccordion).not.toBeUndefined();
    expect(dangerAccordion!.getAttribute("aria-expanded")).toBe("false");

    const region = document.getElementById(
      dangerAccordion!.getAttribute("aria-controls") ?? "",
    );
    expect(region?.getAttribute("aria-hidden")).toBe("true");

    await user.click(dangerAccordion!);

    await waitFor(() => {
      expect(dangerAccordion!.getAttribute("aria-expanded")).toBe("true");
    });
    // Opened → region revealed to assistive tech (aria-hidden cleared) and the
    // DangerZoneSection content is present inside it.
    expect(region?.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByTestId("danger-zone-section")).toBeInTheDocument();
  });

  it("bbr_toggle_renders_and_callable — BBR card shows Toggle, not loading spinner initially", () => {
    render(<ServiceTabSection state={makeState()} />);
    const bbrCard = document.querySelector('[data-testid="bbr-card"]');
    expect(bbrCard).not.toBeNull();
    const bbrToggle = bbrCard?.querySelector('[role="switch"]');
    expect(bbrToggle).not.toBeNull();
  });

  it("bbr_loading_keeps_switch_mounted_with_aria_busy — no Loader2/Toggle swap, no flicker (B-2.5/A-1)", () => {
    // B-2.5/A-1: the loading transition must NOT unmount the switch. The shared
    // Toggle now renders the spinner INSIDE the thumb (loading prop), so the
    // role="switch" stays in the DOM across loading=false→true (kills the
    // position jump the old Loader2/Toggle swap produced). aria-busy=true marks
    // the in-flight apply for assistive tech.
    const name = i18n.t("server.service.bbr.label");

    const view = render(
      <ServiceTabSection state={makeState()} />,
    );
    // Resting state: the switch is mounted and not busy.
    const restingSwitch = screen.getByRole("switch", { name });
    expect(restingSwitch).not.toBeNull();
    expect(restingSwitch.getAttribute("aria-busy")).toBeNull();

    // Flip to loading and re-render the SAME tree — the switch must persist
    // (same role queryable before/after), now reporting aria-busy.
    mockedUseBbrState.mockImplementation(() => bbr({ loading: true }));
    view.rerender(<ServiceTabSection state={makeState()} />);

    const loadingSwitch = screen.getByRole("switch", { name });
    expect(loadingSwitch).not.toBeNull();
    expect(loadingSwitch.getAttribute("aria-busy")).toBe("true");
    // Detecting caption is shown instead of the static description.
    expect(screen.getByText(i18n.t("server.service.bbr.detecting"))).toBeInTheDocument();
  });

  it("bbr_enabled_reflected_in_switch — checked state mirrors hook.enabled=true", () => {
    mockedUseBbrState.mockImplementation(() => bbr({ enabled: true }));
    render(<ServiceTabSection state={makeState()} />);

    const bbrCard = document.querySelector('[data-testid="bbr-card"]');
    const toggle = bbrCard?.querySelector('[role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("bbr_toggle_click_invokes_hook_toggle — clicking the switch calls bbr.toggle()", async () => {
    const toggleSpy = vi.fn(async () => {});
    mockedUseBbrState.mockImplementation(() => bbr({ toggle: toggleSpy }));

    const user = userEvent.setup();
    render(<ServiceTabSection state={makeState()} />);

    const bbrCard = document.querySelector('[data-testid="bbr-card"]');
    const toggle = bbrCard?.querySelector('[role="switch"]') as HTMLElement;
    expect(toggle).not.toBeNull();

    await user.click(toggle);
    expect(toggleSpy).toHaveBeenCalledTimes(1);
  });

  it("latest_derives_by_semver_max_not_publish_order — older release first still yields the semver-max (E-17)", () => {
    // E-17: the GitHub releases feed is ordered by PUBLISH time, not semver.
    // Here [0] (1.0.30) is an OLDER version than [1] (1.0.34) — the old
    // `githubReleases[0]?.version` would wrongly pick 1.0.30. With latestSemver
    // the derived "latest" is the semver-max (1.0.34), so the ProtocolUpdate
    // card receives 1.0.34 as latestVersion and the update is detected.
    mockedUseSidecarVersions.mockImplementation(() =>
      sidecar([release("1.0.30"), release("1.0.34"), release("1.0.33")]),
    );

    render(
      <ServiceTabSection
        state={makeState({ serverInfo: { version: "1.0.20" } as never })}
      />,
    );

    // The stub captured the latestVersion forwarded to ProtocolUpdateSection.
    expect(capturedLatestVersion).toBe("1.0.34");
    // …and an update is available (installed 1.0.20 < semver-max 1.0.34).
    expect(capturedSidecarAvailable).toBe(true);
  });

  it("no_update_when_installed_is_semver_max — installed === highest release (E-17)", () => {
    // Installed 1.0.34 equals the semver-max of the (publish-ordered) feed →
    // no update available, even though [0] is the older 1.0.30.
    mockedUseSidecarVersions.mockImplementation(() =>
      sidecar([release("1.0.30"), release("1.0.34"), release("1.0.33")]),
    );

    render(
      <ServiceTabSection
        state={makeState({ serverInfo: { version: "1.0.34" } as never })}
      />,
    );

    expect(capturedLatestVersion).toBe("1.0.34");
    expect(capturedSidecarAvailable).toBe(false);
  });

  it("mounting_does_not_fire_onSidecarUpdateSeen — E-15 mount-effect removed (dismissal moved to ServerTabs in 09-13)", async () => {
    // E-15: the one-shot mount-effect that fired onSidecarUpdateSeen is gone.
    // Dismissal of the «Панель управления» dot is now ServerTabs' visit-keyed
    // effect (Plan 09-13). Even with an update available and the prop supplied,
    // mounting ServiceTabSection must NOT call it.
    mockedUseSidecarVersions.mockImplementation(() =>
      sidecar([release("1.0.34"), release("1.0.33")]),
    );
    const onSeen = vi.fn();

    render(
      <ServiceTabSection
        state={makeState({ serverInfo: { version: "1.0.20" } as never })}
        onSidecarUpdateSeen={onSeen}
      />,
    );

    // Flush effects, then assert the signal never fired on mount.
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSeen).not.toHaveBeenCalled();
  });

  it("handleAppliedWithRefresh_double_loadServerInfo — update applied re-probes loadServerInfo(true) at 0ms and 2500ms", () => {
    vi.useFakeTimers();
    const loadServerInfo = vi.fn().mockResolvedValue(undefined);
    const onApplied = vi.fn();

    render(
      <ServiceTabSection
        state={makeState({ loadServerInfo })}
        onSidecarUpdateApplied={onApplied}
      />,
    );

    // The orchestrator passes a wrapped callback (handleAppliedWithRefresh) down
    // to ProtocolUpdateSection — captured by the stub above.
    expect(capturedOnApplied).toBeTypeOf("function");

    // Simulate the child firing its update-success cascade.
    act(() => {
      capturedOnApplied!();
    });

    // Parent's own re-probe pipeline triggered immediately + first loadServerInfo at 0ms.
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(loadServerInfo).toHaveBeenCalledTimes(1);
    expect(loadServerInfo).toHaveBeenLastCalledWith(true);

    // Second loadServerInfo only after the 2500ms post-update window.
    act(() => {
      vi.advanceTimersByTime(2499);
    });
    expect(loadServerInfo).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(loadServerInfo).toHaveBeenCalledTimes(2);
    expect(loadServerInfo).toHaveBeenLastCalledWith(true);
  });

  it("no_danger_start_stop_button_at_orchestrator_level — FIXED false green (was :160 name-vs-assertion mismatch)", () => {
    // The orchestrator renders only child blocks — it must NOT directly host a
    // danger start/stop/restart control. Start/Stop live inside DangerZoneSection;
    // Restart lives in OverviewSection (SSOT, SPEC §4.1). The old test name
    // `no_handleStopService_local` promised this absence assertion but never made
    // one (it only re-checked the restart testid + structural presence). Now the
    // name matches the assertion.
    render(<ServiceTabSection state={makeState()} />);

    expect(document.querySelector('[data-testid="overview-restart-service-button"]')).toBeNull();
    expect(document.querySelector('[data-testid="service-restart-service-button"]')).toBeNull();
    expect(document.querySelector('[data-testid="service-stop-button"]')).toBeNull();
    expect(document.querySelector('[data-testid="service-start-button"]')).toBeNull();
    // The DangerZone (where Start/Stop live) is collapsed by default — its region
    // is aria-hidden, so no danger control is exposed at the orchestrator level.
    const dangerAccordion = Array.from(
      document.querySelectorAll<HTMLElement>("[aria-expanded]"),
    ).find((btn) => btn.textContent?.includes(i18n.t("server.danger.title")));
    const region = document.getElementById(
      dangerAccordion?.getAttribute("aria-controls") ?? "",
    );
    expect(region?.getAttribute("aria-hidden")).toBe("true");
  });
});
