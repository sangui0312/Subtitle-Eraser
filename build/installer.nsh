!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "MUI2.nsh"

; Attach the show hook at the directory-page declaration, after the install-mode
; page has consumed its own MUI hooks and selected the installation scope.
!macroundef MUI_PAGE_DIRECTORY
!macro MUI_PAGE_DIRECTORY
  !insertmacro MUI_PAGE_INIT
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ShowAppDirectory
  !insertmacro MUI_PAGEDECLARATION_DIRECTORY
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function ShowAppDirectory
      !insertmacro NormalizeAppDirectory
      SendMessage $mui.DirectoryPage.Directory ${WM_SETTEXT} 0 "STR:$INSTDIR"
    FunctionEnd
  !endif
!macroend

!macro NormalizeAppDirectory
  StrCpy $0 "$INSTDIR" 1 -1
  ${While} $0 == "\"
    StrLen $0 "$INSTDIR"
    ${If} $0 <= 3
      ${Break}
    ${EndIf}
    StrCpy $INSTDIR "$INSTDIR" -1
    StrCpy $0 "$INSTDIR" 1 -1
  ${EndWhile}
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 != "${APP_FILENAME}"
    StrCpy $0 "$INSTDIR" 1 -1
    ${If} $0 == "\"
      StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
    ${Else}
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
!macroend

; Normalize the final path before the built-in install-files page sanitizes it.
; A substring match in an ancestor folder must not suppress the app subfolder.
!macro customPageAfterChangeDir
  Page custom EnsureAppDirectory
  Function EnsureAppDirectory
    ${IfNot} ${isUpdated}
      !insertmacro NormalizeAppDirectory
    ${EndIf}
    Abort
  FunctionEnd
!macroend
