; TrustTunnel NSIS Installer Hooks
; Complete cleanup on uninstall — remove ALL traces of the application

!macro NSIS_HOOK_PREUNINSTALL

  ; ── 1. Kill sidecar VPN process ────────────────────────────────
  ;    Main app is handled by Tauri's CheckIfAppIsRunning after this hook.
  ;    But we need to kill the sidecar (trusttunnel_client.exe) which Tauri doesn't know about.
  nsis_tauri_utils::KillProcess "trusttunnel_client.exe"
  Pop $R0
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

  ; ── 6. Force-remove entire install directory ──────────────────
  ;    Safety net: nuke everything that remains
  RMDir /r "$INSTDIR"

!macroend
