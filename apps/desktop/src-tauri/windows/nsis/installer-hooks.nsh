!macro T3CODE_CLOSE_RUNNING_PROCESSES
  DetailPrint "Closing running T3 Code processes..."

  nsExec::ExecToLog `taskkill /IM "t3code.exe" /T /F`
  Pop $0

  System::Call 'Kernel32::SetEnvironmentVariable(t "T3CODE_NSIS_INSTDIR", t "$INSTDIR")i.r0'
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'SilentlyContinue'; $$installDir = [Environment]::GetEnvironmentVariable('T3CODE_NSIS_INSTDIR'); if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 0 }; $$target = [System.IO.Path]::GetFullPath((Join-Path $$installDir 'apps\desktop\dist\node\node.exe')); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath) -ieq $$target) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "T3CODE_NSIS_INSTDIR", t "")i.r0'

  Sleep 1500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro T3CODE_CLOSE_RUNNING_PROCESSES
  RMDir /r "$INSTDIR\apps\desktop\dist\node"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro T3CODE_CLOSE_RUNNING_PROCESSES
!macroend
