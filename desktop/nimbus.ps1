# Nimbus, a keystroke away.
#
# Opens Nimbus in a frameless Chrome app window pointed at the OS, straight
# into his panel (#nimbus). If that window already exists it is focused
# instead of opened again, so the second press is instant.
#
# Called by nimbus.vbs, which runs it with no console box, exactly like every
# other Wing scheduled task.

$ErrorActionPreference = "Stop"
# Loaded up front: the window placement below needs Screen, not just the error paths.
Add-Type -AssemblyName System.Windows.Forms

# This screen is scaled, so a process that is not DPI aware is handed
# virtualised coordinates (1280x800 on a display that is physically larger).
# Window placement and hit testing then land in the wrong place. Declare
# awareness before anything reads a screen size or moves a window.
$dpiSig = @'
using System;
using System.Runtime.InteropServices;
public class NimbusDpi {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static readonly IntPtr PER_MONITOR_V2 = new IntPtr(-4);
  public static void Declare() {
    try { if (SetProcessDpiAwarenessContext(PER_MONITOR_V2)) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
'@
if (-not ("NimbusDpi" -as [type])) { Add-Type -TypeDefinition $dpiSig }
[NimbusDpi]::Declare()


$Port    = if ($env:NIMBUS_PORT) { $env:NIMBUS_PORT } else { "3000" }
$Profile = Join-Path $env:LOCALAPPDATA "Nimbus\chrome-profile"
$RepoRoot = Split-Path -Parent $PSScriptRoot

# The window opens Nimbus alone, not the OS, and carries the machine key so it
# never meets a login screen. The key lives in .env.local on this PC only; the
# cloud deploy has no such key, so nothing here weakens the hosted OS.
$Key = $env:NIMBUS_LOCAL_KEY
if (-not $Key) {
  $envFile = Join-Path $RepoRoot ".env.local"
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*NIMBUS_LOCAL_KEY\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) { $Key = ($line.Line -split "=", 2)[1].Trim().Trim('"') }
  }
}
$Url = "http://localhost:$Port/nimbus"
if ($Key) { $Url = "$Url" + "?k=" + [uri]::EscapeDataString($Key) }
# The orb opens him straight onto the problems list when there are problems.
# NIMBUS_OPEN_HASH is set by the caller; anything unexpected is ignored.
$Hash = $env:NIMBUS_OPEN_HASH
if ($Hash -eq "#problems" -or $Hash -eq "#nimbus") { $Url = "$Url$Hash" }

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
  Where-Object { $_.MainWindowTitle -and ($_.MainWindowTitle -like "*Nimbus*" -or $_.MainWindowTitle -like "*Wing*") }
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

# Keep the window off the taskbar and out of alt-tab. The orb in the corner is
# the permanent presence; a second button for the same assistant is clutter.
# Set NIMBUS_TASKBAR=1 to get the normal window button back.
$hideSig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NimbusChrome {
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, SW_HIDE = 0, SW_SHOW = 5;

  /// Put the window exactly where it belongs, whatever Chrome remembered.
  public static int SetBounds(int x, int y, int w, int h) {
    int n = 0;
    EnumWindows((hw, p) => {
      if (!IsWindowVisible(hw)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(hw, sb, sb.Capacity);
      if (sb.ToString().IndexOf("Nimbus", StringComparison.OrdinalIgnoreCase) < 0) return true;
      MoveWindow(hw, x, y, w, h, true);
      n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }

  /// Re-style every visible window whose title is the Nimbus window.
  public static int HideFromTaskbar() {
    int n = 0;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf("Nimbus", StringComparison.OrdinalIgnoreCase) < 0) return true;
      // The style only takes effect across a hide/show cycle.
      ShowWindow(h, SW_HIDE);
      SetWindowLong(h, GWL_EXSTYLE, GetWindowLong(h, GWL_EXSTYLE) | WS_EX_TOOLWINDOW);
      ShowWindow(h, SW_SHOW);
      n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@

New-Item -ItemType Directory -Force -Path $Profile | Out-Null

# 560x780 was sized for a chat panel alone. The stage now shows the orb large
# above the conversation, so the window needs height more than width: 520 wide
# keeps the chat column comfortable without going wide enough to look like a
# browser, and 900 tall leaves the stage room without crowding the transcript.
$WinW = 520
$WinH = 900
$WinArgs = @("--window-size=$WinW,$WinH")

# Park it against the right edge, vertically centred, so a keystroke window
# lands somewhere predictable instead of on top of whatever Jack is reading.
# Screen geometry can be unavailable in odd sessions, so it stays optional.
try {
  Add-Type -AssemblyName System.Windows.Forms
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  if ($WinH -gt $area.Height) { $WinH = $area.Height - 40; $WinArgs = @("--window-size=$WinW,$WinH") }
  $x = $area.X + $area.Width - $WinW - 40
  $y = $area.Y + [int](($area.Height - $WinH) / 2)
  if ($x -lt $area.X) { $x = $area.X }
  if ($y -lt $area.Y) { $y = $area.Y }
  $WinArgs += "--window-position=$x,$y"
} catch { }

$args = @(
  "--app=$Url",
  "--user-data-dir=$Profile"
) + $WinArgs + @(
  "--no-first-run",
  "--no-default-browser-check"
)
Start-Process -FilePath $browser -ArgumentList $args | Out-Null

# Size and place it. Chrome's remembered bounds win over --window-size on every
# run after the first, so this is the only reliable way to get the same window
# every time.
$WinW = if ($env:NIMBUS_WIDTH) { [int]$env:NIMBUS_WIDTH } else { 520 }
$WinH = if ($env:NIMBUS_HEIGHT) { [int]$env:NIMBUS_HEIGHT } else { 900 }
try {
  if (-not ("NimbusChrome" -as [type])) { Add-Type -TypeDefinition $hideSig }
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $h = [Math]::Min($WinH, $area.Height - 20)
  $x = $area.Right - $WinW - 24
  $y = $area.Top + [int](($area.Height - $h) / 2)
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 250
    if ([NimbusChrome]::SetBounds($x, $y, $WinW, $h) -gt 0) { break }
  }
} catch {
  # Cosmetic. A wrongly sized window still works.
}

if ($env:NIMBUS_TASKBAR -ne "1") {
  # Chrome needs a moment to create the window before it can be re-styled.
  try {
    if (-not ("NimbusChrome" -as [type])) { Add-Type -TypeDefinition $hideSig }
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 250
      if ([NimbusChrome]::HideFromTaskbar() -gt 0) { break }
    }
  } catch {
    # Cosmetic only. A window that shows in the taskbar still works fine.
  }
}
