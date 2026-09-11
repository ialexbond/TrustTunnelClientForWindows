import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../shared/i18n";
import AppSettingsPanel from "./AppSettingsPanel";
import { renderWithProviders as render } from "../test/test-utils";

// No `@tauri-apps/plugin-autostart` module mock anymore: since the 2026-08-26 owner-bug fix the
// autostart row writes through plain Tauri commands (`get_autostart`/`set_autostart`), so the
// generic `invoke` mock below covers it. The old module mock was the 28-06 harness trap —
// `restoreMocks: true` stripped its resolved values before every test.

// Здесь стоял мок `useFeatureToggles`. Хранилище тумблеров удалено 2026-09-03 вместе с его
// единственным жителем — «Блокировка сайтов»: блокировка по домену никогда не работала и не могла
// без правки замороженного C++-ядра. Мокать больше нечего.

describe("AppSettingsPanel", () => {
  // 12-07: AppSettingsPanel no longer takes `hasConfig` (that prop only fed the auto-connect toggle
  // that has since MOVED out of GeneralSection into «Авто-режим»).
  const defaultProps = {
    theme: "system" as const,
    onThemeChange: vi.fn(),
    language: "ru",
    onLanguageChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      // 12-07: AutoModeSettings (now mounted here) reads the config manifest via list_configs.
      if (cmd === "list_configs") return [];
      return null;
    });
  });

  it("renders GeneralSection", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Основные")).toBeInTheDocument();
  });

  it("renders AppearanceSection", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Внешний вид")).toBeInTheDocument();
  });

  // Секция «Экспериментальные функции» удалена 2026-09-03. В ней была ровно одна строка —
  // «Блокировка сайтов», — и вместе с функцией ушла вся карточка: пустая карточка предупреждающего
  // тона хуже, чем её отсутствие.
  it("does not render the «Экспериментальные функции» section — it is gone, not emptied", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.queryByText("Экспериментальные функции")).not.toBeInTheDocument();
    expect(screen.queryByText("Блокировка сайтов")).not.toBeInTheDocument();
  });

  // 12-07: «Авто-режим» (AutoModeSettings) is now mounted in the Settings panel.
  it("renders AutoModeSettings («Авто-режим»)", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Авто-режим")).toBeInTheDocument();
  });

  it("renders all sections together", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Основные")).toBeInTheDocument();
    expect(screen.getByText("Авто-режим")).toBeInTheDocument();
    expect(screen.getByText("Внешний вид")).toBeInTheDocument();
  });

  it("renders statusPanel when provided", () => {
    render(
      <AppSettingsPanel
        {...defaultProps}
        statusPanel={<div data-testid="status-panel">Status</div>}
      />
    );
    expect(screen.getByTestId("status-panel")).toBeInTheDocument();
  });

  it("renders appearance controls (theme and language)", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Тема оформления")).toBeInTheDocument();
    expect(screen.getByText("Язык интерфейса")).toBeInTheDocument();
  });

  it("renders general toggles (autostart, minimized) — NOT the moved auto-connect toggle", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Запускать вместе с системой")).toBeInTheDocument();
    expect(screen.getByText("Запускать в свёрнутом режиме")).toBeInTheDocument();
    // 12-07: the old GeneralSection auto-connect label is GONE (moved to «Авто-режим»).
    expect(screen.queryByText("Подключаться автоматически")).not.toBeInTheDocument();
  });

  // 12-07: the startup auto-connect toggle now lives in «Авто-режим» with its honest last-used label.
  it("renders the startup auto-connect toggle in «Авто-режим»", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Автоподключение при запуске")).toBeInTheDocument();
  });

  /* ── Phase 28 (28-06): the tab shell ─────────────────────────────────────────────────────── */

  afterEach(() => {
    vi.useRealTimers();
  });

  const SAVED = "Настройки сохранены";
  const SAVE_FAILED = "Не удалось сохранить настройку. Попробуйте ещё раз.";

  // Было «четыре секции в фиксированном порядке». Стало три: четвёртая, «Экспериментальные
  // функции», удалена вместе с единственной своей строкой. Порядок остальных не тронут.
  it("mounts the three sections in the fixed order", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Основные",
      "Авто-режим",
      "Внешний вид",
    ]);
  });

  // Предупреждающий тон был на вкладке В ЕДИНСТВЕННОМ экземпляре — он и означал «эта карточка не
  // такая, как остальные». Карточка ушла, а значит на вкладке не должно остаться НИ ОДНОЙ
  // предупреждающей плашки: одиночный сигнал, потерявший смысл, — это просто цветное пятно.
  it("leaves no warning-tinted header tile on the tab at all", () => {
    const { container } = render(<AppSettingsPanel {...defaultProps} />);
    const warningTiles = Array.from(container.querySelectorAll<HTMLElement>("[style]")).filter(
      (element) => (element.getAttribute("style") ?? "").includes("warning"),
    );
    expect(warningTiles).toHaveLength(0);
  });

  // The two switches used below both write through `invoke`, so the harness controls which one
  // succeeds and which one fails. (Historical: the autostart switch used to be unusable here — it
  // wrote through a dynamically imported plugin module whose mock `restoreMocks: true` kept
  // stripping. Since 2026-08-26 it also writes through `invoke`; these two stay simply because the
  // scenario needs any one success and any one failure, not that particular row.)
  const SUCCEEDS = "Запускать в свёрнутом режиме";
  const FAILS = "Собирать логи";

  it("puts a failed write in the SAME slot the saved message uses, announced as urgent", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "list_configs") return [];
      if (cmd === "set_logging_enabled") throw new Error("disk is read-only");
      return null;
    });

    render(<AppSettingsPanel {...defaultProps} />);

    // A change that succeeds first, so the slot the confirmation uses is known.
    fireEvent.click(screen.getByRole("switch", { name: SUCCEEDS }));
    const saved = await screen.findByRole("status");
    expect(saved).toHaveTextContent(SAVED);
    const slot = saved.parentElement;

    // …then a change that fails.
    fireEvent.click(screen.getByRole("switch", { name: FAILS }));
    const failure = await screen.findByRole("alert");

    expect(failure).toHaveTextContent(SAVE_FAILED);
    expect(failure).toHaveAttribute("aria-live", "assertive");
    expect(failure.parentElement).toBe(slot);
    // Dismissible: the user can put it away rather than wait it out.
    expect(within(failure).getByRole("button", { name: /close/i })).toBeInTheDocument();
    // T-28-20: the backend's own words never reach the screen.
    expect(failure).not.toHaveTextContent("read-only");
  });

  it("holds the failure message longer than the saved one", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "list_configs") return [];
      if (cmd === "set_logging_enabled") throw new Error("nope");
      return null;
    });

    render(<AppSettingsPanel {...defaultProps} />);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("switch", { name: SUCCEEDS }));
    fireEvent.click(screen.getByRole("switch", { name: FAILS }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Past the success dwell: the confirmation is gone, the failure is still readable.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // Flick several switches in a row and the tab must not build a stack of identical messages.
  it("extends one saved message rather than stacking two identical ones", async () => {
    render(<AppSettingsPanel {...defaultProps} />);

    fireEvent.click(screen.getByRole("switch", { name: SUCCEEDS }));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("switch", { name: SUCCEEDS }));

    await waitFor(() => {
      expect(screen.getAllByText(SAVED)).toHaveLength(1);
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  // Phase 14 (D-13): the App-owned isSwitching flag still reaches «Авто-режим» as `locked`.
  // 27 D-06 (plan 28-08) renamed the toggle this addresses: the card promises failover now, not
  // «автоподключение к лучшему серверу». The pass-through under test is unchanged.
  const FAILOVER_TOGGLE = "Переключаться на другой сервер при потере связи";
  it("passes isSwitching through to «Авто-режим» as the lock on its master toggle", () => {
    const { unmount } = render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByRole("switch", { name: FAILOVER_TOGGLE })).toBeEnabled();
    unmount();

    render(<AppSettingsPanel {...defaultProps} isSwitching />);
    expect(screen.getByRole("switch", { name: FAILOVER_TOGGLE })).toBeDisabled();
  });
});
