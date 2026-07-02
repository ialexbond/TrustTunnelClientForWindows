// Phase 13 / Plan 13-02 (Wave 1) — the per-kind copy map for the connection notification plate.
//
// Promoted to production from the `TOK` + `toasts` maps in `Notification.stories.tsx` (the story
// surface D-25 pins). This module is the single source of truth for WHICH icon / colour / title /
// body a NotifyKind renders. It is a PURE data map — no window, no I/O — so it can be snapshot-
// tested in isolation before the plate component exists (Wave 2).
//
// Divergences from the story (deliberate):
//   - DROP `connecting` and `disconnecting` — the 2 transient wire-states are NOT notification
//     kinds (D-01); only the 7 outcome kinds fire.
//   - ADD `disconnected` — the story has no «Отключено» toast, but D-01 fires it, so it is added
//     here (title «Отключено», Power icon, muted colour).
//
// D-29 / T-13-SEC-01: bodies interpolate the config DISPLAY NAME only (via `buildBody`), never the
// endpoint password or `.toml` content. The config name is a plain string, rendered as React text
// (no innerHTML — V5).
//
// 13-07 (UAT round-3 defect 2): the copy is now BILINGUAL (ru + en). The plate is a separate Vite
// entry (own webview) so it does NOT round-trip through the main-window i18n store; instead the app's
// effective language ("ru" | "en") is mirrored into Rust (`set_plate_language`) and threaded into the
// `notify-plate` payload, and the plate selects the copy for that language here. Russian stays the
// PRIMARY language (the app's default); English mirrors it — matching the repo's ru-primary/en-mirror
// i18n convention. (Before 13-07 the copy was hardcoded Russian, so the plate stayed Russian on the
// English app language.)
import {
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  ArrowRightLeft,
  Power,
  type LucideIcon,
} from "lucide-react";

/** The 7 production notification kinds (the wire values the plate renders). The 2 transient
 *  wire-states (connecting / disconnecting) are deliberately absent (D-01).
 *
 *  13-10 (§A): PLUS `switching` — a NEW transient START kind fired directly by the Rust setter
 *  `set_switch_or_reconnect_pending(true)` the moment a DELIBERATE server switch begins — AUTO
 *  (the engine) or MANUAL («Переключиться» on another card; Fable-A review #6, the FE threads an
 *  `isSwitch` hint so the Rust seam tells a switch from a same-server reconnect even though both
 *  manual flows carry origin=Manual) — so the owner SEES «Переключение…» while the servers change
 *  (the terminal «Переключено автоматически» / «Подключено» then REPLACES it via the latest-wins
 *  staging). It is FE-only: it is NOT produced by the pure Rust `decide_notification` decider
 *  (which stays at its 7 outcome kinds) — the setter fires this wire key straight to
 *  `fire_plate_tail`. A manual save-and-reconnect (same server) reuses the EXISTING `reconnecting`
 *  kind for its start plate, so no second manual-start kind is needed. */
export type NotifyKind =
  | "connected"
  | "connectionError"
  | "reconnecting"
  | "recovering"
  | "autoSwitched"
  | "autoConnected"
  | "disconnected"
  | "switching";

/** The two languages the plate copy supports — mirrors the app's ru-primary / en-mirror i18n.
 *  Threaded from Rust (`set_plate_language`, whitelisted to these two values). */
export type PlateLang = "ru" | "en";

/** One entry of the copy map: the language-independent icon COMPONENT + CSS colour TOKEN, plus the
 *  per-language `title` and `body` builder. `body` takes the display name only — never a password
 *  (D-29). */
export interface NotificationCopy {
  /** State icon (Lucide component). The plate paints it in `iconColor`. Language-independent. */
  icon: LucideIcon;
  /** CSS colour token for the icon — a `--color-status-*` / `--color-text-muted` var(), no hex.
   *  Language-independent. */
  iconColor: string;
  /** Bold title — the short state word, per language. */
  title: Record<PlateLang, string>;
  /** Build the quiet one-line body from the live config display name (never the password), per
   *  language. */
  body: Record<PlateLang, (configName: string) => string>;
}

/** Icon colour tokens — one source of truth for the connected / warning / error / muted buckets.
 *  These mirror `Notification.stories.tsx`'s `TOK`; they are `var(--…)` tokens, never hardcoded hex. */
const TOK = {
  connected: "var(--color-status-connected)",
  warning: "var(--color-status-warning)",
  error: "var(--color-status-error)",
  muted: "var(--color-text-muted)",
} as const;

/** The per-kind copy map — exactly the 7 outcome kinds, keyed by their wire value.
 *  `satisfies` (not `:`) so the literal keeps its precise key set for the static key assertions in
 *  the test while still being checked against `Record<NotifyKind, NotificationCopy>`. */
export const notificationCopy = {
  connected: {
    icon: CheckCircle2,
    iconColor: TOK.connected,
    title: { ru: "Подключено", en: "Connected" },
    body: {
      ru: (name: string) => `VPN активен: «${name}»`,
      en: (name: string) => `VPN active: "${name}"`,
    },
  },
  connectionError: {
    icon: AlertTriangle,
    iconColor: TOK.error,
    title: { ru: "Ошибка подключения", en: "Connection error" },
    body: {
      // No title/body word-dup («подключиться» would echo the title «подключения») — «связаться».
      ru: (name: string) => `Не удалось связаться с «${name}»`,
      en: (name: string) => `Couldn't reach "${name}"`,
    },
  },
  reconnecting: {
    icon: RefreshCw,
    iconColor: TOK.warning,
    title: { ru: "Переподключение", en: "Reconnecting" },
    body: {
      // Impersonal — the plate never speaks in the first person («восстанавливаю» → «идёт восстановление»).
      ru: () => "Связь прервалась — идёт восстановление",
      en: () => "Connection lost — restoring",
    },
  },
  recovering: {
    icon: RefreshCw,
    iconColor: TOK.warning,
    title: { ru: "Ожидание сети", en: "Waiting for network" },
    body: {
      // Impersonal + no title/body dup (title carries «сети»; body adds the outcome).
      ru: () => "Переподключение произойдёт автоматически",
      en: () => "Will reconnect automatically",
    },
  },
  autoSwitched: {
    icon: ArrowRightLeft,
    iconColor: TOK.connected,
    title: { ru: "Переключено автоматически", en: "Switched automatically" },
    body: {
      // No dup with the title «Переключено автоматически» — body drops «переключено», gives the target.
      ru: (name: string) => `Связь ухудшилась, теперь «${name}»`,
      en: (name: string) => `Signal degraded, now "${name}"`,
    },
  },
  autoConnected: {
    icon: Power,
    iconColor: TOK.connected,
    title: { ru: "Автоподключение при запуске", en: "Auto-connect on launch" },
    body: {
      // No dup with the title «Автоподключение…» (both root «подключ») — body states what's active.
      ru: (name: string) => `Активен сервер «${name}»`,
      en: (name: string) => `Server "${name}" active`,
    },
  },
  // NEW (the story lacks a `disconnected` toast): D-01 fires «Отключено» on the tunnel going down.
  disconnected: {
    icon: Power,
    iconColor: TOK.muted,
    title: { ru: "Отключено", en: "Disconnected" },
    body: {
      // No dup with the title «Отключено»/«отключён» — body states the consequence instead.
      ru: () => "Трафик идёт напрямую",
      en: () => "Traffic goes directly",
    },
  },
  // 13-10 (§A): the switch START plate — fired the moment a deliberate server switch begins (Rust
  // `set_switch_or_reconnect_pending(true)` with the switch hint / an AutoSwitch pending origin), so
  // the owner SEES the switch happening. A TRANSIENT/start kind — no config-name interpolation in the
  // body (the target server is not yet chosen at start time; the terminal «Переключено автоматически»
  // carries the name when it replaces this). ArrowRightLeft + warning colour mirror `autoSwitched`, so
  // the start→result pair reads as one continuous switch. (A manual save-and-reconnect reuses the
  // `reconnecting` kind for its start plate, so it is not a second entry here.)
  //
  // Fable-A review #6 (owner decision): the copy is NEUTRAL — no degraded-signal claim (this kind now
  // fires for the MANUAL switch too, where nothing degraded), and IMPERSONAL — the plate never speaks in
  // the first person («Переключаюсь…»/«Переключаю сервер…» → «Переключение…»/«Переход на другой сервер»).
  // On the AUTO switch the neutral copy stays honest — the terminal «Переключено автоматически» plate
  // still carries the «Связь ухудшилась …» explanation.
  switching: {
    icon: ArrowRightLeft,
    iconColor: TOK.warning,
    title: { ru: "Переключение…", en: "Switching…" },
    body: {
      ru: () => "Переход на другой сервер",
      en: () => "Moving to another server",
    },
  },
} satisfies Record<NotifyKind, NotificationCopy>;

/** The × close affordance copy (review #11) — the plate IconButton's `aria-label` + `tooltip`, per
 *  language. It lives HERE with the rest of the plate copy so the ru/en pair cannot drift from the
 *  kind map. `ConnectionToast` itself still DEFAULTS to the Russian pair (its Storybook/card usages
 *  are Russian-only and stay unchanged); the production plate (`notification.tsx`) resolves this map
 *  with the payload-threaded language, so the × is announced in the same language as the copy. */
export const plateCloseCopy: Record<PlateLang, { label: string; tooltip: string }> = {
  ru: { label: "Закрыть уведомление", tooltip: "Закрыть" },
  en: { label: "Close notification", tooltip: "Close" },
};

/** Resolve the language-appropriate icon + colour + title for a kind. A thin selector so the plate
 *  call site does not reach into the nested `title[lang]` shape. */
export function getNotificationCopy(
  kind: NotifyKind,
  lang: PlateLang,
): { icon: LucideIcon; iconColor: string; title: string } {
  const c = notificationCopy[kind];
  return { icon: c.icon, iconColor: c.iconColor, title: c.title[lang] };
}

/** Build the plate body for a kind + live config display name in the given language (never the
 *  password — D-29). A thin helper over `notificationCopy[kind].body[lang]` so the call site does
 *  not reach into the nested map. */
export function buildBody(kind: NotifyKind, configName: string, lang: PlateLang): string {
  return notificationCopy[kind].body[lang](configName);
}
