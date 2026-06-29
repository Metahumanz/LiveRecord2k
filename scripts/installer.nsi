Unicode true
RequestExecutionLevel user

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
VIAddVersionKey "FileDescription" "${APP_NAME} Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "OriginalFilename" "bili-record-2k-setup.exe"

!include "MUI2.nsh"

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

Function StopRunningApp
  DetailPrint "正在停止运行中的 ${APP_NAME}..."
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
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

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
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  DeleteRegValue HKCU "${RUN_KEY}" "${APP_NAME}"
  DeleteRegKey HKCU "${REG_KEY}"
SectionEnd

Function un.StopRunningApp
  DetailPrint "正在停止运行中的 ${APP_NAME}..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM BiliRecord2K.exe /T /F'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM BiliRecord2K.Service.exe /T /F'
  Sleep 1200
FunctionEnd
