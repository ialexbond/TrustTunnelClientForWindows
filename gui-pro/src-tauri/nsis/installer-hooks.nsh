; TrustTunnel NSIS Installer Hooks
; Complete cleanup on uninstall — remove ALL traces of the application

!macro NSIS_HOOK_POSTINSTALL

  ; ── Soft icon cache refresh ──────────────────────────────────
  ; Не убиваем explorer — это мигало бы taskbar у пользователя при
  ; каждой установке (intrusive UX).
  ;
  ; Вместо этого:
  ;   1. ie4uinit.exe -ClearIconCache + -show — штатные shell утилиты,
  ;      форсируют rebuild без killing процессов.
  ;   2. Удалить iconcache.db (если explorer его не держит — удалится,
  ;      если держит — Delete тихо проваливается, невыполненное
  ;      cleanup доделает Windows в фоне за несколько часов).
  ;
  ; Если после установки иконка всё ещё старая в taskbar: это связано
  ; с pinned shortcut. Открепить → прикрепить снова, либо перезагрузка.
  DetailPrint "Refreshing icon cache..."
  nsExec::ExecToLog 'ie4uinit.exe -ClearIconCache'
  nsExec::ExecToLog 'ie4uinit.exe -show'
  Delete "$LOCALAPPDATA\IconCache.db"
  Delete "$LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache_*.db"
  Delete "$LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db"

!macroend


; ── The application's DATA ROOT. Must stay in lockstep with Rust. ─────────────
;
;    The app keeps its data in its own install directory: Rust's
;    `ssh::user_data_dir()` (see `src/ssh/mod.rs`) resolves to the executable's
;    own folder, which for this installer is $INSTDIR. The PID basename comes
;    from `lifecycle::SIDECAR_PID_BASENAME`.
;
;    (Phase 30.1 plan 08 briefly moved the root to a separate
;    $LOCALAPPDATA folder and was reverted; the move returns in phases 31/32
;    together with the install relocation it exists to serve. Do not repoint this
;    define on its own — it must change in the same commit as the Rust helper.)
;
;    THE TWO ENDS CANNOT BE ALLOWED TO DRIFT. If Rust writes the pid file
;    somewhere this hook does not read, uninstalling and updating silently stop
;    killing the running VPN core and the tunnel outlives the app — no error, no
;    dialog, on a security product. That is not hypothetical: this hook read
;    `.sidecar.pid` while Rust had moved to the per-edition `.sidecar-pro.pid`
;    (D-07), so the kill had been a no-op for some time and nothing was watching.
;    That fix is INDEPENDENT of where the root points and it stays.
;
;    The agreement is MACHINE-CHECKED from both sides: a Rust test
;    (`lifecycle.rs::the_uninstall_hook_reads_the_pid_file_the_app_writes`)
;    `include_str!`s THIS FILE and asserts the composed path appears verbatim, and
;    the phase hygiene gate carries the same rule. Change one end and both go red.
!define TT_DATA_ROOT "$INSTDIR"
!define TT_SIDECAR_PID_FILE "${TT_DATA_ROOT}\.sidecar-pro.pid"

!macro NSIS_HOOK_PREUNINSTALL

  ; ── 1. Kill only THIS edition's sidecar VPN process ────────────
  ;    Read the PID from this edition's own pid file and kill only that process.
  ;    Do NOT use KillProcess — it kills ALL trusttunnel_client.exe,
  ;    including the other edition's (Pro/Light) active VPN connection.
  ;
  ;    $INSTDIR is elevation-proof in a way a $LOCALAPPDATA path is not: the
  ;    uninstaller sits IN the install directory, so it resolves the right folder
  ;    whichever account UAC elevated it to. A profile-relative root would resolve
  ;    to the ELEVATING account's profile and find nothing.
  ;
  ;    Backstop either way: the Windows Job Object (`job_object.rs`,
  ;    KILL_ON_JOB_CLOSE) terminates the sidecar when the app process ends, so no
  ;    orphan survives the app itself.
  IfFileExists "${TT_SIDECAR_PID_FILE}" 0 +5
    FileOpen $R1 "${TT_SIDECAR_PID_FILE}" r
    FileRead $R1 $R0
    FileClose $R1
    nsExec::ExecToLog 'taskkill /F /PID $R0'
  Sleep 500

!macroend


!macro NSIS_HOOK_POSTUNINSTALL

  ; ── At this point Tauri has already: ───────────────────────────
  ;    - Asked user to close the app (or killed it)
  ;    - Deleted its own installed files
  ;    - Removed uninstall registry keys
  ;    So we clean up everything that Tauri doesn't know about.

  ; ── 2. The user's data is KEPT. This is a decision, not an omission. ──────
  ;
  ;    NOTHING BELOW MAY DELETE USER DATA, AND NOTHING ABOVE DOES. An UPDATE runs
  ;    this uninstaller. Deleting the user's servers, saved passwords, known hosts
  ;    and routing rules as an invisible side effect of "update" is not a cleanup,
  ;    it is data loss with a progress bar.
  ;
  ;    THIS WAS A REAL BUG, FOR YEARS. Until phase 30.1 this macro deleted
  ;    ssh_credentials.json, known_hosts.json, routing_rules.json,
  ;    exclusions.json, active_groups.json, connection_history.json,
  ;    trusttunnel_client.toml and the webview_data / geodata / resolved /
  ;    group_cache folders UNCONDITIONALLY, on every uninstall — so every routine
  ;    update silently wiped the user's stored SSH passwords and routing rules.
  ;    The server list survived only by accident: configs.json and the per-server
  ;    .toml files were never in that list. The whole list is gone.
  ;
  ;    A user who reinstalls or updates expects their servers to still be there;
  ;    a user who wants a clean slate can delete the folder. Full removal
  ;    including data, if it is ever wanted, belongs behind an explicit opt-in on
  ;    the uninstaller's own UI — never as a default.
  ;
  ;    Only genuinely install-scoped leftovers are removed below: registry keys
  ;    the app wrote at runtime, temp files from the updater, and the pid file
  ;    (a process id from a boot that is over). Note there is no separate
  ;    "delete the OLD data root" step either: phase 30.1 plan 08's per-user root
  ;    and its adoption marker are reverted, and a hook that deleted the folder
  ;    the app is currently using is precisely the failure this section exists to
  ;    refuse — ${TT_DATA_ROOT} IS $INSTDIR.
  DetailPrint "Keeping user data in ${TT_DATA_ROOT}"
  Delete "${TT_SIDECAR_PID_FILE}"

  ; ── 3. Clean up registry ──────────────────────────────────────
  DetailPrint "Cleaning registry entries..."

  ; URL protocol handlers (created at runtime by protocol.rs)
  DeleteRegKey HKCU "Software\Classes\trusttunnel"
  DeleteRegKey HKCU "Software\Classes\tt"

  ; Autostart entries (all possible name variants)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TrustTunnel"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TrustTunnel Client Pro"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TrustTunnel Client Light"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "trusttunnel"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "trusttunnel-light"

  ; ── 4. Delete temp update files ───────────────────────────────
  DetailPrint "Removing temporary update files..."
  Delete "$TEMP\trusttunnel_setup.exe"
  ; Legacy cleanup (pre-2.1.0 ZIP-based updater)
  Delete "$TEMP\trusttunnel_update.zip"
  RMDir /r "$TEMP\trusttunnel_update"
  Delete "$TEMP\trusttunnel_updater.bat"
  Delete "$TEMP\trusttunnel_updater.vbs"

  ; ── 5. Remove empty install directory ─────────────────────────
  ;    Only remove if empty (safe for reinstall — Tauri handles its own files)
  RMDir "$INSTDIR"

!macroend
