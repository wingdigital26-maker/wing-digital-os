# Nimbus, a keystroke away.
#
# Opens Nimbus in a frameless Chrome app window pointed at the OS, straight
# into his panel (#nimbus). If that window already exists it is focused
# instead of opened again, so the second press is instant.
#
# Called by nimbus.vbs, which runs it with no console box, exactly like every
# other Wing scheduled task.

$ErrorActionPreference = "Stop"

$Port    = if ($env:NIMBUS_PORT) { $env:NIMBUS_PORT } else { "3000" }
$Url     = "http://localhost:$Port/#nimbus"
$Profile = Join-Path $env:LOCALAPPDATA "Nimbus\chrome-profile"

function Get-ChromePath {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

# Is the OS actually up? Saying so beats a blank window.
try {
  $probe = [System.Net.WebRequest]::Create("http://localhost:$Port/")
  $probe.Timeout = 2500
  $probe.Method = "HEAD"
  $probe.GetResponse().Close()
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Wing OS is not answering on port $Port, so Nimbus cannot open. Start the OS first.",
    "Nimbus") | Out-Null
  exit 1
}

# Already open? Focus it rather than spawning a second window.
$existing = Get-Process -Name chrome, msedge -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like "*Wing*" }
if ($existing) {
  $sig = @'
using System;
using System.Runtime.InteropServices;
public class NimbusWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
}
'@
  if (-not ("NimbusWin" -as [type])) { Add-Type -TypeDefinition $sig }
  $h = $existing[0].MainWindowHandle
  [NimbusWin]::ShowWindowAsync($h, 9) | Out-Null   # SW_RESTORE
  [NimbusWin]::SetForegroundWindow($h) | Out-Null
  exit 0
}

$browser = Get-ChromePath
if (-not $browser) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show("No Chrome or Edge found, so the app window cannot open.", "Nimbus") | Out-Null
  exit 1
}

New-Item -ItemType Directory -Force -Path $Profile | Out-Null
$args = @(
  "--app=$Url",
  "--user-data-dir=$Profile",
  "--window-size=520,760",
  "--no-first-run",
  "--no-default-browser-check"
)
Start-Process -FilePath $browser -ArgumentList $args | Out-Null
