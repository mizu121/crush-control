; Never terminate the app: graceful Quit must release the keyboard first.
; Only electron-updater's explicit --updated installation may wait briefly
; for its parent to exit. Normal installation and all uninstallers refuse.
; Prevent builder from even including nsProcess.nsh. Any future expansion of
; that legacy macro is a compile error, rather than silently bundling the DLL.
!define nsProcess::FindProcess CC_NS_PROCESS_REMOVED_DO_NOT_USE
!include "${__FILEDIR__}\installer-process-check.nsh"

; Preserve electron-builder's default two-pass uninstaller generation. NSIS
; searches compiler cwd before include paths. Use our reviewed overrides
; there, with the original template directory as fallback for all other files.
!addincludedir "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis"
!cd "${PROJECT_DIR}\build\installer-templates"

!macro customCheckAppRunning
  Push $R3
  StrCpy $R3 0
  !ifndef BUILD_UNINSTALLER
    ; Builder's isUpdated uses StdUtils.TestParameter for an exact flag. Unlike
    ; GetOptions("--updated"), it also works alongside the updater's /S switch.
    ${If} ${isUpdated}
      StrCpy $R3 40
    ${EndIf}
  !endif
  Push $R3
  Call ${CC_PROCESS_CHECK}
  Pop $R0
  Pop $R3
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Quit ${PRODUCT_NAME} from its tray menu (or press Ctrl+Q), then run setup again. Closing its window leaves it running." /SD IDOK
    SetErrorLevel 2
    Quit
  ${ElseIf} $R0 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "Setup could not safely check whether ${PRODUCT_NAME} is in use. Quit the app and try again. If this continues, restart Windows." /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}
!macroend
