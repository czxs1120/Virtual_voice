; ============================================================
; VB-CABLE Virtual Audio Driver — install hooks
; ============================================================
; Driver files are bundled at $INSTDIR\resources\drivers\vbcable\
; To install: run Virtual Voice as admin → Settings → Install Driver

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "VB-CABLE driver files installed."
  DetailPrint "Run Virtual Voice as administrator to install the driver."
!macroend

; ------------------------------------------------------------------
; PREUNINSTALL — runs before files/registry/shortcuts are removed
; ------------------------------------------------------------------
!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "正在卸载 VB-CABLE 虚拟音频驱动..."
  DetailPrint "Uninstalling VB-CABLE Virtual Audio Driver..."

  ; Find the published driver name from the INF
  ${If} ${RunningX64}
    StrCpy $0 "$INSTDIR\resources\drivers\vbcable\vbMmeCable64_win7.inf"
  ${Else}
    StrCpy $0 "$INSTDIR\resources\drivers\vbcable\vbMmeCable_win7.inf"
  ${EndIf}

  ; Try to delete the driver package
  ; /delete-driver : remove a driver package from the driver store
  ; /uninstall     : also uninstall any devices using this driver
  nsExec::ExecToStack '"pnputil" /delete-driver "$0" /uninstall'
  Pop $1
  Pop $2

  DetailPrint "pnputil 返回代码: $1"
  DetailPrint "pnputil output: $2"

  ${If} $1 = 0
    DetailPrint "✅ VB-CABLE 驱动卸载成功"
    DetailPrint "✅ VB-CABLE driver uninstalled successfully."
  ${Else}
    DetailPrint "⚠️ VB-CABLE 驱动卸载可能未完成 (代码: $1)"
    DetailPrint "⚠️ VB-CABLE driver uninstallation may not have completed."
  ${EndIf}
!macroend
