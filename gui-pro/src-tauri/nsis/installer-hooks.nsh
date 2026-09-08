; TrustTunnel NSIS Installer Hooks
; Complete cleanup on uninstall — remove ALL traces of the application
;
; Macro order in this file follows EXECUTION order, not the order they were
; written: PREINSTALL (before the template touches anything), POSTINSTALL,
; then the two uninstall hooks.


; ── The UNINSTALLER'S FACE. File scope, and it has to be. ─────────────────────
;
;    WHAT THE TEMPLATE DOES NOT DO. The generated script sets the INSTALLER's icon
;    and bitmaps from the three configuration keys (`MUI_ICON` at :122,
;    `MUI_WELCOMEFINISHPAGE_BITMAP` at :127, `MUI_HEADERIMAGE_BITMAP` at :133) and
;    sets NOTHING for the uninstaller. Unset, the user-interface library falls back
;    to its own stock artwork — so the screen a person sees while REMOVING our
;    program carries the toolkit's icon and the toolkit's blue picture. That is a
;    different product's face on the one screen that matters most for trust.
;
;    WHY THIS NEEDS NO FORK OF THE SCRIPT. The phase brief assumed only a forked
;    template could set these. It is wrong, in the project's favour: the generated
;    script `!include`s THIS FILE at line 28 — before the first user-interface
;    define (:122) and long before the first page macro (:144) — so a define made
;    here at file scope is already in place when the library expands its pages.
;    Verified against the regenerated script, not remembered.
;
;    WHY FILE SCOPE AND NOT INSIDE A HOOK MACRO. The hook macros expand inside a
;    Section body at run time. These are compile-time top-level directives; there
;    is no run time at which they could take effect.
;
;    WHY `MUI_ICON` IS NOT SET HERE, though its uninstaller twin is. The template's
;    own `!define MUI_ICON` is guarded by `!if "${INSTALLERICON}" != ""` — which is
;    now TRUE, because `tauri.conf.json` names the icon. Defining it here as well
;    would make that line a redefinition and abort the compile. The installer icon
;    belongs to the configuration; only what the configuration cannot reach belongs
;    in this block.
;
;    THE PATHS ARE ANCHORED TO THIS FILE, deliberately. `${__FILEDIR__}` is the
;    directory of the file being compiled — this one — so the assets are found
;    whatever working directory the bundler happens to invoke the compiler from. A
;    path relative to the current directory would resolve differently between a
;    local build and CI, and the failure mode of a bitmap that does not resolve is
;    silence: the library falls back to its stock artwork, exit code 0, no warning.
;
;    WHY THE UNINSTALLER REUSES THE SAME THREE FILES. That is the design contract's
;    own default — «деинсталлятор берёт те же две картинки и тот же значок»: one
;    graphic fewer to keep in step, and it is the same product either way.
!define MUI_UNICON "${__FILEDIR__}\..\assets\installer\installer.ico"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${__FILEDIR__}\..\assets\installer\sidebar-164x314.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "${__FILEDIR__}\..\assets\installer\header-150x57.bmp"

; ── WHICH SIDE THE HEADER BITMAP SITS ON. ────────────────────────────────────
;
;    The library's default is the LEFT edge; the design contract draws for the
;    RIGHT one. `memory/v3/screens/app-installer.md` § «Картинка в шапке»: the
;    gradient runs «`accent-200` к середине и `accent-400` у правого края», and
;    the seam rule reads «часть её СЛЕВА от картинки закрашивает сам установщик
;    нашим цветом фона». Both sentences only hold with the bitmap at the right:
;    its light left edge is what meets the painted ground, and its dark accent
;    edge is what meets the window frame.
;
;    Shipped left, the composition is mirrored against its own artwork — the
;    ACCENT edge lands mid-window against the painted strip, which is exactly
;    the vertical seam the contract warns about, on every mid-flow page and on
;    the uninstall screen. The owner reported it on sight from build k4wq82.
;
;    This was item 1 on that document's own «что проверяется глазами» list —
;    «с какой стороны шаблон ставит картинку … композиция рассчитана на правый
;    край — ПОДТВЕРДИТЬ». It was never confirmed against a real window, and the
;    `MUI_BGCOLOR` seam fix below was therefore written for the wrong geometry:
;    it is still correct and still needed, but it was matching the ground to the
;    wrong edge of the bitmap.
!define MUI_HEADERIMAGE_RIGHT

; ── THE UNINSTALLER'S HEADER, WHICH THE DEFINE ABOVE CANNOT REACH. ───────────
;
;    `MUI_HEADERIMAGE_RIGHT` moves the picture with ONE statement — `ChangeUI
;    IDD_INST` (Modern UI 2/Interface.nsh:111-113) — and IDD_INST is the
;    INSTALLER's dialog. There is no `ChangeUI IDD_UNINST` anywhere in the
;    library, and there is nothing to point one at: of the three shipped UI
;    resources, `modern.exe` carries nine dialogs (102-109, 111) while
;    `modern_headerbmp.exe` and `modern_headerbmpr.exe` carry exactly ONE each,
;    dialog 105. Measured by reading their resource directories, not assumed.
;    So overriding `MUI_UI` with the right-hand file cannot work either:
;    `ChangeUI all` would then be asked for eight dialogs it does not contain.
;
;    Left as-is, the uninstall window mirrors the installer — and worse, the
;    bitmap's accent edge lands mid-window against the strip the library paints
;    with `MUI_BGCOLOR`, which is the vertical seam the design contract warns
;    about. The owner hit both, twice.
;
;    So we move the controls ourselves. `MUI_CUSTOMFUNCTION_UNGUIINIT` is called
;    at Interface.nsh:317 — AFTER `MUI_GUIINIT_OUTERDIALOG` at :311 has built the
;    header and loaded the bitmap into it — so by the time this runs the controls
;    exist, are populated, and are ours to lay out. Their ids are the library's
;    own constants: 1034 background, 1037 title, 1038 subtitle, 1046 picture
;    (Interface.nsh:240/244/255/258).
;
;    EVERY NUMBER IS READ FROM THE LIVE CONTROLS, none is hard-coded. A dialog
;    the toolkit redraws in some future version therefore moves this layout
;    VISIBLY — the picture lands somewhere wrong and is seen — rather than
;    drifting silently, which is the failure mode a forked binary resource would
;    have had. That is the whole reason this is a script and not a copied .exe.
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.TtHeaderImageToTheRight

!macro TT_MOVE_HEADER_LABEL ID
  ; Shift one header label left by the picture's width and stop it short of the
  ; picture's new left edge, so text can never run underneath the bitmap.
  GetDlgItem $7 $HWNDPARENT ${ID}
  StrCmp $7 0 +9
  System::Call 'user32::GetWindowRect(p r7, p r1)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r1, i 2)'
  System::Call '*$1(i .r8, i .r9, i, i .r6)'
  IntOp $8 $8 - $3           ; new left  = old left - picture width
  IntOp $6 $6 - $9           ; height
  IntOp $5 $2 - $8           ; width up to the picture's new left edge...
  IntOp $5 $5 - 8            ; ...less an 8 px gap
  IntCmp $5 16 +2 +2 0
  System::Call 'user32::MoveWindow(p r7, i r8, i r9, i r5, i r6, i 1)'
!macroend

Function un.TtHeaderImageToTheRight
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9

  System::Call '*(i,i,i,i)p .r1'
  StrCmp $1 0 tt_done

  ; The outer dialog's client width is the only anchor the right edge needs.
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r1)'
  System::Call '*$1(i, i, i .r2, i)'
  IntCmp $2 0 tt_free tt_free 0

  GetDlgItem $0 $HWNDPARENT 1046
  StrCmp $0 0 tt_free
  System::Call 'user32::GetWindowRect(p r0, p r1)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r1, i 2)'
  System::Call '*$1(i .r3, i .r4, i .r5, i .r6)'

  IntOp $9 $2 - $5           ; gap between the picture's right edge and the frame
  IntCmp $9 4 tt_free tt_free 0   ; already flush right - nothing to do, and say so by doing nothing

  IntOp $3 $5 - $3           ; picture width
  IntOp $6 $6 - $4           ; picture height
  IntOp $5 $2 - $3           ; new left = client width - picture width
  System::Call 'user32::MoveWindow(p r0, i r5, i r4, i r3, i r6, i 1)'
  StrCpy $2 $5               ; from here on $2 is the picture's NEW left edge

  !insertmacro TT_MOVE_HEADER_LABEL 1037
  !insertmacro TT_MOVE_HEADER_LABEL 1038

  ; One repaint of the strip, so the vacated area is not left holding the old
  ; picture's pixels on a slow desktop.
  GetDlgItem $7 $HWNDPARENT 1034
  StrCmp $7 0 tt_free
  System::Call 'user32::InvalidateRect(p r7, p 0, i 1)'

  tt_free:
  System::Free $1

  tt_done:
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ── THE PAGE GROUND. This define is the other half of the seam rule. ──────────
;
;    The header strip runs the full width of the window; our bitmap occupies 150
;    points of it and the library paints the REST of that strip itself, with
;    `MUI_BGCOLOR` (`Interface.nsh:259`, `SetCtlColors $mui.Header.Background`).
;    Its stock value is FFFFFF — measured, not assumed. Our bitmaps' ground is
;    F9F9F7, the product's own light-theme paper. Two colours four units apart,
;    meeting along a vertical line 150 points in: that IS the seam the design
;    contract warns about, and it would appear on every mid-flow page.
;
;    So the page background and the bitmaps' edge colour are ONE constant with two
;    spellings of the same six digits, not two values chosen to look alike. If this
;    number is ever retuned, `scripts/installer-assets.cjs` must be re-run in the
;    same commit — the bitmaps carry it baked in, because their format has no
;    transparency to defer the decision to.
;
;    Nothing in the generated script defines this symbol (checked), so there is no
;    redefinition hazard, and the library's own `MUI_DEFAULT` leaves an existing
;    definition alone.
!define MUI_BGCOLOR "F9F9F7"

; ── THE DETAILS PANE OPENS ITSELF. File scope, and it has to be. ──────────────
;
;    WHAT THIS BUYS, IN ONE SENTENCE. The removal report below already exists and
;    already works — announce, remove, look again, print a distinct failure line —
;    and on a real machine it printed three «Не удалось удалить» lines
;    that nobody saw, because the pane carrying them is COLLAPSED BY DEFAULT. He
;    read a green install over three surviving binaries. A report on a surface
;    nobody opens is the same as no report; this directive is what puts it on
;    screen while it happens.
;
;    WHY FILE SCOPE AND NOT INSIDE A HOOK MACRO. `ShowInstDetails` is a COMPILE-TIME
;    attribute of the installer, like `Name` or `OutFile`. The hook macros expand
;    inside a `Section` body at RUN time; there is no run time at which an attribute
;    could take effect, so a copy of this line inside `NSIS_HOOK_PREINSTALL` would
;    be a compile error rather than a quiet no-op. Same reasoning as the three
;    `MUI_*` defines above, and the same reason this file is `!include`d at
;    `installer.nsi:28` — before the first user-interface define — is what lets a
;    directive here reach the pages at all.
;
;    WHY HERE AND NOT IN CONFIGURATION. There is no `tauri.conf.json` key that
;    reaches this attribute, and the generated script sets it NOWHERE: zero
;    occurrences repository-wide, the emitted `installer.nsi` included. So there is
;    no redefinition hazard and nothing upstream to keep in step — unlike
;    `MUI_ICON`, whose template line is guarded by a config-driven `!if` and would
;    abort the compile if this file defined it too.
ShowInstDetails show

; ── THE SURVIVOR MARKER'S ONE WRITE, WRITTEN ONCE ─────────────────────────────
;
;    WHAT THIS IS FOR. The removal report below is honest and, since 32-FIX-07, on
;    screen — and it is still ephemeral. It lives in a window that closes, it reaches
;    no log, and it triggers no retry. That is exactly how three surviving binaries
;    reached the owner as a green install (UAT gaps G-32-2 / G-32-2b). This macro is
;    what makes a failed removal outlive the installer: when, and only when, an
;    artifact survived, the surviving path is written into a plain-text file beside
;    the NEWLY installed binaries, where the application can find it at first launch.
;    The path itself is composed in the define block at the foot of this file, beside
;    the sidecar pid file and for the same recorded reason.
;
;    WHY A MACRO AND NOT EIGHT COPIES OF FOUR STATEMENTS. The mechanics are identical
;    every time and the only thing that differs is the path — which is precisely what a
;    reviewer of the enumeration needs to see. So the path stays at the CALL SITE, one
;    reviewable line per failure branch naming exactly the artifact that branch is
;    about, and the file handling lives here, once. Nothing is hidden from a rule by
;    this: no existing contract measures file writes, and the new contract
;    (`lifecycle.rs::the_survivor_marker_is_written_only_when_something_survived`)
;    together with the user-data guard both read the call-site lines, which are the
;    lines that carry a filename.
;
;    THE FIRST SURVIVOR OF A RUN TRUNCATES; THE REST APPEND. `$TT_LEGACY_SURVIVOR_SEEN`
;    is what tells them apart. Without the truncate a second install would append to
;    the first one's list and the file would describe two runs at once — and the
;    application reading it would report artifacts that went long ago. The same flag is
;    what `NSIS_HOOK_POSTINSTALL` keys its stale-marker removal on.
;
;    THE JUMPS ARE RELATIVE, NOT LABELLED, AND THAT IS DELIBERATE. This macro is
;    inserted eight times into one section; a named label would be defined eight times
;    and the compile would abort. The offsets count instructions from the jump itself
;    and the targets are written out beside them so they can be checked by reading.
;
;    A FAILED OPEN IS SILENT ON PURPOSE. If the marker cannot be opened, the report in
;    the details pane is still correct and the deferred delete is still scheduled;
;    losing the durable copy is strictly less bad than aborting an install over a
;    diagnostic file. Nothing here reads or branches on the outcome.
Var TT_LEGACY_SURVIVOR_SEEN

!macro TT_MARK_SURVIVOR ArtifactPath
  Push $0                                             ; (1)
  StrCmp $TT_LEGACY_SURVIVOR_SEEN "1" +4              ; (2) already written this run -> (6)
    StrCpy $TT_LEGACY_SURVIVOR_SEEN "1"               ; (3)
    FileOpen $0 "${TT_LEGACY_SURVIVOR_MARKER}" w      ; (4) first survivor: truncate any stale file
    Goto +3                                           ; (5) -> (8)
  FileOpen $0 "${TT_LEGACY_SURVIVOR_MARKER}" a        ; (6)
  FileSeek $0 0 END                                   ; (7)
  StrCmp $0 "" +3                                     ; (8) could not open -> (11)
    FileWrite $0 "${ArtifactPath}$\r$\n"              ; (9)
    FileClose $0                                      ; (10)
  Pop $0                                              ; (11)
!macroend


!macro NSIS_HOOK_PREINSTALL

  ; ── 0. CLOSE THE RUNNING PROGRAM FIRST, AND WAIT FOR IT TO ACTUALLY GO ───────
  ;
  ;    THIS BLOCK IS FIRST BECAUSE THE TEMPLATE PUTS US IN THE WRONG PLACE. The
  ;    generated script expands this hook at `installer.nsi:613-615` — THREE LINES
  ;    BEFORE its own `!insertmacro CheckIfAppIsRunning` at `:617`. So every
  ;    `Delete` below used to run while the application still had its own image
  ;    mapped, and NSIS `Delete` on a mapped file FAILS SILENTLY: no error flag the
  ;    surrounding code reads, no warning, the install walks on. Measured on the
  ;    a real install (UAT gap G-32-2): `trusttunnel.exe`, `trusttunnel_client.exe`
  ;    and `wintun.dll` survived — exactly the three files a live process had
  ;    mapped — while everything unmapped was removed. The hook's position is the
  ;    template's to choose and not ours, so the ONLY place this can be fixed is
  ;    from inside the macro: terminate first, remove second.
  ;
  ;    WHY THE MACRO AND NOT A BARE PLUGIN CALL. `CheckIfAppIsRunning` keeps the
  ;    OK/Cancel prompt the owner confirmed working in UAT test 1: the person is
  ;    still ASKED before their VPN client is closed, and Cancel still aborts the
  ;    install. A bare `KillProcess` would take that consent away. `utils.nsh` is
  ;    included at `installer.nsi:20`, before this file at `:28`, so the macro is
  ;    defined by the time this expands.
  ;
  ;    THIS RUNS UNCONDITIONALLY, BEFORE THE REGISTRY PROBE — and that is not an
  ;    oversight. The template terminates the same image three lines later anyway,
  ;    so nothing is closed here that would have stayed open; the only change is
  ;    WHEN. Making it conditional on a legacy install having been found would
  ;    re-create the defect for the one case that matters most (the legacy folder
  ;    and the install target being the same place), because there the files being
  ;    overwritten are the mapped ones.
  ;
  ;    WHY A POLL AND NOT A SLEEP. `CheckIfAppIsRunning` kills and then sleeps a
  ;    FIXED 500 ms (`utils.nsh:49`); it never waits on the process. It cannot: the
  ;    plugin binary that performs the kill exports no wait primitive at all — its
  ;    import table carries no wait-on-object call, verified by parsing the PE
  ;    rather than assumed. So the wait has to be built here, out of the one thing
  ;    the plugin does offer: asking whether the process is still there.
  ;
  ;    WHY IT CONTINUES INSTEAD OF ABORTING AT THE CEILING. Aborting would leave the
  ;    user with no installation at all, which is strictly worse than a reported
  ;    partial removal — and the enumeration below already reports each artifact's
  ;    real outcome, line by line, in a pane that is now open. So the ceiling prints
  ;    a warning and walks on. ~10 s, expressed as a counted loop rather than an
  ;    open wait, so it always terminates.
  ;
  ;    THE LABELS ARE PREFIXED `tt_preinstall_` deliberately. `CheckIfAppIsRunning`
  ;    generates `kill_<n>` / `cancel_<n>` / `app_check_done_<n>` from `${__LINE__}`,
  ;    and this macro is inserted into the same section as the template's own
  ;    insertion at `:617`. A collision there is a COMPILE error, never a silent
  ;    failure — but a distinct prefix means it cannot arise in the first place.
  ;
  ;    NOTHING HERE EXECUTES ANOTHER PROGRAM. Every statement is a macro insertion
  ;    or a plugin call, so D-06 — compiled as
  ;    `lifecycle.rs::the_pre_install_hook_never_executes_another_program` — stays
  ;    green without being re-aimed. Killing the SIDECAR BY NAME is refused here
  ;    and everywhere else in this file: the co-installed Light edition ships a
  ;    process of the same name, and so does another user's session. Block 0b
  ;    below stops OUR core, by the process id this edition wrote down.
  DetailPrint "$(legacyStoppingApp)"
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  Push $R0
  Push $R1
  StrCpy $R1 0
  tt_preinstall_wait_loop:
    nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
    Pop $R0
    ; The plugin answers 0 when the image WAS found (see utils.nsh:39), so a
    ; non-zero answer is the exit we are waiting for.
    ${If} $R0 <> 0
      Goto tt_preinstall_wait_done
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 40
      DetailPrint "$(legacyStillRunning)"
      Goto tt_preinstall_wait_done
    ${EndIf}
    Sleep 250
    Goto tt_preinstall_wait_loop
  tt_preinstall_wait_done:
  Pop $R1
  Pop $R0

  ; --- 0a. AND WAIT UNTIL THE FILE ITSELF CAN BE OPENED FOR WRITING -----------
  ;
  ;    WHY A SECOND WAIT WHEN THE ONE ABOVE ALREADY WAITS. The poll above asks the
  ;    plugin whether the IMAGE NAME is still in the process list. That is a PROXY
  ;    for the question the installer actually has, and the two answers are allowed
  ;    to differ: what the script does a few statements later is open each file for
  ;    WRITING, and that call fails while any holder still denies write sharing --
  ;    a scanner reading the freshly closed binary, a handle that outlives the
  ;    process that opened it. NSIS answers that with the file-in-use retry dialog,
  ;    which is what the owner got on build h2vn6t (UAT gap G-32-11): his install
  ;    log closes the program, then stops dead at `Extract: trusttunnel.exe`.
  ;
  ;    SO THIS ASKS THE REAL QUESTION, WITH THE CALL THE EXTRACTION WILL MAKE: open
  ;    the binary for writing and close it again at once. Nothing is written and
  ;    nothing is truncated. Mode `a` is OPEN_ALWAYS with read/write access, so an
  ;    existing file is left byte for byte as it was -- and the existence check in
  ;    front of it is what keeps that same mode from CREATING the file on a clean
  ;    machine, where there is nothing to wait for in the first place. Mode `w`
  ;    would be CREATE_ALWAYS and would truncate the binary it is asking about;
  ;    `lifecycle.rs::the_pre_install_hook_waits_for_the_main_binary_file_to_be_writable`
  ;    pins the mode for that reason.
  ;
  ;    SAME CEILING AS THE POLL ABOVE, and for the same reasons: ~10 s expressed as
  ;    a counted loop so it always terminates, and a warning rather than an abort
  ;    when the ceiling is reached, because an aborted install is strictly worse
  ;    than one that says out loud that a file was still busy when it started.
  ;
  ;    BOTH OUTCOMES PRINT. A step that speaks only when it fails cannot be told
  ;    apart from a step that never ran, and telling those two apart is the whole
  ;    of G-32-11: the log the owner sent has no line for this at all.
  Push $R0
  Push $R1
  StrCpy $R1 0
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 tt_preinstall_lock_done
  tt_preinstall_lock_loop:
    ClearErrors
    FileOpen $R0 "$INSTDIR\${MAINBINARYNAME}.exe" a
    IfErrors tt_preinstall_lock_busy
      FileClose $R0
      DetailPrint "$(legacyAppReleased)"
      Goto tt_preinstall_lock_done
    tt_preinstall_lock_busy:
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 40
      DetailPrint "$(legacyAppStillLocked)"
      Goto tt_preinstall_lock_done
    ${EndIf}
    Sleep 250
    Goto tt_preinstall_lock_loop
  tt_preinstall_lock_done:
  Pop $R1
  Pop $R0

  ; --- 0b. STOP THIS EDITION'S VPN CORE IN THE FOLDER BEING INSTALLED INTO ----
  ;
  ;    WHY THIS EXISTS BESIDE BLOCK 3a, WHICH ALREADY STOPS THE CORE. Block 3a is
  ;    inside `${If} $R9 != ""` -- it runs only when the HKCU probe below FOUND a
  ;    legacy install. That probe is deliberately blind to HKLM, because it exists
  ;    to catch the pre-32 currentUser installs the template cannot see. The
  ;    consequence nobody had written down: on a machine whose previous install was
  ;    ALREADY the perMachine build there is no HKCU record, $R9 stays empty, and
  ;    the core-stop step never runs -- not even to say so, because its
  ;    announcement is inside the same branch. That is a real Windows install on build
  ;    h2vn6t (G-32-11): no core line of any kind in his install log, and the app's
  ;    own log next launch showing that the pid file had held a DEAD process id.
  ;
  ;    THE FOLDER IS THE INSTALL TARGET, AND THAT IS THE POINT. Block 3a reads the
  ;    pid file of the DISCOVERED legacy folder, which may be somewhere else
  ;    entirely; this reads the pid file of the folder being installed INTO, which
  ;    on every in-place upgrade is where the running core's binaries are. The path
  ;    is spelled `${TT_SIDECAR_PID_FILE}` -- the one composition rooted at
  ;    ${TT_INSTALL_DIR}, pinned to the Rust constant by
  ;    `lifecycle.rs::the_uninstall_hook_reads_the_pid_file_the_app_writes` and by
  ;    rule 13 of remediation-hygiene.sh, so the basename cannot drift here either.
  ;
  ;    BY PROCESS ID, NEVER BY IMAGE NAME -- the same owner decision (`route-b`,
  ;    2026-09-06) that block 3a and PREUNINSTALL are built on. Both editions ship
  ;    a binary called trusttunnel_client.exe, so an image-name kill would end the
  ;    co-installed Light edition's live tunnel, or another user's session. That is
  ;    why the fallback below LOOKS with FindProcess and never kills with it: a
  ;    core we cannot prove is ours is reported and left alone. Reporting a core we
  ;    may not touch is worth more than a silence that reads like an absence -- and
  ;    is the only thing this step CAN honestly do about that case.
  ;
  ;    THE PID IS UNTRUSTED INPUT and is trimmed and whitelisted as decimal digits
  ;    before it reaches a command line, in the same shape and for the same reasons
  ;    as block 3a. A file that is absent, empty or malformed yields no candidate;
  ;    unlike 3a, each of those outcomes now says which one it was. The residual
  ;    risk that a well-formed number names SOMEBODY ELSE'S process through pid
  ;    reuse is the one already accepted for 3a as T-32-09-02, and it is inherited
  ;    here unchanged: whoever can write that file can already replace the binaries
  ;    in that folder outright, which is a strictly stronger position.
  ;
  ;    EVERY OUTCOME PRINTS A LINE, AND THAT IS THE OTHER HALF OF THE FIX. Block 3a
  ;    announces itself only when a candidate survives validation, on the correct
  ;    principle that a hook must not claim to be stopping the core while doing
  ;    nothing. The INVERSE hole is what made G-32-11 undiagnosable: a step that
  ;    says nothing reads exactly like a step that never ran, and three different
  ;    explanations fitted the real log equally well. So each of the five ways
  ;    this can end names itself -- stopped; no record; a record that will not read;
  ;    a record naming a process that is gone; a core running that is not ours to
  ;    stop by name. `lifecycle.rs::no_path_through_the_pre_install_core_stop_is_silent`
  ;    keeps it that way.
  ;
  ;    THE EXIT CODE IS READ; THE OUTPUT IS NOT. taskkill answers 0 when it
  ;    terminated the process and non-zero when it found nothing to terminate, and
  ;    that is the only thing here that can tell a stale record from a live core.
  ;    Its console TEXT is still never captured and never shown: on Russian Windows
  ;    the child writes code page 866 into a pane that renders 1251, which is the
  ;    mojibake read during a real uninstall (G-32-4). A failure to
  ;    launch taskkill at all is also non-zero and lands in the same two branches --
  ;    both of which report that the core was NOT stopped, never that it was.
  Push $R0
  Push $R1
  Push $R2

  StrCpy $R0 ""
  IfFileExists "${TT_SIDECAR_PID_FILE}" 0 tt_preinstall_target_core_norecord
    FileOpen $R1 "${TT_SIDECAR_PID_FILE}" r
    FileRead $R1 $R0
    FileClose $R1

  ; Strip the line terminator FileRead keeps, plus any trailing blanks. Ends when
  ; the last character is not one of the four, or when nothing is left.
  tt_preinstall_target_pid_trim:
    StrCpy $R2 $R0 1 -1
    StrCmp $R2 "$\r" tt_preinstall_target_pid_chop
    StrCmp $R2 "$\n" tt_preinstall_target_pid_chop
    StrCmp $R2 " " tt_preinstall_target_pid_chop
    StrCmp $R2 "$\t" tt_preinstall_target_pid_chop
    Goto tt_preinstall_target_pid_trimmed
  tt_preinstall_target_pid_chop:
    StrCpy $R0 $R0 -1
    Goto tt_preinstall_target_pid_trim
  tt_preinstall_target_pid_trimmed:

  ; Digits only, and the list IS the whitelist. Running off the end means every
  ; character was a digit; anything else blanks the candidate.
  StrCpy $R1 0
  tt_preinstall_target_pid_scan:
    StrCpy $R2 $R0 1 $R1
    StrCmp $R2 "" tt_preinstall_target_core_validated
    StrCmp $R2 "0" tt_preinstall_target_pid_digit
    StrCmp $R2 "1" tt_preinstall_target_pid_digit
    StrCmp $R2 "2" tt_preinstall_target_pid_digit
    StrCmp $R2 "3" tt_preinstall_target_pid_digit
    StrCmp $R2 "4" tt_preinstall_target_pid_digit
    StrCmp $R2 "5" tt_preinstall_target_pid_digit
    StrCmp $R2 "6" tt_preinstall_target_pid_digit
    StrCmp $R2 "7" tt_preinstall_target_pid_digit
    StrCmp $R2 "8" tt_preinstall_target_pid_digit
    StrCmp $R2 "9" tt_preinstall_target_pid_digit
    StrCpy $R0 ""
    Goto tt_preinstall_target_core_validated
  tt_preinstall_target_pid_digit:
    IntOp $R1 $R1 + 1
    Goto tt_preinstall_target_pid_scan

  tt_preinstall_target_core_validated:
  StrCmp $R0 "" tt_preinstall_target_core_unusable
    DetailPrint "$(legacyStoppingCore)"
    nsExec::Exec 'taskkill /F /PID $R0'
    Pop $R2
    ; Anything but 0 means nothing was terminated by that number. Which of the two
    ; reasons it was is decided below, by LOOKING and never by killing.
    StrCmp $R2 "0" 0 tt_preinstall_target_core_notstopped
    StrCpy $R1 0
    tt_preinstall_target_core_wait_loop:
      nsis_tauri_utils::FindProcess "trusttunnel_client.exe"
      Pop $R2
      ; 0 means the image WAS found (utils.nsh:39), so non-zero is the exit we want.
      ; The name also matches the LIGHT edition's core, so a machine running that
      ; one reaches the ceiling and warns although ours did go: a false WARNING,
      ; never a false kill, which is the right way round.
      ${If} $R2 <> 0
        DetailPrint "$(legacyCoreStopped)"
        Goto tt_preinstall_target_core_done
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 >= 40
        DetailPrint "$(legacyStillRunning)"
        Goto tt_preinstall_target_core_done
      ${EndIf}
      Sleep 250
      Goto tt_preinstall_target_core_wait_loop

  tt_preinstall_target_core_notstopped:
    nsis_tauri_utils::FindProcess "trusttunnel_client.exe"
    Pop $R2
    ${If} $R2 <> 0
      DetailPrint "$(legacyCoreRecordStale)"
      Goto tt_preinstall_target_core_done
    ${EndIf}
    DetailPrint "$(legacyCoreNotStopped)"
    Goto tt_preinstall_target_core_done

  tt_preinstall_target_core_norecord:
    DetailPrint "$(legacyCoreNoRecord)"
    Goto tt_preinstall_target_core_done

  tt_preinstall_target_core_unusable:
    DetailPrint "$(legacyCoreRecordUnusable)"
  tt_preinstall_target_core_done:

  Pop $R2
  Pop $R1
  Pop $R0

  ; ── 1. Find the LEGACY install by ASKING the registry — never by assuming ────
  ;
  ;    WHY THIS HOOK EXISTS AT ALL. This installer is perMachine as of phase 32,
  ;    and Tauri's own previous-install probe reads SHCTX (the emitted script does
  ;    it at :192 for the uninstall key and at :329 for the manufacturer key).
  ;    Under perMachine SHCTX is HKLM. But every install already sitting on a
  ;    user's disk was built currentUser and wrote its metadata to HKCU. So the
  ;    template's upgrade detection is STRUCTURALLY BLIND to exactly the install
  ;    it must find — it looks in a hive that install never wrote. That is not a
  ;    prediction: plan 32-01 probed a real Windows install and found the key
  ;    present under HKCU and absent under HKLM. Closing that blindness is this
  ;    macro's entire job, and it is why the hive below is spelled HKCU LITERALLY
  ;    instead of using the shell-context alias.
  ;
  ;    THE LEGACY UNINSTALLER IS NEVER EXECUTED (D-06). Not a style preference —
  ;    the uninstall.exe on existing users' disks belongs to the OLD build and
  ;    cannot be patched. On every install predating the 30.1 fix it deletes
  ;    ssh_credentials.json, known_hosts.json, routing_rules.json,
  ;    exclusions.json, active_groups.json, connection_history.json,
  ;    trusttunnel_client.toml and the webview_data / geodata / resolved /
  ;    group_cache folders UNCONDITIONALLY. Under D-05 that folder IS the data
  ;    root the new install is about to keep using, so invoking it would destroy
  ;    the user's data in the very act of preserving it. Nothing in this macro
  ;    executes another program, and `lifecycle.rs` asserts at COMPILE time that
  ;    nothing ever will.
  ;
  ;    WHICH REGISTRY VALUE, AND WHY NOT THE OTHER ONE. The template writes the
  ;    install directory into the default (unnamed) value of MANUPRODUCTKEY,
  ;    UNQUOTED (emitted script :639). The uninstall entry's InstallLocation
  ;    carries the same path WRAPPED IN LITERAL QUOTE CHARACTERS (:662, where
  ;    `$\"` is NSIS's escape for a quote) — confirmed twice in plan 32-01, once
  ;    by reading the emitted script and once by probing a real machine.
  ;    So the unnamed value is the one to read, and no quote-stripping is needed.
  ;
  ;    THERE IS DELIBERATELY NO FALLBACK PROBE. Research rated «the key may be
  ;    absent» a HIGH risk (A4) and designed a second probe against
  ;    InstallLocation, with quote-stripping, to cover it. Plan 32-01 retired that
  ;    risk BY OBSERVATION rather than by argument: the key is present. Writing
  ;    the second probe anyway would add a branch no machine we can see ever
  ;    executes — and unreachable code beside a destructive step is worse than
  ;    absent code, because it reads as coverage. If a machine ever turns up
  ;    carrying the uninstall entry without the manufacturer key, add the probe
  ;    THEN, together with the quote-stripping its quoted value requires.
  ;
  ;    The key path is taken from the template's own define and never retyped: a
  ;    hand-typed copy is how two ends drift apart in silence.
  Push $R9
  Push $R8
  Push $R7
  Push $R6
  Push $R5
  Push $R4
  Push $R3

  StrCpy $R9 ""
  ReadRegStr $R9 HKCU "${MANUPRODUCTKEY}" ""

  ; ── 2. Validate BEFORE the value is used for anything ────────────────────────
  ;
  ;    This string is attacker-influenceable input to file operations running as
  ;    Administrator, so every check below happens before the path is composed
  ;    into anything. It is also never interpolated into a shell command — the
  ;    macro runs no commands at all.
  ;
  ;    The rejections are written as «blank the candidate», not as jumps, for two
  ;    specific reasons. `Return` would be a bug rather than a shortcut: this
  ;    macro expands INSIDE `Section Install`, so a Return here returns from the
  ;    section and silently skips the entire installation. And a label would
  ;    collide if the macro were ever inserted twice. A blanked candidate simply
  ;    fails the one guard that wraps the body, which is also what makes «found
  ;    nothing» and «found something invalid» behave identically: both stay
  ;    completely silent. A hook that announced a migration it did not perform
  ;    would be the same class of lie this project's patterns forbid everywhere
  ;    else.

  ; (a) A trailing separator is stripped first, so a value stored as "C:\dir\"
  ;     compares and composes exactly like "C:\dir".
  ${If} $R9 != ""
    StrCpy $R8 $R9 1 -1
    ${If} $R8 == "\"
      StrCpy $R9 $R9 -1
    ${EndIf}
  ${EndIf}

  ; (b) It must be an absolute path with a drive letter. This also refuses UNC
  ;     paths on purpose: an elevated installer must not follow a \\server\share
  ;     it was handed by a registry value. Length < 4 rejects a bare drive root.
  ${If} $R9 != ""
    StrCpy $R8 $R9 1 1
    StrCpy $R7 $R9 1 2
    StrLen $R6 $R9
    ${If} $R8 != ":"
    ${OrIf} $R7 != "\"
    ${OrIf} $R6 < 4
      StrCpy $R9 ""
    ${EndIf}
  ${EndIf}

  ; (c) It must not name a filesystem or system root. Defence in depth: check (d)
  ;     below already refuses any folder that does not hold our own binary, so a
  ;     root would be rejected anyway. This list makes the intent legible and
  ;     fails earlier, which matters for the one step in this phase that becomes
  ;     destructive later.
  ${If} $R9 != ""
    ${If} $R9 == "$WINDIR"
    ${OrIf} $R9 == "$SYSDIR"
    ${OrIf} $R9 == "$PROGRAMFILES"
    ${OrIf} $R9 == "$PROGRAMFILES64"
    ${OrIf} $R9 == "$COMMONFILES"
    ${OrIf} $R9 == "$COMMONFILES64"
    ${OrIf} $R9 == "$PROFILE"
    ${OrIf} $R9 == "$APPDATA"
    ${OrIf} $R9 == "$LOCALAPPDATA"
    ${OrIf} $R9 == "$DESKTOP"
    ${OrIf} $R9 == "$DOCUMENTS"
    ${OrIf} $R9 == "$TEMP"
      StrCpy $R9 ""
    ${EndIf}
  ${EndIf}

  ; (d) Our own main binary must actually be in there. This is the check with
  ;     teeth: it is what distinguishes «the legacy install» from «some folder a
  ;     registry value happens to name».
  ;
  ;     THE BASENAME COMES FROM THE TEMPLATE'S DEFINE AND IS NEVER RETYPED. The
  ;     main binary is `trusttunnel`, while the product is `TrustTunnel Client
  ;     Pro` (emitted script :42 vs :33) — they are different strings. A path
  ;     built from the product name matches nothing, and a hook that matches
  ;     nothing looks EXACTLY like a hook that had nothing to do. That failure
  ;     would be invisible in every log.
  ${If} $R9 != ""
    ${IfNot} ${FileExists} "$R9\${MAINBINARYNAME}.exe"
      StrCpy $R9 ""
    ${EndIf}
  ${EndIf}

  ; ── 3. The same-path guard: never enumerate the install we are performing ────
  ;
  ;    Both paths are normalised with GetFullPathName and then compared with
  ;    LogicLib's `==`, which is case-insensitive — that pair IS the comparison
  ;    discipline, and it covers two of the three ways two spellings of one folder
  ;    can differ: a trailing or doubled separator, a `.` or `..` component
  ;    (GetFullPathName), and letter case (`==`). GetFullPathName needs the path to
  ;    exist, which check (d) above has already established for $R9, and which is
  ;    true of $INSTDIR because the template runs `SetOutPath $INSTDIR`
  ;    immediately before this hook (emitted script :611 vs :613).
  ;
  ;    WHAT IT DOES *NOT* COVER, AND THIS COMMENT USED TO CLAIM IT DID. Without
  ;    /SHORT, GetFullPathName does not expand 8.3 names, so "C:\PROGRA~1\X" and
  ;    "C:\Program Files\X" still compare as different folders. The uncovered case
  ;    is a registry value carrying a short-name spelling of the very folder the
  ;    user is now installing into: the guard then fails to fire, and the hook
  ;    prints a removal report for binaries the template is about to write back
  ;    moments later. No user data is at risk — the enumeration is binaries only,
  ;    which is the design working — but the report has no subject.
  ;    /SHORT is NOT used here to close it: it answers empty on a path with no 8.3
  ;    alias (a volume created with short-name generation off, which is common on
  ;    modern data volumes), and an empty $R5 would make the guard fire on
  ;    everything or on nothing depending on which side went blank — trading a
  ;    misleading log line for a guard that no longer guards. The residual is
  ;    recorded rather than closed; do not credit this pair with a property it
  ;    does not have.
  ;
  ;    WHAT THIS GUARD IS COMPARED AGAINST, AND WHY IT IS NOT THE DATA ROOT.
  ;    The plan for this task asked for the guard against «the new data root».
  ;    It is written against $INSTDIR instead, deliberately, for two reasons that
  ;    each stand alone:
  ;
  ;      1. THIS HOOK CANNOT NAME THE DATA ROOT, at all. The data root is the
  ;         user's %LOCALAPPDATA%\TrustTunnel Client Pro. Under perMachine NSIS's
  ;         $LOCALAPPDATA resolves to %ProgramData% (see the icon-cache block in
  ;         POSTINSTALL), and forcing the per-user context back on resolves the
  ;         ELEVATING administrator's profile, which under UAC need not be the
  ;         person installing — D-08 rejected recovering that identity. So a
  ;         comparison against the data root would be a comparison against a path
  ;         we cannot resolve correctly, i.e. a guard that fires arbitrarily.
  ;      2. IT WOULD SUPPRESS THE ONLY CASE THAT MATTERS. Under D-05 the legacy
  ;         install directory IS the new data root on a default install — that is
  ;         the common case, not an edge case. A guard against the data root
  ;         would therefore fall silent on exactly the machine this phase was
  ;         built for, leaving the old binaries AND the old uninstall.exe on disk
  ;         with a second Add/Remove-Programs entry pointing at it. Double-click
  ;         that entry and the old uninstaller destroys the data root — which is
  ;         the precise disaster D-06 exists to prevent. The «old folder and new
  ;         folder are the same place, nothing to do» state named in the design
  ;         contract belongs to the DATA MIGRATION (D-07), where there is genuinely
  ;         nothing to copy; it does not belong to the binary removal.
  ;
  ;    What $INSTDIR guards against is real and is the guard actually needed: if
  ;    the user points the directory page at the folder the legacy install already
  ;    occupies, the template overwrites those files in place moments later, so
  ;    there is nothing to remove and removing anything would only delete files
  ;    about to be rewritten.
  ;
  ;    Note that the removal stays an ENUMERATED artifact list either way. On a
  ;    default install the folder we are about to enumerate still holds the user's
  ;    servers, credentials and browser profile, so «this is not the folder we are
  ;    installing into» is a reason to name files one by one — never a licence to
  ;    sweep the directory.
  ${If} $R9 != ""
    GetFullPathName $R5 "$R9"
    GetFullPathName $R4 "$INSTDIR"
    ${If} $R5 != ""
    ${AndIf} $R5 == $R4
      StrCpy $R9 ""
    ${EndIf}
  ${EndIf}

  ; ── 4. Remove the enumerated artifacts, and report what actually happened ───
  ;
  ;    THIS LIST WAS READ BY A HUMAN BEFORE IT COULD DELETE ANYTHING, AND THAT IS
  ;    THE WHOLE SAFETY MECHANISM. There is no rehearsal machine for this phase: no
  ;    spare VM, no second Windows account. The only disk this can be tried on is
  ;    a real Windows install, carrying real server configs, SSH credentials,
  ;    known hosts and routing rules. So plan 32-02 shipped this pass LOG-ONLY, the
  ;    owner ran that build (label 04xs4h) against a real data folder, read the printed
  ;    list, and confirmed item by item that none of it was his data and that the
  ;    discovered folder was the one he actually has. Only then did plan 32-06 turn
  ;    the deletions on, and only for exactly the nine artifacts reviewed.
  ;    `.planning/phases/32-*/32-DRYRUN-LOG.md` is that record.
  ;
  ;    SO DO NOT ADD A LINE HERE. Not a tenth artifact, not a "while we are at it".
  ;    The value of a list a human reviewed is destroyed the moment somebody appends
  ;    to it afterwards, and the appended line is the one nobody read. `.sidecar-pro.pid`
  ;    is the concrete case: it IS left behind in the legacy folder, the owner was
  ;    offered the option of adding it, and he declined — so its absence below is his
  ;    decision on record, not an oversight to repair. It is a process id from a boot
  ;    that is over; it harms nothing sitting there.
  ;
  ;    WHAT IS PINNED FROM RUST, at compile time, in `lifecycle.rs`: that nothing here
  ;    removes a directory recursively; that nothing here executes another program;
  ;    that no filename the user owns appears on any removal or report line; that every
  ;    file the template installs is enumerated; and that every enumerated artifact is
  ;    removed and then RE-CHECKED, with a distinct failure line to print when it
  ;    survived. Each of those five arms has been demonstrated red under mutation — a
  ;    rule nobody has seen fail is a rule nobody has evidence works.
  ;
  ;    HOW THE LIST WAS DERIVED — from two sources, cross-checked, never from
  ;    memory:
  ;      (i)  the files the TEMPLATE ITSELF installs, read off the regenerated
  ;           script: the main binary (:620), the two runtime DLLs and the
  ;           network-adapter DLL (:624-626), the sidecar VPN core installed
  ;           under the name `trusttunnel_client.exe` (:629), and the uninstaller
  ;           the template writes (:636). Plus the two shortcuts it creates
  ;           (:892, :916 — STARTMENUFOLDER is empty, so the start-menu link sits
  ;           directly under $SMPROGRAMS) and the uninstall entry (:56, :658-663).
  ;      (ii) the artifact inventory in `30.1-RESEARCH.md` § C.a, ticked at their
  ;           real lines by `30.1-08-SUMMARY.md`.
  ;
  ;    TWO DISCREPANCIES BETWEEN THE SOURCES, RECORDED RATHER THAN AVERAGED AWAY:
  ;      - § C.a names the sidecar by its SOURCE filename,
  ;        `trusttunnel_client-x86_64-pc-windows-msvc.exe`. The template renames it
  ;        on the way in (`/oname=trusttunnel_client.exe`). What is on the user's
  ;        disk is the installed name, and that is the one enumerated here. A list
  ;        built from the inventory alone would have missed the sidecar entirely.
  ;      - § C.a lists neither the main binary nor uninstall.exe, because it is an
  ;        inventory of DATA paths plus shipped resources. Neither source is
  ;        complete on its own; that is precisely why both were read.
  ;
  ;    UNCONDITIONAL GOING IN, CHECKED COMING OUT — and the asymmetry is the point.
  ;    No removal below is GATED on an exists-check first: that is the shape
  ;    `deferred-items.md` § item 5 asks for, NSIS `Delete` is already a silent
  ;    no-op on an absent file so a pre-probe would add only a failure mode, and
  ;    gating each line on existence would make the printed list SHRINK from run to
  ;    run, so «run it twice, get the same report» would stop being true exactly
  ;    when it matters.
  ;
  ;    But every removal IS followed by a re-check, and that is a different thing
  ;    doing a different job. `Delete` on a file another process holds open FAILS
  ;    SILENTLY — no error flag anything here reads, no warning, the install walks
  ;    on — and `trusttunnel.exe` or `trusttunnel_client.exe` may well be running
  ;    when somebody reinstalls, so that is the ordinary case and not an exotic one.
  ;    The dry run the owner read proved the ENUMERATION and could not, structurally,
  ;    prove the DELETION; the second look is what closes that gap. A progress list
  ;    printing the same line whether or not the file went is the application
  ;    claiming what it did not do, which is the one thing this project forbids
  ;    everywhere else. Absence of a failure line therefore MEANS something here.
  ;
  ;    WHAT MUST SURVIVE, AND IS NOT IN THIS LIST. On a default install the folder
  ;    enumerated below is ALSO where the user's data lives (D-05) — the binaries
  ;    are leaving it and the data is staying. So the list must be provably free of
  ;    every data filename, because the defect class this guards is a list that
  ;    grows a data file by accident. What stays: the credential store
  ;    (ssh_credentials.json), the known-hosts file (known_hosts.json), the routing
  ;    rules (routing_rules.json), the exclusions (exclusions.json), the active
  ;    groups (active_groups.json), the connection history
  ;    (connection_history.json), the client configuration (trusttunnel_client.toml),
  ;    the server manifest (configs.json) together with the per-server .toml files
  ;    whose names the USER chooses — which is itself the reason this is a closed
  ;    allow-list of binaries and never a deny-list of data — the application
  ;    settings (app_settings.json), the DNS snapshot (dns_snapshot.json), and the
  ;    webview_data, geodata, resolved, group_cache, runtime and logs folders.
  ;    THE BROWSER PROFILE (webview_data) IS THE ONE PEOPLE FORGET: losing it looks
  ;    to a user like amnesia rather than like an error.
  ;
  ;    NOT ENUMERATED, DELIBERATELY: the legacy autostart values under
  ;    ...\CurrentVersion\Run. This pass is scoped to binaries, shortcuts and the
  ;    programs-list entry; autostart is D-10's, and it lands with the scheduled
  ;    task that replaces it. When that cleanup is written it copies the shape of
  ;    the block in POSTUNINSTALL below — unconditional, no exists-check — and NOT
  ;    its name list, which reaches into the co-installed Light edition and is the
  ;    recorded T-24 defect. Nothing in this macro names the other edition, and an
  ;    acceptance check greps that to zero.
  ${If} $R9 != ""
    DetailPrint "$(legacyInstallFound) $R9"

    ; ── 3a. STOP THIS EDITION'S VPN CORE — BY PROCESS ID, NEVER BY IMAGE NAME ───
    ;
    ;    WHAT THIS FIXES, AND WHY BLOCK 0 ABOVE WAS NOT ENOUGH. Block 0 closes the
    ;    main executable and waits for it. The VPN CORE is a second process, and
    ;    NOTHING in the installer had ever terminated it: `CheckIfAppIsRunning`
    ;    (utils.nsh:22) takes ONE image name and is invoked only with
    ;    `${MAINBINARYNAME}.exe`; the string `trusttunnel_client.exe` occurs nowhere
    ;    in the template or in utils.nsh. The only thing that ever stops the core is
    ;    the Windows Job Object (`job_object.rs:4`, KILL_ON_JOB_CLOSE), which fires
    ;    AFTER the parent dies — asynchronously, long after this hook has finished,
    ;    and with a documented degraded path (`job_object.rs:143-149`). The core
    ;    holds its own image mapped and, through a run-time `LoadLibrary`, holds
    ;    `wintun.dll` as well — neither binary IMPORTS wintun, so the core alone
    ;    pins it. Those are two of the three files that survived on a real disk
    ;    (UAT gap G-32-2); reordering alone would have fixed at most the third.
    ;
    ;    BY PROCESS ID, AND THAT IS A PRODUCT DECISION ON RECORD (2026-09-06,
    ;    «По номеру процесса», option `route-b` of plan 32-FIX-09 task 1). Both
    ;    editions ship an external binary named `trusttunnel_client` (`externalBin`
    ;    in gui-pro AND gui-light tauri.conf.json), so an image-name kill is NOT
    ;    edition-scoped: it would end the co-installed Light edition's live VPN
    ;    session. PREUNINSTALL below refuses that route for the same reason, in
    ;    writing, and this block mirrors it rather than inventing a second shape.
    ;
    ;    THE PATH IS BUILT ON $R9 AND NEVER ON $INSTDIR. The folder being cleaned is
    ;    the OLD one; the pid file belonging to the core that holds the old binaries
    ;    open is the one sitting in the old folder. $INSTDIR names the folder we are
    ;    installing INTO, whose pid file is either absent or somebody else's boot.
    ;    The basename is the same one Rust writes (`lifecycle::SIDECAR_PID_BASENAME`)
    ;    and BOTH spellings in this file are pinned to that constant — by
    ;    `lifecycle.rs::the_uninstall_hook_reads_the_pid_file_the_app_writes` and by
    ;    rule 13 of `remediation-hygiene.sh`. Neither end can drift in silence; that
    ;    drift has already happened once (D-07) and the kill was a no-op for months.
    ;
    ;    THE PID IS UNTRUSTED INPUT AND IS VALIDATED AS DIGITS BEFORE IT IS USED FOR
    ;    ANYTHING. It is a number in a file inside a user-writable directory, read by
    ;    an installer running as Administrator and placed on a command line. So the
    ;    line terminator is stripped and every remaining character must be a decimal
    ;    digit — a WHITELIST, per the project's own validator rule, never a blacklist
    ;    of things to reject. What happens in each degraded case, stated rather than
    ;    left to be discovered:
    ;      - file ABSENT      -> $R0 stays empty, nothing is executed, removal proceeds;
    ;      - file EMPTY       -> the scan sees no character at all, $R0 stays empty, same;
    ;      - file MALFORMED   -> the first non-digit blanks $R0 and the termination step
    ;                            is SKIPPED SILENTLY, in the same «blank the candidate»
    ;                            style the path ladder above uses. It is never repaired,
    ;                            never truncated to its leading digits, and never passed
    ;                            through;
    ;      - process GONE     -> taskkill reports failure into the details pane and
    ;                            nothing here reads or branches on it;
    ;      - process SOMEBODY ELSE'S -> an accepted risk, recorded as T-32-09-02: whoever
    ;                            can write this file can already replace the binaries in
    ;                            that folder outright, which is a strictly stronger
    ;                            position. The identical primitive already ships in
    ;                            PREUNINSTALL.
    ;
    ;    NOTHING HERE READS THE TOOL'S OUTPUT — and since 32-FIX-16 nothing SHOWS it
    ;    either. The plain `nsExec::Exec` form is used deliberately: the logging variant
    ;    copies the child's console bytes into the details window, and a console on
    ;    Russian Windows writes code page 866 while that window renders 1251, so the
    ;    person watching reads mojibake written by a program that is not ours (G-32-4,
    ;    reported by the owner from a real uninstall). We print our own lines instead.
    ;
    ;    The `Pop` after the call is stack hygiene, not a branch: this block brackets
    ;    three registers with Push/Pop, and `nsExec::Exec` leaves its exit code on the
    ;    same stack — unpopped, every subsequent `Pop` in this macro would restore the
    ;    WRONG register. The value is overwritten by the poll below and never read.
    ;    (PREUNINSTALL can omit its pop because it brackets nothing.)
    ;
    ;    WHY A POLL AFTER THE KILL, AND WHAT ITS LIMIT IS. Same counted-ceiling shape
    ;    as block 0 — reused, not reinvented — because `taskkill /F` returns before the
    ;    kernel has finished tearing the process down and unmapping its images. The
    ;    poll asks `FindProcess`, which matches by IMAGE NAME and therefore also sees
    ;    the LIGHT edition's core if that is running: on such a machine the ceiling is
    ;    reached and `legacyStillRunning` prints even though our core did go. That is a
    ;    false WARNING, never a false kill — `FindProcess` only looks — and a spurious
    ;    warning beside an honest per-artifact outcome report is the right way round.
    ;    Narrowing it would need a wait-on-pid the bundled plugin does not export.
    Push $R0
    Push $R1
    Push $R2

    StrCpy $R0 ""
    IfFileExists "$R9\.sidecar-pro.pid" 0 tt_preinstall_core_validated
      FileOpen $R1 "$R9\.sidecar-pro.pid" r
      FileRead $R1 $R0
      FileClose $R1

    ; Strip the line terminator FileRead keeps, plus any trailing blanks. Ends when
    ; the last character is not one of the four, or when nothing is left.
    tt_preinstall_pid_trim:
      StrCpy $R2 $R0 1 -1
      StrCmp $R2 "$\r" tt_preinstall_pid_chop
      StrCmp $R2 "$\n" tt_preinstall_pid_chop
      StrCmp $R2 " " tt_preinstall_pid_chop
      StrCmp $R2 "$\t" tt_preinstall_pid_chop
      Goto tt_preinstall_pid_trimmed
    tt_preinstall_pid_chop:
      StrCpy $R0 $R0 -1
      Goto tt_preinstall_pid_trim
    tt_preinstall_pid_trimmed:

    ; Digits only, and the list IS the whitelist. Running off the end means every
    ; character was a digit; anything else blanks the candidate and skips the kill.
    StrCpy $R1 0
    tt_preinstall_pid_scan:
      StrCpy $R2 $R0 1 $R1
      StrCmp $R2 "" tt_preinstall_core_validated
      StrCmp $R2 "0" tt_preinstall_pid_digit
      StrCmp $R2 "1" tt_preinstall_pid_digit
      StrCmp $R2 "2" tt_preinstall_pid_digit
      StrCmp $R2 "3" tt_preinstall_pid_digit
      StrCmp $R2 "4" tt_preinstall_pid_digit
      StrCmp $R2 "5" tt_preinstall_pid_digit
      StrCmp $R2 "6" tt_preinstall_pid_digit
      StrCmp $R2 "7" tt_preinstall_pid_digit
      StrCmp $R2 "8" tt_preinstall_pid_digit
      StrCmp $R2 "9" tt_preinstall_pid_digit
      StrCpy $R0 ""
      Goto tt_preinstall_core_validated
    tt_preinstall_pid_digit:
      IntOp $R1 $R1 + 1
      Goto tt_preinstall_pid_scan

    tt_preinstall_core_validated:
    ; Announced only when there is something to announce: a hook that says it is
    ; stopping the core while doing nothing is the class of lie this file refuses.
    StrCmp $R0 "" tt_preinstall_core_done
      DetailPrint "$(legacyStoppingCore)"
      nsExec::Exec 'taskkill /F /PID $R0'
      Pop $R2
      StrCpy $R1 0
      tt_preinstall_core_wait_loop:
        nsis_tauri_utils::FindProcess "trusttunnel_client.exe"
        Pop $R2
        ; 0 means the image WAS found (utils.nsh:39), so non-zero is the exit we want.
        ${If} $R2 <> 0
          Goto tt_preinstall_core_done
        ${EndIf}
        IntOp $R1 $R1 + 1
        ${If} $R1 >= 40
          DetailPrint "$(legacyStillRunning)"
          Goto tt_preinstall_core_done
        ${EndIf}
        Sleep 250
        Goto tt_preinstall_core_wait_loop
    tt_preinstall_core_done:

    Pop $R2
    Pop $R1
    Pop $R0

    ; ── 4a. WHAT SURVIVES THE REMOVAL GOES AT THE NEXT RESTART, NOT NEVER ───────
    ;
    ;    WHAT THE TWO TERMINATIONS ABOVE CANNOT COVER. Block 0 closes the application
    ;    and waits for it; block 3a stops this edition's VPN core by process id and
    ;    waits for that. Between them they cover the ordinary case. What neither can
    ;    cover is A HANDLE THAT OUTLIVES ITS PROCESS: `wintun.dll` is loaded by the core
    ;    at run time through `LoadLibrary`, and the adapter driver can hold a reference
    ;    to it after the loading process is gone. On such a machine every termination
    ;    above did its job and `Delete` still fails — silently, as it always does. Left
    ;    at that, the file is orphaned in the legacy folder forever.
    ;
    ;    SO EACH FAILURE BRANCH GETS A SECOND ATTEMPT WITH A LATER DEADLINE. `Delete
    ;    /REBOOTOK` hands the path to the session manager's pending-rename list, which
    ;    the kernel executes at the next boot before anything can open the file again.
    ;    It is a SECOND ATTEMPT AT AN ARTIFACT ALREADY ANNOUNCED, never a tenth artifact:
    ;    the target is the same path its own branch just reported on, composed from the
    ;    same validated register, and the nine stay nine. That is enforced rather than
    ;    promised — the set equality in `lifecycle.rs::every_artifact_the_pre_install_
    ;    hook_removes_reports_what_actually_happened` compares DEDUPLICATED names, so a
    ;    second removal of an announced artifact passes and a first removal of an
    ;    unannounced one does not.
    ;
    ;    THE REGISTRY BRANCH GETS NONE. A key is not a file: `DeleteRegKey` has no
    ;    deferred form, and the pending-rename list schedules FILE deletions, so aiming
    ;    it at a registry path would schedule the deletion of a file that does not exist.
    ;
    ;    NEITHER TOKEN OCCURS ANYWHERE ELSE IN THIS PROJECT. This is the first use of
    ;    both, so both were READ OUT OF THE TOOLCHAIN rather than remembered:
    ;
    ;      * DOES `/REBOOTOK` RAISE THE REBOOT FLAG BY ITSELF? Yes — but only when the
    ;        schedule actually succeeds. Registering a pending rename is a privileged
    ;        operation; when it fails NSIS sets the error flag and leaves the reboot flag
    ;        DOWN. So `SetRebootFlag true` is explicit here rather than inherited. The
    ;        price of the redundancy is a restart offered for nothing on the machine
    ;        where the schedule failed; the price of relying on the implicit raise is a
    ;        scheduled deletion the user is never told about and therefore never
    ;        completes. The second is the worse failure, and the flag is raised inside a
    ;        branch that already knows the artifact survived.
    ;
    ;      * DOES THE FINISH PAGE ACTUALLY OFFER THE RESTART? Yes, on this template.
    ;        `MUI_FINISHPAGE_NOREBOOTSUPPORT` is defined NOWHERE in the emitted script —
    ;        it carries only NOAUTOCLOSE, SHOWREADME and RUN (installer.nsi:382-389) —
    ;        and the interface library guards its reboot radio buttons on exactly that
    ;        `!ifndef` together with `${if} ${RebootFlag}` (`Modern UI 2/Pages/
    ;        Finish.nsh:324-326`, and again at :460-463, where the chosen restart is
    ;        performed). Read out of the toolchain the bundler downloads, not assumed.
    ;
    ;        KNOWN CONSEQUENCE, RECORDED RATHER THAN DISCOVERED LATER. With the flag up
    ;        that page shows the two reboot radio buttons INSTEAD of the «run the
    ;        program» and «add a desktop shortcut» checkboxes — those live in the
    ;        `${else}` arm of the same conditional (`Finish.nsh:354-405`). So on a machine
    ;        where something survived, the user is offered a restart and not the shortcut
    ;        checkbox. That is the library's design and it is the right way round: the
    ;        shortcut can be made at any time, the deferred deletion cannot happen
    ;        without the restart.
    ;
    ;    AND THE USER IS TOLD, IN WORDS. `legacyRemoveOnReboot` prints beside the failure
    ;    line, so the details pane carries both facts about the same artifact — it did
    ;    not go now, and it goes at the restart. A scheduled deletion nobody is told
    ;    about would be a worse defect than the orphan it repairs.

    ; (a) The binaries the template installs into the program folder.
    ;
    ;     `uninstall.exe` is REMOVED AS A FILE AND NEVER RUN (D-06). It belongs to the
    ;     OLD build, cannot be patched, and on every install predating the 30.1 fix it
    ;     deletes the credential store, the known hosts and the routing rules
    ;     unconditionally — which under D-05 is the data root this install is about to
    ;     keep using. Deleting it is the point; executing it would destroy the data in
    ;     the very act of preserving it. `lifecycle.rs` pins the INVOCATION SHAPE
    ;     rather than the filename, so the correct `Delete` line below cannot collide
    ;     with the rule that forbids running it.
    DetailPrint "$(legacyRemoving) $R9\${MAINBINARYNAME}.exe"
    Delete "$R9\${MAINBINARYNAME}.exe"
    ${If} ${FileExists} "$R9\${MAINBINARYNAME}.exe"
      DetailPrint "$(legacyRemoveFailed) $R9\${MAINBINARYNAME}.exe"
      Delete /REBOOTOK "$R9\${MAINBINARYNAME}.exe"
      SetRebootFlag true
      DetailPrint "$(legacyRemoveOnReboot) $R9\${MAINBINARYNAME}.exe"
      !insertmacro TT_MARK_SURVIVOR "$R9\${MAINBINARYNAME}.exe"
    ${EndIf}

    DetailPrint "$(legacyRemoving) $R9\vcruntime140.dll"
    Delete "$R9\vcruntime140.dll"
    ${If} ${FileExists} "$R9\vcruntime140.dll"
      DetailPrint "$(legacyRemoveFailed) $R9\vcruntime140.dll"
      Delete /REBOOTOK "$R9\vcruntime140.dll"
      SetRebootFlag true
      DetailPrint "$(legacyRemoveOnReboot) $R9\vcruntime140.dll"
      !insertmacro TT_MARK_SURVIVOR "$R9\vcruntime140.dll"
    ${EndIf}

    DetailPrint "$(legacyRemoving) $R9\vcruntime140_1.dll"
    Delete "$R9\vcruntime140_1.dll"
    ${If} ${FileExists} "$R9\vcruntime140_1.dll"
      DetailPrint "$(legacyRemoveFailed) $R9\vcruntime140_1.dll"
      Delete /REBOOTOK "$R9\vcruntime140_1.dll"
      SetRebootFlag true
      DetailPrint "$(legacyRemoveOnReboot) $R9\vcruntime140_1.dll"
      !insertmacro TT_MARK_SURVIVOR "$R9\vcruntime140_1.dll"
    ${EndIf}

    DetailPrint "$(legacyRemoving) $R9\wintun.dll"
    Delete "$R9\wintun.dll"
    ${If} ${FileExists} "$R9\wintun.dll"
      DetailPrint "$(legacyRemoveFailed) $R9\wintun.dll"
      Delete /REBOOTOK "$R9\wintun.dll"
      SetRebootFlag true
      DetailPrint "$(legacyRemoveOnReboot) $R9\wintun.dll"
      !insertmacro TT_MARK_SURVIVOR "$R9\wintun.dll"
    ${EndIf}

    DetailPrint "$(legacyRemoving) $R9\trusttunnel_client.exe"
    Delete "$R9\trusttunnel_client.exe"
    ${If} ${FileExists} "$R9\trusttunnel_client.exe"
      DetailPrint "$(legacyRemoveFailed) $R9\trusttunnel_client.exe"
      Delete /REBOOTOK "$R9\trusttunnel_client.exe"
      SetRebootFlag true
      DetailPrint "$(legacyRemoveOnReboot) $R9\trusttunnel_client.exe"
      !insertmacro TT_MARK_SURVIVOR "$R9\trusttunnel_client.exe"
    ${EndIf}

    DetailPrint "$(legacyRemoving) $R9\uninstall.exe"
    Delete "$R9\uninstall.exe"
    ${If} ${FileExists} "$R9\uninstall.exe"
      DetailPrint "$(legacyRemoveFailed) $R9\uninstall.exe"
      Delete /REBOOTOK "$R9\uninstall.exe"
      SetRebootFlag true
      DetailPrint "$(legacyRemoveOnReboot) $R9\uninstall.exe"
      !insertmacro TT_MARK_SURVIVOR "$R9\uninstall.exe"
    ${EndIf}

    ; (b) The two shortcuts, which need a per-user context window of their own.
    ;     The legacy install was currentUser, so its shortcuts were written into
    ;     the INVOKING profile's Start Menu and Desktop. This installer runs with
    ;     SetShellVarContext all, under which $SMPROGRAMS and $DESKTOP name the
    ;     All-Users locations — where those shortcuts have never been. Same
    ;     wrapper, and the same reason, as the icon-cache deletes in POSTINSTALL.
    ;     The context is restored to all-users immediately: everything after this
    ;     hook (the template's own shortcuts, its registry writes) depends on it.
    ;
    ;     Same recorded limitation as POSTINSTALL, and it is not fixable here:
    ;     under UAC «current» is the ELEVATING administrator's profile, which need
    ;     not be the person installing. D-08 rejected recovering that identity —
    ;     every candidate is a heuristic sitting next to a destructive step. The
    ;     cost is a stale shortcut in one profile, not lost data.
    ;
    ;     THE RE-CHECKS LIVE INSIDE THE SAME CONTEXT WINDOW as the deletes they
    ;     verify, and they have to. `${FileExists} "$SMPROGRAMS\..."` resolved after
    ;     the context is restored asks about the ALL-USERS Start Menu — a folder the
    ;     legacy shortcut was never in — so it would answer "gone" every time and the
    ;     failure line could never print. A verification pointed at the wrong folder
    ;     is worse than none: it manufactures evidence.
    SetShellVarContext current
    DetailPrint "$(legacyRemoving) $SMPROGRAMS\${PRODUCTNAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      DetailPrint "$(legacyRemoveFailed) $SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete /REBOOTOK "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      SetRebootFlag true
      DetailPrint "$(legacyRemoveOnReboot) $SMPROGRAMS\${PRODUCTNAME}.lnk"
      !insertmacro TT_MARK_SURVIVOR "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    DetailPrint "$(legacyRemoving) $DESKTOP\${PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      DetailPrint "$(legacyRemoveFailed) $DESKTOP\${PRODUCTNAME}.lnk"
      Delete /REBOOTOK "$DESKTOP\${PRODUCTNAME}.lnk"
      SetRebootFlag true
      DetailPrint "$(legacyRemoveOnReboot) $DESKTOP\${PRODUCTNAME}.lnk"
      !insertmacro TT_MARK_SURVIVOR "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    SetShellVarContext all

    ; (c) The Add/Remove-Programs entry, named in the USER hive explicitly.
    ;     The shell-context alias now means HKLM, and the legacy entry was never
    ;     written there — the same blindness that makes this whole macro
    ;     necessary. Left behind, this entry is not merely untidy: it points at
    ;     the legacy uninstall.exe, and that uninstaller deletes the data files
    ;     the folder now holds as the data root. Key path from the template's own
    ;     define rather than retyped.
    ;
    ;     THE RE-CHECK IS `EnumRegValue`, NOT `ReadRegStr`, and the choice is
    ;     load-bearing. `ReadRegStr` sets the error flag when the KEY is missing OR
    ;     the VALUE is — so reading the unnamed default value (which this key does
    ;     not carry) reports "gone" while the key is still sitting there, and the
    ;     failure line could never print. `EnumRegValue` at index 0 errors only when
    ;     the key answers with no values at all, which after a successful
    ;     `DeleteRegKey` is the same thing as the key being gone. The template writes
    ;     DisplayName, DisplayVersion and InstallLocation into this key, so a
    ;     surviving entry always has a value 0 to return.
    DetailPrint "$(legacyRemoving) HKCU\${UNINSTKEY}"
    DeleteRegKey HKCU "${UNINSTKEY}"
    ClearErrors
    EnumRegValue $R3 HKCU "${UNINSTKEY}" 0
    ${IfNot} ${Errors}
      DetailPrint "$(legacyRemoveFailed) HKCU\${UNINSTKEY}"
    ${EndIf}

    ; (d) Close by saying what SURVIVED, because that is the question the user
    ;     actually has while watching an installer delete things next to their
    ;     servers and saved passwords. The line that used to sit here said «nothing
    ;     has been removed», which was true of the log-only pass and is a lie now —
    ;     so it is gone rather than reworded. A key whose name says one thing while
    ;     its text says the opposite is exactly the drift the comments in this file
    ;     exist to prevent.
    ;
    ;     Nothing prints «removal complete». Absence of a failure line above IS the
    ;     success report, and it means something precisely because the failure line
    ;     would have printed. The app never claims what it did not do.
    DetailPrint "$(legacyDataKept)"
  ${EndIf}

  Pop $R3
  Pop $R4
  Pop $R5
  Pop $R6
  Pop $R7
  Pop $R8
  Pop $R9

!macroend


!macro NSIS_HOOK_POSTINSTALL

  ; ── THE MARKER DESCRIBES THIS INSTALL, OR IT DOES NOT EXIST ──────────────────
  ;
  ;    ITS PRESENCE IS THE SIGNAL, WHICH IS EXACTLY WHY A STALE ONE IS WORSE THAN
  ;    NONE. `TT_MARK_SURVIVOR` writes only inside a failure branch, so a clean
  ;    install writes nothing. But the file sits in $INSTDIR and survives an
  ;    upgrade: a machine where the PREVIOUS install had a survivor carries that
  ;    list into the NEXT install, and if this run had no survivor the application
  ;    would read the old one and report artifacts that went long ago. So a marker
  ;    this run did not write is removed, and the flag the write macro sets is what
  ;    tells the two apart.
  ;
  ;    WHY HERE AND NOT BEFORE THE ENUMERATION, WHICH IS WHERE THE PLAN ASKED FOR IT.
  ;    Measured, not assumed: a `Delete` of the marker inside `NSIS_HOOK_PREINSTALL`
  ;    turns `lifecycle.rs::every_artifact_the_pre_install_hook_removes_reports_what_
  ;    actually_happened` RED, because that arm asserts the set of things that macro
  ;    REMOVES equals the set it ANNOUNCES — the nine artifacts the owner read on his
  ;    own machine and approved. The marker is a tenth removal target there, and the
  ;    whole point of that arm is that a tenth cannot be added quietly. Weakening it
  ;    to admit this one file would trade a compiled review of a destructive list for
  ;    a diagnostic convenience, so the removal moved instead of the rule.
  ;
  ;    THE TIMING IS EQUIVALENT AND THE ORDER IS SAFE. This hook expands AFTER
  ;    `NSIS_HOOK_PREINSTALL` in the same install, so the flag already carries this
  ;    run's answer; and accumulation — the other half of what a pre-enumeration
  ;    delete would have bought — is closed at the other end, by the write macro's
  ;    truncate-on-first-survivor. What a run with survivors leaves behind therefore
  ;    describes that run and nothing else.
  ;
  ;    Instruction offsets: (1) StrCmp, +2 -> (3), skipping (2).
  StrCmp $TT_LEGACY_SURVIVOR_SEEN "1" +2            ; (1) this run wrote it -> keep, jump to (3)
    Delete "${TT_LEGACY_SURVIVOR_MARKER}"           ; (2) it belongs to an earlier install

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
  DetailPrint "$(installRefreshingIconCache)"
  nsExec::Exec 'ie4uinit.exe -ClearIconCache'
  nsExec::Exec 'ie4uinit.exe -show'

  ; ── $LOCALAPPDATA is NOT %LOCALAPPDATA% here. Read this before editing. ──────
  ;    Tauri's utils.nsh `SetContext` macro runs from .onInit and switches the
  ;    shell-variable context by install mode: `currentUser` -> current,
  ;    `perMachine` -> all. Since NSIS 3.02, $LOCALAPPDATA follows that context,
  ;    so under the perMachine mode this installer now uses it resolves to
  ;    %ProgramData% — a folder that holds no icon caches at all. The three
  ;    deletes below would silently stop doing anything: no error, no warning,
  ;    just a stale taskbar icon nobody can explain.
  ;
  ;    So the context is forced back to the invoking profile for exactly these
  ;    three lines and then restored to all-users, which is what the rest of the
  ;    installer (shortcuts, registry hive) expects. Do NOT tidy this wrapper
  ;    away — the statements it guards look profile-relative and are not.
  ;
  ;    Known limitation, recorded rather than hidden: under UAC elevation
  ;    "current" is the ELEVATING administrator's profile, not necessarily the
  ;    person installing. Recovering the pre-elevation user from inside the
  ;    installer is rejected (D-08) — every candidate is a heuristic next to a
  ;    destructive step. The worst case here is a cache refresh that misses,
  ;    which Windows completes on its own within hours; that is an acceptable
  ;    price for not guessing at identities.
  SetShellVarContext current
  Delete "$LOCALAPPDATA\IconCache.db"
  Delete "$LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache_*.db"
  Delete "$LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db"
  SetShellVarContext all

!macroend


; ── The INSTALL DIRECTORY. Must stay in lockstep with Rust. ───────────────────
;
;    THE DATA ROOT AND THE INSTALL DIRECTORY ARE TWO DIFFERENT PLACES. That is
;    new as of phase 32 and it is the single most important thing to know about
;    this file. Until then one noun served as both: the app installed under
;    %LOCALAPPDATA% and kept its data beside its own executable, so $INSTDIR
;    named both and this define was called TT_DATA_ROOT.
;
;    Now the install is perMachine, so the binaries live in Program Files —
;    whose ACL grants BUILTIN\Users read by inheritance over child objects.
;    Leaving the plaintext credential store there would let every account on the
;    machine read it. So Rust's `ssh::user_data_dir()` (see `src/ssh/mod.rs`)
;    now names %LOCALAPPDATA%\TrustTunnel Client Pro explicitly and no longer
;    derives anything from the executable's location.
;
;    WHAT FOLLOWS THE BINARIES: the sidecar pid file, and only it. It is process
;    state, not user data, and it must stay somewhere the UNINSTALLER can name —
;    see the PREUNINSTALL block below for why that has to be $INSTDIR.
;    WHAT DOES NOT: everything the user owns. This hook must never name the data
;    root, and it does not: NEVER write $LOCALAPPDATA into a define here. Under
;    perMachine that variable resolves to %ProgramData% (see the icon-cache
;    block above), so such a define would point at a folder nothing writes and
;    the pid read below would find nothing — the exact silent failure this
;    comment block exists to prevent.
;
;    The PID basename comes from `lifecycle::SIDECAR_PID_BASENAME`.
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
;    `include_str!`s THIS FILE and asserts the composed path appears verbatim
;    AND that Rust's pid directory really is the executable's own folder; a
;    companion test asserts the data root is NOT that folder, so the pre-32
;    identity cannot be quietly restored. Change one end and both go red.
!define TT_INSTALL_DIR "$INSTDIR"
!define TT_SIDECAR_PID_FILE "${TT_INSTALL_DIR}\.sidecar-pro.pid"

; ── THE SURVIVOR MARKER. Same root as the pid file, for the same recorded reason. ──
;
;    WHAT IT HOLDS. The paths of the legacy artifacts that survived their removal in
;    `NSIS_HOOK_PREINSTALL`, one per line, plain text. Nothing else. It is written only
;    when at least one artifact actually survived, so a clean install leaves no file at
;    all and its mere presence means something — see `TT_MARK_SURVIVOR` at the head of
;    this file for how that is kept true, and `NSIS_HOOK_POSTINSTALL` for how a marker
;    left by an EARLIER install is cleared.
;
;    WHY THE INSTALL DIRECTORY, AND NOT THE DATA ROOT. The same argument the pid file
;    above makes, and it is not weakened by this being a diagnostic file rather than
;    process state. Under perMachine $LOCALAPPDATA resolves to %ProgramData% (see the
;    icon-cache block), and forcing the per-user context back on resolves the ELEVATING
;    administrator's profile, which under UAC need not be the person installing — D-08
;    rejected recovering that identity. $INSTDIR is the one root that resolves correctly
;    whichever account UAC elevated this process to, and it is where the application
;    that reads this file already is. NEVER write $LOCALAPPDATA into a define here; the
;    block above states why in full and that rule does not bend for a diagnostic.
;
;    WHAT MAY GO IN IT, AND WHAT MAY NOT. Only paths drawn from the closed allow-list of
;    binaries and shortcuts the enumeration already names — no credential, no user name
;    beyond what such a path already carries, and no data filename. The program folder
;    grants BUILTIN\Users read by inheritance, so anything written here is readable by
;    every account on the machine, which is precisely why nothing else may go in it.
;    `lifecycle.rs::the_pre_install_hook_never_names_a_file_the_user_owns` scans the
;    marker-write call sites against the same `USER_DATA` list that guards the removals,
;    so a data filename reaching this file is caught by the list that already exists
;    rather than by a second copy of it.
;
;    THE BASENAME IS NOT YET PINNED FROM RUST, and that is a stated residual rather than
;    an oversight: nothing in the application reads this file yet. When the reader lands
;    (32-FIX-11) the basename moves to a Rust constant and acquires the same two-ended
;    agreement the pid path has, for the same reason — two ends that can drift in silence
;    is how the pid kill became a no-op for months (D-07).
!define TT_LEGACY_SURVIVOR_MARKER_BASENAME ".legacy-survivors.txt"
!define TT_LEGACY_SURVIVOR_MARKER "${TT_INSTALL_DIR}\${TT_LEGACY_SURVIVOR_MARKER_BASENAME}"

; ── THE DATA-ROOT RECORD. Same root as the two files above, for their reason. ──
;
;    WHAT IT HOLDS. One line, and only one: the absolute path of the folder THIS
;    installation keeps the user's data in. The application writes it beside its own
;    binaries on every start (`lifecycle::record_data_root_on_startup`). Nothing else
;    ever goes in it — no credential, no key, no host, no filename the user chose.
;
;    WHY THE APPLICATION HAS TO BE THE ONE THAT WRITES IT, and this is the whole point
;    of the file. The data folder is under the profile of whichever account approved the
;    APPLICATION's elevation prompt (`trusttunnel.exe.manifest:18` asks for
;    administrator, so under over-the-shoulder UAC that is the supplying administrator
;    and not the person at the keyboard). This uninstaller asks for the same rights and
;    gets its OWN answer to «my profile», which need not be that account; and Windows
;    will not tell an elevated process which account owns another elevated process's
;    data. So the side that KNOWS records the fact, and the side that NEEDS it reads the
;    note back — and refuses on any mismatch with its own profile. No identity is
;    recovered anywhere, which is how D-08 is honoured here rather than evaded.
;    Owner decision `D32-16` = `route-record`, 2026-09-06.
;
;    IT IS INPUT, NEVER INSTRUCTION. This file sits in the program folder, whose ACL
;    grants BUILTIN\Users read by inheritance; the default ACL grants WRITE to
;    Administrators and SYSTEM only, so a standard user cannot author it — but that is
;    a reason to validate it, not a reason to trust it. Every rung of the ladder in
;    NSIS_HOOK_POSTUNINSTALL below runs before the value reaches anything (T-32-56).
;
;    THE BASENAME IS PINNED FROM RUST, at compile time, exactly like the pid path:
;    `lifecycle::DATA_ROOT_RECORD_BASENAME` composes the expected line and
;    `lifecycle.rs::the_uninstall_hook_reads_the_data_root_record_the_app_writes`
;    `include_str!`s THIS FILE and asserts it appears verbatim. Change either end and
;    the test goes red. That mechanism is not decoration here: this is the file a later
;    plan hands to a recursive delete, so a drift would not merely lose a function, it
;    would aim one.
!define TT_DATA_ROOT_RECORD_BASENAME ".data-root-pro.txt"
!define TT_DATA_ROOT_RECORD "${TT_INSTALL_DIR}\${TT_DATA_ROOT_RECORD_BASENAME}"

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
    nsExec::Exec 'taskkill /F /PID $R0'
  Sleep 500

!macroend


!macro NSIS_HOOK_POSTUNINSTALL

  ; ── At this point Tauri has already: ───────────────────────────
  ;    - Asked user to close the app (or killed it)
  ;    - Deleted its own installed files
  ;    - Removed uninstall registry keys
  ;    So we clean up everything that Tauri doesn't know about.

  ; ── 2. The user's data is KEPT by default, with ONE explicit exception. ───
  ;
  ;    THE DEFAULT IS UNCHANGED AND UNCONDITIONAL: nothing in this macro deletes
  ;    user data. An UPDATE runs this uninstaller. Deleting the user's servers,
  ;    saved passwords, known hosts and routing rules as an invisible side effect
  ;    of "update" is not a cleanup, it is data loss with a progress bar.
  ;
  ;    THIS WAS A REAL BUG, FOR YEARS. Until phase 30.1 this macro deleted
  ;    ssh_credentials.json, known_hosts.json, routing_rules.json,
  ;    exclusions.json, active_groups.json, connection_history.json,
  ;    trusttunnel_client.toml and the webview_data / geodata / resolved /
  ;    group_cache folders UNCONDITIONALLY, on every uninstall — so every routine
  ;    update silently wiped the user's stored SSH passwords and routing rules.
  ;    The server list survived only by accident: configs.json and the per-server
  ;    .toml files were never in that list. The whole list is gone, and it is not
  ;    coming back: the exception below is a BRANCH the user has to tick a box to
  ;    enter, never a list of names quietly appended to a cleanup.
  ;
  ;    THE ONE EXCEPTION, and it is LIVE since 32-FIX-16 — named here so the
  ;    default above keeps meaning what it says. When, and only when, BOTH of the
  ;    following hold, the region marked TT_ERASE_DATA_ROOT below resolves which
  ;    folder holds this installation's data, announces it, and removes it:
  ;      - the person uninstalling ticked the erase checkbox on the confirm page,
  ;        and
  ;      - this is not a `uninstall.exe /UPDATE` run.
  ;    Both conditions are the region's FIRST TWO STATEMENTS, as one conjunction
  ;    with nothing between them, and `lifecycle.rs::the_uninstaller_never_deletes_user_data`
  ;    asserts that shape from this file's own text. It also forbids a removal
  ;    naming the resolved data root ANYWHERE ELSE in this file — because the old
  ;    version of that rule only examined removals naming an install-directory
  ;    spelling, and would have waved a data-root removal through without a word.
  ;
  ;    IT WAS NOT ARMED UNTIL A HUMAN HAD READ THE PATH. 32-FIX-15 shipped this
  ;    region log-only, that build was run (label y4kwqh) on a real disk and
  ;    confirmed the announced folder was the one the saved configs and passwords
  ;    are really in, and only then did 32-FIX-16 turn the removal on. Same
  ;    sequence 32-02 → 32-06 used for the legacy removal, and for the same reason:
  ;    there is no rehearsal machine for this.
  ;
  ;    WHY THE REGION CARRIES ITS OWN CONDITIONS RATHER THAN INHERITING THEM. The
  ;    template's own erasure sits inside a two-condition guard that CLOSES two
  ;    lines before this hook is inserted (emitted script :821 vs :823-825), so
  ;    the body of this macro runs on EVERY uninstall. Position in the file is not
  ;    a guard, and Tauri rewrites that script on every build.
  ;
  ;    Everything else removed below is genuinely install-scoped: registry keys
  ;    the app wrote at runtime, temp files from the updater, and the pid file
  ;    (a process id from a boot that is over).
  ;
  ;    THE UNCONDITIONAL "delete the old data root" STEP STILL DOES NOT EXIST, and
  ;    must never. Two separate reasons, both fatal on their own:
  ;      1. the data root is a place this hook cannot NAME from its own variables
  ;         (see the define block above) — hence the record the application
  ;         writes, and hence a ladder that refuses rather than guesses;
  ;      2. on every machine installed before phase 32 that folder IS $INSTDIR,
  ;         because the app used to install there. An uninstaller that swept the
  ;         install directory would take the servers, the saved passwords and
  ;         the known hosts with it — during what the user experiences as an
  ;         update.
  ;
  ;    THE ANNOUNCEMENT BELOW IS GUARDED, AND UNTIL 32-FIX-18 IT WAS NOT. It stood
  ;    unconditionally, eight lines above the region that erases the data, so the
  ;    owner's pass-4 log read, verbatim: "Keeping user data", then the removal of
  ;    the pid file, then "Removing the data folder of this installation: ...". The
  ;    behaviour was correct throughout; the SENTENCE was a lie, printed in the one
  ;    window a person reads to learn what just happened to their saved passwords.
  ;    That is G-32-7, and it is a defect of wording only: nothing below moved.
  ;
  ;    THE GUARD IS THE EXACT COMPLEMENT OF THE REGION'S CONJUNCTION, by De Morgan:
  ;    NOT (ticked AND not-updating) is (not ticked) OR (updating). It is written on
  ;    the same two variables the region tests and on no others, so the two branches
  ;    partition every uninstall between them and exactly one of them speaks.
  ;
  ;    IT MUST STAY "OrIf", NOT "AndIf". With AndIf the line would print only when
  ;    the box was unticked AND the run was a manual /UPDATE - i.e. almost never -
  ;    and the ordinary unticked uninstall, which is the whole case the sentence
  ;    exists for, would say nothing at all. It would also be wrong during a silent
  ;    in-app update: 32-FIX-14 measured that $DeleteAppDataCheckboxState is never
  ;    ASSIGNED on a /S run (the confirm page never runs), so it is 0 there and the
  ;    first disjunct is what carries the update case.
  ;
  ;    `lifecycle.rs::the_kept_data_announcement_prints_only_where_the_data_is_kept`
  ;    DERIVES this guard from the region's own conditions rather than repeating
  ;    them, so editing one of those conditions without editing this one reddens
  ;    that contract instead of quietly restoring the lie.
  ${If} $DeleteAppDataCheckboxState <> 1
  ${OrIf} $UpdateMode = 1
    DetailPrint "$(uninstallDataKept)"
  ${EndIf}
  Delete "${TT_SIDECAR_PID_FILE}"
  ; The survivor marker goes with it, and for the same reason: it is INSTALL STATE, not
  ; user data — a list of the previous install's own binaries that a removal could not
  ; take. Leaving it behind would hand the next install a report about a machine that no
  ; longer exists.
  Delete "${TT_LEGACY_SURVIVOR_MARKER}"

  ; ── BEGIN REGION TT_ERASE_DATA_ROOT ──────────────────────────────────────────
  ;
  ;    WHAT THIS REGION DOES: it works out which folder holds this installation's
  ;    data, announces it, and REMOVES IT RECURSIVELY, running as Administrator.
  ;    That is the most destructive statement this product ships, and everything
  ;    above it in this region exists to make the path it is aimed at trustworthy.
  ;
  ;    WHY IT MAY DO THAT AT ALL. The owner ticked a box captioned «убрать остатки»
  ;    and got a folder still full of the saved configs and passwords, and said what
  ;    he expects of it in one line: «галочка должна работать как "Удалить
  ;    полностью"». 32-FIX-15 shipped this region log-only; that build was run (label
  ;    y4kwqh) on a real disk and confirmed the announced folder was the one his
  ;    data is really in; 32-FIX-16 then armed it. Same sequence the legacy removal
  ;    used (32-02 log-only → owner read the list → 32-06 armed it), for the same
  ;    reason: there is no rehearsal machine, and the only disk this runs on is a
  ;    live one.
  ;
  ;    THE CANDIDATE LIVES IN $R8, NOT $R9, AND THAT IS NOT COSMETIC. In
  ;    `NSIS_HOOK_PREINSTALL` $R9 holds the DISCOVERED LEGACY INSTALL PATH, and
  ;    `remediation-hygiene.sh` rule 12 forbids `RMDir /r "$R9"` across this whole
  ;    file — because on every pre-32 machine that folder is the user's data root.
  ;    That gate scans statements file-wide and cannot tell two meanings of one
  ;    register apart, so an erasure written on $R9 would be indistinguishable from
  ;    the single worst line this installer could contain. The data root gets its own
  ;    name instead of the gate getting an exception: rule 12 keeps its full strength
  ;    over the legacy path, and the Rust guard watches $R8.
  ;
  ;    THE TWO CONDITIONS ARE THE REGION'S FIRST TWO STATEMENTS, as one conjunction,
  ;    with nothing between them — because this same uninstaller executable also runs
  ;    when a person chooses «сначала удалить» on the way to installing another
  ;    version, and getting this wrong wipes a live user's servers and saved passwords
  ;    in the middle of what they experience as maintenance. This project did exactly
  ;    that, for years, before phase 30.1 (see the block above).
  ;
  ;    WHAT EACH CONDITION ACTUALLY BUYS, measured in 32-FIX-14 rather than assumed —
  ;    and the second one is NOT what protects an in-app update:
  ;      - $DeleteAppDataCheckboxState is assigned in exactly ONE place, the confirm
  ;        page's leave function (emitted script :434). No confirm page, no assignment,
  ;        so it is 0 on every path that shows no pages. This is the condition that
  ;        actually holds during an update.
  ;      - $UpdateMode <> 1 guards only a MANUALLY invoked `uninstall.exe /UPDATE`.
  ;        During a real in-app update it is 0 anyway: `updater.rs:159` launches the
  ;        installer as `"<setup>" /S`, the string `/UPDATE` appears zero times in that
  ;        file, and a silent installer shows no pages — so the reinstall page never
  ;        runs and `uninstall.exe` is never started at all. Keep the condition; it
  ;        costs nothing and it is correct. Do NOT call it «the update guard».
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1

    Push $0
    Push $R8
    Push $R7
    Push $R6
    Push $R5
    Push $R4
    Push $R3

    ; $R8 carries the candidate folder, $R7 carries which rung refused. Every rung
    ; BLANKS the candidate and names itself rather than jumping — the same discipline
    ; the pre-install ladder states and for its reason: a `Return` inside a hook macro
    ; returns from the whole uninstall section, and a label would collide if the macro
    ; were ever inserted twice. A refusal short-circuits the remaining rungs by failing
    ; their one guard, so «unclear» and «refused» behave identically, which is the
    ; behaviour a destructive step needs.
    StrCpy $R8 ""
    StrCpy $R7 ""

    ; (1) There must be an interactive desktop at all. A zero answer means a silent or
    ;     automated run with nobody at the keyboard, and this branch is only ever
    ;     entered by a person ticking a box. Existence is ALL that is read here —
    ;     nothing is derived from the window's owner, so no identity crosses this
    ;     boundary (T-32-58). A refusal here is safe; a guess is not.
    ${If} $R7 == ""
      System::Call 'user32::GetShellWindow()i .r0'
      ${If} $0 = 0
        StrCpy $R7 "desktop"
      ${EndIf}
    ${EndIf}

    ; (2) Read the note the application writes beside the binaries. No note means the
    ;     program was never started after it was installed — which means there is no
    ;     data root to remove. Refuse and say so.
    ${If} $R7 == ""
      ${If} ${FileExists} "${TT_DATA_ROOT_RECORD}"
        ClearErrors
        FileOpen $R5 "${TT_DATA_ROOT_RECORD}" r
        ${IfNot} ${Errors}
          FileRead $R5 $R8
          FileClose $R5
        ${EndIf}
      ${EndIf}
      ${If} $R8 == ""
        StrCpy $R7 "norecord"
      ${EndIf}
    ${EndIf}

    ; (3) Strip the line terminator and any trailing blanks, then a trailing separator,
    ;     so a note stored as "C:\dir\" compares and composes exactly like "C:\dir" —
    ;     the same normalisation the pre-install ladder performs on its registry value.
    ${If} $R7 == ""
      ${Do}
        StrCpy $R6 $R8 1 -1
        ${If} $R6 != "$\r"
        ${AndIf} $R6 != "$\n"
        ${AndIf} $R6 != " "
        ${AndIf} $R6 != "$\t"
          ${ExitDo}
        ${EndIf}
        StrCpy $R8 $R8 -1
        ${If} $R8 == ""
          ${ExitDo}
        ${EndIf}
      ${Loop}
      StrCpy $R6 $R8 1 -1
      ${If} $R6 == "\"
        StrCpy $R8 $R8 -1
      ${EndIf}
      ${If} $R8 == ""
        StrCpy $R7 "invalid"
      ${EndIf}
    ${EndIf}

    ; (4) It must be an absolute path with a drive letter. Length < 4 rejects a bare
    ;     drive root, and requiring the drive letter refuses a \\server\share outright
    ;     — an elevated uninstaller must not follow a network path it was handed by a
    ;     file, on the same ground the pre-install ladder states.
    ${If} $R7 == ""
      StrCpy $R6 $R8 1 1
      StrCpy $R5 $R8 1 2
      StrLen $R4 $R8
      ${If} $R6 != ":"
      ${OrIf} $R5 != "\"
      ${OrIf} $R4 < 4
        StrCpy $R8 ""
        StrCpy $R7 "invalid"
      ${EndIf}
    ${EndIf}

    ; (5) It must not name a filesystem or system root. The same list the pre-install
    ;     ladder carries, and defence in depth for the same reason: rungs (6) and (7)
    ;     below already refuse every one of these, but a destructive step should fail
    ;     early and legibly rather than only by a side effect of a later check.
    ${If} $R7 == ""
      ${If} $R8 == "$WINDIR"
      ${OrIf} $R8 == "$SYSDIR"
      ${OrIf} $R8 == "$PROGRAMFILES"
      ${OrIf} $R8 == "$PROGRAMFILES64"
      ${OrIf} $R8 == "$COMMONFILES"
      ${OrIf} $R8 == "$COMMONFILES64"
      ${OrIf} $R8 == "$PROFILE"
      ${OrIf} $R8 == "$APPDATA"
      ${OrIf} $R8 == "$LOCALAPPDATA"
      ${OrIf} $R8 == "$DESKTOP"
      ${OrIf} $R8 == "$DOCUMENTS"
      ${OrIf} $R8 == "$TEMP"
      ${OrIf} $R8 == "$INSTDIR"
        StrCpy $R8 ""
        StrCpy $R7 "invalid"
      ${EndIf}
    ${EndIf}

    ; (6) THE RUNG WITH TEETH. The path must END with a separator followed by our own
    ;     product folder name. That ties the note to this product from both ends: Rust
    ;     composes the data root as <local-app-data>\${PRODUCTNAME} (the constant
    ;     `ssh::PRODUCT_DATA_FOLDER`, pinned to this define by
    ;     `lifecycle.rs::the_product_folder_the_uninstaller_matches_is_the_one_rust_composes`),
    ;     so a note naming any other folder is refused rather than obeyed — however it
    ;     came to say that.
    ${If} $R7 == ""
      StrLen $R4 "\${PRODUCTNAME}"
      IntOp $R3 0 - $R4
      StrCpy $R6 $R8 $R4 $R3
      ${If} $R6 != "\${PRODUCTNAME}"
        StrCpy $R8 ""
        StrCpy $R7 "invalid"
      ${EndIf}
    ${EndIf}

    ; (7) It must lie INSIDE the profile directory of the account performing THIS
    ;     uninstall. This is where the scope decision is enforced rather than
    ;     described: the uninstalling user's profile and no other, with no enumeration
    ;     of C:\Users and no attempt to recover anybody's identity. The note supplies
    ;     one fact and this rung checks it against a second, independent one; a
    ;     mismatch is a refusal, never a substitution.
    ${If} $R7 == ""
      SetShellVarContext current
      StrLen $R4 "$PROFILE"
      StrCpy $R6 $R8 $R4
      StrCpy $R5 $R8 1 $R4
      ${If} $R6 != "$PROFILE"
      ${OrIf} $R5 != "\"
        StrCpy $R8 ""
        StrCpy $R7 "otheruser"
      ${EndIf}
      SetShellVarContext all
    ${EndIf}

    ; (8) The target must not be a reparse point. A directory junction planted at that
    ;     path would redirect an administrator-privileged recursive delete straight out
    ;     of the profile — into the system directory, if that is where it pointed. This
    ;     rung is the only thing standing between that and the disk, so it REFUSES
    ;     rather than follows: there is no safe way to follow one (T-32-57). An
    ;     unreadable attribute answer (-1, i.e. the folder is not there) is refused on
    ;     the same line, because a path that cannot be examined cannot be erased either.
    ${If} $R7 == ""
      System::Call 'kernel32::GetFileAttributesW(w "$R8")i .r0'
      ${If} $0 = -1
        StrCpy $R8 ""
        StrCpy $R7 "invalid"
      ${Else}
        IntOp $R6 $0 & 0x400
        ${If} $R6 <> 0
          StrCpy $R8 ""
          StrCpy $R7 "invalid"
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ; Say what was resolved, or say exactly which rung refused and nothing else. Each
    ; refusal has its own line so a person reading the details pane — or a log pasted
    ; into a bug report — can tell them apart without guessing.
    ;
    ; ANNOUNCE BEFORE REMOVING, AND NAME THE PATH. The details pane opens itself since
    ; 32-FIX-07, so this line is READ while it happens rather than reconstructed after.
    ; It is also the only record of what an administrator-privileged recursive delete
    ; was aimed at, which is why the path is printed rather than merely implied.
    ;
    ; THEN LOOK AGAIN. `RMDir /r` on a folder holding an open file fails SILENTLY —
    ; no error, no line, the uninstall walks on — and the browser profile under
    ; webview_data is exactly the kind of thing another process can still have open.
    ; So the removal is followed by a second look, and the two outcomes get different
    ; lines. That asymmetry is the pre-install pass's discipline (unconditional going
    ; in, checked coming out) applied where the stakes are highest; a pane printing the
    ; same line whether or not the folder went would be the program claiming what it
    ; did not do.
    ${If} $R7 == ""
      DetailPrint "$(eraseDataRootResolved) $R8"
      RMDir /r "$R8"
      ${If} ${FileExists} "$R8"
        DetailPrint "$(eraseDataRootPartial) $R8"
      ${Else}
        DetailPrint "$(eraseDataRootRemoved)"
      ${EndIf}

      ; ── The framework's bundle-identifier folder, in THIS person's profile ──
      ;
      ;    WHAT IT IS. Tauri creates <local-app-data>\${BUNDLEID} on every start and
      ;    this product never writes anything into it — our Rust names the identifier
      ;    nowhere (measured: `app_local_data_dir` / `app_data_dir` have no call site
      ;    that resolves it). It is an empty folder, but it is a TRACE, and «Удалить
      ;    полностью» means no trace.
      ;
      ;    WHY IT IS COMPOSED FROM $R8 AND NOT FROM $LOCALAPPDATA, which is the obvious
      ;    spelling and is the one the template itself uses two lines above this hook.
      ;    This uninstaller runs elevated; `SetShellVarContext current` then resolves the
      ;    profile of whichever administrator approved the elevation prompt, which under
      ;    over-the-shoulder UAC need not be the person uninstalling (D-08). On the
      ;    a real machine all three identities coincide, so the template's line happens
      ;    to hit the right folder — that is a property of that machine and not of the
      ;    code, and 32-ERASURE-EVIDENCE.md (c) says so. $R8 came from a note the
      ;    APPLICATION wrote, running as the person himself, and rung 7 already checked
      ;    it against the uninstalling profile. So the parent of $R8 is this person's
      ;    local app data by construction rather than by a guess.
      ;
      ;    DO NOT «SIMPLIFY» THIS BACK to $LOCALAPPDATA. It would look identical on this
      ;    machine and be wrong on a machine where the two accounts differ — and being
      ;    wrong here means an administrator-privileged recursive delete in the wrong
      ;    profile.
      ;
      ;    Rung 6 has already required that $R8 ends with "\${PRODUCTNAME}", so removing
      ;    exactly that many trailing characters is an exact operation, not a heuristic.
      StrLen $R4 "\${PRODUCTNAME}"
      IntOp $R4 0 - $R4
      StrCpy $R6 $R8 $R4
      RMDir /r "$R6\${BUNDLEID}"

      ; THE ROAMING TWIN ($APPDATA\${BUNDLEID}) GETS NO LINE HERE, and that is measured
      ; rather than forgotten: 32-ERASURE-EVIDENCE.md (c) found it ABSENT on this machine
      ; and nothing this product runs recreates it, while the template's own erasure —
      ; which runs two lines before this hook, under the same two conditions — already
      ; names it. A roaming path cannot be composed from $R8 either: roaming and local are
      ; different roots, and inventing one from the other would be the guess this whole
      ; region exists to avoid.
    ${ElseIf} $R7 == "desktop"
      DetailPrint "$(eraseNoInteractiveDesktop)"
    ${ElseIf} $R7 == "norecord"
      DetailPrint "$(eraseNoRecord)"
    ${ElseIf} $R7 == "otheruser"
      DetailPrint "$(eraseOtherProfile)"
    ${Else}
      DetailPrint "$(eraseRefusedPath)"
    ${EndIf}

    ; ── The stale per-user product key ──────────────────────────────────────────
    ;
    ;    IT IS OURS, IT IS THIS EDITION'S, AND IT SURVIVES THE TEMPLATE. The emitted
    ;    script removes `${MANUPRODUCTKEY}` under SHCTX (HKLM, per-machine) and then
    ;    tries HKCU with `/ifempty` — which does nothing here, because the HKCU copy
    ;    still carries a default value and an «Installer Language» value. Measured on
    ;    2026-09-06: `HKCU\Software\trusttunnel\TrustTunnel Client Pro` holds two
    ;    values, its default pointing at the pre-relocation data root
    ;    (32-ERASURE-EVIDENCE.md (e), finding 2). So it is a leftover of THIS user's
    ;    Pro installation, and «Удалить полностью» has to take it.
    ;
    ;    THE PARENT `Software\trusttunnel` IS NOT TOUCHED. The other edition keeps its
    ;    own subkey under it, and the template already tried `/ifempty` on the parent
    ;    two lines before this hook — which is the correct behaviour: it goes when it
    ;    is empty and stays while Light is there.
    ;
    ;    THE BARE `HKCU\Software\trusttunnel\TrustTunnel` KEY IS A DELIBERATE RESIDUAL.
    ;    It is empty (no subkeys, one blank default) and it predates the Pro/Light
    ;    split, so it cannot be attributed to this edition rather than the other. It
    ;    carries nothing and starts nothing; guessing whose it is, next to a deletion,
    ;    is the class of guess this region refuses everywhere else.
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"

    Pop $R3
    Pop $R4
    Pop $R5
    Pop $R6
    Pop $R7
    Pop $R8
    Pop $0

  ${EndIf}
  ; ── END REGION TT_ERASE_DATA_ROOT ────────────────────────────────────────────

  ; The data-root note goes the same way the pid file and the survivor marker do: it is
  ; INSTALL STATE, not user data — one line naming a folder, written by the application
  ; beside its own binaries. AFTER the region, never before: the region READS it, and a
  ; removal placed above would leave the erasure with nothing to resolve. 32-FIX-15
  ; deliberately wrote no removal at all and handed this ordering to 32-FIX-16.
  Delete "${TT_DATA_ROOT_RECORD}"

  ; ── 3. Clean up registry ──────────────────────────────────────
  DetailPrint "$(uninstallCleaningRegistry)"

  ; ── URL protocol handlers (created at runtime by protocol.rs) ─────────────────
  ;
  ;    THESE TWO KEYS ARE SHARED WITH THE OTHER EDITION, AND UNTIL 32-FIX-16 THIS
  ;    UNINSTALLER TOOK THEM UNCONDITIONALLY. Both Pro and Light register the same two
  ;    schemes into the same per-user hive under the same two names, so uninstalling
  ;    Pro on a machine that still had Light silently broke Light's trusttunnel:// and
  ;    tt:// handling. That is `T-24`, and it was measured live on a real disk
  ;    — both keys present, Light installed per-user — in 32-ERASURE-EVIDENCE.md (e).
  ;    A defect, not a risk.
  ;
  ;    SO: PROBE FIRST, AND SKIP BOTH KEYS WHEN THE OTHER EDITION IS THERE. The probe
  ;    reads the other edition's programs-list entry, under BOTH hives, because the two
  ;    editions install differently — Light is per-user (HKCU), Pro is per-machine
  ;    (HKLM) — and a future Light could change. `utils.nsh` puts this process into the
  ;    64-bit registry view on x64, which is the same view the installer's own uninstall
  ;    entry is written to, so the HKLM read looks where the entry would actually be.
  ;
  ;    THIS IS THE ONE PLACE IN THIS FILE THAT NAMES THE OTHER EDITION ON PURPOSE. The
  ;    pre-install macro must name it NOWHERE (see the standing note there); here the
  ;    whole point is to recognise it and stand down.
  ;
  ;    `lifecycle.rs::the_uninstaller_spares_the_other_edition_s_scheme_keys` asserts
  ;    from this file's text that neither removal appears without a preceding probe
  ;    naming the other edition, AND that the removals are gated on it — a probe whose
  ;    answer nothing branches on is a read with no effect.
  Push $R0
  StrCpy $R0 ""
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TrustTunnel Client Light" "DisplayName"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\TrustTunnel Client Light" "DisplayName"
  ${EndIf}
  ${If} $R0 == ""
    DeleteRegKey HKCU "Software\Classes\trusttunnel"
    DeleteRegKey HKCU "Software\Classes\tt"
  ${Else}
    DetailPrint "$(uninstallSchemeKeysKept)"
  ${EndIf}
  Pop $R0

  ; ── Autostart entries (all possible name variants) ────────────────────────────
  ;
  ;    THESE FIVE RUN ON EVERY UNINSTALL AND THAT IS CORRECT: they are values this
  ;    product wrote into the user's own Run key, and removing a value it did not
  ;    write is a no-op. They are NOT gated on the checkbox because an orphaned
  ;    autostart entry pointing at a deleted executable is not «the user's data», it
  ;    is a broken registration left by us.
  ;
  ;    THE DISABLE-STATE ENTRIES EXPLORER WRITES GET NO LINE, AND THAT IS MEASURED.
  ;    When a person switches a startup item off in Task Manager, Explorer records it
  ;    under ...\Explorer\StartupApproved\Run (and \StartupFolder for shortcuts).
  ;    Read on 2026-09-07, on a real Windows install: 17 values under StartupApproved\Run
  ;    and 3 under StartupApproved\StartupFolder, and NOT ONE of them names this
  ;    product or the other edition. So there is nothing to remove, and a removal line
  ;    for it would be a statement that can never execute on any machine this product
  ;    has touched — which this file's own doctrine treats as worse than an absent
  ;    step, because unreachable code beside a destructive one reads as coverage.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TrustTunnel"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TrustTunnel Client Pro"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TrustTunnel Client Light"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "trusttunnel"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "trusttunnel-light"

  ; ── 4. Remove the logon Scheduled Task ────────────────────────
  ;
  ;    WHY THIS IS NOT HOUSEKEEPING. «Запуск вместе с Windows» is a logon Scheduled
  ;    Task registered with TASK_RUNLEVEL_HIGHEST (see `task_scheduler.rs`). Left
  ;    behind by an uninstall it is a HIGHEST-PRIVILEGES run registration pointing
  ;    at an executable this uninstaller has just deleted — an orphaned elevated
  ;    entry aimed at a path in a directory the removal may leave writable. That is
  ;    the mirror image of the elevation hazard the per-machine relocation closes,
  ;    so it ships in the same release as the task itself rather than after it.
  ;
  ;    The registry block below deletes the LEGACY autostart values under ...\Run.
  ;    Those are the mechanism this task REPLACED; both cleanups are needed, because
  ;    a machine that updates from an older build carries the old values and the new
  ;    task at once.
  ;
  ;    A COMMAND-LINE DELETION IS ACCEPTABLE HERE, AND ONLY HERE. The project
  ;    prohibition is on PARSING console output — Windows localizes tool output and
  ;    the console code page is not the process code page, so a parser built against
  ;    one machine's language mis-reads another's. A deletion needs no output at all:
  ;    it either happened or the task was already absent, and «absent is a valid
  ;    requested state» is settled practice in this codebase. So `/F` forces it and
  ;    NOTHING here reads, pops or branches on the result. The capturing form —
  ;    `ExecToStack` — is refused by a compiled test
  ;    (`lifecycle.rs::the_uninstall_macros_never_branch_on_a_tool_s_output`).
  ;
  ;    AND NOTHING HERE SHOWS THE TOOL'S OUTPUT EITHER, WHICH IS NEW IN 32-FIX-16 AND
  ;    IS A DEFECT WAS READ OFF A REAL SCREEN. These two calls used the LOGGING
  ;    variant of `nsExec::Exec`, which copies the child process's console bytes
  ;    straight into the details window. `schtasks` reported — correctly, and
  ;    harmlessly — that the task it was told to delete did not exist; but it reported
  ;    it in console code page 866, and the details window renders code page 1251. Same
  ;    bytes, different alphabet. Two identical lines of unreadable characters appeared in
  ;    the middle of an uninstall he was asked to inspect (G-32-4).
  ;
  ;    The fix is not to translate Microsoft's message and not to convert code pages
  ;    inside NSIS — we control our own strings and we do not control theirs. The calls
  ;    are made with the plain form, whose output goes nowhere, and the OUTCOME is
  ;    announced by a `LangString` of ours. Which outcome is decided by OUR OWN
  ;    measurement, taken BEFORE the deletion, against the scheduler's own storage —
  ;    not by reading, popping or branching on what `schtasks` said. That distinction
  ;    is what keeps the rule above intact rather than bent.
  ;
  ;    THE PROBE NEEDS 64-BIT FILE PATHS. This uninstaller is a 32-bit process, so
  ;    `$WINDIR\System32` is redirected to `SysWOW64` underneath it and the registered
  ;    tasks would be invisible. `${DisableX64FSRedirection}` (from `x64.nsh`, which
  ;    the emitted script includes) turns that off for the two reads and it is turned
  ;    straight back on.
  ;
  ;    NO COMPONENT-OBJECT CALL. The application talks to the scheduler through the
  ;    interface because it must READ the enabled bit off a registered task, and a
  ;    column position in localized console output is the wrong way to learn that.
  ;    The uninstaller reads nothing. It is a script; the read that justified the
  ;    interface is the application's, not this one's.
  ;
  ;    TWO STATEMENTS, BECAUSE THERE ARE TWO POPULATIONS.
  ;
  ;    (a) THE PER-USER FOLDER. The install is per-machine, so one task name would
  ;        be one registration shared by everybody on the machine — the last person
  ;        to touch the switch would own it and everyone else would read ON while
  ;        nothing started at their logon. Registrations are therefore scoped by the
  ;        user's SID inside a product folder, and there is no single name for this
  ;        teardown to spell. The `\*` wildcard removes the folder's whole contents
  ;        in one statement, which is precisely why a FOLDER was chosen over a name
  ;        prefix: `schtasks` has no prefix match, and `/TN *` would delete every
  ;        task on the machine. The wildcard reaches exactly ONE level, and the
  ;        compiled contract at the other end asserts the registration never nests
  ;        deeper than that.
  ;
  ;        The empty folder itself survives — `schtasks` cannot remove one, and
  ;        deleting `%WINDIR%\System32\Tasks\<folder>` by hand would leave the
  ;        scheduler's TaskCache registry entries dangling. An empty folder carries
  ;        no privileges and starts nothing; a corrupted TaskCache would be a real
  ;        defect. This is the deliberate residue, named so nobody "fixes" it.
  ;
  ;    (b) THE LEGACY GLOBAL TASK. Builds before the per-user split registered one
  ;        machine-wide task in the scheduler's ROOT. That is OUTSIDE the folder
  ;        swept by (a), so without this second line the uninstaller would leave
  ;        exactly the orphan this whole block exists to prevent — on precisely the
  ;        machines that tested the feature before it was fixed.
  ;
  ;    BOTH STRINGS ARE PINNED FROM BOTH ENDS, at compile time, exactly like the pid
  ;    path above: `lifecycle.rs::the_uninstaller_removes_the_logon_task_the_app_registers`
  ;    `include_str!`s THIS FILE and asserts both appear verbatim, COMPOSED from
  ;    `task_scheduler::AUTOSTART_TASK_FOLDER` and `::LEGACY_AUTOSTART_TASK_NAME`
  ;    rather than retyped. They have to be, because a mismatch is silent: a teardown
  ;    naming a task that does not exist finds nothing and reports nothing, which
  ;    looks identical to a teardown that had nothing to do. Rename either end, or
  ;    drop either line, and the test goes red.
  Push $R0
  StrCpy $R0 "0"
  ${DisableX64FSRedirection}
  ${If} ${FileExists} "$WINDIR\System32\Tasks\TrustTunnel Client Pro\*.*"
    StrCpy $R0 "1"
  ${EndIf}
  ${If} ${FileExists} "$WINDIR\System32\Tasks\TrustTunnel Client Pro Autostart"
    StrCpy $R0 "1"
  ${EndIf}
  ${EnableX64FSRedirection}

  DetailPrint "$(uninstallAutostartTask)"
  nsExec::Exec 'schtasks /Delete /TN "TrustTunnel Client Pro\*" /F'
  nsExec::Exec 'schtasks /Delete /TN "TrustTunnel Client Pro Autostart" /F'
  ${If} $R0 == "1"
    DetailPrint "$(uninstallAutostartTaskRemoved)"
  ${Else}
    DetailPrint "$(uninstallAutostartTaskAbsent)"
  ${EndIf}
  Pop $R0

  ; ── 5. Delete temp update files ───────────────────────────────
  DetailPrint "$(uninstallRemovingUpdateFiles)"
  Delete "$TEMP\trusttunnel_setup.exe"
  ; Legacy cleanup (pre-2.1.0 ZIP-based updater)
  Delete "$TEMP\trusttunnel_update.zip"
  RMDir /r "$TEMP\trusttunnel_update"
  Delete "$TEMP\trusttunnel_updater.bat"
  Delete "$TEMP\trusttunnel_updater.vbs"

  ; ── 6. Remove empty install directory ─────────────────────────
  ;    Only remove if empty (safe for reinstall — Tauri handles its own files)
  ;
  ;    BY THE TIME THIS RUNS THE FOLDER SHOULD BE EMPTY. Tauri has removed the files
  ;    it installed; this macro has removed the pid file, the survivor marker and the
  ;    data-root note above. Those three were the only things left in it.
  ;
  ;    THIS MUST NEVER BECOME `RMDir /r`, and the reason is D-05: on every machine
  ;    installed before phase 32 the install directory IS the data root, so a recursive
  ;    sweep here would take that user's servers, saved SSH passwords, known hosts and
  ;    browser profile — during what they experience as an update, because an UPDATE
  ;    runs this uninstaller. D-06 exists to prevent exactly that, and
  ;    `lifecycle.rs::the_uninstaller_never_deletes_user_data` rejects the recursive
  ;    form here in EVERY region, including inside the erasure branch.
  ;
  ;    SO A NON-EMPTY FOLDER SURVIVING IS A DELIBERATE RESIDUAL, not a bug to fix by
  ;    escalating the flag. If anything is left in it, the honest answer is that a file
  ;    was in use or belongs to a pre-32 layout — and a human looking in the folder is
  ;    what establishes that, not a comment here claiming it is empty.
  RMDir "$INSTDIR"

  ; ── WHAT ELSE THE ENUMERATION ASKED FOR, AND WHY NO LINE FOLLOWS ──────────────
  ;
  ;    LIVE PROCESSES — already handled, ABOVE this macro. `NSIS_HOOK_PREUNINSTALL`
  ;    step 1 reads this edition's pid file and terminates that process id and no
  ;    other, deliberately never by image name, because that image name is the other
  ;    edition's too and killing it would drop a stranger's live VPN session. The main
  ;    executable is closed by the template before either hook runs. The Windows Job
  ;    Object (KILL_ON_JOB_CLOSE) is the backstop behind both.
  ;
  ;    FIREWALL RULES — none exist, measured twice rather than assumed. Every
  ;    rule-creating API and command (`netsh advfirewall`, `New-NetFirewallRule`,
  ;    INetFwPolicy2/INetFwRules, FwpmFilterAdd) across the Rust backend, this file,
  ;    the emitted script and the C++ core trees: 0 hits. On the live machine: 756
  ;    firewall rules, 0 of them ours, 756 application filters, 0 naming our binaries.
  ;    The killswitch is real but it is WFP, inside the core, under a provider name
  ;    inherited from upstream — a different store this uninstaller does not manage,
  ;    belonging to a process it has already terminated. 32-ERASURE-EVIDENCE.md (d).
  ;
  ;    THE AUTOSTART TASK FOLDER — the empty `%WINDIR%\System32\Tasks\<folder>` stays.
  ;    `schtasks` cannot remove a folder, and deleting it by hand would leave the
  ;    scheduler's TaskCache entries dangling. An empty folder carries no privileges
  ;    and starts nothing; a corrupted TaskCache would be a real defect. Stated at
  ;    length in block 4 above so nobody «fixes» it.

!macroend
