; Limit Tracker installer additions (electron-builder `nsis.include`).
;
; The program is shared as one file, "Limit Tracker.exe" (this installer).
; - Opening it on a PC that already has this version or a newer one just opens
;   the installed program: no reinstall, no downgrade.
; - The installer has the same file name as the program, so the stock "is the
;   app running?" check would skip itself. customCheckAppRunning below closes
;   every copy of the program in this Windows session (installed, or an older
;   single-file copy running from a temporary folder), never this installer.
; Automatic updates (electron-updater runs the installer with /S --updated) keep
; the normal path.

!include WordFunc.nsh

!macro customInit
  ${ifNot} ${Silent}
  ${andIfNot} ${isUpdated}
    ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${if} $R0 != ""
    ${andIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ; 0 = same version, 1 = installed is newer, 2 = this file is newer.
      ${VersionCompare} "$R0" "${VERSION}" $R1
      ${if} $R1 != 2
        ; Start in the install folder, not in the folder this file was opened
        ; from (which the program would otherwise keep locked while it runs).
        SetOutPath "$INSTDIR"
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
        Quit
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

; $R0 = 0 when another process named like the program runs in this session.
!macro LT_FIND_APP
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$s = (Get-Process -Id $$PID).SessionId; if (@(Get-CimInstance -ClassName Win32_Process | ? { $$_.Name -eq '${APP_EXECUTABLE_FILENAME}' -and $$_.ProcessId -ne $R2 -and $$_.SessionId -eq $$s }).Count -gt 0) { exit 0 } else { exit 1 }"`
  ${else}
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R2" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  ${endIf}
  Pop $R0
!macroend

; Stops those processes; FORCE = 1 skips the polite close.
!macro LT_STOP_APP FORCE
  ${if} $IsPowerShellAvailable == 0
    ${if} ${FORCE} == 1
      nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$s = (Get-Process -Id $$PID).SessionId; Get-CimInstance -ClassName Win32_Process | ? { $$_.Name -eq '${APP_EXECUTABLE_FILENAME}' -and $$_.ProcessId -ne $R2 -and $$_.SessionId -eq $$s } | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    ${else}
      nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$s = (Get-Process -Id $$PID).SessionId; Get-CimInstance -ClassName Win32_Process | ? { $$_.Name -eq '${APP_EXECUTABLE_FILENAME}' -and $$_.ProcessId -ne $R2 -and $$_.SessionId -eq $$s } | % { Stop-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue }"`
    ${endIf}
  ${else}
    ${if} ${FORCE} == 1
      nsExec::Exec `"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R2" /FI "USERNAME eq %USERNAME%"`
    ${else}
      nsExec::Exec `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R2" /FI "USERNAME eq %USERNAME%"`
    ${endIf}
  ${endIf}
  Pop $R3
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ; When the installer runs the old version's uninstaller (always --updated),
    ; it has already closed the program. Checking again here could stop the
    ; installer itself, which also carries the program's name.
    ${if} ${isUpdated}
      Goto lt_check_done
    ${endIf}
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  ; This process's own id, so the check never stops itself.
  System::Call 'kernel32::GetCurrentProcessId() i .R2'
  ${if} ${isUpdated}
    ; The program is already quitting to apply the update.
    Sleep 1000
  ${endIf}
  StrCpy $R1 0
  lt_check_app:
    IntOp $R1 $R1 + 1
    !insertmacro LT_FIND_APP
    ${if} $R0 == 0
      DetailPrint "$(appClosing)"
      !insertmacro LT_STOP_APP 0
      Sleep 1500
      !insertmacro LT_FIND_APP
      ${if} $R0 == 0
        !insertmacro LT_STOP_APP 1
        Sleep 1000
        !insertmacro LT_FIND_APP
      ${endIf}
      ${if} $R0 == 0
        ${if} $R1 > 2
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY lt_check_app
          Quit
        ${endIf}
        Goto lt_check_app
      ${endIf}
    ${endIf}
  !ifdef BUILD_UNINSTALLER
    lt_check_done:
  !endif
!macroend
