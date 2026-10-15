; Simple Recorder setup: one .exe a person downloads and double-clicks.
; Built by scripts/pack-setup.cjs:
;   makensis /DVERSION=1.2.0 /DVIVERSION=1.2.0.0 /DSTAGE=<layout> /DOUTFILE=<exe> installer.nsi
;
; STAGE is the installed layout (Simple Recorder.exe, resources\app,
; install.json). The setup unpacks it to a temp folder and runs
; scripts\install.cjs --portable through the bundled runtime, so the result is
; exactly what `npm run app:install` makes: %LOCALAPPDATA%\Programs, Start Menu
; and Desktop shortcuts, the Add-or-Remove-Programs entry, and the GitHub
; Releases update channel. Per user, no admin.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "FileFunc.nsh"

!ifndef STAGE
  !error "Pass /DSTAGE=<staged install layout>"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VIVERSION
  !define VIVERSION "0.0.0.0"
!endif
!ifndef OUTFILE
  !define OUTFILE "SimpleRecorder-Setup.exe"
!endif

!define APP "Simple Recorder"

Name "${APP}"
Caption "${APP} ${VERSION} setup"
OutFile "${OUTFILE}"
BrandingText "${APP} ${VERSION}"
ShowInstDetails nevershow
AutoCloseWindow true
InstallButtonText "Install"

VIProductVersion "${VIVERSION}"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} setup"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Josephivgi"

Page instfiles

Section "Install"
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\payload\${APP}"
  DetailPrint "Unpacking ${APP} ${VERSION}..."
  SetOutPath "$1"
  File /r "${STAGE}\*.*"

  ; Test hook: /TESTDIR=<folder> installs there with no shortcuts, no
  ; uninstall entry, and no launch, so a check never touches the real install.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/TESTDIR=" $R1
  StrCpy $R2 ""
  IfErrors +2
    StrCpy $R2 '--dir "$R1" --no-shortcuts --no-registry'

  DetailPrint "Installing ${APP}..."
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1") i'
  nsExec::ExecToLog '"$1\${APP}.exe" "$1\resources\app\scripts\install.cjs" --portable "$1" --quiet $R2'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0) i'
  ; Leave the temp folder so it can be removed when the setup closes.
  SetOutPath "$TEMP"

  StrCmp $0 "0" installed
    MessageBox MB_ICONSTOP|MB_OK "${APP} could not be installed.$\r$\n$\r$\nClose ${APP} if it is open, then run this setup again." /SD IDOK
    SetErrorLevel 1
    Quit
  installed:
  StrCmp $R2 "" 0 done

  ; Started here, not by install.cjs: a child of nsExec would hold its pipe
  ; open and the setup window would wait for the app to close.
  Exec '"$LOCALAPPDATA\Programs\${APP}\${APP}.exe"'
  done:
SectionEnd
