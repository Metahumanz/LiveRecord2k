Unicode true
RequestExecutionLevel admin

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_VERSION_QUAD
  !define APP_VERSION_QUAD "0.0.0.0"
!endif
!ifndef RELEASE_DIR
  !error "RELEASE_DIR is required"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE is required"
!endif
!ifndef ICON_PATH
  !define ICON_PATH "${RELEASE_DIR}\assets\app-icon.ico"
!endif

!define APP_NAME "BiliRecord2K"
!define COMPANY_NAME "BiliRecord2K"
!define REG_KEY "Software\BiliRecord2K"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\BiliRecord2K"
InstallDirRegKey HKCU "${REG_KEY}" "InstallDir"
Icon "${ICON_PATH}"
UninstallIcon "${ICON_PATH}"
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION_QUAD}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${COMPANY_NAME}"
VIAddVersionKey "LegalCopyright" "${COMPANY_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "OriginalFilename" "bili-record-2k-setup.exe"

!include "MUI2.nsh"
!include "FileFunc.nsh"

!insertmacro GetParameters
!insertmacro GetOptions

Var UpdateStatusPath
Var UpdateLogPath
Var UpdatePackagePath
Var UpdateStatusValue
Var UpdateMessage

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_PATH}"
!define MUI_UNICON "${ICON_PATH}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\BiliRecord2K.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "--prod"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  Call ParseUpdateArgs
  StrCpy $UpdateStatusValue "applying"
  StrCpy $UpdateMessage "Installer started."
  Call WriteUpdateStatus
  Call AppendUpdateLog
FunctionEnd

Function ParseUpdateArgs
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/STATUS=" $UpdateStatusPath
  ClearErrors
  ${GetOptions} $R0 "/LOG=" $UpdateLogPath
  ClearErrors
  ${GetOptions} $R0 "/PACKAGE=" $UpdatePackagePath
FunctionEnd

Function WriteUpdateStatus
  StrCmp "$UpdateStatusPath" "" done
  FileOpen $0 "$UpdateStatusPath" w
  IfErrors done
  FileWrite $0 "{$\r$\n"
  FileWrite $0 "  $\"status$\": $\"$UpdateStatusValue$\",$\r$\n"
  FileWrite $0 "  $\"version$\": $\"${APP_VERSION}$\",$\r$\n"
  FileWrite $0 "  $\"packagePath$\": $\"$UpdatePackagePath$\",$\r$\n"
  FileWrite $0 "  $\"logPath$\": $\"$UpdateLogPath$\",$\r$\n"
  FileWrite $0 "  $\"message$\": $\"$UpdateMessage$\",$\r$\n"
  FileWrite $0 "  $\"updatedAt$\": 0$\r$\n"
  FileWrite $0 "}$\r$\n"
  FileClose $0
done:
FunctionEnd

Function AppendUpdateLog
  StrCmp "$UpdateLogPath" "" done
  FileOpen $0 "$UpdateLogPath" a
  IfErrors done
  FileWrite $0 "${APP_NAME} ${APP_VERSION}: $UpdateMessage$\r$\n"
  FileClose $0
done:
FunctionEnd

Function StopRunningApp
  DetailPrint "Stopping running ${APP_NAME} processes..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM BiliRecord2K.exe /T /F'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM BiliRecord2K.Service.exe /T /F'
  Sleep 1200
FunctionEnd

Section "Install"
  Call StopRunningApp
  SetOutPath "$INSTDIR"
  File /r "${RELEASE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${REG_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REG_KEY}" "Version" "${APP_VERSION}"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\BiliRecord2K.exe" "--prod" "$INSTDIR\assets\app-icon.ico"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  StrCpy $UpdateStatusValue "success"
  StrCpy $UpdateMessage "Install completed."
  Call WriteUpdateStatus
  Call AppendUpdateLog

  IfSilent 0 +2
  ExecShell "open" "$INSTDIR\BiliRecord2K.exe" "--prod"
SectionEnd

Section "Uninstall"
  Call un.StopRunningApp
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\assets"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\dist"
  Delete "$INSTDIR\BiliRecord2K.exe"
  Delete "$INSTDIR\BiliRecord2K.Service.exe"
  Delete "$INSTDIR\version.json"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  DeleteRegValue HKCU "${RUN_KEY}" "${APP_NAME}"
  DeleteRegKey HKCU "${REG_KEY}"
SectionEnd

Function un.StopRunningApp
  DetailPrint "Stopping running ${APP_NAME} processes..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM BiliRecord2K.exe /T /F'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM BiliRecord2K.Service.exe /T /F'
  Sleep 1200
FunctionEnd
