import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import i18n from "../shared/i18n";
import type { VpnStatus } from "../shared/types";
import { NetworkGuardBanner } from "./NetworkGuardBanner";

let changed: (event: { payload: { armed: boolean } }) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage("ru");
  vi.mocked(invoke).mockImplementation(async (command) => command === "network_guard_status" ? true : null);
  vi.mocked(listen).mockImplementation(async (_event, callback) => {
    changed = (event) => callback({ event: "network-guard-changed", id: 1, payload: event.payload });
    return vi.fn<() => void>();
  });
});

describe("NetworkGuardBanner", () => {
  it.each(["disconnected", "error"] as VpnStatus[])("offers session protection recovery on %s without a running child", async (status) => {
    render(<NetworkGuardBanner status={status} />);
    expect(await screen.findByRole("button", { name: "Продолжить без VPN" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(i18n.t("network_guard.blocked"));
    expect(invoke).not.toHaveBeenCalledWith("vpn_disconnect");
  });

  it.each(["connecting", "connected", "disconnecting", "reconnecting", "recovering"] as VpnStatus[])("does not offer to release during %s", async (status) => {
    render(<NetworkGuardBanner status={status} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("network_guard_status"));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("vpn_disconnect");
  });

  it("stays hidden when protection is not armed", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    render(<NetworkGuardBanner status="disconnected" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("network_guard_status"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not let an old startup query overwrite a newer armed event", async () => {
    const snapshot = deferred<boolean>();
    vi.mocked(invoke).mockReturnValue(snapshot.promise);
    render(<NetworkGuardBanner status="disconnected" />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    act(() => changed({ payload: { armed: true } }));
    await act(async () => snapshot.resolve(false));
    expect(screen.getByRole("button", { name: "Продолжить без VPN" })).toBeInTheDocument();
  });

  it("releases only on explicit click, prevents duplicate commands and waits for confirmation", async () => {
    const disconnect = deferred<null>();
    let armed = true;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "vpn_disconnect") return disconnect.promise;
      return armed;
    });
    render(<NetworkGuardBanner status="error" />);
    const button = await screen.findByRole("button", { name: "Продолжить без VPN" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(invoke).toHaveBeenCalledWith("vpn_disconnect");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "vpn_disconnect")).toHaveLength(1);
    expect(button).toBeDisabled();
    expect(screen.getByText(i18n.t("network_guard.blocked"))).toBeInTheDocument();
    armed = false;
    await act(async () => disconnect.resolve(null));
    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
  });

  it("keeps the protection banner and localized error when release fails", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "vpn_disconnect") throw new Error("private English failure");
      return true;
    });
    render(<NetworkGuardBanner status="error" />);
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить без VPN" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("errors.network_guard_failed"));
    expect(screen.getByText(i18n.t("network_guard.blocked"))).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeEnabled();
    expect(screen.queryByText(/private English/)).not.toBeInTheDocument();
  });

  it("keeps recovery available if a protection query fails", async () => {
    vi.mocked(invoke).mockRejectedValue("network-guard-failed");
    render(<NetworkGuardBanner status="disconnected" />);
    expect(await screen.findByText(i18n.t("errors.network_guard_failed"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Продолжить без VPN" })).toBeEnabled();
    expect(screen.queryByText(i18n.t("network_guard.blocked"))).not.toBeInTheDocument();
  });

  it("refreshes after an active connection ends and responds to release events", async () => {
    const view = render(<NetworkGuardBanner status="connected" />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    view.rerender(<NetworkGuardBanner status="error" />);
    expect(await screen.findByRole("button", { name: "Продолжить без VPN" })).toBeInTheDocument();
    act(() => changed({ payload: { armed: false } }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("cleans up late listeners exactly once in StrictMode", async () => {
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<StrictMode><NetworkGuardBanner status="disconnected" /></StrictMode>);
    view.unmount();
    await act(async () => { first.resolve(stopFirst); second.resolve(stopSecond); });
    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(stopSecond).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("vpn_disconnect");
  });

  it("renders English recovery copy when English is selected", async () => {
    await i18n.changeLanguage("en");
    render(<NetworkGuardBanner status="disconnected" />);
    expect(await screen.findByRole("button", { name: "Continue without VPN" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("While the app is open, protection stops traffic outside the VPN");
  });
});
