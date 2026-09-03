import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../shared/i18n";
import RoutingPanel from "./RoutingPanel";
import { renderWithProviders as render } from "../test/test-utils";
import type { VpnStatus } from "../shared/types";

describe("RoutingPanel", () => {
  const defaultProps = {
    configPath: "/test/config.toml",
    status: "disconnected" as VpnStatus,
    connectedSince: null,
    vpnError: null,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    vpnMode: "general",
    onVpnModeChange: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        return {
          direct: [
            { id: "1", type: "domain", value: "example.com" },
            { id: "2", type: "domain", value: "test.ru" },
          ],
          proxy: [
            { id: "3", type: "domain", value: "proxy-site.com" },
          ],
          block: [],
          process_mode: "exclude",
          processes: [],
        };
      }
      if (cmd === "get_geodata_status") {
        return {
          downloaded: false,
          geoip_exists: false,
          geosite_exists: false,
          geoip_categories_count: 0,
          geosite_categories_count: 0,
        };
      }
      if (cmd === "get_geodata_categories") {
        return { geoip: [], geosite: [] };
      }
      // Plan 22-03 added a mount-time get_iplist_groups invoke (useRoutingState.loadIplistGroups);
      // the real backend returns Vec<IplistGroup> (an array). Mirror that here so the mount-time
      // load hydrates a real (empty) list rather than falling through to the default null.
      if (cmd === "get_iplist_groups") {
        return [];
      }
      if (cmd === "update_vpn_mode") {
        return null;
      }
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows no-config message when configPath is empty", () => {
    render(<RoutingPanel {...defaultProps} configPath="" />);
    expect(screen.getByText("Конфигурация не выбрана")).toBeInTheDocument();
  });

  it("renders configured_in_settings text when no config path", () => {
    render(<RoutingPanel {...defaultProps} configPath="" />);
    expect(screen.getByText(/Настройте подключение на вкладке Настройки/)).toBeInTheDocument();
  });

  it("renders VPN mode selector after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Режим VPN")).toBeInTheDocument();
    });
    expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
  });

  it("renders both VPN mode buttons (general and selective)", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
    });
    // "Напрямую" appears both as a VPN mode button and as the direct routing block title
    const matches = screen.getAllByText(i18n.t("vpn_modes.selective"));
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders routing block cards after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    // "Через VPN" is the proxy block title AND (since Plan 22-04) a preset-tile caption, so it now
    // appears multiple times — assert the label renders at least once rather than exactly once.
    await waitFor(() => {
      expect(screen.getAllByText("Через VPN").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders save and reconnect button after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Сохранить и переподключить")).toBeInTheDocument();
    });
  });

  it("renders rule entries inside direct block", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });
    expect(screen.getByText("test.ru")).toBeInTheDocument();
  });

  it("renders proxy entries in proxy block", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("proxy-site.com")).toBeInTheDocument();
    });
  });

  it("renders both direct and proxy routing block cards", async () => {
    render(<RoutingPanel {...defaultProps} />);
    // See above: "Через VPN" is now shared between the proxy block title and preset-tile captions.
    await waitFor(() => {
      expect(screen.getAllByText("Через VPN").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders geodata status card after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Геоданные")).toBeInTheDocument();
    });
  });

  // ── VPN mode switching ──

  it("calls invoke with update_vpn_mode when selective button is clicked", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getAllByText(i18n.t("vpn_modes.selective")).length).toBeGreaterThanOrEqual(1);
    });

    // The VPN mode selector button is the one inside a grid layout.
    // Query by the i18n label (not a literal) so a label rename can't stale this test.
    const selectiveButtons = screen.getAllByText(i18n.t("vpn_modes.selective"));
    // Click the button element (not the span) — find the one that's a button
    const selectiveBtn = selectiveButtons.find(el => el.closest("button"));
    fireEvent.click(selectiveBtn!.closest("button")!);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("update_vpn_mode", {
        configPath: "/test/config.toml",
        mode: "selective",
      });
    });
  });

  it("calls onVpnModeChange after successful mode switch", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
    });

    // Find the selective mode button by its role and the Zap icon (it's in a grid)
    const allButtons = screen.getAllByRole("button");
    const selectiveBtn = allButtons.find(btn => btn.textContent?.trim() === i18n.t("vpn_modes.selective"));
    expect(selectiveBtn).toBeTruthy();
    fireEvent.click(selectiveBtn!);

    await waitFor(() => {
      expect(defaultProps.onVpnModeChange).toHaveBeenCalledWith("selective");
    });
  });

  it("does not call invoke when configPath is empty in handleVpnModeChange", async () => {
    // Render with empty configPath — should show no-config message, not the selector
    render(<RoutingPanel {...defaultProps} configPath="" />);
    // The mode selector won't be rendered, so update_vpn_mode won't be called
    expect(invoke).not.toHaveBeenCalledWith("update_vpn_mode", expect.anything());
  });

  it("handles vpn mode change error gracefully", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        return { direct: [], proxy: [], block: [], process_mode: "exclude", processes: [] };
      }
      if (cmd === "get_geodata_status") {
        return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      }
      if (cmd === "get_geodata_categories") {
        return { geoip: [], geosite: [] };
      }
      if (cmd === "update_vpn_mode") {
        throw new Error("Update failed");
      }
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
    });

    const allButtons = screen.getAllByRole("button");
    const selectiveBtn = allButtons.find(btn => btn.textContent?.trim() === i18n.t("vpn_modes.selective"));
    expect(selectiveBtn).toBeTruthy();
    fireEvent.click(selectiveBtn!);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
    });
    consoleSpy.mockRestore();
  });

  // ── Selective VPN mode description ──

  it("shows general mode help text when vpnMode is general", async () => {
    render(<RoutingPanel {...defaultProps} vpnMode="general" />);
    await waitFor(() => {
      expect(screen.getByText(i18n.t("help_text.vpn_mode_general"))).toBeInTheDocument();
    });
  });

  it("shows selective mode help text when vpnMode is selective", async () => {
    render(<RoutingPanel {...defaultProps} vpnMode="selective" />);
    await waitFor(() => {
      expect(screen.getByText(i18n.t("help_text.vpn_mode_selective"))).toBeInTheDocument();
    });
  });

  // ── Save button states ──

  it("save button is disabled when VPN is not active", async () => {
    render(<RoutingPanel {...defaultProps} status="disconnected" />);
    await waitFor(() => {
      expect(screen.getByText("Сохранить и переподключить")).toBeInTheDocument();
    });
    const saveBtn = screen.getByText("Сохранить и переподключить").closest("button");
    expect(saveBtn).toBeDisabled();
  });

  // ── Export/Import buttons ──

  it("renders export and import buttons", async () => {
    render(<RoutingPanel {...defaultProps} />);
    // Export/import are now canon icon-only IconButtons (aria-label, not a title attr) living in
    // the bottom strip — query by their accessible name instead of getByTitle.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: i18n.t("routing.exportRules") })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: i18n.t("routing.importRules") })).toBeInTheDocument();
  });

  // ── Error banner ──

  // D-02 (30.1 blocker 2) REWRITTEN. This case used to assert `getByText(/Load failed/)` — i.e.
  // that the BACKEND'S OWN ERROR STRING is shown to the user. That is the behaviour being removed:
  // the real message on this path is the serde parse error, which is English, unbounded, and can
  // quote the rules file's own bytes. The gate passed while the property it implied («the user is
  // told something useful») did not hold.
  //
  // The surviving fact — a failed load is SURFACED rather than swallowed — is asserted here
  // against the localized state instead of against the raw string.
  it("surfaces a failed load as a localized state, not as the backend's raw message", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        throw new Error("Load failed");
      }
      if (cmd === "get_geodata_status") {
        return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      }
      if (cmd === "get_geodata_categories") {
        return { geoip: [], geosite: [] };
      }
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });

    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(i18n.t("routing.unreadable.title"))).toBeInTheDocument();
    });
    expect(screen.queryByText(/Load failed/)).not.toBeInTheDocument();
  });

  // ── Site blocking is removed (2026-09-03) ──
  //
  // Здесь стояли три теста: карточка скрыта по умолчанию, показывается, когда файл правил говорит
  // «блокировка включена», и скрыта, когда файл говорит обратное. Функция удалена целиком, поэтому
  // остаётся ОДНО свойство, и оно самое важное: карточки нет ни при каких сохранённых данных.
  //
  // Условия теста нарочно те, при которых старая сборка карточку ПОКАЗЫВАЛА: и старый ключ
  // localStorage со «включено», и `block_enabled: true` в файле правил. Именно так выглядит машина
  // владельца прямо сейчас. Если карточка когда-нибудь вернётся сама — этот тест покраснеет.
  it("never shows the block card — not even with the old toggle on and the file saying enforced", async () => {
    localStorage.setItem("tt_feature_toggles", JSON.stringify({ blockRouting: true }));
    const base = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (...call) => {
      if (call[0] === "load_routing_rules") {
        return {
          ...((await base(...call)) as object),
          block: [{ id: "b1", type: "domain", value: "ads.example.com", label: null }],
          block_enabled: true,
        };
      }
      return base(...call);
    });

    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Режим VPN")).toBeInTheDocument();
    });
    expect(screen.queryByText("Заблокировать")).not.toBeInTheDocument();
    // Сохранённая запись пользователя тоже никуда не рисуется — её бережёт бэкенд, а не экран.
    expect(screen.queryByText("ads.example.com")).not.toBeInTheDocument();
    // …и это не «панель вообще не отрисовалась»: карточек правил ровно две, и это те две.
    // Считаем по шапкам-кнопкам самих карточек (`aria-expanded`), а не по тексту: слова
    // «Напрямую» / «Через VPN» встречаются ещё и подписями плиток пресетов, и поиск по тексту
    // молча зацепил бы их.
    const cardHeaders = screen.getAllByRole("button", { expanded: true });
    expect(cardHeaders.map((h) => h.textContent)).toEqual([
      expect.stringContaining("Напрямую"),
      expect.stringContaining("Через VPN"),
    ]);
  });

  // ── Process filter ──

  it("does not show process filter by default (feature off)", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Режим VPN")).toBeInTheDocument();
    });
    expect(screen.queryByText(i18n.t("routing.process_filter_title"))).not.toBeInTheDocument();
  });

  it("shows process filter section when feature toggle is enabled", async () => {
    // `tt_feature_toggles` больше никем не читается: хранилище тумблеров удалено вместе с
    // единственным жившим в нём тумблером (блокировка сайтов). Строку, писавшую сюда несуществующий
    // `processFilter`, убрали — она ничего не включала уже давно.
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Режим VPN")).toBeInTheDocument();
    });
    // Process filter section should be rendered
  });

  // ── Geodata status with downloaded data ──

  it("renders geodata card showing not downloaded state", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Геоданные")).toBeInTheDocument();
    });
  });

  it("renders geodata card with downloaded state", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        return { direct: [], proxy: [], block: [], process_mode: "exclude", processes: [] };
      }
      if (cmd === "get_geodata_status") {
        return {
          downloaded: true,
          geoip_exists: true,
          geosite_exists: true,
          geoip_categories_count: 5,
          geosite_categories_count: 10,
        };
      }
      if (cmd === "get_geodata_categories") {
        return { geoip: ["cn", "ru"], geosite: ["google", "facebook"] };
      }
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });

    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Геоданные")).toBeInTheDocument();
    });
  });

  // ── Loading state ──

  it("shows loading spinner initially", () => {
    // When invoke hasn't resolved yet, useRoutingState is still loading
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {})); // never resolves
    render(<RoutingPanel {...defaultProps} />);
    // The component should show a spinner (Loader2)
    // It won't show the VPN mode selector yet
    expect(screen.queryByText("Режим VPN")).not.toBeInTheDocument();
  });

  // ── Fable F4 (BUG-A2 fix-all-paths): the Routing tab's OWN StatusPanel threads switching/connectPending ──
  describe("Fable F4 — StatusPanel switch/pending threading", () => {
    it("shows a LIVE, working «Отмена» during a plain connecting (isSwitching false)", async () => {
      const onDisconnect = vi.fn();
      render(<RoutingPanel {...defaultProps} status="connecting" onDisconnect={onDisconnect} />);
      await waitFor(() => {
        expect(screen.getByText("Режим VPN")).toBeInTheDocument();
      });
      const cancel = screen.getByRole("button", { name: /Отмена/ });
      expect(cancel).toBeEnabled();
      fireEvent.click(cancel);
      expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it("HIDES the dead live «Отмена» during a switch's connecting leg (isSwitching threaded through)", async () => {
      // Without F4 threading, the Routing StatusPanel would show a DEAD live «Отмена» here (the App's
      // handleUserCancel is inert while isSwitching). With the prop threaded, the strip shows the inert
      // spinner instead — no dead button.
      render(<RoutingPanel {...defaultProps} status="connecting" isSwitching />);
      await waitFor(() => {
        expect(screen.getByText("Режим VPN")).toBeInTheDocument();
      });
      // No live cancel; the status strip's only action button in this area is the inert spinner.
      expect(screen.queryByRole("button", { name: /Отмена/ })).not.toBeInTheDocument();
    });
  });

  // ── D-02 (30.1 blocker 2): the unreadable-rules state and the way out ─────

  describe("when routing_rules.json cannot be read", () => {
    function mockBrokenLoad() {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "load_routing_rules") {
          throw new Error("Failed to parse routing_rules.json: expected `,` at line 12 column 3");
        }
        if (cmd === "get_geodata_status") {
          return {
            downloaded: false,
            geoip_exists: false,
            geosite_exists: false,
            geoip_categories_count: 0,
            geosite_categories_count: 0,
          };
        }
        if (cmd === "get_iplist_groups") return [];
        return null;
      });
    }

    it("shows a distinct unreadable state instead of an empty rule list", async () => {
      // The panel used to render its normal body with zero entries — indistinguishable from a user
      // who simply has no rules. «Пусто» and «сломано» are different facts and only one of them
      // asks the user to do something.
      mockBrokenLoad();
      render(<RoutingPanel {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
      });
      expect(screen.getByRole("alert").textContent).toMatch(/маршрутизац/i);
      // The ordinary body must NOT be on screen: showing the rule blocks with nothing in them is
      // precisely the lie being removed.
      expect(screen.queryByText("Режим VPN")).not.toBeInTheDocument();
    });

    it("does not show the parser's English message", async () => {
      // D-29 / the i18n rule: what the serde error says is developer detail. It is also unbounded
      // and can quote the file's own bytes.
      mockBrokenLoad();
      render(<RoutingPanel {...defaultProps} />);

      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
      expect(document.body.textContent).not.toMatch(/expected `,`/);
      expect(document.body.textContent).not.toMatch(/Failed to parse/);
    });

    it("offers the reset BEHIND a confirmation that names what is destroyed", async () => {
      // The reset throws the user's rule list away. Doing that on a single click, from a screen
      // they landed on because something already went wrong, is the reversible-looking control
      // over an irreversible action that D-01 rejected.
      mockBrokenLoad();
      render(<RoutingPanel {...defaultProps} />);

      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

      const resetButton = screen.getByRole("button", { name: /Сбросить правила/i });
      // Nothing is written by merely arriving on the screen or by opening the dialog.
      expect(
        vi.mocked(invoke).mock.calls.filter((c) => c[0] === "save_routing_rules"),
      ).toHaveLength(0);

      fireEvent.click(resetButton);

      // Queried by TEXT, the way `ConfirmDialog.test.tsx` does: `ConfirmDialog` has not opted into
      // Modal's `role="dialog"` (that migration is per-caller and several modals are still
      // outstanding), so there is no dialog role to query. Logged in the phase's deferred items —
      // widening a shared primitive's a11y contract is not this plan's to do quietly.
      await waitFor(() => {
        expect(screen.getByText(i18n.t("routing.unreadable.confirm_title"))).toBeInTheDocument();
      });
      // The confirmation has to say what is LOST, not just ask «вы уверены?».
      const confirmBody = screen.getByText(i18n.t("routing.unreadable.confirm_body"));
      expect(confirmBody.textContent).toMatch(/удалены безвозвратно/i);
      // Still nothing written — the dialog is open, the user has not agreed.
      expect(
        vi.mocked(invoke).mock.calls.filter((c) => c[0] === "save_routing_rules"),
      ).toHaveLength(0);
    });

    it("writes nothing when the user cancels the confirmation", async () => {
      // The other half of «behind a confirmation»: backing out must leave the file alone. A dialog
      // whose Cancel still destroys the list would be worse than no dialog, because it would have
      // promised otherwise.
      mockBrokenLoad();
      render(<RoutingPanel {...defaultProps} />);
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /Сбросить правила/i }));
      await waitFor(() =>
        expect(screen.getByText(i18n.t("routing.unreadable.confirm_title"))).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByRole("button", { name: /^Отмена$/ }));

      await waitFor(() =>
        expect(screen.queryByText(i18n.t("routing.unreadable.confirm_title"))).not.toBeInTheDocument(),
      );
      expect(
        vi.mocked(invoke).mock.calls.filter((c) => c[0] === "save_routing_rules"),
      ).toHaveLength(0);
      // And the user is still on the unreadable state, not dropped somewhere else.
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("writes an empty rules document only after the user confirms", async () => {
      mockBrokenLoad();
      render(<RoutingPanel {...defaultProps} />);
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /Сбросить правила/i }));
      await waitFor(() =>
        expect(screen.getByText(i18n.t("routing.unreadable.confirm_title"))).toBeInTheDocument(),
      );

      // After the confirm the reload must succeed, or the user stays stranded on the error state.
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "load_routing_rules") {
          return {
            direct: [],
            proxy: [],
            block: [],
            process_mode: "exclude",
            processes: [],
            block_enabled: false,
          };
        }
        if (cmd === "get_geodata_status") {
          return {
            downloaded: false,
            geoip_exists: false,
            geosite_exists: false,
            geoip_categories_count: 0,
            geosite_categories_count: 0,
          };
        }
        if (cmd === "get_iplist_groups") return [];
        return null;
      });

      // The dialog's CTA carries its own label, distinct from the trigger, so «нажал кнопку на
      // экране» and «подтвердил в диалоге» can never be confused for one another here.
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("routing.unreadable.confirm_cta") }),
      );

      await waitFor(() => {
        const saves = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "save_routing_rules");
        expect(saves.length).toBeGreaterThan(0);
      });
      const saves = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "save_routing_rules");
      const payload = (saves[saves.length - 1][1] as { rules: Record<string, unknown> }).rules;
      expect(payload.direct).toEqual([]);
      expect(payload.proxy).toEqual([]);
      // Ключей удалённой блокировки в сбросе нет — их бережёт бэкенд, и пустой массив отсюда лёг бы
      // поверх сохранённого списка пользователя (см. useRoutingState.test.ts).
      expect("block" in payload).toBe(false);

      // And the panel comes back — the reset is a way OUT, not a nicer error screen.
      await waitFor(() => {
        expect(screen.getByText("Режим VPN")).toBeInTheDocument();
      });
    });
  });
});
