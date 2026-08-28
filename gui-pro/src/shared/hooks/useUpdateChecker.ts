import { useState, useCallback, useEffect, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { UpdateInfo, UpdateCheckFailure } from "../types";

// Background check interval — 24h per REQ-18-UPDATE-DETECTION-03 + D-2.4
// (was 6h до Phase 18). App startup check unchanged.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Backend reason code → `UpdateCheckFailure`, exhaustively and with NO passthrough.
 *
 * Same device as `vpnEventHelpers.REASON_CODE_I18N`: the backend mints stable ASCII
 * tokens, the presentation boundary is the single place that knows what they mean.
 * The keys mirror `updater.rs` `UPDATE_NO_INTERNET_REASON` /
 * `UPDATE_SERVER_UNREACHABLE_REASON`.
 *
 * A token that is not in this table resolves to `server-unreachable` rather than
 * being carried through as-is. That is deliberate: a passthrough would let a string
 * the front end has never heard of — a stack trace, a hostname, a status line —
 * become the value the card renders. There is no code path here that can put an
 * unknown string on screen.
 */
const FAILURE_BY_REASON_CODE: Record<string, UpdateCheckFailure> = {
  "no-internet": "no-internet",
  "server-unreachable": "server-unreachable",
};

function toCheckFailure(rejected: unknown): UpdateCheckFailure {
  return (
    (typeof rejected === "string" ? FAILURE_BY_REASON_CODE[rejected] : undefined) ??
    "server-unreachable"
  );
}

/**
 * Phase 30 backend contract — `check_app_update_info` wire shape.
 *
 * snake_case for the same reason `SidecarVersionInfo` below is: Tauri serializes
 * the Rust struct's own field names onto the wire.
 */
interface AppUpdateInfoWire {
  current_version: string;
  latest_version: string;
  latest_tag: string;
  available: boolean;
  download_url: string;
  release_notes: string;
  sha256: string;
}

// Plan 18-03 backend contract — match snake_case wire format from Tauri serde.
// Tauri авто-маппит camelCase JS keys → snake_case Rust fields на boundary,
// поэтому на проводе мы видим snake_case (как объявлено в Rust struct).
interface SidecarVersionInfo {
  current_version: string;
  latest_version: string;
  latest_tag: string;
  available: boolean;
  asset_download_url: string;
  asset_size_bytes: number;
}

// Indiv-fields SSH params shape — matches Phase 17.1 mtproto_install pattern
// (PLAN-REVIEW Blocker #1 fix) + Plan 18-03 check_sidecar_version signature.
export interface UpdateCheckerSshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  keyData?: string;
}

/**
 * Dual update detection hook (Phase 18 REQ-18-UPDATE-DETECTION-01..04).
 *
 * Возвращает независимые флаги для app + sidecar обновлений + helpers для
 * per-version dismissal и server-aware sidecar check'ов.
 *
 * Backwards-compat: `useUpdateChecker()` (no args) продолжает работать —
 * `sshParams` опционален с default `undefined`, App.tsx:81 не модифицирован.
 * Existing fields `updateInfo.available` / `latestVersion` / `downloadUrl`
 * остаются (alias `available = appAvailable` для AboutPanel consumer).
 *
 * Two-stage detection (OQ-5):
 * - Stage 1 (app startup, без SSH): GitHub API → `appAvailable`
 * - Stage 2 (user connects к server): `checkSidecarForServer(sshParams)` →
 *   `sidecarAvailable`
 *
 * ProtocolUpdateSection Badge показывается ТОЛЬКО когда `sidecarAvailable && !sidecarDismissed` (Phase 19).
 * Dot indicator показывается когда `appAvailable || sidecarAvailable` (D-2.5).
 *
 * Per-version dismissal (REQ-18-UPDATE-FLOW-02), per-launch scope (UAT-2 / owner 6.8):
 * - sessionStorage key `tt_dismissed_update_<version>` = `"true"`
 * - Флаг живёт ТОЛЬКО в пределах одного запуска приложения. Новый запуск =
 *   свежая сессия = флага нет → точка снова nudge'ит, пока обновление доступно
 *   (UAT-2 per-launch nudge). В пределах сессии visit-dismiss работает как раньше.
 * - Когда выходит более новая sidecar версия — `sidecarDismissed = false`
 *   автоматически (key для новой версии не существует)
 *
 * Silent fail (D-2.x) — STILL TRUE FOR THE SIDECAR TRACK ONLY. A failed sidecar
 * probe returns to a consistent state with nothing said. The APP track stopped
 * being silent in Phase 30 (ABOUT-01): a failed `check_app_update_info` sets
 * `updateInfo.checkError` so the card can name the cause instead of reporting the
 * installed version as current.
 *
 * D-29: hook НЕ logging versions / paths / secrets в activityLog. Только
 * console.warn для debug visibility (DevTools-only).
 */
export function useUpdateChecker(_sshParams?: UpdateCheckerSshParams | null) {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({
    // EXISTING (backwards-compat)
    available: false,
    latestVersion: "",
    currentVersion: "",
    downloadUrl: "",
    sha256: "",
    releaseNotes: "",
    checking: false,
    // NEW (Phase 18)
    appAvailable: false,
    sidecarAvailable: false,
    sidecarCurrentVersion: "",
    sidecarLatestVersion: "",
    sidecarLatestTag: "",
    sidecarDownloadUrl: "",
    sidecarDismissed: false,
    sidecarChecking: false,
    lastChecked: null,
    checkError: null,
  });

  /**
   * Жив ли ещё тот, кто просил проверку.
   *
   * Тот же приём, что у эффекта с `getVersion()` внизу файла: флажок, который снимает уборка
   * эффекта, и который перечитывается ПОСЛЕ ожидания. Разница только в носителе — там флажок
   * локальная переменная эффекта, потому что и запрос живёт внутри эффекта; здесь проверку
   * запускает кто угодно и когда угодно (кнопка на карточке, запуск приложения, суточный будильник),
   * поэтому флажок вынесен в ссылку уровня хука. Механизм новым не является.
   *
   * Зачем вообще. Проверка обновлений ходит в сеть и может идти секунды. Если за это время вкладка
   * «О программе» закрылась или закрылось окно, ответ приезжает НЕКОМУ: записывать его в состояние
   * уже некуда, а побочные записи (отметка времени последней проверки) относятся к сеансу, который
   * пользователь уже прервал. React 18 на такую запись не ругается — она просто теряется молча,
   * поэтому дефект был невидимым, а не безобидным.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    // Значение выставляется в теле эффекта, а не только начальным значением ссылки: в строгом
    // режиме разработки эффекты гасятся и запускаются повторно, и без этой строки второй запуск
    // застал бы флажок уже снятым.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const checkForUpdates = useCallback(async (_silent = false) => {
    setUpdateInfo(prev => ({ ...prev, checking: true }));
    try {
      // Phase 30: the probe runs in Rust (`check_app_update_info`), not as a
      // cross-origin fetch from the webview. Two reasons, both load-bearing:
      // (1) the app's own CSP names no GitHub origin in `connect-src`
      //     (tauri.conf.json: `connect-src 'self' ipc: http://ipc.localhost`), so a
      //     webview request to the GitHub releases API has no route the policy allows;
      // (2) reqwest can tell a DNS/no-route failure from a server that did not
      //     answer, which `fetch` collapses into one opaque TypeError — and that
      //     distinction is the whole point of the failure plates on the card.
      // Asset selection, the checksum lookup and the version comparison all moved
      // into the command with it; the hook now only maps the answer into state.
      const info = await invoke<AppUpdateInfoWire>("check_app_update_info");
      // Ответ приехал — но, возможно, уже некому. Ранний выход СРАЗУ после ожидания, до разбора
      // ответа и до любой записи: ни состояния, ни отметки времени в хранилище. Смотри пояснение
      // у `mountedRef`.
      if (!mountedRef.current) return;
      // A resolved-but-unusable payload is a FAILED check, not a crash. The command
      // is typed, but the IPC boundary is not: anything that reaches here without
      // the shape we asked for (null, a bare string, a truncated object) used to
      // dereference straight into a TypeError and take the whole About tree down.
      // Routing it into the normal failure path is both safer and more honest —
      // «сервер обновлений не ответил» is exactly what a nonsense answer means.
      if (!info || typeof info !== "object" || typeof info.available !== "boolean") {
        throw new Error("malformed_update_payload");
      }

      const nowIso = new Date().toISOString();
      setUpdateInfo(prev => ({
        ...prev,
        available: info.available,        // EXISTING — backwards-compat alias
        appAvailable: info.available,     // NEW (Phase 18)
        latestVersion: info.latest_version,
        currentVersion: info.current_version,
        downloadUrl: info.download_url,
        sha256: info.sha256,
        releaseNotes: info.release_notes,
        checking: false,
        lastChecked: nowIso,
        // A successful check retires whatever the last failure was. Without this
        // the card would keep naming a cause that is no longer true.
        checkError: null,
      }));
      // tt_last_update_check для 24h cadence rate-limit + debug visibility
      // (CLAUDE.md localStorage table). WR-05: guard the write so a
      // privacy-restricted/quota-exceeded WebView throwing here does not abort
      // the rest of the path — the cadence key is best-effort debug metadata.
      try { localStorage.setItem("tt_last_update_check", nowIso); } catch { /* privacy/quota */ }
    } catch (e) {
      // Phase 30 (ABOUT-01) — no longer a SILENT fail. The failure used to end
      // here in a console.warn, which left `available: false` and made the card
      // assert «У вас установлена актуальная версия» after a check that never
      // succeeded. Now the cause reaches the card as a discriminant.
      //
      // NOTE what is deliberately NOT touched: `lastChecked` and every version
      // field keep their previous values. What the app last actually knew is
      // still true, and the design says so explicitly — the card goes on naming
      // the older moment rather than blanking it.
      //
      // The VERDICT is a different matter and IS cleared. `available` answers
      // "is there an update right now", and a check that failed did not answer
      // it. Leaving it standing produced a state where `checkError` and
      // `available` were both truthy at rest — reachable by a background 24h
      // re-check failing after a successful one, and by two overlapping manual
      // checks settling out of order. That state makes `App.tsx` keep the
      // update dot lit off a check that never succeeded, and it is the same
      // class of lie as the up-to-date plate this phase removes. Only the
      // freshness of the claim is dropped; `latestVersion` survives, so the
      // moment a check succeeds again the dot returns without a refetch.
      console.warn("Update check failed:", e);
      // Отказ тоже адресован живому получателю. Запись в журнал разработчика выше оставлена
      // намеренно — она помогает при разборе и ни на что в приложении не влияет, а вот причина
      // отказа дальше не едет: карточки, которой её показывать, больше нет.
      if (!mountedRef.current) return;
      setUpdateInfo(prev => ({
        ...prev,
        checking: false,
        available: false,
        appAvailable: false,
        checkError: toCheckFailure(e),
      }));
    }
  }, []);

  /**
   * Sidecar version detection (REQ-18-UPDATE-DETECTION-02).
   *
   * Вызывается parent'ом когда user подключается к server (sshParams known).
   * Invokes `check_sidecar_version` Tauri command (Plan 18-03 contract —
   * individual fields signature, Phase 17.1 mtproto_install precedent).
   *
   * При detect новой версии (latest changes от 1.0.33 → 1.0.34) —
   * `sidecarDismissed` automatically `false` потому что
   * `tt_dismissed_update_1.0.34` key отсутствует (REQ-18-UPDATE-FLOW-02
   * per-version dismissal scope).
   *
   * Silent fail (D-2.x): любая ошибка backend → state.sidecarAvailable
   * остаётся false, exception не бросается.
   *
   * Phase 30 — THIS FUNCTION NEVER WRITES `checkError`, and that is a decision,
   * not an omission. `checkError` belongs to the APP update track: its two values
   * are localized by `UpdateCard` into copy about the application's own update
   * server. The sidecar cascade is the other update track, with its own
   * vocabulary, its own surfaces (ProtocolUpdateSection / the sidecar update
   * modal) and its own failure wording. Letting a failed SSH probe set
   * `checkError` would make the «О программе» card announce a cause that has
   * nothing to do with the application — the two vocabularies stay separate.
   */
  const checkSidecarForServer = useCallback(
    async (sshParams: UpdateCheckerSshParams) => {
      setUpdateInfo(prev => ({ ...prev, sidecarChecking: true }));
      try {
        // Tauri auto-maps camelCase JS keys → snake_case Rust fields на boundary.
        // Plan 18-03 frozen contract: individual fields signature
        // (host, port, user, password, key_path, key_data). См. SUMMARY Plan 18-03.
        const info = await invoke<SidecarVersionInfo>("check_sidecar_version", {
          host: sshParams.host,
          port: sshParams.port,
          user: sshParams.user,
          password: sshParams.password,
          keyPath: sshParams.keyPath ?? null,
          keyData: sshParams.keyData ?? null,
        });

        // Тот же ранний выход, что и у проверки приложения выше. Дорожка сайдкара идёт по SSH и
        // ждёт дольше всех, так что закрытое за это время окно здесь ВЕРОЯТНЕЕ, а не реже.
        // Чинится вместе, потому что это один и тот же дефект, а не два похожих.
        if (!mountedRef.current) return;

        // Per-version dismissal lookup (REQ-18-UPDATE-FLOW-02), per-launch
        // scope (UAT-2 / owner 6.8): read from sessionStorage so a fresh
        // launch re-nudges. A stale localStorage flag from the old permanent
        // scope is intentionally ignored.
        // WR-05: guard the read like useSidecarUpdateCascade does — on a
        // platform without sessionStorage this would otherwise throw inside the
        // try and silently lose the dismissal lookup. Treat absent storage as
        // "not dismissed".
        const dismissedKey = `tt_dismissed_update_${info.latest_version}`;
        const dismissed =
          typeof sessionStorage !== "undefined" &&
          sessionStorage.getItem(dismissedKey) === "true";

        const nowIso = new Date().toISOString();
        setUpdateInfo(prev => ({
          ...prev,
          sidecarAvailable: info.available,
          sidecarCurrentVersion: info.current_version,
          sidecarLatestVersion: info.latest_version,
          sidecarLatestTag: info.latest_tag,
          sidecarDownloadUrl: info.asset_download_url,
          sidecarDismissed: dismissed,
          sidecarChecking: false,
          lastChecked: nowIso,
        }));
        // WR-05: guard the cadence-key write. As the last statement in the try,
        // an unguarded throw here (privacy/quota WebView) was swallowed by the
        // catch and prematurely flipped sidecarChecking off mid-flight after the
        // state was already set. Best-effort write keeps the happy path intact.
        try { localStorage.setItem("tt_last_update_check", nowIso); } catch { /* privacy/quota */ }
      } catch (e) {
        // Silent fail per D-2.x — DevTools-only visibility
        console.warn("Sidecar update check failed:", e);
        if (!mountedRef.current) return;
        setUpdateInfo(prev => ({ ...prev, sidecarChecking: false }));
      }
    },
    [],
  );

  /**
   * Per-version dismissal (REQ-18-UPDATE-FLOW-02), per-launch scope
   * (UAT-2 / owner 6.8).
   *
   * Записывает `tt_dismissed_update_<version> = "true"` в sessionStorage и
   * flips state.sidecarDismissed = true. НЕ trigger refetch GitHub. Флаг живёт
   * только до перезапуска приложения (свежая сессия) — после рестарта точка
   * снова nudge'ит, пока обновление доступно (UAT-2 per-launch nudge). В пределах
   * сессии visit-dismiss работает как раньше.
   *
   * Caller — обычно ProtocolUpdateSection (Phase 19) через ServiceTabSection prop drilling.
   */
  const dismissSidecarUpdate = useCallback((version: string) => {
    const key = `tt_dismissed_update_${version}`;
    sessionStorage.setItem(key, "true");
    setUpdateInfo(prev => ({ ...prev, sidecarDismissed: true }));
  }, []);

  // Resolve current app version EARLY (Tauri-only, без сети) чтобы AboutPanel
  // / About tab никогда не падали на fallback при offline / GitHub timeout.
  // `getVersion()` читает Cargo.toml/package.json через Tauri runtime, no API.
  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (cancelled) return;
        setUpdateInfo((prev) => (prev.currentVersion ? prev : { ...prev, currentVersion: v }));
      })
      .catch((e) => console.warn("getVersion() failed:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Check on startup + periodic background check every 24 hours
  // (REQ-18-UPDATE-DETECTION-03). Sidecar check НЕ included здесь — он
  // server-aware и зависит от sshParams (Stage 2 detection, OQ-5).
  useEffect(() => {
    checkForUpdates(true);
    const interval = setInterval(() => checkForUpdates(true), CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkForUpdates]);

  return { updateInfo, checkForUpdates, checkSidecarForServer, dismissSidecarUpdate };
}
