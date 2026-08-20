import { useEffect, useMemo, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * The shared, lazy, batched, session-scoped application-icon cache (D-01/D-02).
 *
 * WHY THIS EXISTS AT ALL. The tracer in plan 24-02 let every `ProcessIcon` fetch for itself. That is
 * fine for the saved list, which holds a handful of rows, and ruinous for the picker, which can list
 * ~200 running processes: one command per row would be ~200 IPC round-trips and ~200 process
 * snapshots on a single scroll, and a cold shell icon cache costs single-digit seconds to resolve
 * them all. So the modal must open instantly and fill icons in as the user scrolls.
 *
 * WHY IT LOOKS HAND-BUILT. Nothing in this codebase batches, debounces or de-duplicates in-flight
 * requests — there is no hook to copy and no library in the dependency set that does this. The only
 * idiom borrowed from elsewhere is the session-lifetime key→value cache holder
 * (`shared/hooks/useConfigPingSource.ts`, a `Map` held outside the render cycle). Everything below —
 * the in-flight set, the debounce, the ≤32 batch splitter and the negative cache — is written from
 * scratch, so each rule is spelled out here rather than left for a reader to infer.
 *
 * THE FOUR SCHEDULING RULES, and what each one prevents:
 *
 *  1. DEBOUNCE (~100 ms). Rows declare their need as they mount or scroll into view; without a
 *     coalescing window, a fast scroll would issue one call per row per frame. One shared timer
 *     collects every declaration in the window into a single flush.
 *  2. BATCH ≤ 32 NAMES, SENT ONE AT A TIME. The backend takes ONE process snapshot per call and
 *     reuses it, so a batch is dramatically cheaper than N calls. The cap exists on the other side
 *     of the trade: a single unbounded call would occupy the blocking thread for its whole duration,
 *     so a bounded call is what lets other work reach that pool in between.
 *     The chunks are therefore AWAITED IN SEQUENCE, not fired together. Firing them together was
 *     the opposite of what this rule is for: one fling down a 200-row list declared the whole list,
 *     and the next flush issued seven simultaneous `get_process_icons` calls — seven full
 *     `CreateToolhelp32Snapshot` walks of every process on the machine, each holding a
 *     blocking-pool thread through up to 32 cold shell-icon lookups, on the pool the VPN
 *     connectivity monitor shares. Awaiting them gives the intended shape: bounded units of work,
 *     one at a time, with room between them.
 *  3. NEVER ASK TWICE. A name already resolved, already known-unresolvable, or currently in flight is
 *     skipped. Without the in-flight set, scrolling a row out of and back into view before its answer
 *     lands would fire a duplicate call for a question already being asked.
 *  4. CACHE THE NEGATIVE ANSWER. `icon: null` (a protected or elevated process the backend cannot
 *     open) is cached exactly as firmly as a hit. Caching only successes would make every scroll past
 *     such a row re-pay a lookup guaranteed to fail — a request storm wearing laziness as a costume.
 *
 * MEMORY ONLY, APP SESSION ONLY (D-02). Nothing here touches browser storage or the filesystem. The
 * cache is a module-level `Map`, which is precisely as long-lived as the running app and no longer.
 * (Note for the next author: do NOT name the browser storage APIs in this file, not even to say they
 * are unused. The acceptance gate for this rule is a plain grep for those API names, and it cannot
 * tell a comment from a call — spelling them out here would make the gate report a violation that
 * does not exist. The same trap cost a rerun in plan 24-02.)
 *
 * WHY MODULE-LEVEL AND NOT A PROVIDER. The saved list (`ProcessFilterSection`) and the picker
 * (`ProcessPickerModal`) show the same programs, so resolving `chrome.exe` twice would be waste the
 * user can feel. One cache must sit above both. A React context would force a provider around every
 * consumer — including each one's tests and stories — for no gain, and would reset whenever that
 * provider unmounted. A module-level store is shared by construction and survives remounts, which is
 * exactly the "one app session" lifetime D-02 asks for. Its one cost is that it also survives between
 * tests in a file, so `resetProcessIconCache()` exists for suites to call in `beforeEach`.
 */

/** One row of the `get_process_icons` answer. `icon` is a PNG data URL, or null when unresolvable. */
interface ProcessIconRecord {
  name: string;
  icon: string | null;
}

/** Names per `invoke` call. See scheduling rule 2 above for why this is capped at all. */
export const ICON_BATCH_SIZE = 32;

/** Coalescing window in ms. See scheduling rule 1. */
export const ICON_REQUEST_DEBOUNCE_MS = 100;

/**
 * Resolved answers: cache key → PNG data URL, or null for "the backend says there is no icon".
 * A present key means the question is settled and must never be asked again.
 */
const cache = new Map<string, string | null>();

/** Names whose command call is currently airborne. Rule 3's de-duplication. */
const inFlight = new Set<string>();

/**
 * Names whose last batch REJECTED — the command itself failed, as opposed to the backend answering
 * "no icon for this one". Deliberately NOT the cache: a transient failure must not blank a row for
 * the rest of the session, so the next declaration of that name retries it. It still reads as
 * "unavailable" meanwhile, because a row that shows a skeleton forever is a worse lie than a row
 * that shows the neutral fallback glyph.
 */
const failed = new Set<string>();

/** Declared-but-not-yet-sent names: cache key → the name EXACTLY as the caller spelled it. */
const queued = new Map<string, string>();

const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The cache key is the lowercased name — it matches the key the picker already de-duplicates on, and
 * the backend already compares case-insensitively. Note this is a UI-side lookup key ONLY: the name
 * we SEND, and the name the app persists, stay exactly as the process reported them. Process-name
 * semantics belong to the core, so the frontend never normalizes what it hands over or stores.
 */
function cacheKey(name: string): string {
  return name.toLowerCase();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * The current answer for one name.
 *
 * The three return values ARE `ProcessIcon`'s three rendered states, and keeping them distinguishable
 * is the whole point: `undefined` (not known yet) must never collapse into `null` (known to have no
 * icon), or a still-loading row would render the give-up glyph instead of a skeleton.
 */
export function readProcessIcon(name: string): string | null | undefined {
  const key = cacheKey(name);
  if (cache.has(key)) return cache.get(key);
  if (failed.has(key)) return null;
  return undefined;
}

/**
 * Declare that these names are wanted now. Idempotent and cheap: anything already answered or already
 * airborne is dropped here, so a consumer may call this on every render without thinking about it.
 */
export function requestProcessIcons(names: readonly string[]): void {
  let addedSomething = false;

  for (const name of names) {
    if (!name) continue;
    const key = cacheKey(name);
    // Rule 3: settled, airborne, or already waiting in this window — all three mean "do not ask".
    if (cache.has(key) || inFlight.has(key) || queued.has(key)) continue;
    // A fresh declaration retires a previous transient failure, so the retry is honest: the row goes
    // back to its pending skeleton rather than staying on the give-up glyph while we re-ask.
    failed.delete(key);
    queued.set(key, name);
    addedSomething = true;
  }

  if (!addedSomething) return;
  // One shared timer, not one per call — that shared timer IS the coalescing (rule 1). A caller
  // arriving mid-window joins the flush already scheduled instead of scheduling a second one.
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => void flush(), ICON_REQUEST_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  flushTimer = null;
  const pending = [...queued.entries()];
  queued.clear();
  if (pending.length === 0) return;

  // Claim the in-flight marker for the WHOLE flush before the first chunk goes out, not chunk by
  // chunk. Because the chunks are now awaited, a name in chunk 5 sits unclaimed for as long as
  // chunks 1-4 take; a row re-declaring it in that window would see it neither cached nor airborne
  // and enqueue a second command for a question already being asked. `sendBatch` re-adds its own
  // names (a Set makes that free) and its `finally` is what removes them again.
  for (const [key] of pending) inFlight.add(key);

  for (let i = 0; i < pending.length; i += ICON_BATCH_SIZE) {
    // Awaited on purpose — see scheduling rule 2. `sendBatch` never rejects.
    await sendBatch(pending.slice(i, i + ICON_BATCH_SIZE));
  }
}

async function sendBatch(batch: [string, string][]): Promise<void> {
  for (const [key] of batch) inFlight.add(key);
  // Send the names as the caller spelled them; only our own lookup table is lowercased.
  const names = batch.map(([, original]) => original);

  try {
    const rows = await invoke<ProcessIconRecord[]>("get_process_icons", { names });
    const answers = new Map<string, string | null>();
    if (Array.isArray(rows)) {
      for (const row of rows) answers.set(cacheKey(row.name), row.icon ?? null);
    }
    // Rule 4: every requested name is written, including the ones that came back null and the ones
    // the answer omitted entirely. An omission means the backend could not resolve it, which is the
    // same settled fact as an explicit null — and settling it here is what stops the re-request.
    // `failed` is cleared alongside: a name that once rejected and has now been answered has no
    // business staying in the retry set for the rest of the session. `readProcessIcon` checks the
    // cache first, so the stale entry was inert — but inert junk still accumulates.
    for (const [key] of batch) {
      cache.set(key, answers.get(key) ?? null);
      failed.delete(key);
    }
  } catch {
    // The COMMAND failed, which says nothing about whether these programs have icons. Marking them
    // as permanently iconless would turn one bad moment into a session-long blank column, so they
    // stay out of the cache and a later declaration will ask again. The rejection is swallowed on
    // purpose: an icon is decoration, and no row's decoration may crash the picker.
    for (const [key] of batch) failed.add(key);
  } finally {
    for (const [key] of batch) inFlight.delete(key);
    notify();
  }
}

/**
 * Resolve the icon of ONE file the user just chose in the OS file dialog, and cache it under that
 * file's base name.
 *
 * WHY THIS EXISTS BESIDE THE BATCH. Everything above resolves an icon by asking the backend to find
 * a RUNNING process of that name. A program the user picked off the disk is usually not running, so
 * that route can never answer for it and the row would sit on the neutral fallback glyph forever.
 * The path the dialog handed back is the only way to that file's real icon — and it is acceptable
 * to use precisely because the dialog is where the user consented to this one file. The backend
 * command refuses anything that is not an executable.
 *
 * WHY IT WRITES INTO THE SAME CACHE. The key is the file's base name, exactly the key every other
 * consumer uses, so a program added from disk and a later running instance of that same program
 * share one answer instead of being resolved twice.
 *
 * WHY IT CLAIMS THE IN-FLIGHT MARKER FIRST. That marker is what tells `requestProcessIcons` the
 * question is already being asked, so the row that is about to mount does not also enqueue a
 * name-based lookup that is guaranteed to fail. Claiming it synchronously, before the row renders,
 * is the whole trick.
 *
 * The absolute path is used here and then dropped. It is never stored in this cache and never
 * persisted: only the base name outlives this call.
 */
export async function resolveProcessIconForPath(path: string, name: string): Promise<void> {
  const key = cacheKey(name);
  // Settled or already airborne — rule 3 applies here exactly as it does to the batch.
  if (!key || cache.has(key) || inFlight.has(key)) return;
  inFlight.add(key);
  // …and drop any declaration already waiting in the debounce window. Claiming `inFlight` stops a
  // FUTURE declaration, but it says nothing about one that is already queued: the pending `flush()`
  // would still send this name, producing two commands for one question. Harmless (last write wins
  // and both answers are correct), but the doc above promises a guarantee, so give it.
  queued.delete(key);

  try {
    const icon = await invoke<string | null>("get_process_icon_for_path", { path });
    cache.set(key, icon ?? null);
    failed.delete(key);
  } catch {
    // The command rejected — the guard refused the path, or the extraction blew up. Either way an
    // icon is decoration: the row shows the neutral glyph and the user is told nothing, because
    // nothing they care about went wrong.
    failed.add(key);
  } finally {
    inFlight.delete(key);
    notify();
  }
}

/**
 * Drop every cached answer, pending request and in-flight marker.
 *
 * For tests only. A module-level cache is shared by every test in a file, so without this a name
 * resolved (or left hanging) by one test would silently answer — or silently suppress — the next
 * test's request. Production never calls this: the cache is meant to live as long as the app does.
 */
export function resetProcessIconCache(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  cache.clear();
  inFlight.clear();
  failed.clear();
  queued.clear();
}

/**
 * Declare a set of names as currently needed. Consumers that own a list (the saved list, the picker's
 * visible slice) call this so requests follow what the user is actually looking at.
 */
export function useProcessIcons(names: readonly string[]): void {
  // Join into one primitive so an inline array literal — which is a new object on every render —
  // does not re-trigger the effect. The separator is NUL: a Windows file name may contain a space
  // («My App.exe»), so a space separator would split one program into two bogus requests.
  const requestKey = names.join("\u0000");

  useEffect(() => {
    if (!requestKey) return;
    requestProcessIcons(requestKey.split("\u0000"));
  }, [requestKey]);
}

/**
 * Read one name's icon, declaring it as needed and re-rendering when its answer lands.
 *
 * `useSyncExternalStore` rather than a `useState` + effect pair: the store lives outside React, and
 * this is the supported way to read one. It also means a hundred mounted rows share ONE subscription
 * mechanism and each re-renders only when its own value actually changes.
 */
export function useProcessIcon(name: string): string | null | undefined {
  const requested = useMemo(() => [name], [name]);
  useProcessIcons(requested);
  return useSyncExternalStore(subscribe, () => readProcessIcon(name));
}
