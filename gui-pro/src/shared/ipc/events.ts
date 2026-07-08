// PA-1 (Phase 17): the single typed mirror of the Rust IPC event payloads.
//
// The `internet-status` and `vpn-adapter-conflict` events used to be emitted as ad-hoc
// `serde_json::json!` blobs on the Rust side, with the field names living ONLY in string
// literals on both ends — a rename compiled clean and silently killed banner routing
// (16-PATTERN-AUDIT §MAJOR-3/§MAJOR-4, Pitfall 2). The Rust producers are now typed serde
// structs (`InternetStatusPayload` / `AdapterConflictPayload` in commands/vpn.rs +
// connectivity.rs), and THIS file is the FE half of that contract: the interfaces below
// mirror the Rust wire shape exactly, so a field rename on either end fails a test instead
// of drifting silently.
//
// A serde byte-identity round-trip test locks the Rust shape (vpn.rs
// `wave0_pa1_internet_and_adapter_payloads_are_byte_identical`); the sibling
// `events.test.ts` locks the FE shape. The listener retype that CONSUMES these interfaces
// (useVpnEvents decomposition) is plan 17-05's job — this file ships the producer-side
// contract + the interface so 17-05 wires the consumer against a typed target.

/**
 * The `"internet-status"` event channel — connectivity transitions Rust announces so the
 * banner routing (server-lost / internet-lost / gave-up) can react. Emitted at every
 * `internet-status` site in `connectivity.rs` (all now `InternetStatusPayload` structs).
 */
export const INTERNET_STATUS_EVENT = "internet-status" as const;

/**
 * The `"vpn-adapter-conflict"` event channel — a foreign VPN adapter was detected while (or
 * before) connecting, so the «Подключение» tab can show the yellow second-VPN banner.
 */
export const ADAPTER_CONFLICT_EVENT = "vpn-adapter-conflict" as const;

/**
 * Stable action code the `"internet-status"` event carries. F10/F15 (Fable-5 review): narrowed
 * from a plain `string` to the closed literal union of the ACTUAL codes the Rust side emits, so a
 * mistyped comparison in a consumer (`action === "give-up"`) is a tsc error, not a silent
 * banner-kill. Mirrors the Rust `InternetStatusAction` enum's serde renames (verified byte-identical
 * by the vpn.rs round-trip test). `"reconnect"` is intentionally ABSENT — PA-4 removed every Rust
 * producer of it (F15), so it can no longer arrive on the wire.
 */
export type InternetStatusAction = "disconnect" | "give_up";

/**
 * Stable reason code that classifies a `disconnect` drop. F10: narrowed to the closed literal union
 * of the real Rust codes (mirrors `InternetStatusReason`). Stage-2 localizes these — never a
 * Russian string on the wire.
 */
export type InternetStatusReason = "tunnel-lost" | "internet-lost";

/**
 * Mirrors Rust `InternetStatusPayload { online, action, reason }`.
 *
 * On the wire the two optional fields are SKIPPED when the Rust `Option` is `None`
 * (`skip_serializing_if = "Option::is_none"`), so an online event arrives as just
 * `{ online: true }`. Banner routing branches on `online` + `action` (and `reason` to
 * distinguish `tunnel-lost` from `internet-lost`). The values are STABLE ASCII codes the
 * Rust side controls — never a localized/Russian string (Stage-2 localizes `reason`). F10:
 * `action`/`reason` are typed as closed literal unions (not plain `string`) so a mistyped code
 * on either end is a compile error, mirroring the Rust closed enums.
 */
export interface InternetStatusEvent {
  online: boolean;
  /** Stable action code: `"disconnect"` | `"give_up"` (omitted when None). */
  action?: InternetStatusAction;
  /** Stable reason code: `"tunnel-lost"` | `"internet-lost"` (omitted when None). */
  reason?: InternetStatusReason;
}

/**
 * Mirrors Rust `AdapterConflictPayload { adapters, message }`.
 *
 * `adapters` is already own-adapter-filtered Rust-side (T-21), so every entry is a genuinely
 * foreign VPN; `message` is the human warning the yellow banner shows.
 */
export interface AdapterConflictEvent {
  adapters: string[];
  message: string;
}

/**
 * Mirrors Rust `ConnectOutcome { spawned, reason }` (camelCase serde) — the resolved value
 * of `invoke("vpn_connect", …)` (NIT-1). `spawned: false` means the connect bailed to a
 * clean Disconnected WITHOUT a live session because a genuine disconnect/cancel superseded
 * it (F11); `reason` is then a STABLE ASCII token (currently only
 * `"superseded-by-disconnect"`), never prose or a secret (D-29). `reason` is omitted when
 * `spawned` is true.
 *
 * `switchTo` reacts to `spawned:false` (release the switch lock immediately — no 15s park on
 * a terminal edge that never comes). `handleConnect` (the direct-connect path) intentionally
 * does NOT react to it: a supersede there means a disconnect already landed, and the Rust
 * `vpn-status` event is the single status owner (D-01) that drives the UI. The decision is
 * recorded once here so the two call sites read the SAME typed shape without re-deciding.
 */
export interface ConnectOutcome {
  spawned: boolean;
  reason?: string;
}
