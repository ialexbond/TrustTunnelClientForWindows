import { vi } from "vitest";
import { listen } from "@tauri-apps/api/event";

/**
 * Tauri event-capture helper (Phase 3 safety-net, Wave 0).
 *
 * Dedupes the `listen` mock + `emitEvent` pattern from TESTING.md §Tauri Event
 * Simulation. Wave-1 streams that drive async / cascade flows
 * (`benchmark-progress`, `update-protocol-step`, `tt:security-changed`) install
 * the capture before render, then fire events into the registered listeners:
 *
 *   const events = captureListeners();
 *   render(<Surface />);
 *   await act(async () => { events.emitEvent("tt:security-changed", {}); });
 *
 * `@tauri-apps/api/event` is already globally mocked in src/test/tauri-mock.ts,
 * so this only re-points the mocked `listen` at an in-memory registry.
 */

type ListenCallback = (event: { payload: unknown }) => void;

export interface CapturedListeners {
  /** Fire all callbacks registered for `name` with `{ payload }`. */
  emitEvent: (name: string, payload?: unknown) => void;
  /** How many listeners are registered for `name` (assertion convenience). */
  count: (name: string) => number;
  /** Raw registry — escape hatch for advanced assertions. */
  registry: Record<string, ListenCallback[]>;
}

/**
 * Install an in-memory capture over the globally-mocked `listen`. Returns
 * `emitEvent` (fires captured callbacks) plus small inspection helpers. Call
 * inside the test (after `vi.clearAllMocks()` in beforeEach) and BEFORE the
 * render that registers the listeners.
 */
export function captureListeners(): CapturedListeners {
  const registry: Record<string, ListenCallback[]> = {};

  vi.mocked(listen).mockImplementation(
    // The real `listen<T>(event, handler)` returns a Promise<UnlistenFn>.
    // We capture the handler keyed by event name and hand back a no-op
    // unlisten so unmount cleanup does not throw.
    (async (eventName: string, callback: ListenCallback) => {
      if (!registry[eventName]) registry[eventName] = [];
      registry[eventName].push(callback);
      return () => {
        registry[eventName] = (registry[eventName] || []).filter(
          (cb) => cb !== callback,
        );
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );

  return {
    emitEvent(name: string, payload: unknown = {}) {
      (registry[name] || []).forEach((cb) => cb({ payload }));
    },
    count(name: string) {
      return (registry[name] || []).length;
    },
    registry,
  };
}

/**
 * Standalone emit against an existing registry (when a stream prefers to hold
 * the registry itself). Mirrors the TESTING.md `emitEvent` free function.
 */
export function emitEvent(
  registry: Record<string, ListenCallback[]>,
  name: string,
  payload: unknown = {},
): void {
  (registry[name] || []).forEach((cb) => cb({ payload }));
}
