import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
// CR-01 (19-fix): the picker-door partial-import App integration test drives the real OS file
// picker seam (`open` from plugin-dialog, mocked globally in tauri-mock.ts) to prove a picker
// batch that partly fails STAYS in-modal instead of closing (the pre-fix defect).
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import i18n from "./shared/i18n";
import App from "./App";
import { renderWithProviders as render } from "./test/test-utils";

// Mock recharts
vi.mock("recharts", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LineChart: ({ children }: any) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
}));

// Mock heavy child components to keep tests fast — capture props for assertions
vi.mock("./components/SetupWizard", () => ({
  __esModule: true,
  default: () => <div data-testid="setup-wizard">SetupWizard</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let controlPanelProps: any = {};
vi.mock("./components/ControlPanelPage", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ControlPanelPage: (props: any) => {
    controlPanelProps = props;
    return <div data-testid="control-panel-page">ControlPanelPage</div>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connectionPanelProps: any = {};
// Phase 11: the Connection tab now renders the multi-config ConnectionPanel
// (components/connection/ConnectionPanel — a forwardRef). It owns the card list and no
// longer receives a statusPanel prop (the lead-card lifecycle owns the status, layered on
// in Plan 03; the StatusPanel strip stays on Settings/About). Status-machine tests below
// observe StatusPanel from the Settings tab via `gotoSettings()`.
vi.mock("./components/connection/ConnectionPanel", async () => {
  const React = await import("react");
  return {
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ConnectionPanel: React.forwardRef((props: any, ref: any) => {
      // Test-only prop capture (same pattern as the other panel mocks) — the
      // react-hooks/globals "no reassign in render" rule does not apply to a test double.
      // eslint-disable-next-line react-hooks/globals
      connectionPanelProps = props;
      // Expose no-op reload()/refresh() so App's connectionPanelRef.current?.reload()/refresh() are safe.
      React.useImperativeHandle(ref, () => ({ reload: () => {}, refresh: () => {} }), []);
      return <div data-testid="connection-panel">ConnectionPanel</div>;
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let routingPanelProps: any = {};
vi.mock("./components/RoutingPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => {
    routingPanelProps = props;
    return <div data-testid="routing-panel">RoutingPanel</div>;
  },
}));

vi.mock("./components/LogPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="log-panel">LogPanel</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let aboutPanelProps: any = {};
vi.mock("./components/AboutPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => {
    aboutPanelProps = props;
    return <div data-testid="about-panel">AboutPanel</div>;
  },
}));

vi.mock("./components/DashboardPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="dashboard-panel">DashboardPanel</div>,
}));

vi.mock("./components/AppSettingsPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => {
    // IN-11: render the passed statusPanel so a test that probes status from the Settings
    // tab still mounts the StatusPanel instance (App now gates it to the active tab).
    return <div data-testid="app-settings-panel">AppSettingsPanel{props.statusPanel}</div>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let statusPanelProps: any = {};
vi.mock("./components/StatusPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => {
    statusPanelProps = props;
    return <div data-testid="status-panel">StatusPanel</div>;
  },
}));

// Phase 30: the app update check is the Rust command `check_app_update_info`, not a
// webview fetch — the app's own CSP names no GitHub origin in `connect-src`. Tests that
// care about update state answer that command from their own `invoke` mock using this
// factory, which mirrors the command's snake_case wire shape.
function appUpdateWire(overrides: Record<string, unknown> = {}) {
  return {
    current_version: "1.5.0",
    latest_version: "1.5.0",
    latest_tag: "v1.5.0",
    available: false,
    download_url: "",
    release_notes: "",
    sha256: "",
    ...overrides,
  };
}

// Mock window.matchMedia
const matchMediaListeners: Array<(e: MediaQueryListEvent) => void> = [];
const mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: query.includes("dark"),
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener: vi.fn((_: string, handler: any) => {
    matchMediaListeners.push(handler);
  }),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: mockMatchMedia,
});

// Helper: capture listen callbacks by event name
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenCallback = (event: { payload: any }) => void;
let listenCallbacks: Record<string, ListenCallback[]> = {};

function setupListenMock() {
  listenCallbacks = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(listen).mockImplementation(async (eventName: string, callback: any) => {
    if (!listenCallbacks[eventName]) listenCallbacks[eventName] = [];
    listenCallbacks[eventName].push(callback);
    return () => {};
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitEvent(eventName: string, payload: any) {
  const cbs = listenCallbacks[eventName] || [];
  cbs.forEach(cb => cb({ payload }));
}

// Phase 11: the Connection tab no longer hosts the StatusPanel (the lead-card lifecycle
// owns the status; the StatusPanel strip stays on Settings/About). The status-machine
// tests observe StatusPanel through `statusPanelProps`, so they navigate to the Settings
// tab — where StatusPanel still mounts — before asserting. The status logic itself lives
// in hooks and is independent of which tab is active.
async function gotoSettings() {
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: /Настройки/ }));
  });
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    i18n.changeLanguage("ru");
    localStorage.clear();
    matchMediaListeners.length = 0;

    // Default Tauri mocks
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return null;
      if (cmd === "get_auto_connect") return false;
      if (cmd === "auto_detect_config") return null;
      // Without this the mount-time update check would reject on every App test and
      // fill the run with «Update check failed» warnings that mean nothing.
      if (cmd === "check_app_update_info") return appUpdateWire();
      return null;
    });

    setupListenMock();
    vi.mocked(getVersion).mockResolvedValue("2.0.0");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Basic rendering ───

  it("renders without crashing", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(document.querySelector(".h-screen.flex")).toBeInTheDocument();
  });

  it("shows tab navigation", async () => {
    await act(async () => {
      render(<App />);
    });
    const tablist = document.querySelector('[role="tablist"]');
    expect(tablist).toBeInTheDocument();
  });

  it("renders control panel by default when no config", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByTestId("control-panel-page")).toBeInTheDocument();
  });

  it("renders settings page when config exists", async () => {
    localStorage.setItem("tt_config_path", "/some/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    expect(screen.getByTestId("connection-panel")).toBeInTheDocument();
  });

  // ─── In-window log overlay (Plan 02-16) ───
  // The title-bar Terminal button toggles an IN-WINDOW LogPanel overlay (the
  // safe replacement for the old separate-webview log window that froze the
  // app). No second window is created — the LogPanel mock renders inline.

  it("does not render the log overlay until the title-bar button is clicked", async () => {
    await act(async () => {
      render(<App />);
    });
    // The toggle button is present (aria-label from logs.toggle_aria) but the
    // LogPanel is not mounted yet.
    expect(
      screen.getByRole("button", { name: i18n.t("logs.toggle_aria") }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("log-panel")).not.toBeInTheDocument();
  });

  it("toggles the in-window LogPanel overlay open and closed via the title-bar button", async () => {
    await act(async () => {
      render(<App />);
    });

    const toggle = screen.getByRole("button", {
      name: i18n.t("logs.toggle_aria"),
    });

    // Open
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.getByTestId("log-panel")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Close via the same button
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.queryByTestId("log-panel")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("closes the log overlay via its close (X) button", async () => {
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("logs.toggle_aria") }),
      );
    });
    expect(screen.getByTestId("log-panel")).toBeInTheDocument();

    // The overlay header has a close button labelled logs.close_aria.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("logs.close_aria") }),
      );
    });
    expect(screen.queryByTestId("log-panel")).not.toBeInTheDocument();
  });

  // ─── Setup wizard overlay — no overlay-level × (06-uat, user request) ───
  // The overlay-level close (×) was REMOVED: the install flow is self-contained
  // (ServerStep «Назад» + the Done/Found buttons exit via onClose), and switching
  // bottom tabs hides the overlay (it sits between the title bar and the tab bar,
  // which stays clickable), so there is no trap. Assert the overlay opens via
  // onSwitchToSetup and that it no longer renders a × close button.

  it("opens the setup wizard overlay via onSwitchToSetup and exposes NO overlay × (removed)", async () => {
    // Returning user — suppress the first-run WelcomeTour so only the wizard
    // overlay is in play.
    localStorage.setItem("tt_welcome_completed", "true");

    await act(async () => {
      render(<App />);
    });

    // No config → control panel; wizard overlay not mounted yet.
    expect(screen.queryByTestId("setup-wizard")).not.toBeInTheDocument();

    // «Установить» path → wizardActive = true.
    await act(async () => {
      controlPanelProps.onSwitchToSetup();
    });
    expect(screen.getByTestId("setup-wizard")).toBeInTheDocument();

    // The overlay-level × is gone — there is no «Закрыть мастер установки» button.
    expect(
      screen.queryByRole("button", { name: "Закрыть мастер установки" }),
    ).not.toBeInTheDocument();
  });

  // ─── Wizard overlay dialog a11y (D-01/D-05) — RED until Plan 03 ───
  //
  // The wizardActive overlay wrapper lives in App.tsx (NOT inside SetupWizard,
  // which is mocked here), so we can assert its roles directly. Plan 03 (D-01)
  // added role="dialog" + aria-modal="true" + aria-labelledby pointing at the
  // hidden stable wizard title (06-UI-SPEC §"Accessibility Contract"). Assert by
  // ARIA role/name only — never CSS classes.
  describe("wizard overlay dialog a11y (D-01 / Plan 03)", () => {
    it("exposes the overlay as role=dialog with aria-modal and a non-empty accessible name", async () => {
      // Returning user — suppress the first-run WelcomeTour so only the wizard
      // overlay is in play (same harness as the anti-trap close test above).
      localStorage.setItem("tt_welcome_completed", "true");

      await act(async () => {
        render(<App />);
      });

      // «Установить» path → wizardActive = true (overlay mounts).
      await act(async () => {
        controlPanelProps.onSwitchToSetup();
      });
      // The mocked SetupWizard confirms the overlay opened.
      expect(screen.getByTestId("setup-wizard")).toBeInTheDocument();

      // The overlay wrapper carries the dialog role (D-01 / Plan 03).
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-modal", "true");
      // A dialog must have a non-empty accessible name (aria-labelledby →
      // the current screen heading).
      expect(dialog).toHaveAccessibleName(/\S/);
    });

    // ─── UAT (06-uat fix 9): overlay only on its launching tab ───
    //
    // The wizard overlay used to render on `wizardActive` alone, so a running
    // install covered EVERY tab. The overlay now records its launching tab and is
    // only VISIBLE there; on other tabs it is hidden (display:none + aria-hidden)
    // while the SetupWizard stays MOUNTED (the deploy keeps running). Assert that
    // switching away from the launch tab hides the overlay but keeps the wizard
    // mounted, and switching back reveals it again.
    it("shows the overlay only on the launching tab and keeps the wizard mounted on others", async () => {
      localStorage.setItem("tt_welcome_completed", "true");

      await act(async () => {
        render(<App />);
      });

      // Launch from the control tab → overlay visible (dialog accessible).
      await act(async () => {
        controlPanelProps.onSwitchToSetup();
      });
      expect(screen.getByTestId("setup-wizard")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      // Switch to the connection tab → overlay hidden (display:none → getByRole
      // can't find the now-hidden dialog), but the wizard is STILL mounted so a
      // background install keeps running.
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Подключение/ }));
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByTestId("setup-wizard")).toBeInTheDocument();

      // Switch back to control → overlay visible again.
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Панель управления/ }));
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  // ─── Connection no-config import relocation (D-02 A1) — D-01 / Plan 03 / 06-uat ───
  //
  // D-01 removed the welcome 3-card menu, which was the ONLY place the "import config"
  // action lived. D-02 relocates it onto the existing Connection no-config surface
  // (App.tsx connection.noConfig EmptyState) WITHOUT restyling the Connection section
  // (v2/CONNECT-01, out of scope). 06-uat: the «Забрать с сервера» (fetch) entry was
  // removed end-to-end — fetching an existing user's config is done from the Control Panel
  // (per-user QR/Link). The quiet affordance now goes STRAIGHT to the import modal; there
  // is no fetch button. Assert by role + Russian text only.
  describe("connection import entry (Phase 11 — multi-config ConnectionPanel)", () => {
    // Phase 11: the import affordance moved INTO the multi-config ConnectionPanel
    // (ConfigList's empty-state «Импортировать конфиг» CTA — covered by
    // ConfigList.production.test.tsx). At the App level the panel is mocked, so we assert
    // the App wires an `onImport` callback to the panel and that invoking it opens the
    // reused ImportConfigModal. There is no «Забрать с сервера» fetch entry anywhere.
    it("wires an onImport callback into ConnectionPanel and never a «Забрать с сервера» fetch entry", async () => {
      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Подключение/ }));
      });

      // The App passes an import opener to the panel (the affordance lives inside it).
      expect(typeof connectionPanelProps.onImport).toBe("function");
      // …and the removed fetch entry is NOT present anywhere.
      expect(
        screen.queryByRole("button", { name: /Забрать с сервера/ }),
      ).not.toBeInTheDocument();
    });

    it("the panel's onImport opens the import modal directly", async () => {
      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Подключение/ }));
      });
      // Invoke the import opener the panel was given (the empty-state CTA's wiring).
      await act(async () => {
        connectionPanelProps.onImport();
      });
      // Phase 11 (11-06): App now mounts the PRODUCTION ImportModal — its accessible dialog
      // name «Добавить конфиг» renders when open.
      expect(
        screen.getByRole("dialog", { name: i18n.t("connection.import.title") }),
      ).toBeInTheDocument();
      // The legacy wizard ImportConfigModal is NO LONGER mounted in the Connection tabpanel.
      expect(screen.queryByText(i18n.t("wizard.import.title"))).not.toBeInTheDocument();
    });
  });

  // ─── Drag-drop config-partial → rich in-modal partial UX (19-04, Q3/D-09) ───
  // The global document-level drop handler (useFileDrop) used to fire a per-file flyaway ERROR
  // toast for each failed config + a success snackbar for the ok count — a SEPARATE surface from
  // the file-picker path. 19-04 unifies it: a config batch that partly fails now opens the SAME
  // rich in-modal ImportModal partial view (failed list + «Повторить») that the picker path shows.
  describe("drag-drop config-partial → rich in-modal partial UX (19-04, Q3/D-09)", () => {
    it("opens the ImportModal seeded into its partial view (failed list + «Повторить») when a dropped config batch partly fails", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "read_client_config") return null;
        if (cmd === "get_auto_connect") return false;
        if (cmd === "auto_detect_config") return null;
        if (cmd === "import_dropped_content") {
          // bad.toml is a malformed config → import_dropped_content rejects; good.toml imports.
          if ((args as { fileName?: string })?.fileName === "bad.toml") {
            throw new Error("import failed");
          }
          return { file_type: "config", config_path: "/path/good.toml" };
        }
        if (cmd === "add_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Подключение/ }));
      });

      const good = new File(["[endpoint]"], "good.toml", { type: "" });
      const bad = new File(["broken"], "bad.toml", { type: "" });

      await act(async () => {
        const event = new Event("drop", { bubbles: true }) as DragEvent;
        Object.defineProperty(event, "dataTransfer", { value: { files: [good, bad] } });
        Object.defineProperty(event, "preventDefault", { value: vi.fn() });
        Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
        document.dispatchEvent(event);
      });

      // The SAME rich in-modal partial UX as the picker path opens — its accessible dialog name is
      // «Добавить конфиг», the failed file is listed by NAME only (D-29), and «Повторить» is offered.
      await waitFor(() => {
        expect(
          screen.getByRole("dialog", { name: i18n.t("connection.import.title") }),
        ).toBeInTheDocument();
      });
      expect(screen.getByText("bad.toml")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: i18n.t("connection.import.retry") }),
      ).toBeInTheDocument();
    });

    // WR-05 (19-fix): a SECOND config-partial drop while the modal already shows a partial must NOT
    // silently discard the first batch's retained failed items — it MERGES into the existing partial
    // (both failed files stay listed with their retry closures). Pre-fix the seed effect replaced
    // partial/retryItems, losing the first drop's failures.
    it("merges a second config-partial drop into the open partial view instead of wiping the first", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "read_client_config") return null;
        if (cmd === "get_auto_connect") return false;
        if (cmd === "auto_detect_config") return null;
        if (cmd === "import_dropped_content") {
          const name = (args as { fileName?: string })?.fileName;
          if (name === "bad1.toml" || name === "bad2.toml") throw new Error("import failed");
          return { file_type: "config", config_path: `/path/${name}` };
        }
        if (cmd === "add_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Подключение/ }));
      });

      const dropFiles = (files: File[]) => {
        const event = new Event("drop", { bubbles: true }) as DragEvent;
        Object.defineProperty(event, "dataTransfer", { value: { files } });
        Object.defineProperty(event, "preventDefault", { value: vi.fn() });
        Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
        document.dispatchEvent(event);
      };

      // First drop: good1 ok, bad1 fails → partial view opens with bad1 listed.
      await act(async () => {
        dropFiles([
          new File(["[endpoint]"], "good1.toml", { type: "" }),
          new File(["broken"], "bad1.toml", { type: "" }),
        ]);
      });
      await waitFor(() => {
        expect(screen.getByText("bad1.toml")).toBeInTheDocument();
      });

      // Second drop while the partial is open: good2 ok, bad2 fails → MERGES (both bad files listed).
      await act(async () => {
        dropFiles([
          new File(["[endpoint]"], "good2.toml", { type: "" }),
          new File(["broken"], "bad2.toml", { type: "" }),
        ]);
      });
      await waitFor(() => {
        expect(screen.getByText("bad2.toml")).toBeInTheDocument();
      });
      // The first drop's failed item is STILL listed — not wiped by the second seed.
      expect(screen.getByText("bad1.toml")).toBeInTheDocument();
    });
  });

  // ─── Picker-door config-partial → rich in-modal partial UX (CR-01, 19-fix) ───
  // REGRESSION GUARD for CR-01: before the fix, App's `onImported` prop did
  // `setImportOpen(false)`, so a FILE-PICKER batch that partly failed closed the modal in the
  // same render as `setPartial(...)` — the rich partial view (D-09 headline deliverable) was
  // unreachable through the picker door and stale partial state leaked into the next open. Only
  // the drag-drop door (covered above) promoted via a non-closing callback, which is why the bug
  // hid. The fix makes `onImported` PROMOTE-ONLY; the modal decides when to close (it calls
  // onClose itself only on a FULL-success batch). These tests drive the picker end-to-end.
  describe("picker-door config-partial → rich in-modal partial UX (CR-01, 19-fix)", () => {
    it("keeps the modal open on a picker batch with 1 ok + 1 failing file — failed list + «Повторить», no snackbar", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "read_client_config") return null;
        if (cmd === "get_auto_connect") return false;
        if (cmd === "auto_detect_config") return null;
        if (cmd === "read_config_file_for_import") return "[endpoint]";
        if (cmd === "import_config_from_string") {
          // bad.toml is malformed → the backend import rejects; good.toml imports fine.
          if ((args as { originalFileName?: string })?.originalFileName === "bad.toml") {
            throw new Error("import failed");
          }
          return "/path/good.toml";
        }
        return null;
      });
      // The OS multi-select picker hands back both paths.
      vi.mocked(openDialog).mockResolvedValue(["C:/dl/good.toml", "C:/dl/bad.toml"]);

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Подключение/ }));
      });
      // Open the ImportModal through the panel's import affordance (the picker door).
      await act(async () => {
        connectionPanelProps.onImport();
      });
      // Click the «Из файла» tile → OS picker → batch import.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: new RegExp(i18n.t("connection.import.tile_file")) }),
        );
      });

      // The modal STAYS OPEN in its partial view (the pre-fix defect closed it here).
      await waitFor(() => {
        expect(
          screen.getByRole("dialog", { name: i18n.t("connection.import.title") }),
        ).toBeInTheDocument();
      });
      // Only the FAILED file is listed (by NAME only, D-29); «Повторить» is offered.
      expect(screen.getByText("bad.toml")).toBeInTheDocument();
      expect(screen.queryByText("good.toml")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: i18n.t("connection.import.retry") }),
      ).toBeInTheDocument();
      // A partial batch fires NO success snackbar (feedback stays in-modal, D-09).
      expect(
        screen.queryByText(i18n.t("connection.snackbar.config_added")),
      ).not.toBeInTheDocument();
    });

    it("keeps the modal open when a «Повторить» is again partial", async () => {
      // First batch: good ok, bad1 + bad2 fail → partial (ok=1, 2 failed). Retry re-runs ONLY the
      // failed items; bad1 now succeeds (2nd attempt) but bad2 still fails → the retry is AGAIN
      // partial, so the modal must stay open with bad2 still listed + «Повторить».
      let bad1Attempts = 0;
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "read_client_config") return null;
        if (cmd === "get_auto_connect") return false;
        if (cmd === "auto_detect_config") return null;
        if (cmd === "read_config_file_for_import") return "[endpoint]";
        if (cmd === "import_config_from_string") {
          const name = (args as { originalFileName?: string })?.originalFileName;
          if (name === "bad1.toml") {
            bad1Attempts++;
            if (bad1Attempts >= 2) return "/path/bad1.toml"; // recovers on retry
            throw new Error("import failed");
          }
          if (name === "bad2.toml") throw new Error("import failed"); // never recovers
          return "/path/good.toml";
        }
        return null;
      });
      vi.mocked(openDialog).mockResolvedValue([
        "C:/dl/good.toml",
        "C:/dl/bad1.toml",
        "C:/dl/bad2.toml",
      ]);

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Подключение/ }));
      });
      await act(async () => {
        connectionPanelProps.onImport();
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: new RegExp(i18n.t("connection.import.tile_file")) }),
        );
      });

      // First partial: both bad files listed.
      await waitFor(() => {
        expect(screen.getByText("bad1.toml")).toBeInTheDocument();
      });
      expect(screen.getByText("bad2.toml")).toBeInTheDocument();

      // Retry — re-runs only the two failed items; bad1 recovers, bad2 still fails.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: i18n.t("connection.import.retry") }),
        );
      });

      // Still partial → modal stays open, bad2 remains, bad1 dropped off the failed list.
      await waitFor(() => {
        expect(screen.queryByText("bad1.toml")).not.toBeInTheDocument();
      });
      expect(
        screen.getByRole("dialog", { name: i18n.t("connection.import.title") }),
      ).toBeInTheDocument();
      expect(screen.getByText("bad2.toml")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: i18n.t("connection.import.retry") }),
      ).toBeInTheDocument();
    });
  });

  // ─── Deep-link config import (06-18 C-22 / D-14) ───
  // A clicked tt:// / trusttunnel:// link funnels into a `deep-link-url` event;
  // App routes to the Connection no-config import surface and pre-fills the modal
  // via its initialUrl prop. The URL is NEVER auto-imported — the user must click
  // «Импортировать», which routes through decode_deeplink (the trusted boundary).
  describe("deep-link config import (06-18 C-22/D-14)", () => {
    it("a deep-link-url event navigates to connection and pre-fills the import modal", async () => {
      await act(async () => {
        render(<App />);
      });

      // Fire the deep-link arrival (the same event every channel funnels into).
      await act(async () => {
        emitEvent("deep-link-url", { url: "tt://?ZmFrZQ" });
      });

      // Routed to the Connection tab (its tabpanel becomes the visible one).
      expect(document.getElementById("tabpanel-connection")).toHaveAttribute(
        "aria-hidden",
        "false",
      );

      // Phase 11 (11-06): the production ImportModal opens, pre-filled. Its dialog name
      // «Добавить конфиг» renders and the link field carries the deep-link URL (prefill only).
      expect(
        screen.getByRole("dialog", { name: i18n.t("connection.import.title") }),
      ).toBeInTheDocument();
      const linkInput = screen.getByPlaceholderText(
        i18n.t("connection.import.link_placeholder"),
      ) as HTMLInputElement;
      expect(linkInput.value).toBe("tt://?ZmFrZQ");
    });

    it("does NOT auto-import the pre-filled URL (no decode_deeplink / import without a click)", async () => {
      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        emitEvent("deep-link-url", { url: "tt://garbage" });
      });

      // Modal is open + pre-filled, but no import command fired without a user click
      // (deeplink-never-auto). The production ImportModal's dialog renders pre-filled.
      expect(
        screen.getByRole("dialog", { name: i18n.t("connection.import.title") }),
      ).toBeInTheDocument();

      const invokeCalls = vi.mocked(invoke).mock.calls.map((c) => c[0]);
      expect(invokeCalls).not.toContain("decode_deeplink");
      expect(invokeCalls).not.toContain("import_config_from_string");
    });
  });

  // ─── Plate body-click → Connection tab (Phase 13, 13-09 Fix 2) ───
  // Clicking the connection notification plate's BODY invokes Rust `restore_main_window`, which
  // shows+focuses the window and then emits `navigate-to-tab` with the tab id ("connection"). App
  // listens (useNavigateToTab) and switches the active tab. This proves the FE side of Fix 2: the
  // event lands the user on the Connection tab regardless of which tab they were last on.
  describe("navigate-to-tab event (Phase 13 — plate body-click opens Connection)", () => {
    it("switches the active tab to Connection when a navigate-to-tab 'connection' event arrives", async () => {
      // Start on a DIFFERENT tab (routing) so we can prove the event actually switches TO Connection.
      localStorage.setItem("tt_config_path", "/config.json");
      localStorage.setItem("tt_active_page", "routing");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });

      // Move to the Routing tab so Connection is definitively NOT the active tab beforehand.
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Маршрутизация/ }));
      });
      expect(document.getElementById("tabpanel-connection")).toHaveAttribute("aria-hidden", "true");

      // The plate body-click path: Rust emits navigate-to-tab with the Connection tab id.
      await act(async () => {
        emitEvent("navigate-to-tab", "connection");
      });

      // Now the Connection tab is the visible one.
      expect(document.getElementById("tabpanel-connection")).toHaveAttribute("aria-hidden", "false");
      expect(document.getElementById("tabpanel-routing")).toHaveAttribute("aria-hidden", "true");
    });

    it("ignores a navigate-to-tab event carrying an unknown tab id", async () => {
      // Only the known "connection" id is honoured — a stray/unknown payload must NOT move the tab.
      localStorage.setItem("tt_config_path", "/config.json");
      localStorage.setItem("tt_active_page", "routing");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });

      // Sit on the Routing tab.
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Маршрутизация/ }));
      });
      expect(document.getElementById("tabpanel-routing")).toHaveAttribute("aria-hidden", "false");

      await act(async () => {
        emitEvent("navigate-to-tab", "totally-unknown");
      });

      // Still on Routing — the unknown id was ignored.
      expect(document.getElementById("tabpanel-routing")).toHaveAttribute("aria-hidden", "false");
      expect(document.getElementById("tabpanel-connection")).toHaveAttribute("aria-hidden", "true");
    });
  });

  // ─── Theme management ───

  it("sets data-theme attribute on document element", async () => {
    await act(async () => {
      render(<App />);
    });
    const theme = document.documentElement.getAttribute("data-theme");
    expect(["dark", "light"]).toContain(theme);
  });

  it("theme defaults to system (dark via matchMedia mock)", async () => {
    await act(async () => {
      render(<App />);
    });
    // matchMedia mock returns matches=true for dark query
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("theme toggle cycles dark → light → system", async () => {
    localStorage.setItem("tt_theme", "dark");
    await act(async () => {
      render(<App />);
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // Find and click the theme toggle button (sidebar has moon/sun icon)
    // Sidebar exposes onThemeToggle — we can find the sidebar theme button
    const themeBtn = document.querySelector('button[title="Тема"]') ||
      document.querySelector('button[aria-label*="theme"]');
    if (themeBtn) {
      // dark → light
      await act(async () => { fireEvent.click(themeBtn); });
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(localStorage.getItem("tt_theme")).toBe("light");

      // light → system
      await act(async () => { fireEvent.click(themeBtn); });
      expect(localStorage.getItem("tt_theme")).toBe("system");

      // system → dark
      await act(async () => { fireEvent.click(themeBtn); });
      expect(localStorage.getItem("tt_theme")).toBe("dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    }
  });

  it("respects saved theme from localStorage", async () => {
    localStorage.setItem("tt_theme", "light");
    await act(async () => {
      render(<App />);
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("listens for system theme changes when mode is system", async () => {
    localStorage.setItem("tt_theme", "system");
    await act(async () => {
      render(<App />);
    });
    // matchMedia addEventListener should have been called
    expect(mockMatchMedia).toHaveBeenCalled();
  });

  // ─── Language management ───

  it("language starts as Russian", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(i18n.language).toBe("ru");
  });

  it("language toggle switches ru → en", async () => {
    await act(async () => {
      render(<App />);
    });
    const langBtn = document.querySelector('button[title="Язык"]') ||
      document.querySelector('button[aria-label*="language"]');
    if (langBtn) {
      await act(async () => { fireEvent.click(langBtn); });
      expect(i18n.language).toBe("en");
      expect(localStorage.getItem("tt_language")).toBe("en");
    }
  });

  // ─── VPN event listeners ───

  it("listens for vpn-status, internet-status, and vpn-log events", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(listenCallbacks["vpn-status"]).toBeDefined();
    expect(listenCallbacks["vpn-status"].length).toBeGreaterThanOrEqual(1);
    expect(listenCallbacks["internet-status"]).toBeDefined();
    expect(listenCallbacks["vpn-log"]).toBeDefined();
  });

  it("calls check_vpn_status_full on mount", async () => {
    // Phase 1 (Codex MEDIUM): the mount snapshot now uses check_vpn_status_full so
    // a late-mounting window recovers BOTH status and error, not just status.
    await act(async () => {
      render(<App />);
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("check_vpn_status_full");
  });

  it("fires migrate_configs exactly once on mount (before the Connection list loads)", async () => {
    // Phase 11 (P11-02): startup migrates the legacy single tt_config_path into the
    // configs.json manifest. The effect is once-guarded (didMigrateRef) against
    // StrictMode's double-invoke, so the command must fire EXACTLY ONCE per mount.
    localStorage.setItem("tt_config_path", "/legacy/config.json");

    await act(async () => {
      render(<App />);
    });

    // Called with the legacy active path read from localStorage (the migration input).
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("migrate_configs", {
      legacyActivePath: "/legacy/config.json",
    });
    // …and only once — the once-guard must not let StrictMode double-run it.
    const migrateCalls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "migrate_configs");
    expect(migrateCalls).toHaveLength(1);
  });

  // ─── VPN connect/disconnect flow ───

  it("vpn-status event updates status to connected", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    // Simulate VPN connected event
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    // StatusPanel should receive connected status
    expect(statusPanelProps.status).toBe("connected");
    expect(statusPanelProps.connectedSince).toBeInstanceOf(Date);
  });

  it("vpn-status event updates status to disconnected and clears connectedSince", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    // Connect then disconnect
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });
    expect(statusPanelProps.connectedSince).toBeInstanceOf(Date);

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    expect(statusPanelProps.status).toBe("disconnected");
    expect(statusPanelProps.connectedSince).toBeNull();
  });

  it("vpn-status event with error sets error", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "Server refused the connection" });
    });

    // F16: the core's fixed English phrase is localized on the StatusPanel banner (ru locale here),
    // never leaked raw — proves localizeError maps the core strings, not just the ASCII reason codes.
    expect(statusPanelProps.error).toBe(i18n.t("errors.connection_refused"));
  });

  // ─── Control Panel tab connection-error surface (Phase 19, 19-01 Bug 1 / D-01/D-02) ───
  //
  // Verified gap: showStatusPanel = hasConfig && activeTab !== "control" (App.tsx) hid ALL in-app
  // status — including the error banner — on the Control Panel tab; with the window open the desktop
  // plate is ALSO suppressed, so a live connection error was invisible in-app on the control tab
  // (only the tray went red). D-01/D-02 (Q1 = FE route): the in-app connection-error surface (the
  // StatusPanel error banner, whose × routes through the existing handleDismiss → clear_vpn_error →
  // gray tray) must render on the control tab too when an error is LIVE — while a NON-error status
  // still shows no panel there (only the error case bypasses the tab gate; other tabs unchanged).
  describe("Control Panel tab connection-error surface (Phase 19 — D-01/D-02)", () => {
    async function renderWithConfigOnControlTab() {
      localStorage.setItem("tt_config_path", "/config.json");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        return null;
      });
      await act(async () => {
        render(<App />);
      });
      // Make the Control Panel tab the active one (that is where the gap lives).
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Панель управления/ }));
      });
    }

    it("renders the in-app error surface on the Control Panel tab when a connection error is live", async () => {
      await renderWithConfigOnControlTab();
      // Idle / non-error on the control tab → no status panel yet.
      expect(screen.queryByTestId("status-panel")).not.toBeInTheDocument();

      // A live connection error arrives.
      await act(async () => {
        emitEvent("vpn-status", { status: "error", error: "Server refused the connection" });
      });

      // The in-app error surface (StatusPanel) is now visible ON the control tab, carrying the
      // localized error — its × acknowledges through the SAME StatusPanel.handleDismiss path.
      expect(screen.getByTestId("status-panel")).toBeInTheDocument();
      expect(statusPanelProps.status).toBe("error");
      expect(statusPanelProps.error).toBe(i18n.t("errors.connection_refused"));
    });

    it("shows NO status panel on the Control Panel tab for a non-error status (unchanged, D-02)", async () => {
      await renderWithConfigOnControlTab();
      // A connected (non-error) status must NOT drag the full status panel onto the control tab —
      // only the error case bypasses the control-tab gate.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });
      expect(screen.queryByTestId("status-panel")).not.toBeInTheDocument();
    });

    it("removes the control-tab error surface once the error is acknowledged (status leaves error)", async () => {
      await renderWithConfigOnControlTab();
      await act(async () => {
        emitEvent("vpn-status", { status: "error", error: "Server refused the connection" });
      });
      expect(screen.getByTestId("status-panel")).toBeInTheDocument();

      // Acknowledge → status moves off Error to Disconnected (the gray-tray transition); the
      // error-only surface disappears from the control tab (it is gated on the live error).
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
      });
      expect(screen.queryByTestId("status-panel")).not.toBeInTheDocument();
    });
  });

  it("vpn-status recovering → disconnected resolves to Disconnected (terminal NoConfig — F0)", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    // 02-20: the AUTHORITATIVE status now comes from vpn-status (the internet-status
    // handler no longer sets status). The backend drives «Восстановление» on a local-net
    // loss via a vpn-status "recovering" event.
    await act(async () => {
      emitEvent("vpn-status", { status: "recovering" });
    });
    expect(statusPanelProps.status).toBe("recovering");

    // F0 (Codex M1): from «Восстановление» a "disconnected" is TERMINAL — the network
    // came back but there is no saved config to reconnect to (WR-03), or a give-up
    // cleanup resolved to Disconnected. It must NOT be suppressed; the old no-dwell guard
    // hid it and stuck the UI on red «Восстановление» forever.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    expect(statusPanelProps.status).toBe("disconnected");
  });

  it("vpn-status reconnecting → disconnected COMMITS when no manual reconnect is in flight (tray disconnect — AUDIT #8)", async () => {
    // Re-pinned (AUDIT-2026-06-11 #8): this test used to assert the OLD unconditional
    // no-dwell suppression — exactly the bug. A backend-driven "reconnecting" (auto-
    // reconnect supervisor) followed by a bare "disconnected" is a TRAY disconnect:
    // the backend emits no intermediate status (D-09) and the supervisor's T-31 abort
    // forces Disconnected. Suppressing it left the window stuck on «Переподключение»
    // forever while the tray went grey. The suppression now requires an actually
    // in-flight MANUAL reconnect (manualReconnectActiveRef, raised only by
    // useVpnActions.handleReconnect) — that no-dwell path is pinned end-to-end in
    // useVpnActions.test.ts; here no manual reconnect ran, so the event must land.
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    // Backend auto-reconnect drives the status to "reconnecting" (no frontend action).
    await act(async () => {
      emitEvent("vpn-status", { status: "reconnecting" });
    });
    expect(statusPanelProps.status).toBe("reconnecting");

    // Tray disconnect → single terminal "disconnected" — must COMMIT, not be eaten.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    expect(statusPanelProps.status).toBe("disconnected");
  });

  it("handleConnect invokes vpn_connect with config", async () => {
    localStorage.setItem("tt_config_path", "/my/config.json");
    localStorage.setItem("tt_log_level", "debug");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    // Call onConnect via StatusPanel props
    await act(async () => {
      await statusPanelProps.onConnect();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/my/config.json",
      logLevel: "debug",
    });
    // Phase 13 (13-08b): the active-config connect pushes the config's known reachability ping BEFORE
    // vpn_connect so the notification plate shows a real number (replacing the fresh probe of the
    // active endpoint, which read Unreachable by design → «—»). No ping probe has resolved for this
    // config in this test, so the pushed value is `null` (→ the plate renders «—», honest no-data).
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_connect_ping", { ms: null });
    // The push must PRECEDE the connect (mirrors the origin-before-connect pattern).
    const pingIdx = vi
      .mocked(invoke)
      .mock.calls.findIndex(
        (c) => c[0] === "set_pending_connect_ping" && (c[1] as { ms?: number | null })?.ms === null,
      );
    const connectIdx = vi
      .mocked(invoke)
      .mock.calls.findIndex((c) => c[0] === "vpn_connect");
    expect(pingIdx).toBeGreaterThanOrEqual(0);
    expect(pingIdx).toBeLessThan(connectIdx);
  });

  it("manual connect stamps origin=Manual before vpn_connect (13-10 §B no origin leak)", async () => {
    // Phase 13 (13-10 / §B): the manual connect path must explicitly set origin=Manual right before
    // connecting, so a STALE AutoConnectLaunch/AutoSwitch origin (a shared AppState cell whose Connected
    // was only observed via the mount snapshot, so it was never consumed) can never leak in and
    // mislabel a manual connect «Автоподключение при запуске». Assert the manual connect pushes
    // set_pending_connect_origin { origin: "manual" } BEFORE vpn_connect.
    localStorage.setItem("tt_config_path", "/my/config.json");
    localStorage.setItem("tt_log_level", "debug");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      await statusPanelProps.onConnect();
    });

    // The manual connect explicitly asserts its own origin.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_connect_origin", {
      origin: "manual",
    });
    // …and it must PRECEDE the connect, so the Rust Connected edge reads Manual → «Подключено».
    const originIdx = vi
      .mocked(invoke)
      .mock.calls.findIndex(
        (c) =>
          c[0] === "set_pending_connect_origin" &&
          (c[1] as { origin?: string })?.origin === "manual",
      );
    const connectIdx = vi
      .mocked(invoke)
      .mock.calls.findIndex((c) => c[0] === "vpn_connect");
    expect(originIdx).toBeGreaterThanOrEqual(0);
    expect(originIdx).toBeLessThan(connectIdx);
  });

  // ─── Manual connect/switch plate ping (13-12: fresh-probe fallback mirrors the launch path) ───
  //
  // Owner UAT (phase 13): the connect plate showed «—» on a MANUAL connect/switch but a real
  // number on the LAUNCH auto-connect — asymmetric ping supply. The manual path read ONLY the
  // background usePerConfigPing map (numeric `valueMs` exists just for an ok band; a timed-out /
  // not-yet-probed target pushed null), while the launch path fresh-probed the still-disconnected
  // target. pushPendingConnectPing now mirrors the launch probe as a SLOW-PATH fallback, and every
  // caller AWAITS the push before connecting (a direct connect has no teardown window, so a
  // fire-and-forget probe would land its push AFTER the Rust Connected edge already peeked the cell).

  it("manual switch pushes the target's numeric map ping before vpn_connect (fast path — no fresh probe)", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_log_level", "info");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "list_configs")
        return [
          { id: "id-1", name: "C1", host: "h1.example.com", user: "u", path: "/config.json", order: 0, last_used: true },
          { id: "id-2", name: "C2", host: "h2.example.com", user: "u", path: "/other.toml", order: 1, last_used: false },
        ];
      // A MANUAL ping round lands a NUMERIC band for the target (ok → valueMs) in the App-level map.
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 42 };
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    // The ping loop is MANUAL now (no auto sweep). Trigger one round through the App-level source so the
    // target's numeric band lands in the ping map — the fast path of pushPendingConnectPing reads it.
    await act(async () => {
      await connectionPanelProps.source.refreshPings();
    });

    // F23 (14-UAT round 2): count probes of the SWITCH TARGET only. The manual round probed the
    // inactive target already; the fast-path contract is only that the TARGET (/other.toml) is not
    // freshly RE-probed at switch time (its map value is used), so we snapshot the count now and assert
    // it does not grow across the switch.
    const targetProbesBefore = vi
      .mocked(invoke)
      .mock.calls.filter(
        (c) => c[0] === "ping_config_endpoint" && (c[1] as { configPath?: string })?.configPath === "/other.toml",
      ).length;

    // Manual switch to the inactive config (ConnectionPanel's onSwitchTo → handleConnectConfig).
    // FAB-02: performSwitch now PARKS on the terminal `vpn-status` edge after B spawns, so fire the
    // switch (capturing its promise), let the ping/connect chain run, then settle it with a
    // `connected` edge. The ping-before-connect ordering asserted below all happens BEFORE the park.
    let switchPromise: Promise<unknown> | undefined;
    await act(async () => {
      switchPromise = connectionPanelProps.onSwitchTo("/other.toml");
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
      await switchPromise;
    });

    // The EXACT map number was pushed…
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_connect_ping", { ms: 42 });
    // …with NO fresh probe (the fast path reads the map synchronously — no manual round ran during the
    // switch, so any new probe of the target here would be the — forbidden — slow-path fallback)…
    const targetProbesAfter = vi
      .mocked(invoke)
      .mock.calls.filter(
        (c) => c[0] === "ping_config_endpoint" && (c[1] as { configPath?: string })?.configPath === "/other.toml",
      ).length;
    expect(targetProbesAfter).toBe(targetProbesBefore);
    // …and BEFORE vpn_connect (mirrors the origin-before-connect ordering contract).
    const calls = vi.mocked(invoke).mock.calls;
    const pingIdx = calls.findIndex(
      (c) => c[0] === "set_pending_connect_ping" && (c[1] as { ms?: number | null })?.ms === 42,
    );
    const connectIdx = calls.findIndex((c) => c[0] === "vpn_connect");
    expect(pingIdx).toBeGreaterThanOrEqual(0);
    expect(connectIdx).toBeGreaterThanOrEqual(0);
    expect(pingIdx).toBeLessThan(connectIdx);
  });

  it("manual switch with NO numeric band falls back to a fresh ping_config_endpoint probe and pushes its ms before vpn_connect", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_log_level", "info");
    // The background sweep answers no-data (a band WITHOUT valueMs — e.g. a timed-out sweep);
    // the switch-time FRESH probe then answers ok/87. This is the exact owner-UAT case: a
    // genuinely reachable target whose background band is non-numeric must still show a real
    // plate ping instead of «—».
    let probeResult: { status: string; ms?: number } = { status: "no-data" };
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "list_configs")
        return [
          { id: "id-1", name: "C1", host: "h1.example.com", user: "u", path: "/config.json", order: 0, last_used: true },
          { id: "id-2", name: "C2", host: "h2.example.com", user: "u", path: "/other.toml", order: 1, last_used: false },
        ];
      if (cmd === "ping_config_endpoint") return probeResult;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // From now on the endpoint answers — only the fresh switch-time probe sees this.
    probeResult = { status: "ok", ms: 87 };

    // FAB-02: fire the switch, let the probe/connect chain run, then settle on the terminal edge.
    let switchPromise: Promise<unknown> | undefined;
    await act(async () => {
      switchPromise = connectionPanelProps.onSwitchTo("/other.toml");
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
      await switchPromise;
    });

    // The fallback probe targeted the SWITCH TARGET with the launch-path bound (1500ms — not the
    // 3000ms background-sweep bound; distinguishes the fresh probe from sweep probes)…
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("ping_config_endpoint", {
      configPath: "/other.toml",
      timeoutMs: 1500,
    });
    // …its number was pushed…
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_connect_ping", { ms: 87 });
    // …BEFORE vpn_connect (the awaited push means the Rust Connected edge cannot outrun it).
    const calls = vi.mocked(invoke).mock.calls;
    const pingIdx = calls.findIndex(
      (c) => c[0] === "set_pending_connect_ping" && (c[1] as { ms?: number | null })?.ms === 87,
    );
    const connectIdx = calls.findIndex((c) => c[0] === "vpn_connect");
    expect(pingIdx).toBeGreaterThanOrEqual(0);
    expect(connectIdx).toBeGreaterThanOrEqual(0);
    expect(pingIdx).toBeLessThan(connectIdx);
  });

  it("manual switch fallback pushes null when the fresh probe answers non-ok (honest «—»)", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_log_level", "info");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "list_configs")
        return [
          { id: "id-1", name: "C1", host: "h1.example.com", user: "u", path: "/config.json", order: 0, last_used: true },
          { id: "id-2", name: "C2", host: "h2.example.com", user: "u", path: "/other.toml", order: 1, last_used: false },
        ];
      // Both the background sweep AND the fresh fallback probe read unreachable → no number exists.
      if (cmd === "ping_config_endpoint") return { status: "unreachable" };
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // FAB-02: fire the switch, let the probe/connect chain run, then settle on the terminal edge.
    let switchPromise: Promise<unknown> | undefined;
    await act(async () => {
      switchPromise = connectionPanelProps.onSwitchTo("/other.toml");
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
      await switchPromise;
    });

    // A non-ok fresh probe pushes an honest null («—») — and the switch still connects.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_connect_ping", { ms: null });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/other.toml",
      logLevel: "info",
    });
    const calls = vi.mocked(invoke).mock.calls;
    const pingIdx = calls.findIndex(
      (c) => c[0] === "set_pending_connect_ping" && (c[1] as { ms?: number | null })?.ms === null,
    );
    const connectIdx = calls.findIndex((c) => c[0] === "vpn_connect");
    expect(pingIdx).toBeGreaterThanOrEqual(0);
    expect(connectIdx).toBeGreaterThanOrEqual(0);
    expect(pingIdx).toBeLessThan(connectIdx);
  });

  it("manual connect pushes null and still connects when the fresh probe THROWS (never blocks the connect)", async () => {
    localStorage.setItem("tt_config_path", "/my/config.json");
    localStorage.setItem("tt_log_level", "debug");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      // Older backend / non-Tauri env: the probe command itself rejects — the push must
      // degrade to null and the connect must proceed (no error state, no hang).
      if (cmd === "ping_config_endpoint") throw new Error("unknown command");
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    // The ACTIVE-config entry point (handleConnectActive — status panel / shortcut).
    await act(async () => {
      await statusPanelProps.onConnect();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_connect_ping", { ms: null });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/my/config.json",
      logLevel: "debug",
    });
    // The throw was contained: the connect flow reached "connecting", not "error".
    expect(statusPanelProps.status).toBe("connecting");
  });

  // ─── Fable-A review #1/#2: the synchronous in-flight guard over the manual connect initiators ───
  //
  // The 13-12 awaited pre-connect probe opened a ≤1500ms window in which status stays
  // "disconnected" while nothing is visibly happening — the «Подключить» button and the
  // Ctrl-connect shortcut gate stayed live. A second activation in that window ran a FULL second
  // connect: it either hit the Rust R8 guard («VPN is already running» → the FE catch flipped to
  // "error" over a live tunnel) or, in the tighter race, two vpn_connect calls both passed the
  // guard.is_none() pre-flight window and spawned TWO sidecars (leaking the first
  // killswitch-owning process). connectInFlightRef closes the window synchronously.

  it("a second manual activation during the awaited pre-connect probe window is a NO-OP (in-flight guard)", async () => {
    localStorage.setItem("tt_config_path", "/my/config.json");
    localStorage.setItem("tt_log_level", "info");
    // Hold the slow-path fresh probe OPEN so the test can activate again mid-await — the exact
    // window the guard exists to close.
    let resolveProbe: ((v: unknown) => void) | undefined;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "ping_config_endpoint")
        return new Promise((res) => {
          resolveProbe = res;
        });
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      const first = statusPanelProps.onConnect();
      // The double-fire: a second click / Ctrl-shortcut while the first is still awaiting the
      // probe. The guard must swallow it — NOT run a second connect.
      const second = statusPanelProps.onConnect();
      resolveProbe?.({ status: "ok", ms: 55 });
      await Promise.all([first, second]);
    });

    // Exactly ONE vpn_connect fired for the two activations.
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "vpn_connect").length).toBe(1);

    // The guard was RELEASED in the `finally` — a later, deliberate re-activation still works
    // (a failed/hung guard would have wedged the button forever).
    await act(async () => {
      const third = statusPanelProps.onConnect();
      resolveProbe?.({ status: "ok", ms: 56 });
      await third;
    });
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "vpn_connect").length).toBe(2);
  });

  // ─── Fable-A review #3: the save-and-reconnect plate ping ───

  it("save-and-reconnect pushes origin=manual + the fresh-probe ping AFTER the teardown and BEFORE its vpn_connect", async () => {
    // handleReconnect («Сохранить и переподключить») was the ONLY initiator reaching vpn_connect
    // without pushing pending_connect_ping / stamping origin=Manual — its terminal «Подключено»
    // plate deterministically rendered ping «—». It now runs App's pushPendingConnectPing (threaded
    // into useVpnActions) after the teardown wait (endpoint inactive → the fresh probe reads a real
    // number) and before the reconnect's vpn_connect.
    localStorage.setItem("tt_config_path", "/my/config.json");
    localStorage.setItem("tt_log_level", "info");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 33 };
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    // A live session: the reconnect is only reachable while connected.
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    let reconnectPromise: Promise<void>;
    await act(async () => {
      // RoutingPanel stays mounted on every tab; its onReconnect is App's guarded reconnect.
      reconnectPromise = routingPanelProps.onReconnect();
      await Promise.resolve();
    });
    // The teardown completes (sidecar down) → resolves the reconnect wait; push + connect follow.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise!;
    });

    // The reconnect leg now wears the same belts as every other connect initiator:
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_connect_origin", {
      origin: "manual",
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_connect_ping", { ms: 33 });
    // Ordering: teardown vpn_disconnect → ping push → reconnect vpn_connect. Pushing BEFORE the
    // teardown would probe the still-active endpoint (reads Unreachable by design → «—»); pushing
    // after vpn_connect could lose to the Rust Connected edge.
    const calls = vi.mocked(invoke).mock.calls;
    const names = calls.map((c) => c[0]);
    const disconnectIdx = names.indexOf("vpn_disconnect");
    const pingIdx = calls.findIndex(
      (c) => c[0] === "set_pending_connect_ping" && (c[1] as { ms?: number | null })?.ms === 33,
    );
    const connectIdx = names.indexOf("vpn_connect");
    expect(disconnectIdx).toBeGreaterThanOrEqual(0);
    expect(pingIdx).toBeGreaterThan(disconnectIdx);
    expect(connectIdx).toBeGreaterThan(pingIdx);
  });

  // IN-04: removed the "handleConnect sets error when configPath is empty"
  // placeholder — it contained no `expect`, so it always passed regardless of
  // behaviour and gave false coverage confidence for the empty-config-path
  // branch. The empty-path branch is not reachable through any prop exposed to
  // this test, so rather than assert nothing we drop the test; if that branch
  // becomes testable (e.g. via an injectable prop) it should be re-added with a
  // real assertion.

  it("handleConnect fails with error when invoke rejects", async () => {
    localStorage.setItem("tt_config_path", "/my/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") throw new Error("VPN connect failed");
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      await statusPanelProps.onConnect();
    });

    expect(statusPanelProps.status).toBe("error");
    expect(statusPanelProps.error).toContain("VPN connect failed");
  });

  it("handleDisconnect invokes vpn_disconnect", async () => {
    localStorage.setItem("tt_config_path", "/my/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      await statusPanelProps.onDisconnect();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_disconnect");
    expect(statusPanelProps.status).toBe("disconnecting");
  });

  // ─── BUG-A2 (17-uat): the RACE-SAFE user «Отмена» / handleUserCancel ───
  //
  // handleUserCancel is the disconnect wired to every FE-reachable disconnect BUTTON (Connection lead
  // card, StatusPanel, RoutingPanel, VpnContext). Its gate is `isSwitching || reconnectResolve.current
  // !== null`, NOT `connectInFlightRef`. These tests are the exact regression guard for BUG-A: they
  // must FAIL if the reconnectResolve gate is removed (the naive fix that ungated the disconnect and
  // let a cancel resolve the SHARED reconnectResolve latch early → double-spawn storm + lock-up).
  describe("BUG-A2 — race-safe user cancel (handleUserCancel)", () => {
    it("PROCEEDS during a plain connect (status connecting, reconnectResolve null) → fires vpn_disconnect", async () => {
      // A plain connect from disconnected: connectInFlightRef is held for the connect span but
      // reconnectResolve is NEVER armed (no teardown), so the cancel MUST tear the connect down.
      localStorage.setItem("tt_config_path", "/my/config.json");
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        if (cmd === "ping_config_endpoint") return { status: "ok", ms: 20 };
        if (cmd === "vpn_connect") return null;
        if (cmd === "vpn_disconnect") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      await gotoSettings();

      // Fire the connect (its finally releases connectInFlightRef once vpn_connect resolves).
      await act(async () => {
        await statusPanelProps.onConnect();
      });
      // The tunnel is coming up — the live status is «Подключение».
      await act(async () => {
        emitEvent("vpn-status", { status: "connecting" });
      });
      expect(statusPanelProps.status).toBe("connecting");

      const before = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "vpn_disconnect").length;
      // The «Отмена» (StatusPanel onDisconnect === App handleUserCancel) — reconnectResolve is null,
      // isSwitching false → it PROCEEDS and tears the connect down.
      await act(async () => {
        await statusPanelProps.onDisconnect();
      });
      const after = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "vpn_disconnect").length;
      expect(after).toBe(before + 1); // exactly one vpn_disconnect fired by the cancel
      expect(statusPanelProps.status).toBe("disconnecting");
    });

    it("is INERT while a save-and-reconnect teardown latch is armed (reconnectResolve !== null) — no double vpn_disconnect", async () => {
      // THE core regression guard. A manual «Сохранить и переподключить» arms the SHARED
      // reconnectResolve during its teardown wait (handleReconnect: after vpn_disconnect, before the
      // `disconnected` event). A cancel landing in THAT window must be INERT — firing vpn_disconnect
      // again (or resolving the latch) is exactly the BUG-A double-spawn storm. If the reconnectResolve
      // gate is removed, a SECOND vpn_disconnect fires here and this test fails.
      localStorage.setItem("tt_config_path", "/my/config.json");
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        if (cmd === "ping_config_endpoint") return { status: "ok", ms: 33 };
        if (cmd === "vpn_connect") return null;
        if (cmd === "vpn_disconnect") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      // A live session so the reconnect is reachable.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      // Fire the save-and-reconnect but DO NOT emit the teardown `disconnected` — the flow parks with
      // reconnectResolve ARMED (the exact dangerous window).
      let reconnectPromise: Promise<void> | undefined;
      await act(async () => {
        reconnectPromise = routingPanelProps.onReconnect();
        // Let the teardown vpn_disconnect resolve so reconnectResolve.current is armed for the wait.
        await Promise.resolve();
        await Promise.resolve();
      });
      const teardownCount = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "vpn_disconnect").length;
      expect(teardownCount).toBe(1); // only the reconnect's own teardown so far

      // A cancel in the armed window — MUST be inert (no extra vpn_disconnect, latch untouched).
      await act(async () => {
        await routingPanelProps.onDisconnect();
      });
      expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "vpn_disconnect").length).toBe(1);

      // Release the latch so the reconnect completes cleanly (proves the latch was still intact).
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await reconnectPromise!;
      });
      // The reconnect proceeded to its own vpn_connect (the flow was never derailed by the cancel).
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
        configPath: "/my/config.json",
        logLevel: "info",
      });
    });

    it("is INERT while a seamless switch is in flight (isSwitching) — no cancel-driven vpn_disconnect", async () => {
      // During a seamless A→B switch isSwitching is true AND reconnectResolve is armed across the
      // teardown; a cancel must be inert so it cannot race the swap. The switch does its OWN single
      // teardown vpn_disconnect; a cancel in that window must add NO further vpn_disconnect.
      const CFG_A = "/config-a.toml";
      const CFG_B = "/config-b.toml";
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        if (cmd === "list_configs")
          return [
            { id: "id-a", name: "A", host: "a.example.com", user: "u", path: CFG_A, order: 0, last_used: true },
            { id: "id-b", name: "B", host: "b.example.com", user: "u", path: CFG_B, order: 1, last_used: false },
          ];
        if (cmd === "ping_config_endpoint") return { status: "ok", ms: 30 };
        if (cmd === "vpn_connect") return null;
        if (cmd === "vpn_disconnect") return null;
        void args;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // Seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch (sets isSwitching).
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      // Fire the switch WITHOUT settling it — isSwitching is true, the teardown is in flight.
      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      expect(connectionPanelProps.isSwitching).toBe(true);

      const before = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "vpn_disconnect").length;
      // The lead card «Отмена» (connectionPanelProps.onDisconnect === App handleUserCancel) must be
      // INERT mid-switch — no extra vpn_disconnect.
      await act(async () => {
        await connectionPanelProps.onDisconnect();
      });
      const after = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "vpn_disconnect").length;
      expect(after).toBe(before); // cancel added nothing

      // Let the switch settle so nothing dangles (teardown → B connects).
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "connected" });
        await switchPromise;
      });
    });

    it("Fable F1: a REAL button-click cancel (connecting → click «Отмена» → disconnected event) toasts «Подключение отменено»", async () => {
      // The Fable F1 regression guard: this drives the ACTUAL button path, NOT a synthesized
      // recovering→disconnected edge (which passed spuriously). handleUserCancel sets connectCancelledRef
      // + handleDisconnect sets the optimistic `disconnecting`, so the terminal `disconnected` arrives
      // with prev="disconnecting" — the FLAG (not prev) must carry the cancel to «Подключение отменено».
      localStorage.setItem("tt_config_path", "/my/config.json");
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        if (cmd === "ping_config_endpoint") return { status: "ok", ms: 20 };
        if (cmd === "vpn_connect") return null;
        if (cmd === "vpn_disconnect") return null;
        return null;
      });

      const pushSpy = vi.spyOn(i18n, "t");
      await act(async () => {
        render(<App />);
      });
      await gotoSettings();

      // Real connect → live status «Подключение».
      await act(async () => {
        await statusPanelProps.onConnect();
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "connecting" });
      });
      expect(statusPanelProps.status).toBe("connecting");

      pushSpy.mockClear();
      // Click «Отмена» — handleUserCancel sets connectCancelledRef, handleDisconnect sets optimistic
      // `disconnecting` (status flips) and calls vpn_disconnect.
      await act(async () => {
        await statusPanelProps.onDisconnect();
      });
      expect(statusPanelProps.status).toBe("disconnecting");
      // The Rust terminal `disconnected` edge lands (prev is now `disconnecting`).
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
      });

      // The cancel snackbar copy was resolved (via the flag) — never the neutral «VPN отключён».
      expect(pushSpy).toHaveBeenCalledWith("messages.connect_cancelled", "Connection cancelled");
      expect(pushSpy).not.toHaveBeenCalledWith("messages.vpn_disconnected", "VPN disconnected");
      // Part B (cancel notification): handleUserCancel ALSO mirrors the cancel intent into Rust so the
      // desktop PLATE (window-closed) shows «Подключение отменено» not «Отключено». It is invoked at
      // the SAME point as connectCancelledRef (in-flight connect/recovery cancel only).
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_pending_cancel", { pending: true });
      pushSpy.mockRestore();
    });

    it("Fable F1: a connected «Отключить» (connectCancelledRef stays false) toasts the neutral «VPN отключён»", async () => {
      // A genuine live-tunnel disconnect: handleUserCancel does NOT set connectCancelledRef (statusRef is
      // `connected`, not connecting/recovering), so the terminal edge routes the neutral «VPN отключён».
      localStorage.setItem("tt_config_path", "/my/config.json");
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        if (cmd === "vpn_disconnect") return null;
        return null;
      });

      const pushSpy = vi.spyOn(i18n, "t");
      await act(async () => {
        render(<App />);
      });
      await gotoSettings();
      // Live tunnel.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });
      expect(statusPanelProps.status).toBe("connected");

      pushSpy.mockClear();
      // «Отключить» → handleUserCancel (statusRef=connected → flag NOT set) → handleDisconnect.
      await act(async () => {
        await statusPanelProps.onDisconnect();
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
      });

      expect(pushSpy).toHaveBeenCalledWith("messages.vpn_disconnected", "VPN disconnected");
      expect(pushSpy).not.toHaveBeenCalledWith("messages.connect_cancelled", "Connection cancelled");
      // Part B (cancel notification): a genuine connected «Отключить» must NOT raise the Rust cancel
      // intent — statusRef is `connected`, so handleUserCancel skips the flag branch entirely and the
      // desktop plate stays «Отключено», never «Подключение отменено».
      expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_pending_cancel", { pending: true });
      pushSpy.mockRestore();
    });

    it("Fable F1: a genuine connect FAILURE (error payload) toasts the red snack:error, not «отменено»", async () => {
      // A real failure arrives as an `error` status with a reason; the connectCancelledRef is not set
      // (no user cancel), so it routes the localized red error snackbar — never the cancel toast.
      localStorage.setItem("tt_config_path", "/my/config.json");
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        if (cmd === "ping_config_endpoint") return { status: "ok", ms: 20 };
        if (cmd === "vpn_connect") return null;
        return null;
      });

      const pushSpy = vi.spyOn(i18n, "t");
      await act(async () => {
        render(<App />);
      });
      await gotoSettings();
      await act(async () => {
        await statusPanelProps.onConnect();
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "connecting" });
      });
      pushSpy.mockClear();
      // The core fails the connect straight to `error` with a reason — no user cancel involved.
      await act(async () => {
        emitEvent("vpn-status", { status: "error", error: "connect-timeout" });
      });

      // Never the cancel toast; the status reflects the genuine failure.
      expect(pushSpy).not.toHaveBeenCalledWith("messages.connect_cancelled", "Connection cancelled");
      expect(statusPanelProps.status).toBe("error");
      expect(statusPanelProps.error).toBe(i18n.t("errors.connect_timeout"));
      pushSpy.mockRestore();
    });
  });

  // ─── Internet status (DISPLAY-ONLY — reconnect is driven in Rust) ───
  //
  // Plan 02-04 deleted the frontend-driven reconnect: the window-independent Rust
  // supervisor (connectivity.rs) is now the SOLE owner of auto-reconnect, and the
  // internet-status listener in useVpnEvents only DISPLAYS the recovering label /
  // give-up message — it never invokes vpn_disconnect or vpn_connect. These tests
  // assert that current reality. Plan 02-12 removed the previous three tests that
  // still asserted the deleted `action === "reconnect"` reconnect (they expected
  // the frontend to invoke vpn_connect / vpn_disconnect on an internet-status
  // event, behaviour that no longer exists) and replaced them with the display-only
  // contract below.

  it("internet-status disconnect sets the recovering BANNER but NOT the status, and invokes no VPN commands (02-20: vpn-status owns status)", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      emitEvent("internet-status", { online: false, action: "disconnect" });
    });

    // 02-20 conflict fix: the handler shows the descriptive banner …
    expect(statusPanelProps.error).toBe(i18n.t("errors.internet_lost_disconnecting"));
    // … but does NOT set the status — the authoritative vpn-status event owns it now
    // (forcing recovering here would clobber a backend tunnel-lost `reconnecting`).
    // The status stays at the pre-event value (initial "disconnected").
    expect(statusPanelProps.status).toBe("disconnected");
    // … and it must NOT drive recovery from the frontend — the Rust supervisor owns
    // that now, and a frontend disconnect/connect would fight it (Plan 02-04).
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_disconnect");
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("internet-status reconnect action is IGNORED by the frontend (no vpn_connect) — Rust owns reconnect", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_log_level", "info");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      emitEvent("internet-status", { online: true, action: "reconnect" });
    });

    // The `action === "reconnect"` branch was DELETED in Plan 02-04 — the frontend
    // must NOT invoke vpn_connect on this event anymore (no double-reconnect window).
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("internet-status give_up shows the recovery-timeout banner but no longer forces the status (02-20)", async () => {
    // 02-20: the give_up branch keeps surfacing the friendly message, but no longer
    // sets the status — the terminal STATUS (error) arrives via the vpn-status event
    // carrying the `recovery-timeout` reason code (the single status owner, D-01).
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      emitEvent("internet-status", { online: false, action: "give_up" });
    });

    // The friendly message is surfaced …
    expect(statusPanelProps.error).toBe(i18n.t("errors.network_recovery_timeout"));
    // … but the status is untouched by this handler (stays at the initial value).
    expect(statusPanelProps.status).toBe("disconnected");
  });

  // ─── Auto-connect on startup ───

  it("auto-connects when tt_auto_connect is true", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_log_level", "info");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") return null;
      // Phase 11 (P11-03): auto-connect now targets the manifest's last-used config
      // (resolved via list_configs), not the single tt_config_path. 12-07: the App now also
      // feeds list_configs to useConfigPingSource (dedupe + candidate build), so the fixture
      // returns the FULL ConfigSummary shape list_configs really emits.
      if (cmd === "list_configs")
        return [{ id: "id-1", name: "Config 1", host: "h1.example.com", user: "u1", path: "/config.json", order: 0, last_used: true }];
      if (cmd === "ping_config_endpoint") return { status: "no-data" };
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Auto-connect fires after 1500ms; advance with the async timer so the
    // list_configs resolve + the connect microtask chain settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("does not auto-connect when tt_auto_connect is not set", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("auto-connect error sets error status", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") throw new Error("Auto-connect failed");
      // Phase 11 (P11-03): auto-connect resolves the last-used config from the manifest.
      // 12-07: full ConfigSummary shape (App now also feeds it to useConfigPingSource).
      if (cmd === "list_configs")
        return [{ id: "id-1", name: "Config 1", host: "h1.example.com", user: "u1", path: "/config.json", order: 0, last_used: true }];
      if (cmd === "ping_config_endpoint") return { status: "no-data" };
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    // Allow microtasks to complete
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(statusPanelProps.status).toBe("error");
  });

  // ─── Smart auto-switch engine wiring (Phase 12, plan 12-07) ───

  it("wires the App-level config-ping source into ConnectionPanel (single ping loop)", async () => {
    // The engine + the cards must share ONE inactive-ping source (T-12-14). App owns it via
    // useConfigPingSource and passes it to ConnectionPanel as `source` — assert that prop exists
    // and carries the candidate list the engine consumes.
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "list_configs")
        return [
          { id: "id-1", name: "C1", host: "h1.example.com", user: "u", path: "/config.json", order: 0, last_used: true },
          { id: "id-2", name: "C2", host: "h2.example.com", user: "u", path: "/other.toml", order: 1, last_used: false },
        ];
      if (cmd === "ping_config_endpoint") return { status: "no-data" };
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // The source prop is wired with a candidate list (the inactive config, excluding the active one).
    expect(connectionPanelProps.source).toBeDefined();
    expect(Array.isArray(connectionPanelProps.source.candidates)).toBe(true);
    const candidatePaths = connectionPanelProps.source.candidates.map((c: { path: string }) => c.path);
    expect(candidatePaths).toContain("/other.toml");
    expect(candidatePaths).not.toContain("/config.json"); // the active config is never a candidate
  });

  it("does NOT auto-switch while the master toggle is OFF (default), even when connected", async () => {
    // The engine is INERT unless masterOn (default OFF). With a connected tunnel and a healthy
    // candidate available, no switch (vpn_connect/vpn_disconnect for a switch) must fire.
    localStorage.setItem("tt_config_path", "/config.json");
    // tt_auto_switch_enabled is unset → masterOn defaults false. tt_auto_connect unset → no startup connect.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "list_configs")
        return [
          { id: "id-1", name: "C1", host: "h1.example.com", user: "u", path: "/config.json", order: 0, last_used: true },
          { id: "id-2", name: "C2", host: "h2.example.com", user: "u", path: "/other.toml", order: 1, last_used: false },
        ];
      // A HEALTHY candidate — if the engine were live it would switch to it. With master OFF it must not.
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 10 };
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    // Mark the tunnel connected so the engine's status gate would be satisfied if master were on.
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });
    // Advance well past several engine intervals (default 15s) — the engine must stay inert.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // No switch was attempted: the only allowed switch path (switchTo → vpn_connect to /other.toml)
    // never fired. (The startup auto-connect is also off, so vpn_connect must not be called at all.)
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  // ─── Config validation on startup ───

  it("reads config on startup and sets vpn mode", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "proxy" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("read_client_config", { configPath: "/config.json" });
    // vpnMode is passed to routing panel
    expect(routingPanelProps.vpnMode).toBe("proxy");
  });

  it("invalid config clears localStorage and resets to wizard", async () => {
    localStorage.setItem("tt_config_path", "/invalid/config.json");
    localStorage.setItem("tt_active_page", "settings");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") throw new Error("Config not found");
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Should have cleared config and reset to server page
    await waitFor(() => {
      expect(localStorage.getItem("tt_config_path")).toBeFalsy();
    });
  });

  it("auto-detect config when no saved path", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "auto_detect_config") return "/detected/config.json";
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("auto_detect_config");
  });

  // ─── VPN status sync on mount ───

  it("syncs to connected status on mount", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status_full") return { status: "connected", error: null };
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    expect(statusPanelProps.status).toBe("connected");
    expect(statusPanelProps.connectedSince).toBeInstanceOf(Date);
  });

  it("syncs to connecting status on mount", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status_full") return { status: "connecting", error: null };
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    expect(statusPanelProps.status).toBe("connecting");
    expect(statusPanelProps.connectedSince).toBeNull();
  });

  it("syncs to error status AND restores the reason on late mount", async () => {
    // Phase 1 (Codex MEDIUM): a window that mounts AFTER an error event must
    // recover BOTH the status and the backend's (sanitized) reason via the
    // check_vpn_status_full snapshot — not render "error" with no detail.
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status_full") {
        return { status: "error", error: "Configuration parse error. Check your config file." };
      }
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    expect(statusPanelProps.status).toBe("error");
    // F16: the core's fixed English phrase is localized on the StatusPanel banner (ru locale), never raw.
    expect(statusPanelProps.error).toBe(i18n.t("errors.config_parse_error"));
    expect(statusPanelProps.connectedSince).toBeNull();
  });

  // ─── Navigation / tab switching ───

  it("navigates to saved page on startup", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "routing");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("routing-panel")).toBeInTheDocument();
  });

  it("maps old tab name 'setup' to control page", async () => {
    localStorage.setItem("tt_active_tab", "setup");
    // No config — shows control panel

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("control-panel-page")).toBeInTheDocument();
  });

  it("maps old tab name 'about' to 'about' page", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("about-panel")).toBeInTheDocument();
  });

  it("defaults to settings when config exists but no saved page", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    // No tt_active_page set

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("connection-panel")).toBeInTheDocument();
  });

  it("persists active page to localStorage on change", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Navigate via sidebar click
    const aboutBtn = document.querySelector('button[title="О программе"]');
    if (aboutBtn) {
      await act(async () => { fireEvent.click(aboutBtn); });
      expect(localStorage.getItem("tt_active_page")).toBe("about");
    }
  });

  // ─── Update check ───

  it("checks for updates on mount", async () => {
    await act(async () => {
      render(<App />);
    });

    // The probe leaves the webview: obligation 1 / RESEARCH L-1.
    expect(invoke).toHaveBeenCalledWith("check_app_update_info");
  });

  it("update available when remote version is newer", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.0.0");

    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "check_app_update_info")
        return appUpdateWire({
          current_version: "1.0.0",
          latest_version: "2.0.0",
          latest_tag: "v2.0.0",
          available: true,
          download_url: "https://example.com/Pro-setup.exe",
          release_notes: "New features",
        });
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.available).toBe(true);
      expect(aboutPanelProps.updateInfo?.latestVersion).toBe("2.0.0");
      expect(aboutPanelProps.updateInfo?.downloadUrl).toBe("https://example.com/Pro-setup.exe");
    });
  });

  it("update not available when current version is newer", async () => {
    vi.mocked(getVersion).mockResolvedValue("3.0.0");

    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "check_app_update_info")
        return appUpdateWire({
          current_version: "3.0.0",
          latest_version: "2.0.0",
          latest_tag: "v2.0.0",
          available: false,
        });
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.available).toBe(false);
    });
  });

  it("update check failure is handled gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_app_update_info") return Promise.reject("server-unreachable");
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Update check failed:", expect.anything());
    });

    consoleSpy.mockRestore();
  });

  it("a failed check leaves the update dot dark (hasAppUpdate stays false)", async () => {
    // App.tsx derives `hasAppUpdate` from `appAvailable ?? available`. A check that
    // never succeeded must not light the tab nudge — that is the same lie as the
    // up-to-date plate this phase removed from the card.
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_app_update_info") return Promise.reject("no-internet");
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.checkError).toBe("no-internet");
    });
    expect(aboutPanelProps.updateInfo?.appAvailable).toBe(false);
    expect(aboutPanelProps.updateInfo?.available).toBe(false);

    consoleSpy.mockRestore();
  });

  // ─── VPN log collector ───

  // vpn-log tests removed — LogPanel no longer rendered in App.tsx (D-05: logs folded into connection tab)

  // STATUS-03 / D-07: the frontend no longer infers status from vpn-log text.
  // A fatal log line still enriches the user-facing error MESSAGE (setError),
  // but the error STATUS now arrives via the authoritative backend "vpn-status"
  // event (emitted by sidecar.rs for these same markers in plan 01-01). These
  // tests assert the new contract: message yes, status-from-log no.
  const FATAL_LOG_MARKERS: Array<[string, string]> = [
    ["Authorization Required", "Authorization Required"],
    ["WintunCreateAdapter", "WintunCreateAdapter cannot find module"],
    ["Failed to create listener", "Failed to create listener on port 1080"],
    ["Connection refused", "Connection refused by remote host"],
    ["adapter setup timeout", "Failed to setup adapter: Timed out"],
  ];

  it.each(FATAL_LOG_MARKERS)(
    "vpn-log %s sets a friendly error message but does NOT set status (D-07)",
    async (_name, line) => {
      localStorage.setItem("tt_config_path", "/config.json");

      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      await gotoSettings();

      await act(async () => {
        emitEvent("vpn-log", { message: line, source: "stderr" });
      });

      // Friendly message still surfaces …
      expect(statusPanelProps.error).toBeTruthy();
      // … but status is NOT inferred from the log line — it stays disconnected
      // (snapshot-on-mount value) until a real vpn-status event changes it.
      expect(statusPanelProps.status).not.toBe("error");
      expect(statusPanelProps.status).toBe("disconnected");
    },
  );

  it("error STATUS now arrives only via the backend vpn-status event", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "Authorization failed" });
    });

    expect(statusPanelProps.status).toBe("error");
    // F16: the core's fixed «Authorization failed» phrase is localized on the banner (ru locale).
    expect(statusPanelProps.error).toBe(i18n.t("errors.auth_required"));
  });

  // vpn-log empty messages test removed — LogPanel no longer rendered in App.tsx

  // ─── Clear config ───
  // Phase 11: the per-config "clear/remove" action moved off the Connection panel into
  // the per-card delete flow (delete_config, covered by manifest.rs tests); the old
  // handleClearConfig App test was removed with that prop.

  // ─── Status panel visibility ───

  it("does not show StatusPanel on server page", async () => {
    await act(async () => {
      render(<App />);
    });
    // activePage is "server" by default without config
    // StatusPanel should not be visible
    expect(screen.queryByTestId("status-panel")).not.toBeInTheDocument();
  });

  it("shows StatusPanel on settings page when config exists", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    // Phase 11: the StatusPanel strip is no longer injected into the Connection tab (the
    // lead-card lifecycle owns it; it stays on Settings/About). Navigate to Settings and
    // assert the StatusPanel actually renders there.
    await gotoSettings();

    expect(screen.getByTestId("status-panel")).toBeInTheDocument();
  });

  // ─── Connected since persistence ───

  it("restores connectedSince from localStorage", async () => {
    const past = new Date("2025-01-01T00:00:00Z");
    localStorage.setItem("tt_connected_since", past.toISOString());
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    await gotoSettings();

    expect(statusPanelProps.connectedSince).toBeInstanceOf(Date);
  });

  // ─── Dashboard panel props ───

  // DashboardPanel test removed — Dashboard disbanded per D-04, no longer rendered in App.tsx

  // ─── Routing panel props ───

  it("passes correct props to RoutingPanel", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "routing");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(routingPanelProps.configPath).toBe("/config.json");
    expect(routingPanelProps.status).toBe("disconnected");
    expect(typeof routingPanelProps.onConnect).toBe("function");
    expect(typeof routingPanelProps.onDisconnect).toBe("function");
    expect(typeof routingPanelProps.onReconnect).toBe("function");
  });

  // ─── Control panel callbacks ───

  it("ControlPanelPage onConfigExported updates config", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "control");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      controlPanelProps.onConfigExported("/new/exported/config.json");
    });

    expect(localStorage.getItem("tt_config_path")).toBe("/new/exported/config.json");
  });

  it("ControlPanelPage onSwitchToSetup resets wizard key", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_tab", "control");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // onSwitchToSetup increments wizard key (stays on control tab)
    await act(async () => {
      controlPanelProps.onSwitchToSetup();
    });

    // With config present, app starts on connection tab — onSwitchToSetup doesn't navigate
    expect(localStorage.getItem("tt_active_tab")).toBe("connection");
  });

  it("ControlPanelPage onNavigateToSettings navigates to settings", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "control");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      controlPanelProps.onNavigateToSettings();
    });

    expect(localStorage.getItem("tt_active_page")).toBe("settings");
  });

  // ─── VPN status persistence ───

  it("persists VPN status to localStorage", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(localStorage.getItem("tt_vpn_status")).toBe("connected");
  });

  // ─── compareVersions tests (indirectly via update check) ───

  it("EDGE adjacency: identical version strings → not available, the up-to-date branch", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.5.0");

    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      // The comparison itself now happens in Rust (compare_semver); what the front
      // end owes is that it renders the command's verdict rather than re-deriving one.
      if (cmd === "check_app_update_info")
        return appUpdateWire({ current_version: "1.5.0", latest_version: "1.5.0", available: false });
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.available).toBe(false);
      expect(aboutPanelProps.updateInfo?.checkError).toBeNull();
    });
  });

  // ─── Reconnect disconnect resolve listener ───

  it("reconnect disconnect resolve listener fires on vpn-status disconnected", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // There should be multiple vpn-status listeners (status sync + reconnect resolve)
    expect(listenCallbacks["vpn-status"].length).toBeGreaterThanOrEqual(2);
  });

  // ─── Update: find exe/msi asset ───

  it("carries the installer URL and its checksum through from the command", async () => {
    // Asset selection moved into Rust with the check; what this asserts is that the
    // front end still carries both the URL and the digest, because `self_update`
    // needs the pair and losing the digest would silently disarm the tamper control.
    vi.mocked(getVersion).mockResolvedValue("1.0.0");

    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "check_app_update_info")
        return appUpdateWire({
          current_version: "1.0.0",
          latest_version: "2.0.0",
          latest_tag: "v2.0.0",
          available: true,
          download_url: "https://example.com/Pro-setup.exe",
          sha256: "b".repeat(64),
        });
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.downloadUrl).toBe("https://example.com/Pro-setup.exe");
    });
    expect(aboutPanelProps.updateInfo?.sha256).toBe("b".repeat(64));
  });

  // ─── Phase 18 — Welcome tour mount logic (REQ-18-ONBOARDING-01..04) ───

  describe("Welcome tour", () => {
    it("first-run user (нет tt_welcome_completed + нет tt_ssh_last_host) видит WelcomeTour", async () => {
      localStorage.clear();

      await act(async () => {
        render(<App />);
      });

      expect(screen.getByTestId("welcome-tour-overlay")).toBeVisible();
      // Active screen — Screen 1.
      expect(screen.getByTestId("welcome-tour-screen-1")).toBeVisible();
    });

    it("existing user (tt_ssh_last_host есть) НЕ видит WelcomeTour даже без tt_welcome_completed (REQ-18-ONBOARDING-04, Pitfall 8)", async () => {
      localStorage.setItem("tt_ssh_last_host", "1.2.3.4");

      await act(async () => {
        render(<App />);
      });

      expect(screen.queryByTestId("welcome-tour-overlay")).not.toBeInTheDocument();
    });

    it("existing user может вручную вызвать WelcomeTour событием tt-show-welcome-tour (About → «Приветственный тур»)", async () => {
      // Configured user: auto-skip suppresses the first-run tour.
      localStorage.setItem("tt_ssh_last_host", "1.2.3.4");
      localStorage.setItem("tt_welcome_completed", "true");

      await act(async () => {
        render(<App />);
      });

      expect(screen.queryByTestId("welcome-tour-overlay")).not.toBeInTheDocument();

      // The manual trigger (the window event AboutPanel dispatches) re-opens the
      // tour on demand, bypassing the existing-user auto-skip.
      await act(async () => {
        window.dispatchEvent(new CustomEvent("tt-show-welcome-tour"));
      });

      expect(screen.getByTestId("welcome-tour-overlay")).toBeVisible();
    });

    it("completed user (tt_welcome_completed === \"true\") НЕ видит WelcomeTour", async () => {
      localStorage.setItem("tt_welcome_completed", "true");

      await act(async () => {
        render(<App />);
      });

      expect(screen.queryByTestId("welcome-tour-overlay")).not.toBeInTheDocument();
    });

    it("после complete() WelcomeTour unmount-ится (state flip)", async () => {
      localStorage.clear();

      await act(async () => {
        render(<App />);
      });

      // Тур видим.
      expect(screen.getByTestId("welcome-tour-overlay")).toBeVisible();

      // X corner close → complete writes localStorage + onComplete('skip') flips state.
      await act(async () => {
        fireEvent.click(screen.getByTestId("welcome-tour-close"));
      });

      // Overlay больше не в DOM.
      expect(screen.queryByTestId("welcome-tour-overlay")).not.toBeInTheDocument();
      expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
    });
  });

  // ─── 06-17 — Cross-app entry-flow unification (C-21/D-17, C-24) ───

  describe("06-17 entry flow", () => {
    // Drives the WelcomeTour to its final screen and clicks «Начать».
    async function finishOnboardingStart() {
      // Navigate Screen 1 → 2 → 3 via the right arrow, then click start.
      await act(async () => {
        fireEvent.click(screen.getByTestId("welcome-tour-arrow-right"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("welcome-tour-arrow-right"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("welcome-tour-start"));
      });
    }

    it("C-21/D-17: onboarding «Начать» с НЕТ конфига → вкладка «Панель управления» (control), не в петлю Подключения", async () => {
      localStorage.clear();
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "auto_detect_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      // First-run tour is visible (no config, no tt_ssh_last_host).
      expect(screen.getByTestId("welcome-tour-overlay")).toBeVisible();

      await finishOnboardingStart();

      // The control tabpanel is active (aria-hidden=false), Connection is hidden.
      expect(document.getElementById("tabpanel-control")).toHaveAttribute("aria-hidden", "false");
      expect(document.getElementById("tabpanel-connection")).toHaveAttribute("aria-hidden", "true");
    });

    it("C-21/D-17: onboarding «Начать» С конфигом → вкладка «Подключение» (connection)", async () => {
      localStorage.clear();
      // Config present → wizard auto-skip is NOT engaged because tt_ssh_last_host is
      // absent, so the tour still shows; but completion must route to connection.
      localStorage.setItem("tt_config_path", "/config.json");
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      expect(screen.getByTestId("welcome-tour-overlay")).toBeVisible();

      await finishOnboardingStart();

      expect(document.getElementById("tabpanel-connection")).toHaveAttribute("aria-hidden", "false");
      expect(document.getElementById("tabpanel-control")).toHaveAttribute("aria-hidden", "true");
    });

    // C-24 «Забрать с сервера» fetch-entry test REMOVED (06-uat): the fetch flow was
    // removed end-to-end from the Connection no-config affordance (fetching an existing
    // user's config is done from the Control Panel via per-user QR/Link). There is no
    // longer a «Забрать с сервера» button to seed a fetch-mode wizard.

    it("C-26: emitting tray-navigate {target:install} активирует вкладку «Панель управления»", async () => {
      // Start on the connection tab (config present) so the route change is observable.
      localStorage.setItem("tt_config_path", "/config.json");
      localStorage.setItem("tt_ssh_last_host", "1.2.3.4"); // suppress the welcome tour
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });
      // Starts on connection (saved config path).
      expect(document.getElementById("tabpanel-connection")).toHaveAttribute("aria-hidden", "false");

      await act(async () => {
        emitEvent("tray-navigate", { target: "install" });
      });

      expect(document.getElementById("tabpanel-control")).toHaveAttribute("aria-hidden", "false");
      expect(document.getElementById("tabpanel-connection")).toHaveAttribute("aria-hidden", "true");
    });
  });

  // ─── Phase 14 (Wave 0, plan 14-01): the App-level isSwitching lifecycle + revert ───
  //
  // RED SCAFFOLD — these tests pin Phase-14's seamless-switch contract (D-07/D-12/D-13/D-05/
  // D-05-impl) BEFORE any production code exists. They MUST FAIL until the later vertical slices
  // land (isSwitching state in App, the `isSwitching` prop threaded to ConnectionPanel, the
  // capture-before-promote revert, and the info-variant revert banner). The whole describe is
  // scaffolded RED via `it` (not `it.todo`) so the failure is observable in the suite; the
  // pre-existing App tests above stay GREEN (no production change in this plan).
  //
  // OBSERVABLE SEAM: ConnectionPanel is mocked here (connectionPanelProps captures its props), so
  // App-level `isSwitching` is asserted through the prop the panel WILL receive
  // (connectionPanelProps.isSwitching) and through activeConfigPath repointing on revert. The
  // amber card FACE / control lock themselves are unit-tested at the ConfigList/ConfigCard tier.
  describe("Phase 14 — isSwitching lifecycle + revert (RED until 14-02/14-03/14-04)", () => {
    // The two-config manifest every switch test drives: A is the live/last-used config, B is the
    // inactive target the user switches to. list_configs returns them last-used-first (Rust order).
    const CFG_A = "/config-a.toml";
    const CFG_B = "/config-b.toml";
    // WR-02: `extra` also receives the invoke ARGS so a test can branch on the vpn_connect target
    // (e.g. fail only CFG_B but let the A-reconnect succeed). Existing single-arg overrides keep
    // working — the second parameter is simply ignored by them.
    function twoConfigInvoke(extra?: (cmd: string, args?: unknown) => unknown) {
      return async (cmd: string, args?: unknown) => {
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        if (cmd === "list_configs")
          return [
            { id: "id-a", name: "A", host: "a.example.com", user: "u", path: CFG_A, order: 0, last_used: true },
            { id: "id-b", name: "B", host: "b.example.com", user: "u", path: CFG_B, order: 1, last_used: false },
          ];
        // 14-02 fix: consult the per-test `extra` override BEFORE the default ping response, so a
        // test that holds `ping_config_endpoint` open (to park the switch handler at its first await
        // and observe the synchronously-set isSwitching flag) actually takes effect. Previously the
        // default `{status:"ok", ms:30}` returned first, so config B always had a NUMERIC ping →
        // pushPendingConnectPing took the fast path (no await), the switch completed synchronously,
        // and the finally cleared isSwitching before the assertion could see it true.
        const e = extra?.(cmd, args);
        if (e !== undefined) return e;
        if (cmd === "ping_config_endpoint") return { status: "ok", ms: 30 };
        if (cmd === "vpn_connect") return null;
        if (cmd === "vpn_disconnect") return null;
        return null;
      };
    }

    // GREEN in 14-02/14-03: isSwitching is set SYNCHRONOUSLY in the same handler window as the
    // config promote — before any await resolves — so the very first re-render already carries the
    // hero-preserving gate + control lock (Pitfall 1: a flag set after the first await flickers one
    // frame). Assert the panel sees isSwitching===true on the first re-render after the switch is
    // triggered, WITHOUT flushing the awaited probe/switch.
    it("sets isSwitching synchronously on switch start (before any await resolves)", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      // Hold the pre-connect probe OPEN so the switch handler is suspended at its FIRST await — the
      // exact window in which the sync-set flag must already be true. F23 (14-UAT round 2): promoting
      // to B makes the FORMER active A a NEW inactive ping target, so useConfigPingSource fires an
      // EXTRA ping_config_endpoint(A) that would overwrite a single resolver — collect ALL held probe
      // resolvers and settle them together so the switch's own B-probe is always resolved.
      const probeResolvers: Array<(v: unknown) => void> = [];
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd) => {
          if (cmd === "ping_config_endpoint")
            return new Promise((res) => {
              probeResolvers.push(res);
            });
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      // Trigger the switch but DO NOT resolve the probe yet — the handler is parked at its first
      // await. A synchronously-set flag is already visible on the re-render that the promote caused.
      let switchPromise: Promise<void> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      expect(connectionPanelProps.isSwitching).toBe(true);

      // Let it settle: switchTo tears down A (disconnected). BUG-B (17-uat) B1: the destination probe
      // now runs POST-teardown (honest), so it fires AFTER the disconnected event — resolve any probe
      // resolvers again after emitting disconnected so the seeded post-teardown probe is settled too
      // (before the seeded probe existed, the pre-teardown probe was resolved up front). Then the
      // terminal connected edge it parks on (FAB-02) settles the switch.
      await act(async () => {
        probeResolvers.forEach((res) => res({ status: "ok", ms: 30 }));
        await vi.advanceTimersByTimeAsync(1);
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(1);
        // The post-teardown seeded probe fired now — resolve it (and any A-reprobe) so switchTo proceeds.
        probeResolvers.forEach((res) => res({ status: "ok", ms: 30 }));
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "connected" });
        await switchPromise;
      });
    });

    // 3.7 F-SWITCHDEF (F3): a FRESH connect from a DISCONNECTED state is NOT a switch — isSwitching
    // must stay FALSE (the card shows «Подключение», never the amber «Переключение»). The inverse of
    // the switch tests above (which seed a live tunnel first).
    it("3.7 F-SWITCHDEF: a fresh connect from disconnected keeps isSwitching FALSE", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(twoConfigInvoke());
      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // NO connected edge — the app is DISCONNECTED. Connecting CFG_B is a FRESH connect, not a switch.
      await act(async () => {
        await connectionPanelProps.onSwitchTo(CFG_B);
      });
      expect(connectionPanelProps.isSwitching).toBe(false);
    });

    // 3.7 F-SWITCHDEF (F3): a FRESH connect that FAILS has NO A to revert to — no revert notice; the
    // status lands on error honestly (a switch would revert; a fresh connect does not).
    it("3.7 F-SWITCHDEF: a fresh connect that fails shows no revert notice", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd) => {
          if (cmd === "vpn_connect") throw new Error("connect failed");
          return undefined;
        }),
      );
      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        await connectionPanelProps.onSwitchTo(CFG_B);
      });
      expect(connectionPanelProps.revertNotice).toBeFalsy();
      expect(connectionPanelProps.isSwitching).toBe(false);
    });

    // FAB-02: isSwitching clears when the TERMINAL connected edge arrives. B's process spawns
    // (vpn_connect accepts), then performSwitch PARKS on the real terminal `vpn-status` edge — the
    // switch does NOT settle on switchTo's spawn-accept return. So we fire the switch (capturing its
    // promise WITHOUT awaiting — it is parked on the terminal edge), emit `connected`, THEN await.
    it("clears isSwitching atomically on the terminal connected edge (FAB-02)", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(twoConfigInvoke());

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch (a fresh
      // connect keeps isSwitching false — tested separately).
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      // Fire the switch; a real switch first tears down A (waits for "disconnected") then connects B
      // and parks on B's terminal edge. Do NOT await here — it stays in flight.
      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      // Still in flight (amber lock held) whether parked at the teardown wait or the terminal edge.
      expect(connectionPanelProps.isSwitching).toBe(true);

      // Teardown A completes → switchTo connects B → B reaches Connected → the switch settles.
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "connected" });
        await switchPromise;
      });
      expect(connectionPanelProps.isSwitching).toBe(false);
    });

    // FAB-02: the DOMINANT real "B не подключается" case — B's process SPAWNS (vpn_connect accepts)
    // but B then dies never-connected (broken auth / connect-timeout), emitting a terminal `error`.
    // The silent revert MUST fire on that POST-SPAWN error edge (the old code settled on switchTo's
    // ok:true and skipped the revert). Assert the active pointer reverts to A and the flag clears.
    it("FAB-02: reverts on a POST-SPAWN B failure (B spawns then errors never-connected)", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      // B's vpn_connect ACCEPTS (spawns) — default mock returns null for vpn_connect. B then dies via
      // the terminal error edge below. The revert's A-reconnect (vpn_connect CFG_A) also accepts.
      vi.mocked(invoke).mockImplementation(twoConfigInvoke());

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      // B spawned → the pointer optimistically shows B while the switch is parked.
      expect(connectionPanelProps.activeConfigPath).toBe(CFG_B);
      expect(connectionPanelProps.isSwitching).toBe(true);

      // Teardown A completes → switchTo connects B → B dies never-connected (terminal error) → revert.
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "error", error: "sidecar-exit" });
        await switchPromise;
      });
      expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
      expect(connectionPanelProps.isSwitching).toBe(false);
    });

    // R2-2 (Fable-5 re-review): a FAILED switch (B errors) must revert to A INSTANTLY — skipTeardown,
    // no spurious SECOND vpn_disconnect (and thus no 5s F-4-silenced «Отключение» dwell). The revert's
    // skipTeardown is now derived from the park OUTCOME (`error` ⇒ B settled), not a stale statusRef
    // re-read in the settle microtask. Lock it: exactly ONE vpn_disconnect (the initial A→B teardown).
    it("R2-2: an error-edge revert uses skipTeardown — exactly one vpn_disconnect, no second teardown", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      let disconnectCalls = 0;
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd) => {
          if (cmd === "vpn_disconnect") disconnectCalls += 1;
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" }); // A→B teardown settles (1st vpn_disconnect)
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "error", error: "sidecar-exit" }); // B dies → revert to A
        await switchPromise;
      });

      expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
      // Exactly ONE vpn_disconnect (the initial teardown). A second would mean the error-edge revert
      // ran a spurious teardown (the R2-2 stale-statusRef regression).
      expect(disconnectCalls).toBe(1);
    });

    // G-19-PING (owner UAT): a failed switch that REVERTS to A must push A's connect-time ping, so A's
    // terminal «Подключено» plate + active card show a real number — NOT «—» (the "восстанавливает
    // подключение к предыдущему конфигу и не отображает ping"). revertToPrevious was the last path reaching
    // vpn_connect without a ping push: switchTo's own seeded push lives INSIDE its teardown block, which the
    // common skipTeardown (error-edge) revert bypasses. Assert the switch+revert pushes set_pending_connect_ping
    // TWICE — once for the forward switch to B, once for the revert to A. Before the fix the revert pushed none
    // (only the forward B push), so A rendered «—».
    it("G-19-PING: an error-edge revert pushes A's connect-time ping (not «—»)", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      let pingPushes = 0;
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd) => {
          if (cmd === "set_pending_connect_ping") pingPushes += 1;
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      // Snapshot AFTER the initial connect settles, so only the switch+revert pushes are counted.
      const before = pingPushes;

      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" }); // A→B teardown settles → forward B push
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "error", error: "sidecar-exit" }); // B dies → revert to A → A push
        await switchPromise;
      });

      expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
      // TWO pushes since the switch began: the forward switch to B AND the revert to A. Before the fix
      // the revert reconnected A without a push (only the forward B push landed) → A's plate showed «—».
      expect(pingPushes - before).toBeGreaterThanOrEqual(2);
    });

    // FAB-02 + F-1 (Fable-5) status-aware backstop: B spawns but NEVER reaches connected AND never
    // emits a terminal edge (a wedged connect that stays «Подключение»). Under 3.8 delay-green a
    // HEALTHY http3 B legitimately warms this long, so the backstop RE-ARMS while the status is still
    // "connecting" and reverts only after the ceiling (SWITCH_SETTLE_MAX_TICKS × 15s = 75s), NOT the
    // first 15s tick — that first-tick revert was the F-1 blocker (phantom revert of a warming B).
    it("FAB-02/F-1: reverts only after the ceiling when B stays «Подключение» with no terminal edge", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(twoConfigInvoke());

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      expect(connectionPanelProps.isSwitching).toBe(true);

      // Teardown A completes → switchTo connects B → B stays «Подключение». Emit the Connecting edge
      // Rust sends for B so the LIVE status is deterministically "connecting" during the park (the
      // exact 3.8 delay-green warming window). F-1: the status-aware backstop then RE-ARMS across the
      // ticks instead of reverting a warming B at the first 15s tick.
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "connecting" });
        await vi.advanceTimersByTimeAsync(0);
      });
      // Advance to one tick short of the ceiling (4 × 15s): still parked, no revert yet (re-arm).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(connectionPanelProps.activeConfigPath).toBe(CFG_B);
      expect(connectionPanelProps.isSwitching).toBe(true);
      await act(async () => {
        // Cross the ceiling → timeout → revert. F-1 defensive: the still-"connecting" B is torn down
        // first (skipTeardown:false), so its teardown wait falls through the 5s safety (no
        // disconnected event follows) before A reconnects.
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(5_000);
        await switchPromise;
      });
      expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
      expect(connectionPanelProps.isSwitching).toBe(false);
    });

    // FAB-02: a failed B is NEVER stamped last-used. `set_last_used` must be called for B ONLY after
    // B's terminal `connected` edge — never on a spawn-accept that then fails. Here B spawns then
    // errors; assert set_last_used was NOT called with B's id.
    it("FAB-02: does NOT stamp last-used for a B that spawns then fails (only after connected)", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      const setLastUsedIds: unknown[] = [];
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd, args) => {
          if (cmd === "set_last_used") {
            setLastUsedIds.push((args as { id?: string } | undefined)?.id);
          }
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "error", error: "sidecar-exit" });
        await switchPromise;
      });

      // B (id-b) must never have been stamped last-used — it never reached connected. (id-a MAY be
      // stamped by the revert's A-reconnect, which is correct — A is the server we stayed on.)
      expect(setLastUsedIds).not.toContain("id-b");
    });

    // FAB-02: the happy path DOES stamp B last-used — but ONLY after the terminal connected edge.
    it("FAB-02: stamps last-used for B only after the terminal connected edge", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      const setLastUsedIds: unknown[] = [];
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd, args) => {
          if (cmd === "set_last_used") {
            setLastUsedIds.push((args as { id?: string } | undefined)?.id);
          }
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      // Not yet stamped — B has only spawned (still tearing down A / connecting B).
      expect(setLastUsedIds).not.toContain("id-b");
      // Teardown A → B connects → terminal connected → NOW stamp B.
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "connected" });
        await switchPromise;
      });
      expect(setLastUsedIds).toContain("id-b");
    });

    // FAB-03: the hero + card lock stay held through the ENTIRE revert leg. On B's error edge the
    // onSettled defensive clear must NOT release isSwitching while the switch guard is held — the
    // revert is still running. Assert isSwitching is still true immediately after the error edge (the
    // revert's A-reconnect is parked at its own await), and only clears once the switch fully settles.
    it("FAB-03: keeps isSwitching held through the revert (onSettled does not release it mid-revert)", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      // B spawns then errors; the revert's A-reconnect is held OPEN so we can observe the mid-revert
      // window (isSwitching must still be true while the revert leg runs).
      let resolveAConnect: ((v: unknown) => void) | undefined;
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd, args) => {
          if (cmd === "vpn_connect") {
            const path = (args as { configPath?: string } | undefined)?.configPath;
            if (path === CFG_A)
              return new Promise((res) => {
                resolveAConnect = res;
              });
          }
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      // Teardown A → B connects → parks; then B dies → revert starts, parked on A's (held-open) reconnect.
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        emitEvent("vpn-status", { status: "error", error: "sidecar-exit" });
        await Promise.resolve();
      });
      // MID-REVERT: the guard is still held, so onSettled's defensive clear did NOT release the lock.
      expect(connectionPanelProps.isSwitching).toBe(true);

      // Release A's reconnect → the whole switch+revert settles and the lock clears atomically.
      await act(async () => {
        resolveAConnect?.(null);
        await switchPromise;
      });
      expect(connectionPanelProps.isSwitching).toBe(false);
    });

    // FAB-01: a manual «Переключиться» while status is `reconnecting`/`recovering` is REFUSED (early
    // no-op) — it must not race the Rust reconnect supervisor. Drive status to `reconnecting`, fire a
    // switch, and assert the active pointer never moved to B (no switch happened) and no vpn_connect
    // for B fired.
    it("FAB-01: refuses a switch while status is reconnecting (races the reconnect supervisor)", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      const connectPaths: unknown[] = [];
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd, args) => {
          if (cmd === "vpn_connect") {
            connectPaths.push((args as { configPath?: string } | undefined)?.configPath);
          }
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // Drive the backend reconnect supervisor status.
      await act(async () => {
        emitEvent("vpn-status", { status: "reconnecting" });
      });

      // Attempt a manual switch to B — it must be REFUSED (no-op).
      await act(async () => {
        await connectionPanelProps.onSwitchTo(CFG_B);
      });

      // The active pointer never moved to B, and B's vpn_connect never fired.
      expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
      expect(connectPaths).not.toContain(CFG_B);
    });

    // GREEN in 14-04: the revert shows a calm INFO banner (ErrorBanner variant="info"), NEVER the
    // red error banner (D-05). B's vpn_connect THROWS at spawn-accept → switchTo returns ok:false →
    // performSwitch reverts immediately (no terminal-edge wait for this leg); the revert's A-reconnect
    // succeeds so the calm notice shows. Key on the banner ROLE + info tone (role="status").
    it("shows a calm info-variant revert banner (never the red error banner) on failure", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      // WR-02: the calm blue «остались на A» info notice is shown ONLY when the A-reconnect ACTUALLY
      // succeeds. Only B (CFG_B) throws; the A-reconnect (vpn_connect with CFG_A) resolves.
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd, args) => {
          if (cmd === "vpn_connect") {
            const path = (args as { configPath?: string } | undefined)?.configPath;
            if (path === CFG_B) throw new Error("B connect failed");
          }
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch (only a real
      // switch reverts to A — a fresh connect has no revert target).
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      // Teardown A → B's vpn_connect throws → switchTo ok:false → revert to A (resolves) → notice STAGED.
      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        await switchPromise;
      });

      // F30 (14-UAT round 3): the calm «…восстановлено» notice is STAGED after the revert's switchTo(A)
      // spawn-accept, but must NOT be shown while A is still «Подключение» — the owner saw it pop over the
      // amber connecting badge, i.e. "restored before it was restored". So it is still null here.
      expect(connectionPanelProps.revertNotice).toBeNull();

      // Only A's REAL `connected` edge commits it (the true moment A is back).
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });
      // F6 (14-UAT): the revert notice renders EMBEDDED inside the lead ConfigCard (not a window-level
      // banner), so App passes it DOWN as the `revertNotice` prop naming the server we stayed on (the
      // info-variant / role="status" / never-red rendering is covered by ConfigCard's own tests).
      expect(connectionPanelProps.revertNotice).toMatch(/восстановлено/);
    });

    // WR-02: the honesty case — when the revert's A-reconnect ALSO fails, the calm blue «остались на A»
    // info notice is SUPPRESSED so the user sees ONLY the honest red error status. B fails AND A fails
    // (any vpn_connect throws) — both at spawn-accept, so the switch+revert settle on this await.
    it("WR-02: suppresses the calm revert notice when the A-reconnect also fails", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd) => {
          if (cmd === "vpn_connect") throw new Error("connect failed");
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // 3.7 F-SWITCHDEF: seed a LIVE tunnel on A so onSwitchTo(CFG_B) is a REAL switch.
      await act(async () => {
        emitEvent("vpn-status", { status: "connected" });
      });

      // Teardown A → B's vpn_connect throws → revert → A's vpn_connect ALSO throws → notice suppressed.
      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await Promise.resolve();
      });
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" });
        await vi.advanceTimersByTimeAsync(5);
        await switchPromise;
      });

      // No calm info notice — only the honest red error remains (the revert's switchTo returned
      // ok:false, so setRevertNotice was never called). The active pointer still repointed to A.
      // F6 (14-UAT): the notice is now the `revertNotice` prop (embedded in the card) — assert unset.
      expect(connectionPanelProps.revertNotice).toBeFalsy();
      expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
    });

    // 3.5 F-VERDICT (F11): a genuine tray/manual disconnect that supersedes a switch mid-flight makes
    // Rust bail vpn_connect(B) to a clean Disconnected WITHOUT spawning (ConnectOutcome spawned:false).
    // performSwitch must then NOT park on a terminal edge (no 15s stuck amber), NOT revert, and NOT
    // show the phantom «остались на A» notice — it just releases the lock and leaves the app disconnected.
    it("F11: a superseded switch (disconnect mid-switch) does NOT revert or show a notice, releases the lock", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      vi.mocked(invoke).mockImplementation(
        twoConfigInvoke((cmd, args) => {
          if (cmd === "vpn_connect") {
            const path = (args as { configPath?: string } | undefined)?.configPath;
            if (path === CFG_B) return { spawned: false, reason: "superseded-by-disconnect" };
          }
          return undefined;
        }),
      );

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        await connectionPanelProps.onSwitchTo(CFG_B);
      });

      // No phantom revert notice, and the amber switch lock was released (no stuck «Переключение»).
      expect(connectionPanelProps.revertNotice).toBeFalsy();
      expect(connectionPanelProps.isSwitching).toBe(false);
    });

    // 3.6 F-TRAY (F10/F11): a genuine tray «Отключить» that lands DURING a switch (while performSwitch
    // is parked on the settle edge) arrives as a `vpn-flow` disconnect@tray event. It must ABORT the
    // park WITHOUT a revert — the user's disconnect wins — releasing the lock and clearing any notice.
    it("F10: a vpn-flow tray disconnect during a switch aborts the park without a revert", async () => {
      localStorage.setItem("tt_config_path", CFG_A);
      localStorage.setItem("tt_log_level", "info");
      // Default mock: vpn_connect(CFG_B) resolves (treated as spawned) so performSwitch PARKS.
      vi.mocked(invoke).mockImplementation(twoConfigInvoke());

      await act(async () => {
        render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Fire the switch but do NOT settle it — it parks waiting for a terminal edge.
      let switchPromise: Promise<unknown> | undefined;
      await act(async () => {
        switchPromise = connectionPanelProps.onSwitchTo(CFG_B);
        await vi.advanceTimersByTimeAsync(10);
      });

      // Mid-park, a genuine tray «Отключить» arrives → vpn-flow disconnect@tray resolves it "external".
      await act(async () => {
        emitEvent("vpn-flow", { action: "disconnect", origin: "tray" });
        await switchPromise;
      });

      // Aborted without a revert: no notice, lock released.
      expect(connectionPanelProps.revertNotice).toBeFalsy();
      expect(connectionPanelProps.isSwitching).toBe(false);
    });
  });
});
