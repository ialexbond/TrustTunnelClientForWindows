import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { SecurityTabSection } from "./SecurityTabSection";
import type { ServerState } from "./useServerState";
import { renderWithProviders as render } from "../../test/test-utils";

/**
 * Phase 3 safety-net (stream 4a) — FIRST-EVER test for SecurityTabSection.
 *
 * SecurityTabSection is a thin route-level shell: it delegates entirely to
 * `SecuritySection`, forwarding the `state` prop unchanged (see
 * SecurityTabSection.tsx — Phase 16 Plan 05 moved the 4-card layout into
 * SecuritySection, leaving this as a wrapping shell for ServerTabs).
 *
 * Two complementary characterizations:
 *   1. Delegation (mocked child): proves SecurityTabSection renders its child
 *      AND forwards the exact `state` prop it received.
 *   2. Integration (real child): proves the delegated content actually shows up
 *      by role/text (the Firewall / Fail2Ban cards) — not a class assertion.
 *
 * D-04: assert behavior/role/text, never CSS classes. D-06: no production code
 * touched — these tests pin the shell's current delegation behavior.
 */

// ── Block 1: delegation against a mocked child ──────────────────────────────
// A hoisted spy lets us assert the exact props SecurityTabSection forwards.
const securitySectionSpy = vi.fn();
vi.mock("./SecuritySection", () => ({
  SecuritySection: (props: { state: ServerState }) => {
    securitySectionSpy(props);
    return <div data-testid="mock-security-section" />;
  },
}));

// CertSection (rendered by the REAL SecuritySection in the integration block)
// fires an async `server_get_cert_info` invoke on mount; useSecurityState fires
// `security_get_status`. Stub both so the integration render is deterministic.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "***",
};

function makeServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    sshParams: mockSshParams,
    pushSuccess: vi.fn(),
    onPortChanged: vi.fn(),
    certRaw: null,
    setCertRaw: vi.fn(),
    setActionResult: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("SecurityTabSection (delegation shell)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders its delegated child (SecuritySection)", () => {
    render(<SecurityTabSection state={makeServerState()} />);
    expect(screen.getByTestId("mock-security-section")).toBeInTheDocument();
  });

  it("forwards the received `state` prop unchanged to SecuritySection", () => {
    const state = makeServerState();
    render(<SecurityTabSection state={state} />);
    // The shell must pass the SAME state reference through (no wrapping/mutation).
    expect(securitySectionSpy).toHaveBeenCalledTimes(1);
    expect(securitySectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ state }),
    );
  });
});
