import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../shared/i18n";
import StatusPanel from "./StatusPanel";
import type { VpnStatus } from "../shared/types";

// 02-09 (UAT Gap #3): the error-banner dismiss must call the backend clear_vpn_error
// command (so the clear broadcasts to ALL windows), not just flip local state. Mock the
// Tauri invoke so the test can assert the IPC call.
const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("StatusPanel", () => {
  const defaultProps = {
    status: "disconnected" as VpnStatus,
    error: null,
    connectedSince: null,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders disconnected state with connect button", () => {
    render(<StatusPanel {...defaultProps} />);
    expect(screen.getByText("Отключен")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Подключить/ })).toBeInTheDocument();
  });

  it("renders connected state with disconnect button", () => {
    render(
      <StatusPanel
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
      />
    );
    expect(screen.getByText("Подключен")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Отключить/ })).toBeInTheDocument();
  });

  it("renders connecting state with cancel button", () => {
    render(<StatusPanel {...defaultProps} status="connecting" />);
    // Status label appears in badge only; button shows "Cancel"
    expect(screen.getByText("Подключение")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Отмена/ });
    expect(btn).toBeEnabled();
  });

  it("renders disconnecting state with disabled button", () => {
    render(<StatusPanel {...defaultProps} status="disconnecting" />);
    const texts = screen.getAllByText("Отключение");
    expect(texts.length).toBe(2);
    const btn = screen.getByRole("button", { name: /Отключение/ });
    expect(btn).toBeDisabled();
  });

  it("renders the «Отключение» badge in the GRAY variant, not yellow (WR-04 / SPEC §1)", () => {
    // WR-04: `disconnecting` is teardown-in-flight → ⚪ gray per SPEC §1 (matching the
    // tray `off` bucket), NOT the yellow «connecting» (actively-trying) variant. The
    // StatusBadge dot carries a variant-specific class: the gray `disconnected` variant
    // uses --color-text-muted; the yellow `connecting` variant uses
    // --color-status-connecting. Assert the dot is the gray one — a regression mapping
    // disconnecting back to "connecting" would flip the class and fail here.
    render(<StatusPanel {...defaultProps} status="disconnecting" />);
    const dot = screen.getByTestId("status-dot");
    expect(dot.className).toContain("var(--color-text-muted)");
    expect(dot.className).not.toContain("var(--color-status-connecting)");
  });

  it("renders recovering state with an ENABLED «Отмена» button (SPEC §4)", () => {
    // 02-20 SPEC §4: «Восстановление» is an actively-trying state — the user can abort
    // the wait, so the toggle is «Отмена» (enabled), not a disabled spinner.
    render(<StatusPanel {...defaultProps} status="recovering" />);
    // The badge shows «Восстановление» …
    expect(screen.getByText("Восстановление")).toBeInTheDocument();
    // … and the descriptive sub-text explains the local-net wait.
    expect(
      screen.getByText("Соединение с интернетом потеряно. Восстановление, подождите…"),
    ).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Отмена/ });
    expect(btn).toBeEnabled();
  });

  it("renders a LIVE «Отмена» while a BACKEND auto-reconnect runs (owner UAT 2026-08-26)", () => {
    // `reconnecting` used to be treated as AMBIGUOUS — it is set BOTH by the backend auto-retry
    // supervisor (reconnectResolve null → the cancel is safe) AND by a FE save-and-reconnect whose
    // teardown ARMS the shared latch (the cancel would be INERT, and resolving that latch early is
    // the BUG-A double-spawn storm). Hiding it in both cases meant an automatic reconnect could only
    // be stopped from the tray menu, which the owner hit ten attempts deep.
    //
    // The two cases ARE separable: a FE save-and-reconnect raises `connectPending` for exactly its
    // own span, a backend auto-retry raises nothing. Without `connectPending` this is the backend's
    // reconnect and the cancel lands.
    render(<StatusPanel {...defaultProps} status="reconnecting" />);
    expect(screen.getByTestId("status-dot")).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: /Отмена/ });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(defaultProps.onDisconnect).toHaveBeenCalled();
  });

  it("keeps the INERT spinner for a FE save-and-reconnect (reconnecting + connectPending)", () => {
    // The other half of the same rule, and the reason the discriminator is `connectPending` rather
    // than «show it whenever the status is reconnecting»: here the App's shared latch is armed, so a
    // live button would be a dead no-op — the exact thing BUG-A2 forbids.
    render(<StatusPanel {...defaultProps} status="reconnecting" connectPending />);
    expect(screen.queryByRole("button", { name: /Отмена/ })).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Переподключение/ });
    expect(btn).toBeDisabled();
  });

  it("shows ONLY the «Попытка N/3» counter (no «Связь с сервером потеряна» sub-text) during a server-lost reconnect", () => {
    // 02-20: a server-lost auto-retry carries the per-attempt counter on the payload.
    // WR-01: the «Связь с сервером потеряна» sentence now lives SOLELY in the error
    // BANNER (useVpnEvents sets errors.server_connection_lost on a `tunnel-lost` drop),
    // so StatusPanel must NOT also render it as a sub-text — otherwise the same line
    // appears twice. StatusPanel renders ONLY the «Попытка N из M» progress line here.
    render(
      <StatusPanel
        {...defaultProps}
        status="reconnecting"
        reconnectProgress={{ attempt: 2, max: 3 }}
      />
    );
    expect(screen.queryByText("Связь с сервером потеряна")).not.toBeInTheDocument();
    expect(screen.getByText("Попытка 2 из 3")).toBeInTheDocument();
  });

  it("names the SERVER, not the attempt, while a failover walk is running", () => {
    // Owner UAT 2026-08-26. On a walk every candidate gets exactly one attempt, so the retry
    // wording rendered «Попытка 1 из 1» on server after server — a counter that never moved,
    // describing a process the person could not see. With `failover` the same two numbers are the
    // QUEUE position, and the line answers the question actually being asked: how far along is
    // this, and how much is left.
    render(
      <StatusPanel
        {...defaultProps}
        status="reconnecting"
        reconnectProgress={{ attempt: 2, max: 4, failover: true }}
      />
    );
    expect(screen.getByText("Пробуем сервер 2 из 4")).toBeInTheDocument();
    // …and the retry wording must NOT also appear — the two readings are mutually exclusive.
    expect(screen.queryByText(/Попытка/)).not.toBeInTheDocument();
  });

  it("does NOT show any sub-text for a manual reconnect (no counter)", () => {
    // A manual save+reconnect is also `reconnecting` but carries no attempt counter —
    // nothing was lost, so neither the «Связь…» line (WR-01: banner-only) nor the
    // «Попытка» counter must appear.
    render(<StatusPanel {...defaultProps} status="reconnecting" />);
    expect(screen.queryByText("Связь с сервером потеряна")).not.toBeInTheDocument();
    expect(screen.queryByText(/Попытка/)).not.toBeInTheDocument();
  });

  it("clicking «Отмена» during recovering calls onDisconnect (cancel/stop)", () => {
    // BUG-A2: `recovering` is a reconnectResolve-null state, so it keeps the LIVE, working «Отмена».
    // (`reconnecting` keeps it too now, unless a FE save-and-reconnect is what raised it — above.)
    render(<StatusPanel {...defaultProps} status="recovering" />);
    fireEvent.click(screen.getByRole("button", { name: /Отмена/ }));
    expect(defaultProps.onDisconnect).toHaveBeenCalledOnce();
  });

  // BUG-A2 (17-uat): the live «Отмена» SHOWS during a plain connect EVEN WHILE connectPending is
  // true. handleConnectActive raises pendingConnectPath (→ connectPending) for the WHOLE connecting
  // span, and handleUserCancel is SAFE during connecting/recovering (reconnectResolve null), so
  // hiding it there is the exact "нет кнопки отмены при обычном подключении" bug. This is the
  // dead-window the old F6 tests missed (they only tested connectPending=false).
  for (const status of ["connecting", "recovering"] as VpnStatus[]) {
    it(`BUG-A2: shows a LIVE, working «Отмена» when connectPending + status = ${status} (plain connect)`, () => {
      render(<StatusPanel {...defaultProps} status={status} connectPending />);
      const cancel = screen.getByRole("button", { name: /Отмена/ });
      expect(cancel).toBeEnabled();
      fireEvent.click(cancel);
      expect(defaultProps.onDisconnect).toHaveBeenCalledOnce();
    });
  }

  it("BUG-A2: shows a LIVE, working «Отмена» for an ordinary connecting (connectPending absent)", () => {
    render(<StatusPanel {...defaultProps} status="connecting" />);
    const btn = screen.getByRole("button", { name: /Отмена/ });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(defaultProps.onDisconnect).toHaveBeenCalledOnce();
  });

  // BUG-A2: during a seamless switch's `connecting` leg isSwitching is held, and handleUserCancel is
  // INERT then (isSwitching gate) — so the live «Отмена» must be HIDDEN (inert spinner), never a dead
  // button. This is the StatusPanel dead-window guard the coordinator flagged.
  it("BUG-A2: HIDES the live «Отмена» during a switch's connecting leg (switching=true → inert spinner)", () => {
    render(<StatusPanel {...defaultProps} status="connecting" switching />);
    expect(screen.queryByRole("button", { name: /Отмена/ })).not.toBeInTheDocument();
    // The only action button is the disabled spinner.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toBeDisabled();
  });

  // Fable F3: a seamless switch transiently passes through `disconnected` (the ~1.5s post-teardown
  // probe window) and `connected` (A live during teardown / A reconnected on revert). Without the
  // `!switching` gates, the connect/disconnect button AND the `switching` inert spinner both rendered
  // → TWO buttons. Assert EXACTLY ONE action button (the inert spinner) for every switch-transient status.
  for (const status of ["connected", "disconnected", "error", "connecting"] as VpnStatus[]) {
    it(`F3: renders exactly ONE (inert) action button while switching + status = ${status} (no duplicate)`, () => {
      render(<StatusPanel {...defaultProps} status={status} switching connectedSince={new Date()} />);
      const buttons = screen.getAllByRole("button");
      // Exactly one action button, and it is the disabled inert spinner (no live cancel, no connect,
      // no disconnect — the switch owns the control face).
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toBeDisabled();
      expect(screen.queryByRole("button", { name: /Отмена/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Подключить/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Отключить/ })).not.toBeInTheDocument();
    });
  }

  it("renders error state with error message", () => {
    render(
      <StatusPanel {...defaultProps} status="error" error="Test error message" />
    );
    expect(screen.getByText("Ошибка")).toBeInTheDocument();
    expect(screen.getByText("Test error message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Подключить/ })).toBeInTheDocument();
  });

  it("calls onConnect when connect button clicked", () => {
    render(<StatusPanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Подключить/ }));
    expect(defaultProps.onConnect).toHaveBeenCalledOnce();
  });

  it("calls onDisconnect when disconnect button clicked", () => {
    render(
      <StatusPanel
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Отключить/ }));
    expect(defaultProps.onDisconnect).toHaveBeenCalledOnce();
  });

  it("shows uptime counter when connected", () => {
    render(
      <StatusPanel
        {...defaultProps}
        status="connected"
        connectedSince={new Date(Date.now() - 3661000)} // 1h 1m 1s ago
      />
    );
    expect(screen.getByText(/01:01:0/)).toBeInTheDocument();
  });

  it("does not show uptime when disconnected", () => {
    render(<StatusPanel {...defaultProps} />);
    expect(screen.queryByText(/\d{2}:\d{2}:\d{2}/)).not.toBeInTheDocument();
  });

  it("invokes clear_vpn_error (not just local state) when the error banner is dismissed", () => {
    // 02-09 (UAT Gap #3): dismissing the error must clear it in EVERY window via the
    // backend command, so a stale window can't keep showing it and the snapshot can't
    // re-surface it. Assert the dismiss button fires the clear_vpn_error IPC call — a
    // local-only setErrorDismissed(true) path would NOT call this and the test fails.
    render(
      <StatusPanel {...defaultProps} status="error" error="Test error message" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(invokeMock).toHaveBeenCalledWith("clear_vpn_error");
    // The banner is optimistically hidden locally too.
    expect(screen.queryByText("Test error message")).not.toBeInTheDocument();
  });

  it("offers a LOCAL dismiss (X) while status is 'recovering' — hides the banner WITHOUT calling clear_vpn_error (F2)", () => {
    // F2: the recovering/reconnecting banner carries a system message that
    // clear_vpn_error would no-op on (its is_error guard fails while the live status is
    // not Error). The old code therefore showed NO X at all — but the user reported
    // wanting to close it ("крестик не закрывает"). We now offer a LOCAL-only dismiss:
    // the X is present, and clicking it hides the banner locally WITHOUT an IPC call.
    render(
      <StatusPanel
        {...defaultProps}
        status="recovering"
        error="Переподключение после потери сети"
      />
    );
    // The banner (message) is shown with a dismiss X.
    expect(
      screen.getByText("Переподключение после потери сети")
    ).toBeInTheDocument();
    const dismissBtn = screen.getByRole("button", { name: "Закрыть" });
    expect(dismissBtn).toBeInTheDocument();

    // Clicking it hides the banner locally...
    fireEvent.click(dismissBtn);
    expect(
      screen.queryByText("Переподключение после потери сети")
    ).not.toBeInTheDocument();
    // ...but does NOT call the backend clear (a no-op in this state — local hide only).
    expect(invokeMock).not.toHaveBeenCalledWith("clear_vpn_error");
  });

  it("offers the dismiss (X) when status is 'error' (WR-03 positive control)", () => {
    // Positive control proving the previous test fails for the right reason: in the
    // genuine 'error' state the dismiss X IS rendered.
    render(
      <StatusPanel {...defaultProps} status="error" error="Test error message" />
    );
    expect(
      screen.getByRole("button", { name: "Закрыть" })
    ).toBeInTheDocument();
  });
});
