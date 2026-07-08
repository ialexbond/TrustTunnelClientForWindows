import { describe, it, expect, vi, beforeEach } from "vitest";
import { memo } from "react";
import { render } from "@testing-library/react";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";
import type { ConfigPing } from "./ConfigPingPill";

// F13 (17-review): PP-8's `React.memo(ConfigCard)` only skips a render if ConfigList hands each
// card STABLE prop identities. It used to build FRESH inline arrow callbacks + a freshly-mapped
// `existingNames` array every render, so the shallow compare always failed and every card
// re-rendered on every ping tick — the memo was a no-op. ConfigList now hands each card the SAME
// closures from a memoized id→handlers map + a memoized shared `existingNames` array, so an
// unchanged card's props compare equal and the memo genuinely bails.
//
// This test proves that END-TO-END: we replace the real ConfigCard with a React.memo-wrapped render
// counter (a faithful stand-in for the real memoized component — the memo semantics are React's, the
// thing under test is that ConfigList's props are stable). We render, then re-render with a NEW
// `pings` object where ONE card's ping changed and the other's `pings[id]` reference is UNCHANGED.
// Only the changed card should re-render; before F13 both re-rendered on every tick.

// Per-card render tally, keyed by config id. `recordRender` is a plain function (NOT a render-time
// object mutation — the eslint immutability rule forbids the latter) that counts each render into a
// closed-over Map; the mock component calls it during render.
const tally = new Map<string, number>();
function recordRender(id: string) {
  tally.set(id, (tally.get(id) ?? 0) + 1);
}
function renderCount(id: string) {
  return tally.get(id) ?? 0;
}

vi.mock("./ConfigCard", () => {
  // A faithful React.memo wrapper (default shallow compare) — exactly what the real ConfigCard uses.
  const Impl = (props: { config: ConfigSummary }) => {
    recordRender(props.config.id);
    return <div data-testid={`card-${props.config.id}`} />;
  };
  return { ConfigCard: memo(Impl) };
});

// i18n is pulled in by ConfigList via react-i18next; the real provider-less `useTranslation` returns
// a passthrough `t`, which is all these render-count assertions need (no visible text is checked).
import { ConfigList } from "./ConfigList";

const cfgDe: ConfigSummary = {
  id: "cfg-de-abc12345",
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  display_host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};
const cfgNl: ConfigSummary = {
  id: "cfg-nl-def67890",
  name: "Нидерланды",
  host: "nl.example.com",
  display_host: "nl.example.com",
  user: "bold-eagle",
  path: "C:/app/TrustTunnel_bold-eagle.toml",
  order: 1,
  last_used: false,
};

describe("ConfigList — F13: React.memo(ConfigCard) skips unchanged cards on a ping tick", () => {
  beforeEach(() => {
    tally.clear();
  });

  it("a ping-map update re-renders ONLY the card whose ping changed", () => {
    const configs = [cfgDe, cfgNl];
    // Stable per-id ping references (as usePerConfigPing keeps them across ticks).
    const demoPing: ConfigPing = { band: "green", valueMs: 42 };
    const nlPing: ConfigPing = { band: "yellow", valueMs: 120 };

    // Stable callbacks (as ConnectionPanel passes useCallback-wrapped ones).
    const onConnect = vi.fn();
    const onEdit = vi.fn();
    const onQr = vi.fn();
    const onDelete = vi.fn();
    const onDuplicate = vi.fn();
    const onRename = vi.fn();

    const props = {
      configs,
      loading: false,
      onImport: vi.fn(),
      onConnect,
      onEdit,
      onQr,
      onDelete,
      onDuplicate,
      onRename,
    };

    const { rerender } = render(
      <ConfigList {...props} pings={{ [cfgDe.id]: demoPing, [cfgNl.id]: nlPing }} />,
    );

    expect(renderCount(cfgDe.id)).toBe(1);
    expect(renderCount(cfgNl.id)).toBe(1);

    // A ping tick: a NEW `pings` object (new outer reference — parent state changed), but only
    // cfgDe's ping is a new value; cfgNl keeps the SAME reference.
    rerender(
      <ConfigList {...props} pings={{ [cfgDe.id]: { band: "yellow", valueMs: 88 }, [cfgNl.id]: nlPing }} />,
    );

    // The changed card re-rendered; the unchanged card did NOT (memo bailed on stable props).
    expect(renderCount(cfgDe.id)).toBe(2);
    expect(renderCount(cfgNl.id)).toBe(1);
  });

  it("a pure parent re-render (same props) re-renders NO card", () => {
    const configs = [cfgDe, cfgNl];
    const nlPing: ConfigPing = { band: "yellow", valueMs: 120 };
    const demoPing: ConfigPing = { band: "green", valueMs: 42 };
    const pings = { [cfgDe.id]: demoPing, [cfgNl.id]: nlPing };
    const props = {
      configs,
      loading: false,
      onImport: vi.fn(),
      onConnect: vi.fn(),
      onEdit: vi.fn(),
      onQr: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onRename: vi.fn(),
      pings,
    };

    const { rerender } = render(<ConfigList {...props} />);
    expect(renderCount(cfgDe.id)).toBe(1);
    expect(renderCount(cfgNl.id)).toBe(1);

    // Re-render with the SAME props object contents (same references) — every card's props are
    // identical, so with the F13 stabilization no card re-renders.
    rerender(<ConfigList {...props} />);
    expect(renderCount(cfgDe.id)).toBe(1);
    expect(renderCount(cfgNl.id)).toBe(1);
  });
});
