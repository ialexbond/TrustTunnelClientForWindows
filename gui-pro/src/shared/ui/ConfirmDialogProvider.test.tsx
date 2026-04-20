import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import i18n from "../i18n";
import { ConfirmDialogProvider } from "./ConfirmDialogProvider";
import { useConfirm } from "./useConfirm";

// Helper: a component that triggers confirm() on demand and stores results.
function TriggerHarness({
  onResult,
  options = { title: "t", message: "m", variant: "danger" as const },
}: {
  onResult: (v: boolean) => void;
  options?: Parameters<ReturnType<typeof useConfirm>>[0];
}) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={async () => {
        const r = await confirm(options);
        onResult(r);
      }}
    >
      ask
    </button>
  );
}

describe("ConfirmDialogProvider", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    cleanup();
  });

  it("resolves true when user clicks Confirm", async () => {
    const results: boolean[] = [];
    render(
      <ConfirmDialogProvider>
        <TriggerHarness
          onResult={(v) => results.push(v)}
          options={{ title: "Подтвердить?", message: "Ок?", variant: "danger" }}
        />
      </ConfirmDialogProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ask" }));
    // ConfirmDialog renders its buttons with i18n defaults: "Подтвердить" / "Отмена"
    await user.click(
      screen.getByRole("button", { name: /Удалить/i }),
    );
    expect(results).toEqual([true]);
  });

  it("resolves false when user clicks Cancel", async () => {
    const results: boolean[] = [];
    render(
      <ConfirmDialogProvider>
        <TriggerHarness onResult={(v) => results.push(v)} />
      </ConfirmDialogProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ask" }));
    await user.click(screen.getByRole("button", { name: /Отмена/i }));
    expect(results).toEqual([false]);
  });

  it("queues concurrent calls FIFO (second waits for first)", async () => {
    const results: Array<[string, boolean]> = [];

    function DoubleTrigger() {
      const confirm = useConfirm();
      const firedRef = useRef(false);
      useEffect(() => {
        if (firedRef.current) return;
        firedRef.current = true;
        void (async () => {
          const a = await confirm({
            title: "first",
            message: "m1",
            variant: "danger",
          });
          results.push(["first", a]);
        })();
        void (async () => {
          const b = await confirm({
            title: "second",
            message: "m2",
            variant: "warning",
          });
          results.push(["second", b]);
        })();
      }, [confirm]);
      return null;
    }

    render(
      <ConfirmDialogProvider>
        <DoubleTrigger />
      </ConfirmDialogProvider>,
    );

    // Wait for first dialog to appear
    await screen.findByText("first");
    // Second must NOT be visible yet
    expect(screen.queryByText("second")).toBeNull();

    const user = userEvent.setup();
    // Accept first
    await user.click(screen.getByRole("button", { name: /Удалить/i }));

    // Second must appear now
    await screen.findByText("second");
    await user.click(screen.getByRole("button", { name: /Отмена/i }));

    expect(results).toEqual([
      ["first", true],
      ["second", false],
    ]);
  });

  it("resolves pending calls with false on Provider unmount", async () => {
    const results: boolean[] = [];

    function Harness() {
      const confirm = useConfirm();
      useEffect(() => {
        void (async () => {
          const r = await confirm({
            title: "will unmount",
            message: "x",
            variant: "danger",
          });
          results.push(r);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    }

    const { unmount } = render(
      <ConfirmDialogProvider>
        <Harness />
      </ConfirmDialogProvider>,
    );

    await screen.findByText("will unmount");

    await act(async () => {
      unmount();
      // Give microtasks a tick to drain.
      await Promise.resolve();
    });

    expect(results).toEqual([false]);
  });

  it("useConfirm throws when used outside ConfirmDialogProvider", () => {
    // Suppress React's expected error boundary noise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(<TriggerHarness onResult={() => {}} />),
    ).toThrow(/useConfirm must be used within ConfirmDialogProvider/);
    spy.mockRestore();
  });

  // ══════════════════════════════════════════════════════
  // Phase 14 post-install: async action API + 200ms exit-lag
  // ══════════════════════════════════════════════════════

  it("action prop: modal stays open while async action is pending", async () => {
    const results: boolean[] = [];
    let resolveAction!: () => void;
    const actionPromise = new Promise<void>((res) => {
      resolveAction = res;
    });
    const action = vi.fn().mockReturnValue(actionPromise);

    render(
      <ConfirmDialogProvider>
        <TriggerHarness
          onResult={(v) => results.push(v)}
          options={{ title: "Delete", message: "sure?", variant: "danger", action }}
        />
      </ConfirmDialogProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ask" }));
    await user.click(screen.getByRole("button", { name: /Удалить/i }));

    // Action was invoked but its promise is pending — dialog MUST stay open.
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByText("sure?")).toBeInTheDocument();
    expect(results).toEqual([]);

    // Resolve action — dialog closes, confirm() resolves true.
    await act(async () => {
      resolveAction();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    expect(results).toEqual([true]);
  });

  it("action prop: resolves false when action throws, modal closes", async () => {
    const results: boolean[] = [];
    const action = vi.fn().mockRejectedValue(new Error("backend exploded"));

    render(
      <ConfirmDialogProvider>
        <TriggerHarness
          onResult={(v) => results.push(v)}
          options={{ title: "Delete", message: "sure?", variant: "danger", action }}
        />
      </ConfirmDialogProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ask" }));
    await user.click(screen.getByRole("button", { name: /Удалить/i }));

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(results).toEqual([false]);
  });

  it("action prop: Cancel is ignored while action is in flight", async () => {
    const results: boolean[] = [];
    let resolveAction!: () => void;
    const actionPromise = new Promise<void>((res) => {
      resolveAction = res;
    });
    const action = vi.fn().mockReturnValue(actionPromise);

    render(
      <ConfirmDialogProvider>
        <TriggerHarness
          onResult={(v) => results.push(v)}
          options={{ title: "Delete", message: "sure?", variant: "danger", action }}
        />
      </ConfirmDialogProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ask" }));
    await user.click(screen.getByRole("button", { name: /Удалить/i }));
    // Try Cancel while action is still running — should be ignored.
    // Cancel button is disabled via loading=true, but belt-and-suspenders: click does nothing.
    const cancelBtn = screen.getByRole("button", { name: /Отмена/i });
    expect(cancelBtn).toBeDisabled();

    await act(async () => {
      resolveAction();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    expect(results).toEqual([true]);
  });

  it("exit animation: content stays rendered briefly after close, then unmounts", async () => {
    // Regression guard for the 200ms exit lag (see Modal lifecycle contract —
    // Modal.tsx JSDoc + known-issues #10). Provider must NOT immediately
    // unmount ConfirmDialog when current goes null — that would kill the
    // 200ms exit animation of Modal primitive.
    //
    // Approach: use fireEvent (synchronous) + real timers. Content must still
    // be in DOM at least for one React commit after close before Modal unmounts.
    const results: boolean[] = [];
    render(
      <ConfirmDialogProvider>
        <TriggerHarness
          onResult={(v) => results.push(v)}
          options={{ title: "Hold me", message: "body-stays-during-exit", variant: "danger" }}
        />
      </ConfirmDialogProvider>,
    );

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    expect(screen.getByText("body-stays-during-exit")).toBeInTheDocument();

    // Cancel click — Provider sets current=null immediately, but Modal's own
    // exit transition + our displayed-lag keep content in DOM.
    fireEvent.click(screen.getByRole("button", { name: /Отмена/i }));

    // Content must still be mounted right after click (exit animation starts).
    expect(screen.getByText("body-stays-during-exit")).toBeInTheDocument();
    // After 250ms (> 200ms lag) content should be unmounted.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(screen.queryByText("body-stays-during-exit")).not.toBeInTheDocument();
    expect(results).toEqual([false]);
  }, 10000);
});
