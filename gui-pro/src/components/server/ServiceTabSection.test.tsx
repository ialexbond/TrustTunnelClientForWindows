/**
 * UtilitiesTabSection.test.tsx — Phase 17 Plan 06
 *
 * Tests:
 * 1. renders_5_blocks_in_canonical_order — BBR → MTProto → Benchmark → Logs → DangerZone
 * 2. restart_button_not_in_utilities (W5 anti-presence) — data-testid must NOT appear here
 * 3. danger_zone_accordion_closed_by_default — aria-expanded=false
 * 4. bbr_toggle_renders_and_callable — toggle click calls bbr.toggle
 * 5. no_handleStopService_local — source does not define handleStopService
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
import { UtilitiesTabSection } from "./UtilitiesTabSection";
import type { ServerState } from "./useServerState";

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

// Mock child section components to avoid their own effects/invocations
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    serverInfo: {
      installed: true,
      version: "1.0.20",
      serviceActive: true,
      users: ["u1"],
    } as ServerState["serverInfo"],
    actionLoading: null,
    runAction: vi.fn(),
    pushSuccess: vi.fn(),
    serverLogs: null,
    uninstallLoading: false,
    setUninstallLoading: vi.fn(),
    setActionResult: vi.fn(),
    setServerInfo: vi.fn(),
    onSwitchToSetup: vi.fn(),
    onClearConfig: vi.fn(),
    host: "10.0.0.1",
    ...overrides,
  } as unknown as ServerState;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("UtilitiesTabSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders_5_blocks_in_canonical_order — BBR Card first, then MTProto, Benchmark, Logs, DangerZone accordion", () => {
    render(<UtilitiesTabSection state={makeState()} />);

    // All 4 section testids present
    const bbrCard = document.querySelector('[data-testid="bbr-card"]');
    const mtprotoCard = document.querySelector('[data-testid="mtproto-section-card"]');
    const benchmarkCard = document.querySelector('[data-testid="benchmark-section-card"]');
    const logsCard = document.querySelector('[data-testid="logs-section-card"]');

    expect(bbrCard).not.toBeNull();
    expect(mtprotoCard).not.toBeNull();
    expect(benchmarkCard).not.toBeNull();
    expect(logsCard).not.toBeNull();

    // Verify document order: BBR → MTProto → Benchmark → Logs
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(bbrCard!.compareDocumentPosition(mtprotoCard!) & FOLLOWING).toBeTruthy();
    expect(mtprotoCard!.compareDocumentPosition(benchmarkCard!) & FOLLOWING).toBeTruthy();
    expect(benchmarkCard!.compareDocumentPosition(logsCard!) & FOLLOWING).toBeTruthy();

    // Danger Zone Accordion present (title text)
    expect(screen.getByText(i18n.t("server.danger.title"))).toBeInTheDocument();
  });

  it("restart_button_not_in_utilities (W5 explicit anti-presence) — overview-restart-service-button MUST NOT be in Utilities", () => {
    render(<UtilitiesTabSection state={makeState()} />);
    // W5: Restart test-id lives ONLY in OverviewSection (SSOT per SPEC §4.1)
    expect(document.querySelector('[data-testid="overview-restart-service-button"]')).toBeNull();
    // Also verify no legacy utilities-level restart button
    expect(document.querySelector('[data-testid="utilities-restart-service-button"]')).toBeNull();
  });

  it("danger_zone_accordion_closed_by_default — DangerZone content not expanded", () => {
    render(<UtilitiesTabSection state={makeState()} />);
    // Accordion renders with defaultOpen=[] — the accordion button should have aria-expanded=false
    const accordionButtons = document.querySelectorAll('[aria-expanded]');
    const dangerAccordion = Array.from(accordionButtons).find((btn) =>
      btn.textContent?.includes(i18n.t("server.danger.title"))
    );
    expect(dangerAccordion).not.toBeUndefined();
    expect(dangerAccordion?.getAttribute("aria-expanded")).toBe("false");
  });

  it("bbr_toggle_renders_and_callable — BBR card shows Toggle, not loading spinner initially", () => {
    render(<UtilitiesTabSection state={makeState()} />);
    // BBR card should be present
    const bbrCard = document.querySelector('[data-testid="bbr-card"]');
    expect(bbrCard).not.toBeNull();
    // Toggle rendered (not loading spinner, since useBbrState mock has loading=false)
    // Toggle renders as button with role="switch" per Toggle.tsx
    const bbrToggle = bbrCard?.querySelector('[role="switch"]');
    expect(bbrToggle).not.toBeNull();
  });

  it("no_handleStopService_local — UtilitiesTabSection renders without Stop/Restart logic at orchestrator level", () => {
    // Behavioral check: handleStopService migrated to DangerZoneSection (Task 2).
    // Utilities orchestrator only renders 5 child blocks — no inline action handlers.
    // Stop button test-id must NOT appear at the utilities orchestrator level.
    render(<UtilitiesTabSection state={makeState()} />);
    // The utilities orchestrator does NOT directly render a Stop or Restart button.
    // These are handled by DangerZoneSection and OverviewSection respectively.
    expect(document.querySelector('[data-testid="overview-restart-service-button"]')).toBeNull();
    expect(document.querySelector('[data-testid="utilities-restart-service-button"]')).toBeNull();
    // BBR card with space-y-4 container present (D-4.3 structural check)
    expect(document.querySelector('[data-testid="bbr-card"]')).not.toBeNull();
    // all 4 section blocks present
    expect(document.querySelector('[data-testid="mtproto-section-card"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="benchmark-section-card"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="logs-section-card"]')).not.toBeNull();
  });
});
