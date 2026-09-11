import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import i18n from "../../shared/i18n";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { ProcessPickerModal } from "./ProcessPickerModal";
import { resetProcessIconCache } from "./useProcessIcons";
import { useRoutingState, type ProcessInfo } from "./useRoutingState";

// The Tauri bridge is mocked globally in src/test/setup.ts; the icon tests below route the icon
// command per test through vi.mocked(invoke).mockImplementation — the project's existing idiom.
const invokeMock = vi.mocked(invoke);

// The OS file dialog is likewise mocked globally; the file-pick tests route its return value per
// test rather than declaring a second mock.
const dialogMock = vi.mocked(openFileDialog);

/** A resolved PNG data URL, shaped exactly like the ones the backend returns. */
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("ProcessPickerModal", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onConfirm: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onClose: any;
  /** Every `names` array the icon command was asked for, in call order. */
  let iconRequests: string[][];

  const processList: ProcessInfo[] = [
    { name: "chrome.exe" },
    { name: "firefox.exe" },
    { name: "code.exe" },
    { name: "node.exe" },
  ];

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onConfirm = vi.fn();
    onClose = vi.fn();
    iconRequests = [];
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    // The icon cache is module-level and lives for the whole app session, so it also survives from
    // one test to the next. Clearing it keeps each test's recorded requests its own.
    resetProcessIconCache();
    dialogMock.mockReset();
    dialogMock.mockResolvedValue(null);
  });

  /** Record every icon request and answer it with `answer(name)`. */
  function routeIconCommand(answer: (name: string) => string | null = () => DATA_URL) {
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_process_icons") {
        const names = (args?.names ?? []) as string[];
        iconRequests.push(names);
        return names.map((name) => ({ name, icon: answer(name) }));
      }
      return null;
    }) as unknown as typeof invoke);
  }

  function renderModal(overrides: {
    open?: boolean;
    loading?: boolean;
    error?: string;
    alreadyAdded?: string[];
    processes?: ProcessInfo[];
  } = {}) {
    return render(
      <ProcessPickerModal
        open={overrides.open ?? true}
        processes={overrides.processes ?? processList}
        loading={overrides.loading ?? false}
        error={overrides.error}
        alreadyAdded={overrides.alreadyAdded ?? []}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
  }

  it("renders nothing when closed", () => {
    renderModal({ open: false });
    expect(screen.queryByText("Выберите процессы")).not.toBeInTheDocument();
  });

  it("renders modal title when open", () => {
    renderModal();
    expect(screen.getByText("Выберите процессы")).toBeInTheDocument();
  });

  it("shows search input", () => {
    renderModal();
    expect(screen.getByPlaceholderText("Поиск по имени...")).toBeInTheDocument();
  });

  it("displays process list", () => {
    renderModal();
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    expect(screen.getByText("firefox.exe")).toBeInTheDocument();
    expect(screen.getByText("code.exe")).toBeInTheDocument();
    expect(screen.getByText("node.exe")).toBeInTheDocument();
  });

  it("shows the program NAME and never a file system path", () => {
    renderModal();

    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    // The row used to render a second line with the full image path, against a field the backend
    // never populated. A full path is `C:\Users\<name>\…` — the Windows user name — which this
    // feature keeps off every other channel including the log. Nothing may put it back on screen.
    expect(screen.queryByText(/^[A-Za-z]:\\/)).not.toBeInTheDocument();
  });

  it("filters processes by search query", async () => {
    renderModal();
    const input = screen.getByPlaceholderText("Поиск по имени...");
    await userEvent.type(input, "chrome");
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    expect(screen.queryByText("firefox.exe")).not.toBeInTheDocument();
  });

  it("shows 'no processes found' when search has no matches", async () => {
    renderModal();
    const input = screen.getByPlaceholderText("Поиск по имени...");
    await userEvent.type(input, "nonexistent");
    expect(screen.getByText("Процессы не найдены")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    renderModal({ loading: true });
    // Loading spinner should be present, no process names
    expect(screen.queryByText("chrome.exe")).not.toBeInTheDocument();
  });

  it("marks already-added processes as disabled", () => {
    renderModal({ alreadyAdded: ["chrome.exe"] });
    // The row's interactive control is now the shared Checkbox (role=checkbox),
    // named by the process. Already-added rows render it disabled.
    const chromeCheckbox = screen.getByRole("checkbox", { name: "chrome.exe" });
    expect(chromeCheckbox).toBeDisabled();
    // Should show 'already added' label
    expect(screen.getByText("добавлен")).toBeInTheDocument();
  });

  // ── One duplicate rule, folded (D-05) ────────────────────────────────────────────────────────
  //
  // The test above passes lowercase on BOTH sides, which is exactly why it never caught the defect:
  // the picker compared exact strings while `addProcess` folded case, and the two rules only agree
  // while every saved name happens to be lowercase. The file-picker door is what breaks that
  // assumption — it stores whatever the user picked, verbatim — so these use a real case mismatch.

  it("marks a process as added when the saved spelling differs only in case", () => {
    // Saved as `Chrome.exe` (picked from disk); enumerated as `chrome.exe` (the backend lowercases).
    renderModal({ alreadyAdded: ["Chrome.exe"] });

    const chromeCheckbox = screen.getByRole("checkbox", { name: "chrome.exe" });
    // Without the folded compare the row is tickable, the button counts it, and `addProcess` then
    // folds, matches and returns the previous state — nothing added, nothing said.
    expect(chromeCheckbox).toBeDisabled();
    expect(screen.getByText("добавлен")).toBeInTheDocument();
  });

  it("does not count a picked file that is already saved under a different case", async () => {
    dialogMock.mockResolvedValue("C:\\Tools\\MyApp\\Chrome.exe");
    renderModal({ alreadyAdded: ["chrome.exe"] });

    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    // The row is there and reads as added; the confirm button promises no addition it cannot make.
    await waitFor(() => expect(screen.getByText("добавлен")).toBeInTheDocument());
    expect(screen.getByText("Добавить выбранные")).toBeInTheDocument();
    expect(screen.queryByText(/Добавить выбранные \(/)).not.toBeInTheDocument();
  });

  it("shows one row for a program picked twice in different letter case", async () => {
    renderModal({ processes: [] });

    dialogMock.mockResolvedValue("C:\\A\\Foo.exe");
    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));
    await screen.findByRole("checkbox", { name: "Foo.exe" });

    dialogMock.mockResolvedValue("C:\\B\\foo.exe");
    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    // One program, one row — the merge dedups on the same folded key the rows compare on.
    await waitFor(() =>
      expect(screen.getAllByRole("checkbox", { name: /^foo\.exe$/i })).toHaveLength(1)
    );
    // And the FIRST spelling survives: folding is a lookup key, never a rewrite of what is stored.
    expect(screen.getByRole("checkbox", { name: "Foo.exe" })).toBeInTheDocument();
    expect(screen.getByText("Добавить выбранные (1)")).toBeInTheDocument();
  });

  it("confirm button is disabled when nothing selected", () => {
    renderModal();
    const confirmBtn = screen.getByText("Добавить выбранные");
    expect(confirmBtn.closest("button")).toBeDisabled();
  });

  it("selects a process and enables confirm", async () => {
    renderModal();
    const codeCheckbox = screen.getByRole("checkbox", { name: "code.exe" });
    await userEvent.click(codeCheckbox);
    // Confirm button should show count and be enabled
    expect(screen.getByText("Добавить выбранные (1)")).toBeInTheDocument();
    const confirmBtn = screen.getByText("Добавить выбранные (1)").closest("button");
    expect(confirmBtn).not.toBeDisabled();
  });

  it("calls onConfirm with selected processes", async () => {
    renderModal();
    await userEvent.click(screen.getByRole("checkbox", { name: "code.exe" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "node.exe" }));
    await userEvent.click(screen.getByText("Добавить выбранные (2)"));
    expect(onConfirm).toHaveBeenCalledWith(expect.arrayContaining(["code.exe", "node.exe"]));
  });

  it("calls onClose when cancel button is clicked", async () => {
    renderModal();
    await userEvent.click(screen.getByText("Отмена"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deselects a process on second click", async () => {
    renderModal();
    const codeCheckbox = screen.getByRole("checkbox", { name: "code.exe" });
    await userEvent.click(codeCheckbox);
    expect(screen.getByText("Добавить выбранные (1)")).toBeInTheDocument();
    await userEvent.click(codeCheckbox);
    // Back to disabled confirm with no count
    expect(screen.getByText("Добавить выбранные")).toBeInTheDocument();
  });

  // ── The shared Input search field ────────────────────────────────────────────────────────────
  //
  // These query by ROLE + ACCESSIBLE NAME rather than by placeholder. That is the assertion: the
  // field this replaced had only a placeholder, which is a hint and not a name, so a role+name
  // lookup only succeeds once the field carries a real aria-label.

  it("exposes the search field by its accessible name and still filters the list", async () => {
    renderModal();
    const input = screen.getByRole("textbox", { name: "Поиск по имени..." });

    await userEvent.type(input, "chrome");

    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    expect(screen.queryByText("firefox.exe")).not.toBeInTheDocument();
  });

  it("offers a clear affordance that empties the query", async () => {
    renderModal();
    const input = screen.getByRole("textbox", { name: "Поиск по имени..." });
    await userEvent.type(input, "chrome");
    expect(screen.queryByText("firefox.exe")).not.toBeInTheDocument();

    // The primitive's own clear ✕ — no hand-rolled button was written for it.
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(input).toHaveValue("");
    expect(screen.getByText("firefox.exe")).toBeInTheDocument();
  });

  // ── The icon slot ────────────────────────────────────────────────────────────────────────────

  it("renders each row's icon slot as skeleton, then image or fallback glyph as answers land", async () => {
    // One controllable batch, so all three states are observable in one render: pending before it
    // settles, then a resolved icon and an unresolvable one side by side.
    let settleBatch: ((rows: { name: string; icon: string | null }[]) => void) | undefined;
    invokeMock.mockImplementation((async (cmd: string) => {
      if (cmd === "get_process_icons") {
        return new Promise((resolve) => {
          settleBatch = resolve as (rows: { name: string; icon: string | null }[]) => void;
        });
      }
      return null;
    }) as unknown as typeof invoke);

    renderModal({ processes: processList.slice(0, 2) });

    await waitFor(() =>
      expect(document.querySelectorAll('[data-process-icon="pending"]')).toHaveLength(2)
    );
    // The request is debounced, so wait for the batch to actually be airborne before settling it —
    // settling a call that has not been made yet would silently do nothing and leave both rows
    // pending, which is exactly the false pass this wait prevents.
    await waitFor(() => expect(settleBatch).toBeDefined());

    await act(async () => {
      settleBatch?.([
        { name: "chrome.exe", icon: DATA_URL },
        { name: "firefox.exe", icon: null },
      ]);
    });

    await waitFor(() => {
      expect(document.querySelectorAll('[data-process-icon="resolved"]')).toHaveLength(1);
      expect(document.querySelectorAll('[data-process-icon="unavailable"]')).toHaveLength(1);
    });
    expect(document.querySelector("img")?.getAttribute("src")).toBe(DATA_URL);
  });

  it("keeps every icon slot the same box before and after the icons arrive", async () => {
    routeIconCommand((name) => (name === "chrome.exe" ? DATA_URL : null));
    renderModal({ processes: processList.slice(0, 2) });

    const boxes = () =>
      [...document.querySelectorAll<HTMLElement>("[data-process-icon]")].map((el) => [
        el.style.width,
        el.style.height,
      ]);

    // Pending.
    expect(boxes()).toEqual([
      ["24px", "24px"],
      ["24px", "24px"],
    ]);

    // Settled — one resolved, one fallback, and the geometry is untouched, so the list cannot
    // reflow as icons fill in.
    await waitFor(() =>
      expect(document.querySelector('[data-process-icon="resolved"]')).toBeInTheDocument()
    );
    expect(boxes()).toEqual([
      ["24px", "24px"],
      ["24px", "24px"],
    ]);
  });

  it("requests icons only for the visible slice, never for the whole list at once", async () => {
    // A realistic picker load: this is the scale D-02 exists for.
    const many: ProcessInfo[] = Array.from({ length: 100 }, (_, i) => ({
      name: `proc${i}.exe`,
    }));
    routeIconCommand();

    renderModal({ processes: many });

    await waitFor(() => expect(iconRequests.length).toBeGreaterThan(0));
    const requested = iconRequests.flat();
    const everyName = new Set(many.map((p) => p.name));

    // A STRICT subset — asking for all hundred would be the freeze this design avoids.
    expect(requested.length).toBeLessThan(many.length);
    expect(requested.every((name) => everyName.has(name))).toBe(true);
    // The rows past the window still exist, at the same size, with an empty slot — no reflow when
    // their icons later arrive.
    const deferred = document.querySelectorAll<HTMLElement>("[data-process-icon-deferred]");
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred[0].style.width).toBe("24px");
  });

  /**
   * Drive a scroll with REAL geometry. jsdom lays nothing out, so `scrollTop`, `clientHeight` and
   * `scrollHeight` all read 0 on every element unless a test defines them. A scroll test that skips
   * this is not testing the scroll maths at all — it is testing what that maths does when handed
   * three zeroes, which is why the icon window shipped frozen at its first batch.
   */
  function scrollListTo(
    el: HTMLElement,
    geometry: { scrollTop: number; clientHeight: number; scrollHeight: number }
  ) {
    for (const [prop, value] of Object.entries(geometry)) {
      Object.defineProperty(el, prop, { value, configurable: true, writable: true });
    }
    fireEvent.scroll(el);
  }

  it("asks for the next slice when the list is scrolled, and never re-asks for what it has", async () => {
    const many: ProcessInfo[] = Array.from({ length: 100 }, (_, i) => ({
      name: `proc${i}.exe`,
    }));
    routeIconCommand();

    renderModal({ processes: many });
    await waitFor(() => expect(iconRequests.length).toBeGreaterThan(0));
    const firstSlice = iconRequests.flat();

    const list = document.querySelector("[data-process-list]") as HTMLElement;

    // jsdom performs no layout: scrollTop/clientHeight/scrollHeight are all 0 unless we say
    // otherwise. Stating them is not decoration — the previous version of this test fired a bare
    // scroll event and passed, because the old `scrollTop + clientHeight >= scrollHeight - 200`
    // check reads TRUE at 0 >= -200. It asserted a condition that is true only in the test
    // environment and false in a browser, which is how a window that never grew shipped green.
    // 100 rows over 4000px is 40px a row; a 320px viewport at scrollTop 1600 puts the user on
    // rows ~40-48, deep in the list but nowhere near its bottom — the exact position that used to
    // load nothing.
    scrollListTo(list, { scrollTop: 1600, clientHeight: 320, scrollHeight: 4000 });

    await waitFor(() => expect(iconRequests.flat().length).toBeGreaterThan(firstSlice.length));
    const secondSlice = iconRequests.flat().slice(firstSlice.length);

    // The second call carries only NEW names: the cache and the in-flight set between them mean a
    // scroll never re-pays for a row whose answer is already known.
    expect(secondSlice.some((name) => firstSlice.includes(name))).toBe(false);

    // And it reached the rows the user is actually looking at, not merely "one more batch".
    const covered = new Set(iconRequests.flat());
    expect(covered.has("proc44.exe")).toBe(true);
  });

  it("stops asking once the window already covers where the user is", async () => {
    // The mirror of the test above, and the reason the window is a COUNT rather than a running
    // total: scrolling is a stream of events, so the same position must resolve to the same
    // coverage. Growth is deliberately one batch ahead of the last visible row — that lookahead is
    // what makes an icon look like it was waiting rather than loading — but a second scroll landing
    // on rows that lookahead already claimed must cost nothing. Without this, every scroll event
    // would enlarge the window and "lazy" would collapse into "fetch everything on the first flick".
    const many: ProcessInfo[] = Array.from({ length: 100 }, (_, i) => ({
      name: `proc${i}.exe`,
    }));
    routeIconCommand();

    renderModal({ processes: many });
    await waitFor(() => expect(iconRequests.length).toBeGreaterThan(0));

    const list = document.querySelector("[data-process-list]") as HTMLElement;
    const geometry = { scrollTop: 80, clientHeight: 320, scrollHeight: 4000 };

    scrollListTo(list, geometry);
    await waitFor(() => expect(iconRequests.length).toBeGreaterThan(1));
    const callsAfterFirstScroll = iconRequests.length;

    // Same place, three more events — the coverage it implies is already in hand.
    scrollListTo(list, geometry);
    scrollListTo(list, geometry);
    scrollListTo(list, geometry);

    await new Promise((r) => setTimeout(r, 250));
    expect(iconRequests.length).toBe(callsAfterFirstScroll);
  });

  // ── Picking a file from disk, inside this modal (D-04) ───────────────────────────────────────
  //
  // The file pick used to be a second button on the card outside this modal, with its own handler
  // and its own duplicate check. It now lives here, which means a picked file has to behave exactly
  // like a ticked row: it joins the SAME selection set and leaves through the SAME confirmation.

  it("adds a picked file to the selection instead of committing it", async () => {
    dialogMock.mockResolvedValue("C:\\Tools\\MyApp\\myapp.exe");
    renderModal();

    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    expect(dialogMock).toHaveBeenCalledTimes(1);
    // Selected, not committed — the confirm button is what commits, and it has not been pressed.
    expect(await screen.findByText("Добавить выбранные (1)")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows a picked file that is not running as a selected, tickable row", async () => {
    dialogMock.mockResolvedValue("C:\\Tools\\MyApp\\notrunning.exe");
    renderModal();

    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    // Nothing in the running list carries this name, so without the merge the row would vanish
    // even though it is selected.
    const row = await screen.findByRole("checkbox", { name: "notrunning.exe" });
    expect(row).toBeChecked();
    expect(row).not.toBeDisabled();
  });

  it("carries a picked file and a ticked running process out through ONE confirmation", async () => {
    dialogMock.mockResolvedValue(["C:\\Tools\\a.exe", "C:\\Tools\\b.exe"]);
    renderModal();

    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));
    await screen.findByRole("checkbox", { name: "a.exe" });
    await userEvent.click(screen.getByRole("checkbox", { name: "code.exe" }));

    await userEvent.click(screen.getByText("Добавить выбранные (3)"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.arrayContaining(["a.exe", "b.exe", "code.exe"])
    );
  });

  it("treats a cancelled dialog as a no-op, with no error and no selection", async () => {
    dialogMock.mockResolvedValue(null);
    renderModal();

    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    expect(screen.getByText("Добавить выбранные")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
  });

  it("reports a dialog failure WITHOUT taking the process list away", async () => {
    dialogMock.mockRejectedValue(new Error("dialog blew up"));
    renderModal();

    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось открыть выбор файла");
    // The whole point: one button failed to open a window, so the ~200 programs the user was
    // looking at must still be there. Merging this into the region that REPLACES the list wiped
    // them, and the only escape was closing and reopening the modal.
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "code.exe" })).toBeEnabled();
    // The raw failure text never reaches the screen — a dialog error can carry a file system path.
    expect(screen.queryByText(/dialog blew up/)).not.toBeInTheDocument();
  });

  it("retires the dialog failure on the next attempt, even one the user cancels", async () => {
    dialogMock.mockRejectedValue(new Error("dialog blew up"));
    renderModal();

    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Second press, this time cancelled. The cancel path returns early, so clearing the error only
    // on a SUCCESSFUL pick left it on screen forever.
    dialogMock.mockReset();
    dialogMock.mockResolvedValue(null);
    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
  });

  it("gives a picked file its own application icon, resolved from the path the user consented to", async () => {
    dialogMock.mockResolvedValue("C:\\Tools\\MyApp\\mytool.exe");
    // The path command answers for the chosen file; the name-based batch answers for everything
    // else. Both are routed so the assertion cannot be satisfied by the wrong one.
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_process_icon_for_path") {
        expect(args?.path).toBe("C:\\Tools\\MyApp\\mytool.exe");
        return DATA_URL;
      }
      if (cmd === "get_process_icons") {
        const names = (args?.names ?? []) as string[];
        return names.map((name) => ({ name, icon: null }));
      }
      return null;
    }) as unknown as typeof invoke);

    renderModal();
    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    const row = (await screen.findByRole("checkbox", { name: "mytool.exe" })).parentElement!;
    await waitFor(() =>
      expect(row.querySelector('[data-process-icon="resolved"]')).toBeInTheDocument()
    );
    expect(row.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  it("falls back to the neutral glyph when a picked file's icon cannot be resolved", async () => {
    dialogMock.mockResolvedValue("C:\\Tools\\MyApp\\mytool.exe");
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_process_icon_for_path") return null;
      if (cmd === "get_process_icons") {
        const names = (args?.names ?? []) as string[];
        return names.map((name) => ({ name, icon: null }));
      }
      return null;
    }) as unknown as typeof invoke);

    renderModal();
    await userEvent.click(screen.getByRole("button", { name: /обзор/i }));

    const row = (await screen.findByRole("checkbox", { name: "mytool.exe" })).parentElement!;
    await waitFor(() =>
      expect(row.querySelector('[data-process-icon="unavailable"]')).toBeInTheDocument()
    );
    expect(row.querySelector("img")).toBeNull();
  });

  // ── Enumeration failure vs. a genuinely empty list ───────────────────────────────────────────
  //
  // These two states used to be one. A backend that could not enumerate anything produced an empty
  // array, and the empty array rendered as «Процессы не найдены» — the picker reporting that the
  // machine was running no programs. The harness below drives the REAL path (useRoutingState's
  // loadProcessList calling the real command) rather than just setting the prop, because the defect
  // lived in that path: the failure was caught and dropped on the floor.

  function ErrorPathHarness() {
    const state = useRoutingState({
      configPath: "/path/to/config.json",
      status: "disconnected",
      vpnMode: "general",
      onReconnect: async () => {},
    });
    return (
      <>
        <button onClick={() => void state.loadProcessList()}>load-processes</button>
        <ProcessPickerModal
          open
          processes={state.processList}
          loading={state.processListLoading}
          error={state.processListError}
          alreadyAdded={[]}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      </>
    );
  }

  function renderErrorPath() {
    return render(
      <SnackBarProvider>
        <ErrorPathHarness />
      </SnackBarProvider>
    );
  }

  /** Answer `list_running_processes` with `answer`; everything else stays inert. */
  function routeEnumeration(answer: () => Promise<ProcessInfo[]>) {
    invokeMock.mockImplementation((async (cmd: string) => {
      if (cmd === "list_running_processes") return answer();
      return null;
    }) as unknown as typeof invoke);
  }

  it("shows the failure message, not the empty-list copy, when enumeration rejects", async () => {
    routeEnumeration(() => Promise.reject(new Error("snapshot failed")));
    renderErrorPath();

    await userEvent.click(screen.getByText("load-processes"));

    expect(
      await screen.findByText("Не удалось получить список программ")
    ).toBeInTheDocument();
    // The lie this closes: the picker must NOT claim the machine is running no programs.
    expect(screen.queryByText("Процессы не найдены")).not.toBeInTheDocument();
  });

  it("still shows the empty-list copy when enumeration succeeds with nothing", async () => {
    routeEnumeration(async () => []);
    renderErrorPath();

    await userEvent.click(screen.getByText("load-processes"));

    await waitFor(() =>
      expect(screen.getByText("Процессы не найдены")).toBeInTheDocument()
    );
    expect(
      screen.queryByText("Не удалось получить список программ")
    ).not.toBeInTheDocument();
  });

  it("clears a previous failure before the retry, so a stale error cannot outlive a good load", async () => {
    let shouldFail = true;
    routeEnumeration(() =>
      shouldFail
        ? Promise.reject(new Error("snapshot failed"))
        : Promise.resolve([{ name: "chrome.exe" }])
    );
    renderErrorPath();

    await userEvent.click(screen.getByText("load-processes"));
    expect(
      await screen.findByText("Не удалось получить список программ")
    ).toBeInTheDocument();

    shouldFail = false;
    await userEvent.click(screen.getByText("load-processes"));

    await waitFor(() => expect(screen.getByText("chrome.exe")).toBeInTheDocument());
    expect(
      screen.queryByText("Не удалось получить список программ")
    ).not.toBeInTheDocument();
  });

  it("deduplicates processes with same name", () => {
    const duped: ProcessInfo[] = [
      { name: "chrome.exe" },
      { name: "chrome.exe" },
      { name: "firefox.exe" },
    ];
    renderModal({ processes: duped });
    const chromeItems = screen.getAllByText("chrome.exe");
    expect(chromeItems).toHaveLength(1);
  });
});
