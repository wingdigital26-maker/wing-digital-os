' Launch nimbus.ps1 with no console box. Same pattern as ghl-cli\hidden_run.vbs,
' which every other Wing task already uses.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "nimbus.ps1""", 0, False
