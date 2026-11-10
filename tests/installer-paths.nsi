Unicode true
Name "SubtitleEraser directory validation"
OutFile "..\validation\installer-path-test.exe"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define APP_FILENAME "SubtitleEraser"
!define isUpdated '"" == "updated"'
!include "..\build\installer.nsh"

!macro CheckPath INPUT EXPECTED
  StrCpy $INSTDIR "${INPUT}"
  !insertmacro NormalizeAppDirectory
  FileOpen $2 "$EXEDIR\installer-path-cases.txt" a
  FileWrite $2 "Input=${INPUT} | Actual=$INSTDIR | Expected=${EXPECTED}$\r$\n"
  FileClose $2
  ${If} $INSTDIR != "${EXPECTED}"
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

Section
  !insertmacro CheckPath "$EXEDIR\InstallParent" "$EXEDIR\InstallParent\SubtitleEraser"
  CreateDirectory "$INSTDIR"
  FileOpen $1 "$INSTDIR\created-by-installer.txt" w
  FileWrite $1 "Directory created successfully"
  FileClose $1
  !insertmacro CheckPath "$EXEDIR\SubtitleEraser" "$EXEDIR\SubtitleEraser"
  !insertmacro CheckPath "$EXEDIR\SubtitleEraserTests\Parent" "$EXEDIR\SubtitleEraserTests\Parent\SubtitleEraser"
  !insertmacro CheckPath "$EXEDIR\InstallParent\" "$EXEDIR\InstallParent\SubtitleEraser"
  !insertmacro CheckPath "C:\" "C:\SubtitleEraser"
  FileOpen $1 "$EXEDIR\installer-path-test.txt" w
  FileWrite $1 "PASS: parent, existing leaf, matching ancestor, trailing separator, drive root, directory creation"
  FileClose $1
  SetErrorLevel 0
SectionEnd
