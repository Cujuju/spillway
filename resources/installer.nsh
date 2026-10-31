
; Keep the installed version as the seed for partial updates.
!macro customInstall
  CopyFiles /SILENT "$EXEPATH" "$INSTDIR\update-seed.bin"
!macroend
