!include "FileFunc.nsh"
!include "LogicLib.nsh"

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
