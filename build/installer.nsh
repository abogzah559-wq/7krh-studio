; 7krh Studio — installer additions: a "Create a desktop shortcut" page (checked by default, Arabic/English)
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
Var DesktopCheckbox
Var CreateDesktop

!macro customPageAfterChangeDir
  Page custom DesktopPageCreate DesktopPageLeave
!macroend

Function DesktopPageCreate
  ${If} $LANGUAGE == 1025
    !insertmacro MUI_HEADER_TEXT "الاختصارات" "اختر الاختصارات اللي تبيها لـ 7krh Studio."
    StrCpy $1 "إنشاء اختصار على سطح المكتب"
    StrCpy $2 "يمديك تشغّل البرنامج بعدين من قائمة ابدأ أو من سطح المكتب."
  ${Else}
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose the shortcuts to create for 7krh Studio."
    StrCpy $1 "Create a desktop shortcut"
    StrCpy $2 "You can start the app from the Start menu or from your desktop."
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 18u 100% 14u "$1"
  Pop $DesktopCheckbox
  ${NSD_CreateLabel} 0 40u 100% 24u "$2"
  Pop $0
  ${If} $CreateDesktop == ""
    StrCpy $CreateDesktop ${BST_CHECKED}
  ${EndIf}
  ${NSD_SetState} $DesktopCheckbox $CreateDesktop
  nsDialogs::Show
FunctionEnd

Function DesktopPageLeave
  ${NSD_GetState} $DesktopCheckbox $CreateDesktop
FunctionEnd
!endif

!macro customInstall
  ${If} $CreateDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
!macroend
