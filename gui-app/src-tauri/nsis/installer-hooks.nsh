; TrustTunnel NSIS Installer Hooks
; Complete cleanup on uninstall — remove ALL traces of the application

!macro NSIS_HOOK_POSTINSTALL

  ; ── Force icon cache rebuild ─────────────────────────────────
  ; ie4uinit.exe -show мягко просит shell обновиться, но не всегда
  ; помогает на upgrade поверх существующей установки — Windows
  ; держит handle на старую иконку пока explorer.exe не перезапустится.
  ;
  ; Последовательность:
  ;   1. `ie4uinit.exe -ClearIconCache` + `-show` — штатные утилиты,
  ;      форсируют rebuild без killing explorer.
  ;   2. Удалить iconcache.db + thumbnail cache files вручную —
  ;      Windows создаст заново при next shell action.
  ;   3. НЕ убиваем explorer.exe — это закрывает все открытые папки
  ;      у пользователя, too intrusive для installer'а. Шаги 1-2
  ;      достаточны в 95% случаев; оставшимся 5% достаточно logout/login.
  DetailPrint "Forcing icon cache rebuild..."
  nsExec::ExecToLog 'ie4uinit.exe -ClearIconCache'
  nsExec::ExecToLog 'ie4uinit.exe -show'
  Delete "$LOCALAPPDATA\IconCache.db"
  Delete "$LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache_*.db"
  Delete "$LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db"

!macroend


!macro NSIS_HOOK_PREUNINSTALL

  ; ── 1. Kill only THIS edition's sidecar VPN process ────────────
  ;    Read PID from .sidecar.pid and kill only that process.
  ;    Do NOT use KillProcess — it kills ALL trusttunnel_client.exe,
  ;    including the other edition's (Pro/Light) active VPN connection.
  IfFileExists "$INSTDIR\.sidecar.pid" 0 +5
    FileOpen $R1 "$INSTDIR\.sidecar.pid" r
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

  ; ── 2. Delete runtime config files ────────────────────────────
  DetailPrint "Removing configuration files..."
  Delete "$INSTDIR\trusttunnel_client.toml"
  Delete "$INSTDIR\routing_rules.json"
  Delete "$INSTDIR\exclusions.json"
  Delete "$INSTDIR\active_groups.json"
  Delete "$INSTDIR\connection_history.json"
  Delete "$INSTDIR\ssh_credentials.json"
  Delete "$INSTDIR\known_hosts.json"
  Delete "$INSTDIR\.sidecar.pid"
  Delete "$INSTDIR\.start_minimized"
  Delete "$INSTDIR\.pending_deeplink"

  ; ── 3. Delete runtime directories ─────────────────────────────
  DetailPrint "Removing application data directories..."
  RMDir /r "$INSTDIR\webview_data"
  RMDir /r "$INSTDIR\geodata"
  RMDir /r "$INSTDIR\resolved"
  RMDir /r "$INSTDIR\group_cache"

  ; ── 4. Clean up registry ──────────────────────────────────────
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

  ; ── 5. Delete temp update files ───────────────────────────────
  DetailPrint "Removing temporary update files..."
  Delete "$TEMP\trusttunnel_setup.exe"
  ; Legacy cleanup (pre-2.1.0 ZIP-based updater)
  Delete "$TEMP\trusttunnel_update.zip"
  RMDir /r "$TEMP\trusttunnel_update"
  Delete "$TEMP\trusttunnel_updater.bat"
  Delete "$TEMP\trusttunnel_updater.vbs"

  ; ── 6. Remove empty install directory ─────────────────────────
  ;    Only remove if empty (safe for reinstall — Tauri handles its own files)
  RMDir "$INSTDIR"

!macroend
