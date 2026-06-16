; Custom NSIS page — asks for BACKEND_URL before installation
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var Dialog
Var BackendUrlLabel
Var BackendUrlInput
Var BackendUrl

; ── Custom page ──────────────────────────────────────────────────────────────
Page custom BackendUrlPage BackendUrlPageLeave

Function BackendUrlPage
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Введите адрес локального бекенда (Sales Backend):"
  Pop $BackendUrlLabel

  ${NSD_CreateText} 0 28u 100% 14u "http://192.168.1.x:3001"
  Pop $BackendUrlInput

  ${NSD_CreateLabel} 0 48u 100% 40u "Укажите IP-адрес компьютера, на котором установлен Sales Backend.$\nПример: http://192.168.1.100:3001$\nЕсли бекенд на этом же компьютере: http://localhost:3001"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function BackendUrlPageLeave
  ${NSD_GetText} $BackendUrlInput $BackendUrl
  ${If} $BackendUrl == ""
    StrCpy $BackendUrl "http://localhost:3001"
  ${EndIf}
FunctionEnd

; ── Write config after install ────────────────────────────────────────────────
!macro customInstall
  ; Write BACKEND_URL to a config file read by the app on first launch
  CreateDirectory "$INSTDIR\config"
  FileOpen $0 "$INSTDIR\config\backend.url" w
  FileWrite $0 $BackendUrl
  FileClose $0
!macroend
