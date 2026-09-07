# One-time setup: put Nimbus on a global hotkey using only built-in Windows.
#
# Creates a Start Menu shortcut whose hotkey is Ctrl+Shift+N. Windows itself
# watches that key, so nothing extra runs in the background and nothing needs
# installing. Press it from anywhere and the Nimbus window opens focused.
#
#   powershell -ExecutionPolicy Bypass -File .\install-nimbus-hotkey.ps1
#
# Undo:  powershell -File .\install-nimbus-hotkey.ps1 -Remove

param(
  [switch]$Remove,
  [string]$Hotkey = "Ctrl+Shift+N"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs  = Join-Path $here "nimbus.vbs"
$link = Join-Path ([Environment]::GetFolderPath("Programs")) "Nimbus.lnk"

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link -Force; Write-Host "Removed $link" }
  else { Write-Host "Nothing to remove." }
  return
}

if (-not (Test-Path $vbs)) { throw "nimbus.vbs is missing from $here" }

# Windows .lnk hotkeys must include Ctrl+Alt or Ctrl+Shift. Ctrl+Space is not
# available this way, which is why the AutoHotkey script exists as the
# alternative for anyone who wants that exact chord.
$chord = ($Hotkey.ToUpper() -replace "\s", "")
$keyName = ($chord -split "\+")[-1]
if ($keyName.Length -ne 1) { throw "Hotkey must end in a single letter, e.g. Ctrl+Shift+N" }
if (-not ($chord -match "CTRL" -and ($chord -match "SHIFT" -or $chord -match "ALT"))) {
  throw "Windows shortcut hotkeys need Ctrl+Shift or Ctrl+Alt, e.g. Ctrl+Shift+N"
}

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
$sc.Arguments        = """$vbs"""
$sc.WorkingDirectory = $here
$sc.WindowStyle      = 7                       # minimized, no flash
$sc.Description      = "Open Nimbus"
$sc.IconLocation     = "$env:SystemRoot\System32\shell32.dll,13"
$sc.Hotkey           = $chord
$sc.Save()

Write-Host "Nimbus is on $Hotkey."
Write-Host "Shortcut: $link"
Write-Host "If the hotkey does not fire, open the shortcut's Properties once and confirm the Shortcut key field."
