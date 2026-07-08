// Phase 13 / Plan 13-02 (Wave 1) — GREEN tests for the per-kind copy map.
//
// The 3 `it` names are inherited VERBATIM from the Wave-0 (13-01) `it.todo` scaffold so the plan's
// intent stays traceable. They lock the notificationCopy contract: exactly the 7 outcome kinds
// (no 2 transient states, D-01), each with an icon/color/title/body, and colours that resolve to
// design-system tokens rather than hardcoded hex (CLAUDE.md).
import { describe, it, expect } from "vitest";
import {
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  ArrowRightLeft,
  Power,
  Ban,
} from "lucide-react";
import {
  notificationCopy,
  buildBody,
  getNotificationCopy,
  plateCloseCopy,
} from "./notificationCopy";

const EXPECTED_KINDS = [
  "connected",
  "connectionError",
  "reconnecting",
  "recovering",
  "autoSwitched",
  "autoConnected",
  "disconnected",
  // 13-10 (§A): the FE-only START kind, fired directly by the Rust setter (NOT the pure decider) the
  // moment a deliberate auto-switch begins, so the owner SEES «Переключение…» before the terminal
  // «Переключено автоматически» replaces it.
  "switching",
  // Part B (cancel notification): a USER CANCEL of an in-flight connect — «Подключение отменено». A
  // DIFFERENT event from `disconnected` (owner requirement); fired by the pure Rust decider
  // (NotifyKind::Cancelled) when the FE-raised `pending_cancel` intent is set on a terminal Disconnected.
  "cancelled",
] as const;

describe("notificationCopy", () => {
  it("maps all 7 production kinds to icon/color/title/body", () => {
    // The 7 outcome kinds PLUS the 13-10 `switching` start kind — no more, no fewer.
    expect(Object.keys(notificationCopy).sort()).toEqual([...EXPECTED_KINDS].sort());

    // Each entry is well-formed: a Lucide icon component, a colour token, a non-empty title, and a
    // body builder that interpolates the live config display name.
    for (const kind of EXPECTED_KINDS) {
      const entry = notificationCopy[kind];
      // Lucide icons are forwardRef components — a renderable (function or forwardRef object).
      expect(["function", "object"]).toContain(typeof entry.icon);
      expect(entry.icon).toBeTruthy();
      expect(entry.iconColor.length).toBeGreaterThan(0);
      // 13-07: title/body are now per-language ({ ru, en }); both languages must be present.
      expect(entry.title.ru.length).toBeGreaterThan(0);
      expect(entry.title.en.length).toBeGreaterThan(0);
      expect(typeof entry.body.ru).toBe("function");
      expect(typeof entry.body.en).toBe("function");
    }

    // Spot-check the icon assignment + Russian title copy against the story surface (D-25).
    expect(notificationCopy.connected.icon).toBe(CheckCircle2);
    expect(notificationCopy.connected.title.ru).toBe("Подключено");
    expect(notificationCopy.connectionError.icon).toBe(AlertTriangle);
    expect(notificationCopy.reconnecting.icon).toBe(RefreshCw);
    expect(notificationCopy.recovering.icon).toBe(RefreshCw);
    expect(notificationCopy.autoSwitched.icon).toBe(ArrowRightLeft);
    expect(notificationCopy.autoConnected.icon).toBe(Power);
    // NEW «Отключено» entry the story lacked (Power icon, muted colour).
    expect(notificationCopy.disconnected.icon).toBe(Power);
    expect(notificationCopy.disconnected.title.ru).toBe("Отключено");
    // 13-10 (§A): the `switching` START kind — ArrowRightLeft + warning colour (mirrors autoSwitched),
    // bilingual «Переключение…» / "Switching…", and a start body with NO config-name interpolation.
    expect(notificationCopy.switching.icon).toBe(ArrowRightLeft);
    expect(notificationCopy.switching.iconColor).toBe("var(--color-status-warning)");
    expect(notificationCopy.switching.title.ru).toBe("Переключение…");
    expect(notificationCopy.switching.title.en).toBe("Switching…");
    // The start body is name-independent (the target is not yet chosen); passing a name changes nothing.
    // Review #6 (owner): the body is NEUTRAL — the kind fires for the MANUAL switch too, where «Связь
    // ухудшилась» would falsely claim the link degraded — AND IMPERSONAL (no first-person «я»): the plate
    // never speaks as a person, so «Переключаю сервер…» → «Переход на другой сервер».
    expect(buildBody("switching", "любой сервер", "ru")).toBe("Переход на другой сервер");
    expect(buildBody("switching", "any server", "en")).toBe("Moving to another server");

    // Part B (cancel notification): the `cancelled` kind — «Подключение отменено» / "Connection
    // cancelled", NEUTRAL (Ban icon + muted colour, like `disconnected`), name-independent body.
    expect(notificationCopy.cancelled.icon).toBe(Ban);
    expect(notificationCopy.cancelled.iconColor).toBe("var(--color-text-muted)");
    expect(notificationCopy.cancelled.title.ru).toBe("Подключение отменено");
    expect(notificationCopy.cancelled.title.en).toBe("Connection cancelled");
    // Body is name-independent (the connect was aborted); passing a name changes nothing.
    expect(buildBody("cancelled", "Германия", "ru")).toBe("Соединение не установлено");
    expect(buildBody("cancelled", "Germany", "en")).toBe("No connection was established");

    // Bodies interpolate the live config display name (never a hardcoded fixture, never a password).
    expect(buildBody("connected", "Германия — Frankfurt", "ru")).toContain("Германия — Frankfurt");
    expect(buildBody("connectionError", "Нидерланды", "ru")).toContain("Нидерланды");
    expect(buildBody("autoSwitched", "Швеция", "ru")).toContain("Швеция");
  });

  it("is bilingual (13-07): en titles/bodies differ from ru, name still interpolated", () => {
    // Russian is primary; English mirrors it. Titles must be the English words, and the body still
    // interpolates the live config display name in either language (D-29 — display name only).
    expect(getNotificationCopy("connected", "en").title).toBe("Connected");
    expect(getNotificationCopy("connected", "ru").title).toBe("Подключено");
    expect(getNotificationCopy("disconnected", "en").title).toBe("Disconnected");
    expect(getNotificationCopy("autoConnected", "en").title).toBe("Auto-connect on launch");
    // icon/colour are language-independent.
    expect(getNotificationCopy("connected", "en").icon).toBe(CheckCircle2);
    expect(getNotificationCopy("connected", "ru").icon).toBe(CheckCircle2);
    // Bodies: the name is interpolated in both languages.
    expect(buildBody("connected", "Sweden", "en")).toContain("Sweden");
    expect(buildBody("autoConnected", "Germany", "en")).toContain("Germany");
    // en body differs from ru body for the same kind+name (real translation, not a passthrough).
    expect(buildBody("connected", "X", "en")).not.toBe(buildBody("connected", "X", "ru"));
  });

  it("carries the × close label/tooltip pair in both languages (review #11)", () => {
    // The plate's close affordance copy lives with the kind map so the pair cannot drift; the
    // Russian pair doubles as the ConnectionToast defaults (Storybook/card usages unchanged).
    expect(plateCloseCopy.ru).toEqual({ label: "Закрыть уведомление", tooltip: "Закрыть" });
    expect(plateCloseCopy.en).toEqual({ label: "Close notification", tooltip: "Close" });
  });

  it("does NOT contain connecting or disconnecting entries (D-01 drops the 2 transient states)", () => {
    expect(notificationCopy).not.toHaveProperty("connecting");
    expect(notificationCopy).not.toHaveProperty("disconnecting");
  });

  it("colors resolve to --color-status-* / --color-text-muted tokens, no hardcoded hex", () => {
    const HEX = /#[0-9a-fA-F]{3,8}/;
    for (const kind of EXPECTED_KINDS) {
      const color = notificationCopy[kind].iconColor;
      // Every colour is a CSS var() referencing a design-system token, never a literal hex.
      expect(color).toMatch(/^var\(--color-(status-(connected|warning|error)|text-muted)\)$/);
      expect(color).not.toMatch(HEX);
    }
  });
});
