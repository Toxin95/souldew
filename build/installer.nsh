; souldew's additions to electron-builder's NSIS installer (package.json build.nsis.include).
;
; A second Start menu entry, "souldew (safe graphics)": the app started with --safe-graphics (shared/gpu.mjs) – drawn
; without the graphics card, for a PC where souldew opens with a blank window. From there Settings › General switches
; the graphics backend for the next normal start. Created next to the normal entry, removed with the app.

!macro customInstall
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk" "$appExe" "--safe-graphics" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk" "${APP_ID}"
  ClearErrors
!macroend

!macro customUnInstall
  ; an update uninstalls the old version first and installs the shortcut again right after
  WinShell::UninstShortcut "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk"
  ClearErrors
!macroend
