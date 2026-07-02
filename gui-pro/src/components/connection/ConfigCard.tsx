import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Check, Clock, ClipboardList, Copy, Globe, Loader2, Pencil, Settings, Trash2, X } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { StatusBadge } from "../../shared/ui/StatusBadge";
import { Tooltip } from "../../shared/ui/Tooltip";
import { FieldError } from "../../shared/ui/FieldError";
import { OverflowMenu, type OverflowMenuItem } from "../../shared/ui/OverflowMenu";
import { statusBadgeVariant } from "../../shared/lib/statusBadgeVariant";
import { ConfigPingPill, type ConfigPing } from "./ConfigPingPill";
import { InlineNameEdit } from "./InlineNameEdit";
import type { VpnStatus } from "../../shared/types";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";

/**
 * `ConfigCard` (production, Phase 11 Plan 11-03) — one horizontal config card. It mirrors
 * the story-tier `connectionDemos.tsx` `ConfigCardDemo` pixel-for-pixel, but built from
 * production `shared/ui` primitives, the real `ConfigPingPill`, i18n strings, and the
 * StatusPanel status→colour mapping (reused verbatim so the lead-card states land in the
 * right colour band by construction).
 *
 * Two shapes:
 *   - LEAD CARD (`leadCard`) — the active/last-used config. A 3-column vertically-centred
 *     strip: status badge (left) · centred name + «host · ping · uptime» meta · primary
 *     button + overflow (right). Connected → green «Отключить» (danger) + ping + monospace
 *     uptime; any in-flight state → an icon-only spinner (no text), ping HIDDEN. The active
 *     highlight is a green tint + FULL ring (NO left accent rail — banned design artifact).
 *   - RESTING ROW (inactive) — leading glyph (or a busy spinner) · name + «host · username»
 *     · ping pill · primary («Переключиться» when a tunnel is active elsewhere, D-20) +
 *     overflow. No status dot (a resting config's dot would be always-grey, info-free).
 *
 * Decisions honoured: D-18 (lead card carries the lifecycle, no separate block), D-20
 * («Переключиться» on inactive), D-21 (lock the primary + overflow while another connects),
 * D-26 (overflow collapsed by default: Изменить/Дублировать/Удалить — QR deferred), F03
 * (ping hidden during connecting/disconnecting/error). NO `switching`/`switch-failed`
 * wire-state and NO new VpnStatus value are introduced (Pitfall 4).
 */

// ─── TruncatedText (production helper, lifted from connectionDemos) ───────────

/** Tooltip width for the full-text reveal — wide so a long name/host reads on 1–2 lines. */
const FULL_TEXT_TOOLTIP_W = 600;

/**
 * A single-line text that clips with «…» AND reveals its FULL value in the Tooltip on
 * hover, but ONLY when it is actually clipped (measured via ResizeObserver). Used for every
 * truncatable datum on the card so the full text is always reachable at the 672px card
 * width (Pitfall 7). Needs a width-bounded parent (min-w-0 cell), which all call-sites give.
 */
function TruncatedText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure once up-front (also the only measurement in jsdom, which lacks
    // ResizeObserver), then observe width changes when the API is available.
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <Tooltip text={text} maxWidth={FULL_TEXT_TOOLTIP_W} disabled={!clipped} className="flex min-w-0 max-w-full">
      <span ref={ref} className={`block w-full select-none truncate ${className ?? ""}`}>
        {text}
      </span>
    </Tooltip>
  );
}

// ─── Lifecycle helpers (VpnStatus only — no deferred switching states) ────────

/** In-flight lifecycles → the lead primary shows a SPINNER (loading) instead of a text
 *  label, because an action is already running. connected / disconnected / error are
 *  settled (they render a real text button). */
function isInFlight(status: VpnStatus): boolean {
  return (
    status === "connecting" ||
    status === "reconnecting" ||
    status === "recovering" ||
    status === "disconnecting"
  );
}

/** A config's ping pill is only honest for the settled disconnected/connected states.
 *  During any in-flight transition or error a stale ping must NOT paint (F03). */
function shouldShowPing(status: VpnStatus): boolean {
  return status === "connected" || status === "disconnected";
}

export interface ConfigCardProps {
  config: ConfigSummary;
  /** The VPN lifecycle for THIS card. Only the lead (active) card sees non-disconnected
   *  states; inactive cards are always "disconnected". */
  status?: VpnStatus;
  /** The resolved ping band for this config (from usePerConfigPing). When absent the pill
   *  reads no-data «—». */
  ping?: ConfigPing;
  /** Lead-card mode — carries the big primary, monospace uptime, ping, and the lifecycle. */
  leadCard?: boolean;
  /** Monospace uptime string for the lead card (e.g. «01:23:45»). */
  uptime?: string;
  /** A mutation (duplicate/delete) is in flight — actions disabled, a spinner on the dot. */
  busy?: boolean;
  /** A tunnel is active on ANOTHER card → this inactive card's primary reads «Переключиться». */
  activeElsewhere?: boolean;
  /** Another card is connecting → this card's primary + overflow are locked (D-21). */
  locked?: boolean;
  onConnect?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  /**
   * Commit a rename (D-14). Receives the trimmed new name ("" is a valid clear — IN-58);
   * returns an error i18n-resolved string when the name is rejected (duplicate / backend
   * failure) so the card can render a FieldError and keep the rename open, or
   * void/undefined on success (the card exits edit mode).
   * Only the resting (inactive) row exposes rename — the lead card's name is read-only.
   */
  onRename?: (newName: string) => Promise<string | void> | string | void;
  /** Names already taken by OTHER configs — used for the inline duplicate-name check. */
  existingNames?: string[];
}

export function ConfigCard({
  config,
  status = "disconnected",
  ping,
  leadCard = false,
  uptime,
  busy = false,
  activeElsewhere = false,
  locked = false,
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onRename,
  existingNames = [],
}: ConfigCardProps) {
  const { t } = useTranslation();

  const effectivePing: ConfigPing = ping ?? { band: "no-data" };
  const isConnected = status === "connected";

  // IN-58: an EMPTY name is VALID, and the card TITLE then falls back to the config's
  // username (owner: «при пустом имени отображается username из конфига»). The Rust list
  // already derives endpoint.name → username on read (manifest.rs::summarize_unchecked),
  // so a blank name normally never reaches this card via list_configs — this render-level
  // fallback keeps the rule true at the COMPONENT contract too (stories/tests/any caller
  // can pass a raw empty name). NOTE: the rename DRAFT below still starts from the RAW
  // config.name — the pencil edits the real (possibly empty) name, never the fallback.
  const displayName = config.name.trim() ? config.name : config.user;

  // ─── Inline rename state (D-14, resting/inactive row ONLY) ───
  // The name is the config's user-facing TITLE (source: endpoint.name → else username).
  // It is committed ONLY by Enter/✓ and ONLY when valid; ✗/Escape (and any other action via
  // runAction) discards the draft. A DUPLICATE name shows a FieldError and never commits;
  // an EMPTY name is a valid clear (IN-58 — the title falls back to the username).
  // INLINE rename via the pencil is offered ONLY on the resting (inactive) card; the
  // ACTIVE/lead card's title is read-only here and is edited in «Изменить» → «Настройки
  // конфигурации» → «Имя конфига» instead (ConfigEditView), then applied on save.
  const renameEnabled = !leadCard && Boolean(onRename);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(config.name);
  const [renameError, setRenameError] = useState<string | null>(null);

  const trimmed = draft.trim();
  // IN-58: an EMPTY name is VALID — it clears the title and the card then shows the username
  // (owner: "имя может быть пустым, тогда отображается username"). Only a DUPLICATE is blocked;
  // the empty-name error was removed. Clearing commits onRename("") → backend clears endpoint.name.
  const isDuplicate =
    trimmed !== config.name && existingNames.some((n) => n === trimmed);
  const localError = isDuplicate ? t("connection.rename.error_duplicate") : null;
  // The displayed error is the local validation error OR a server-side error from onRename.
  const nameErrorMsg = editing ? (localError ?? renameError) : null;
  const nameInvalid = nameErrorMsg !== null;

  const startRename = () => {
    setDraft(config.name);
    setRenameError(null);
    setEditing(true);
  };
  const cancelRename = () => {
    setDraft(config.name);
    setRenameError(null);
    setEditing(false);
  };
  const commitRename = async () => {
    if (localError) return; // never commit a duplicate name (empty is a valid clear, IN-58)
    if (trimmed === config.name) {
      // No change — just close the editor (no-op commit).
      setEditing(false);
      return;
    }
    const result = onRename ? await onRename(trimmed) : undefined;
    if (typeof result === "string" && result) {
      // The mutation rejected (e.g. a backend duplicate/rename failure) — keep the editor
      // open and surface the error below the field.
      setRenameError(result);
      return;
    }
    setEditing(false);
    setRenameError(null);
  };
  // Any non-rename action on a card with an open rename cancels the rename first (D-14), so
  // an in-flight rename never hangs when the user clicks Connect / an overflow item.
  const runAction = (fn?: () => void) => () => {
    if (editing) cancelRename();
    fn?.();
  };

  // The inline name editor (InlineNameEdit + ✓/✗ + FieldError) — shared verbatim by the lead
  // card's centred hero name and the resting row, so both edit the title the same way.
  const nameEditor = (
    <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
      <div className="flex min-h-8 min-w-0 items-center gap-[var(--space-1)]">
        <InlineNameEdit
          value={draft}
          onChange={(v) => {
            setDraft(v);
            setRenameError(null);
          }}
          onCommit={() => void commitRename()}
          onCancel={cancelRename}
          maxLength={64}
          ariaLabel={t("connection.rename.edit_aria")}
          invalid={nameInvalid}
          autoFocus
        />
        {/* ✓ commits (disabled while invalid), ✗ discards — nothing saves without an explicit
            ✓/Enter, and a duplicate name can never save (D-14). An EMPTY draft commits a
            valid clear (IN-58) — the title then falls back to the username. */}
        <IconButton
          aria-label={t("connection.rename.commit")}
          tooltip={t("connection.rename.commit")}
          icon={<Check className="w-3.5 h-3.5" />}
          onClick={() => void commitRename()}
          disabled={Boolean(localError)}
          className="h-6 w-6 shrink-0"
        />
        <IconButton
          aria-label={t("connection.rename.cancel")}
          tooltip={t("connection.rename.cancel")}
          icon={<X className="w-3.5 h-3.5" />}
          onClick={cancelRename}
          className="h-6 w-6 shrink-0"
        />
      </div>
      {/* Validation message below the field via the shared FieldError primitive. */}
      {nameErrorMsg && <FieldError>{nameErrorMsg}</FieldError>}
    </div>
  );

  // D-17 active highlight: an 8% green tint over the surface + a FULL-perimeter green ring
  // (the stronger success-ramp token so the ring survives on a near-white light surface).
  // There is deliberately NO single-sided (left-edge) accent rail (feedback_no_left_accent_rail).
  const highlightActive = leadCard && isConnected;
  // The lead card ALWAYS sits inside ConfigList's frosted-glass wrapper (leadCard ⟺ a live hero:
  // connecting / connected / disconnecting / reconnecting / recovering). For that frost to show
  // through, the lead-card body must stay TRANSPARENT in EVERY live state — an opaque Card surface
  // hides the glass (owner: «отключение»/«подключение» read as solid grey). Connected additionally
  // gets the 8% green tint + ring (the active marker); the other live states show the neutral frost
  // alone. Resting (inactive) rows keep Card's opaque surface (no wrapper behind them).
  const activeHighlightClass = highlightActive
    ? "bg-[var(--color-status-connected-bg)] ring-1 ring-[var(--color-success-tint-25)]"
    : leadCard
      ? "bg-transparent"
      : "";

  // Lead-card status label — short state word (no trailing «…» in the badge). Uses the
  // existing status.* i18n keys (the _short variants for in-flight states).
  const leadStatusLabel =
    status === "connected"
      ? t("status.connected")
      : status === "connecting"
        ? t("status.connecting_short")
        : status === "reconnecting"
          ? t("status.reconnecting_short")
          : status === "recovering"
            ? t("status.recovering_short")
            : status === "disconnecting"
              ? t("status.disconnecting_short")
              : status === "error"
                ? t("status.error")
                : t("status.disconnected");

  // D-20: an inactive card's primary reads «Переключиться» when a tunnel is active on
  // ANOTHER card; otherwise the resting primary is «Подключить». The connected card's
  // primary is «Отключить».
  const primaryLabel = isConnected
    ? t("connection.card.disconnect")
    : activeElsewhere
      ? t("connection.card.switch")
      : t("connection.card.connect");

  // D-19 / D-26: the three secondary actions live in the OverflowMenu BY DEFAULT, each with
  // its one canonical glyph. QR is DEFERRED this phase (not shown). D-21: locked while
  // another card is connecting.
  const overflowItems: OverflowMenuItem[] = [
    {
      label: t("connection.card.edit"),
      onSelect: runAction(onEdit),
      icon: <Settings className="w-3.5 h-3.5" />,
      disabled: locked,
    },
    {
      label: t("connection.card.duplicate"),
      onSelect: runAction(onDuplicate),
      icon: <Copy className="w-3.5 h-3.5" />,
      disabled: locked,
    },
    {
      label: t("connection.card.delete"),
      onSelect: runAction(onDelete),
      icon: <Trash2 className="w-3.5 h-3.5" />,
      destructive: true,
      disabled: locked,
    },
  ];

  return (
    <Card
      padding="sm"
      // The hero (any live state) never hover-highlights its border — it is the frosted focal card,
      // not an actionable row. Only resting (inactive) rows get the hover affordance.
      hover={!leadCard}
      data-testid="config-card"
      data-lead={leadCard ? "true" : undefined}
      // data-active-highlight is an inert testability hook: tests assert the green-active
      // marker semantically (not via CSS hex), and confirm NO left-accent-rail element.
      data-active-highlight={highlightActive ? "true" : undefined}
      // IN-38: the live lead card keeps the normal --radius-lg (ROUNDED corners) — the owner
      // explicitly reverted the IN-28 square. Corner "bleed" (sharp scrolled-under content peeking
      // past the rounded corner) is handled NOT by squaring the card but by the sticky wrapper's
      // SQUARE frost in ConfigList: an un-rounded frost is not clipped to a radius, so it fills the
      // corner triangles with a soft blur instead of leaving them transparent.
      className={`transition-all ${activeHighlightClass}`}
    >
      {leadCard ? (
        /* ── Lead card: one vertically-centred 3-column strip ── */
        <div className="grid min-h-[3.75rem] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[var(--space-3)]">
          {/* Left: status badge */}
          <div className="flex min-w-0 items-center">
            <StatusBadge variant={statusBadgeVariant(status)} label={leadStatusLabel} />
          </div>

          {/* Centre: config identity — name (hero, READ-ONLY here) + «host · ping · uptime»
              meta. The active config's title is edited in «Изменить» (ConfigEditView), not
              inline — inline rename is a resting-row affordance only. */}
          <div className="flex min-w-0 flex-col items-center gap-[var(--space-1)] text-center">
            <TruncatedText
              text={displayName}
              className="max-w-full text-base font-semibold text-[var(--color-text-primary)]"
            />
            <div className="flex min-w-0 max-w-full items-center justify-center gap-[var(--space-3)] text-xs text-[var(--color-text-muted)]">
              <span className="flex min-w-0 items-center gap-[var(--space-1)]">
                <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <TruncatedText text={config.host} className="min-w-0 font-mono" />
              </span>
              {isConnected && shouldShowPing(status) && (
                <span className="flex shrink-0 items-center gap-[var(--space-1)]">
                  <Activity className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <ConfigPingPill ping={effectivePing} />
                </span>
              )}
              {isConnected && uptime && (
                <span className="flex shrink-0 items-center gap-[var(--space-1)] font-mono tabular-nums">
                  <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {uptime}
                </span>
              )}
            </div>
          </div>

          {/* Right: primary + overflow. min-w-[9rem] fits the longest label «Переключиться». */}
          <div className="flex items-center justify-end gap-[var(--space-1)]">
            {isInFlight(status) ? (
              <Button
                variant="ghost"
                size="sm"
                disabled
                loading
                aria-label={leadStatusLabel}
                title={leadStatusLabel}
                className="min-w-[9rem] justify-center"
              />
            ) : (
              <Button
                variant={isConnected ? "danger" : "ghost"}
                size="sm"
                onClick={() => onConnect?.()}
                disabled={busy || locked}
                aria-label={primaryLabel}
                className="min-w-[9rem] justify-center"
              >
                {primaryLabel}
              </Button>
            )}
            <OverflowMenu
              items={overflowItems}
              triggerAriaLabel={t("connection.card.actions_label")}
              className={locked ? "pointer-events-none opacity-50" : ""}
            />
          </div>
        </div>
      ) : (
        /* ── Resting (inactive) row ── */
        <div className="flex items-center gap-[var(--space-3)] min-w-0">
          {/* Leading slot — a glyph that swaps to a busy spinner WITHOUT shifting the row. */}
          {busy ? (
            <Loader2
              className="w-4 h-4 shrink-0 animate-spin text-[var(--color-text-muted)]"
              aria-label={t("connection.card.busy_label")}
            />
          ) : (
            <ClipboardList className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
          )}

          {/* Name area: display / inline-edit / error sub-states (D-14). The display↔edit
              swap keeps a constant min-height (h-8) so the host line never shifts. Rename is
              offered only when the caller wires onRename (resting card only). */}
          <div className="flex flex-col min-w-0 flex-1 gap-[var(--space-1)]">
            {editing ? (
              nameEditor
            ) : (
              <div className="flex items-center gap-[var(--space-1)] min-w-0 min-h-8">
                <TruncatedText
                  text={displayName}
                  className="min-w-0 text-sm font-medium text-[var(--color-text-primary)]"
                />
                {renameEnabled && (
                  <IconButton
                    aria-label={t("connection.rename.aria")}
                    tooltip={t("connection.rename.aria")}
                    icon={<Pencil className="w-3.5 h-3.5" />}
                    onClick={startRename}
                    disabled={busy || locked}
                    className="h-6 w-6 shrink-0"
                  />
                )}
              </div>
            )}

            <div className="flex items-center gap-[var(--space-1)] min-w-0 text-xs text-[var(--color-text-muted)]">
              <TruncatedText text={config.host} className="min-w-0 font-mono" />
              {config.user && (
                <>
                  <span aria-hidden="true" className="shrink-0 select-none">·</span>
                  <span className="shrink-0 select-none truncate">{config.user}</span>
                </>
              )}
            </div>
          </div>

          {/* Ping pill — right-aligned in a fixed column; only for the settled buckets (F03). */}
          {shouldShowPing(status) && (
            <div className="flex w-20 shrink-0 items-center justify-end">
              <ConfigPingPill ping={effectivePing} />
            </div>
          )}

          {/* Action zone — primary + overflow, separated by a wider gap (Gestalt). */}
          <div className="flex items-center gap-[var(--space-1)] shrink-0 ml-[var(--space-4)]">
            <Button
              variant={isConnected ? "danger" : "ghost"}
              size="sm"
              onClick={runAction(onConnect)}
              disabled={busy || locked}
              aria-label={primaryLabel}
              className="min-w-[9rem] justify-center"
            >
              {primaryLabel}
            </Button>
            <OverflowMenu
              items={overflowItems}
              triggerAriaLabel={t("connection.card.actions_label")}
              className={locked ? "pointer-events-none opacity-50" : ""}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
