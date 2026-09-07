# One-time setup: put Nimbus on a global hotkey.
#
#   powershell -ExecutionPolicy Bypass -File .\install-nimbus-hotkey.ps1
#
# Default is Ctrl+Space. Windows shortcut hotkeys cannot be Ctrl+Space, so that
# chord is claimed properly by a tiny background listener (nimbus-hotkey.ps1)
# that starts at login and toggles the window: press to open or focus, press
# again while it is in front to send it away.
#
# Any Ctrl+Shift+<letter> or Ctrl+Alt+<letter> chord is installed the lighter
# way instead, as a Start Menu shortcut Windows itself watches, with nothing
# running in the background:
#
#   .\install-nimbus-hotkey.ps1 -Hotkey "Ctrl+Shift+N"
#
# Undo either of them:  .\install-nimbus-hotkey.ps1 -Remove

param(
  [switch]$Remove,
  [string]$Hotkey = "Ctrl+Space"
)

$ErrorActionPreference = "Stop"
$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs       = Join-Path $here "nimbus.vbs"
$listener  = Join-Path $here "nimbus-hotkey.vbs"
$orbVbs    = Join-Path $here "nimbus-orb.vbs"
$link      = Join-Path ([Environment]::GetFolderPath("Programs")) "Nimbus.lnk"
$startup   = Join-Path ([Environment]::GetFolderPath("Startup")) "Nimbus hotkey.lnk"
$orbStartup = Join-Path ([Environment]::GetFolderPath("Startup")) "Nimbus orb.lnk"

function Get-ListenerProcesses {
  # NOTE the leading backslash and the install- exclusion. Matching a bare
  # "nimbus-hotkey.ps1" also matches THIS script's own command line, and the
  # installer cheerfully killed itself.
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like "*\nimbus-hotkey.ps1*" -and
      $_.CommandLine -notlike "*install-nimbus-hotkey.ps1*" -and
      $_.ProcessId -ne $PID
    }
}

function Get-OrbProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like "*\nimbus-orb.ps1*" -and
      $_.ProcessId -ne $PID
    }
}

function Stop-Orb {
  Get-OrbProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Stop-Listener {
  # The listener holds a named mutex, so killing the powershell that owns the
  # script is enough; nothing else is left behind.
  Get-ListenerProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Remove) {
  Stop-Listener
  Stop-Orb
  foreach ($f in @($link, $startup, $orbStartup)) {
    if (Test-Path $f) { Remove-Item $f -Force; Write-Host "Removed $f" }
  }
  Write-Host "Nimbus is off the hotkey."
  return
}

if (-not (Test-Path $vbs)) { throw "nimbus.vbs is missing from $here" }

$chord   = ($Hotkey.ToUpper() -replace "\s", "")
$keyName = ($chord -split "\+")[-1]
$shell   = New-Object -ComObject WScript.Shell

# ── Ctrl+Space (and anything else Windows shortcuts cannot express) ──────────
if ($keyName -eq "SPACE") {
  if (-not (Test-Path $listener)) { throw "nimbus-hotkey.vbs is missing from $here" }
  Stop-Listener
  if (Test-Path $link) { Remove-Item $link -Force }   # drop the old .lnk chord

  $sc = $shell.CreateShortcut($startup)
  $sc.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
  $sc.Arguments        = """$listener"""
  $sc.WorkingDirectory = $here
  $sc.WindowStyle      = 7
  $sc.Description      = "Nimbus hotkey listener"
  $sc.Save()

  Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$listener""" -WindowStyle Hidden
  Start-Sleep -Milliseconds 700

  $running = Get-ListenerProcesses
  if ($running) {
    Write-Host "Nimbus is on $Hotkey. Press it to open him, press it again to send him away."
  } else {
    Write-Host "The listener did not stay running. Something else may already own $Hotkey."
    Write-Host "Try: .\install-nimbus-hotkey.ps1 -Hotkey 'Ctrl+Alt+Space'"
  }
  Write-Host "Starts again at login: $startup"

# ── The orb: Nimbus in the corner of the screen, always ─────────────────────
# No taskbar button and no alt-tab entry, the way a chat widget sits on a page.
# It also watches, and pops up when something new breaks.
if (Test-Path $orbVbs) {
  Stop-Orb
  $so = $shell.CreateShortcut($orbStartup)
  $so.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
  $so.Arguments        = """$orbVbs"""
  $so.WorkingDirectory = $here
  $so.WindowStyle      = 7
  $so.Description      = "Nimbus orb"
  $so.Save()
  Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$orbVbs""" -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
  if (Get-OrbProcesses) {
    Write-Host "The orb is on screen, bottom right. Click it to open Nimbus, right click it for the menu."
  } else {
    Write-Host "The orb did not stay running. Start it by hand to see the error:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\nimbus-orb.ps1"
  }
  Write-Host "Starts again at login: $orbStartup"
}
  return
}

# ── Ctrl+Shift+<letter> / Ctrl+Alt+<letter>: no background process needed ────
if ($keyName.Length -ne 1) { throw "Hotkey must end in a single letter or be Ctrl+Space" }
if (-not ($chord -match "CTRL" -and ($chord -match "SHIFT" -or $chord -match "ALT"))) {
  throw "Windows shortcut hotkeys need Ctrl+Shift or Ctrl+Alt, for example Ctrl+Shift+N"
}

Stop-Listener
if (Test-Path $startup) { Remove-Item $startup -Force }

$sc = $shell.CreateShortcut($link)
$sc.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
$sc.Arguments        = """$vbs"""
$sc.WorkingDirectory = $here
$sc.WindowStyle      = 7
$sc.Description      = "Open Nimbus"
$sc.IconLocation     = "$env:SystemRoot\System32\shell32.dll,13"
$sc.Hotkey           = $chord
$sc.Save()

Write-Host "Nimbus is on $Hotkey."
Write-Host "Shortcut: $link"
Write-Host "If the hotkey does not fire, open the shortcut's Properties once and confirm the Shortcut key field."

# ── The orb: Nimbus in the corner of the screen, always ─────────────────────
# No taskbar button and no alt-tab entry, the way a chat widget sits on a page.
# It also watches, and pops up when something new breaks.
if (Test-Path $orbVbs) {
  Stop-Orb
  $so = $shell.CreateShortcut($orbStartup)
  $so.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
  $so.Arguments        = """$orbVbs"""
  $so.WorkingDirectory = $here
  $so.WindowStyle      = 7
  $so.Description      = "Nimbus orb"
  $so.Save()
  Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$orbVbs""" -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
  if (Get-OrbProcesses) {
    Write-Host "The orb is on screen, bottom right. Click it to open Nimbus, right click it for the menu."
  } else {
    Write-Host "The orb did not stay running. Start it by hand to see the error:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\nimbus-orb.ps1"
  }
  Write-Host "Starts again at login: $orbStartup"
}
