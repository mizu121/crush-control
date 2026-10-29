; Copyright (c) 2026 mi0ir. Original project code; no nsProcess code is used.
; Query-only Windows Restart Manager integration. Never shut down or restart an app.
; DWORD session handles stay 32-bit; all actual memory addresses use System's p type.
; Windows resolves the registered full executable path, independent of process bitness.
;
; Stack in: maximum number of 250 ms waits (0 for normal install/uninstall).
; Stack out: 603 = no users, 0 = in use, 1 = query/cleanup failure (fail closed).
; Registers are preserved. Each successful session is closed on every exit path.

!ifdef BUILD_UNINSTALLER
  !define CC_PROCESS_CHECK "un.CCCheckInstalledExecutable"
!else
  !define CC_PROCESS_CHECK "CCCheckInstalledExecutable"
!endif

Function ${CC_PROCESS_CHECK}
  Exch $9
  Push $8
  Push $7
  Push $6
  Push $5
  Push $4
  Push $3
  Push $2
  Push $1
  Push $0
  Push $R0
  Push $R1
  StrCpy $8 1
  StrCpy $R1 0
  StrCpy $1 0
  StrCpy $2 0
  StrCpy $3 0

  ; Register exactly the installed executable, never a basename or directory.
  ClearErrors
  ; PRODUCT_FILENAME is supplied by builder before this include. common.nsh
  ; defines APP_EXECUTABLE_FILENAME to this same value later in the script.
  GetFullPathName $R0 "$INSTDIR\${PRODUCT_FILENAME}.exe"
  IfErrors cc_cleanup
  StrCmp $R0 "" cc_cleanup

  ; CCH_RM_SESSION_KEY is 32, plus a terminating WCHAR: 66 bytes.
  System::Alloc 66
  Pop $1
  StrCmp $1 0 cc_cleanup
  StrCpy $4 -1
  System::Call '"$SYSDIR\Rstrtmgr.dll"::RmStartSession(*i .r0, i 0, p r1) i.r4'
  StrCmp $4 0 0 cc_cleanup
  StrCpy $R1 1

  ; A real WCHAR buffer and pointer array remain live through registration.
  System::Call '*(&w${NSIS_MAX_STRLEN} R0) p.r2'
  StrCmp $2 0 cc_cleanup
  StrCmp $2 error cc_cleanup
  System::Call '*(p r2) p.r3'
  StrCmp $3 0 cc_cleanup
  StrCmp $3 error cc_cleanup
  StrCpy $4 -1
  System::Call '"$SYSDIR\Rstrtmgr.dll"::RmRegisterResources(i r0, i 1, p r3, i 0, p 0, i 0, p 0) i.r4'
  StrCmp $4 0 0 cc_cleanup

cc_query:
  StrCpy $4 -1
  StrCpy $5 0
  StrCpy $6 0
  StrCpy $7 0
  ; With no array, MORE_DATA + positive needed count means the file is in use.
  ; No RM_PROCESS_INFO structures or cross-bitness process memory are inspected.
  System::Call '"$SYSDIR\Rstrtmgr.dll"::RmGetList(i r0, *i .r5, *i r6 r6, p 0, *i .r7) i.r4'
  StrCmp $7 0 0 cc_cleanup
  StrCmp $4 234 cc_in_use
  StrCmp $4 0 0 cc_cleanup
  StrCmp $5 0 0 cc_cleanup
  StrCmp $6 0 0 cc_cleanup
  StrCpy $8 603
  Goto cc_cleanup

cc_in_use:
  IntCmpU $5 0 cc_cleanup
  StrCpy $8 0
  IntCmp $9 0 cc_cleanup cc_cleanup
  Sleep 250
  IntOp $9 $9 - 1
  ; A later API error must not inherit an earlier successful in-use result.
  StrCpy $8 1
  Goto cc_query

cc_cleanup:
  StrCmp $3 0 cc_free_path
  StrCmp $3 error cc_free_path
  System::Free $3
cc_free_path:
  StrCmp $2 0 cc_free_key
  StrCmp $2 error cc_free_key
  System::Free $2
cc_free_key:
  StrCmp $1 0 cc_end_session
  System::Free $1
cc_end_session:
  StrCmp $R1 1 0 cc_return
  StrCpy $4 -1
  System::Call '"$SYSDIR\Rstrtmgr.dll"::RmEndSession(i r0) i.r4'
  StrCmp $4 0 cc_return
  StrCpy $8 1
cc_return:
  StrCpy $9 $8
  Pop $R1
  Pop $R0
  Pop $0
  Pop $1
  Pop $2
  Pop $3
  Pop $4
  Pop $5
  Pop $6
  Pop $7
  Pop $8
  Exch $9
FunctionEnd
