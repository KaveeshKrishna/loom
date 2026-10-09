; Uninstalling Loom removes what the app added to File Explorer
; (src/windows_shell.rs): the "Upload to Loom" verbs and the Send to shortcut.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\LoomUpload"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\LoomUpload"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\LoomUpload"
  Delete "$APPDATA\Microsoft\Windows\SendTo\Loom.lnk"
!macroend
