# The Ctrl+Space listener.
#
# Windows shortcut hotkeys cannot be Ctrl+Space, so this tiny background process
# claims the chord properly through RegisterHotKey and toggles the Nimbus window
# with it: press once to open or focus, press again while it is in front to send
# it away.
#
# It is a hidden message loop. No window, no console, no taskbar entry. Started
# at login by a Startup shortcut that install-nimbus-hotkey.ps1 creates, and
# stopped by that same script with -Remove.
#
# Only one copy runs at a time. If the chord is already owned by something else
# (an IME switcher is the usual culprit) it says so once and exits rather than
# sitting there doing nothing.

param(
  # Override with e.g. -Chord "Ctrl+Alt+Space" if something else owns Ctrl+Space.
  [string]$Chord = "Ctrl+Space"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs  = Join-Path $here "nimbus.vbs"
if (-not (Test-Path $vbs)) { throw "nimbus.vbs is missing from $here" }

# One instance only. A named mutex beats counting powershell.exe processes,
# which would also match every other Wing task.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\WingNimbusHotkey", [ref]$createdNew)
if (-not $createdNew) { exit 0 }

# Chord -> modifier flags + virtual key. Only what is worth binding is accepted;
# anything else is refused rather than registering the wrong chord silently.
$MOD_ALT = 0x1; $MOD_CONTROL = 0x2; $MOD_SHIFT = 0x4
$parts = ($Chord.ToUpper() -replace "\s", "") -split "\+"
$mods = 0
foreach ($p in $parts[0..($parts.Length - 2)]) {
  switch ($p) {
    "CTRL"    { $mods = $mods -bor $MOD_CONTROL }
    "CONTROL" { $mods = $mods -bor $MOD_CONTROL }
    "SHIFT"   { $mods = $mods -bor $MOD_SHIFT }
    "ALT"     { $mods = $mods -bor $MOD_ALT }
    default   { throw "Unknown modifier '$p' in chord '$Chord'" }
  }
}
$keyName = $parts[-1]
$vk = if ($keyName -eq "SPACE") { 0x20 }
      elseif ($keyName.Length -eq 1) { [int][char]$keyName }
      else { throw "Unknown key '$keyName' in chord '$Chord'" }
if ($mods -eq 0) { throw "A global hotkey needs at least one modifier" }

# The window that owns the hotkey. It has to be a real C# type: WM_HOTKEY is
# delivered to a WndProc, and a PowerShell script block cannot be one.
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class NimbusHotkeyForm : Form {
  [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);

  const int HOTKEY_ID = 0xB17;
  const int WM_HOTKEY = 0x0312;
  const int SW_MINIMIZE = 6;

  readonly uint mods, vk;
  /// True when the chord was claimed. False means someone else owns it.
  public bool Registered { get; private set; }
  /// Raised on every press. The action lives in PowerShell so it stays readable.
  public event EventHandler Pressed;

  public NimbusHotkeyForm(uint modifiers, uint key) {
    mods = modifiers; vk = key;
    // Invisible in every sense: no taskbar button, no alt-tab entry, off screen.
    ShowInTaskbar = false;
    FormBorderStyle = FormBorderStyle.FixedToolWindow;
    StartPosition = FormStartPosition.Manual;
    Location = new Point(-32000, -32000);
    Size = new Size(1, 1);
    Opacity = 0;
  }

  protected override void SetVisibleCore(bool value) {
    // Force the handle to exist (that is what owns the hotkey) without ever
    // actually showing the window.
    if (!IsHandleCreated) { CreateHandle(); }
    base.SetVisibleCore(false);
  }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    Registered = RegisterHotKey(Handle, HOTKEY_ID, mods, vk);
  }

  protected override void OnHandleDestroyed(EventArgs e) {
    UnregisterHotKey(Handle, HOTKEY_ID);
    base.OnHandleDestroyed(e);
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY && ((int)m.WParam) == HOTKEY_ID && Pressed != null) Pressed(this, EventArgs.Empty);
    base.WndProc(ref m);
  }

  /// True when the window in front of the user is the Nimbus window.
  public static bool NimbusIsInFront() {
    IntPtr h = GetForegroundWindow();
    int len = GetWindowTextLength(h);
    if (len <= 0) return false;
    var sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString().IndexOf("Nimbus", StringComparison.OrdinalIgnoreCase) >= 0;
  }

  public static void MinimizeFront() {
    ShowWindowAsync(GetForegroundWindow(), SW_MINIMIZE);
  }
}
'@

$form = New-Object NimbusHotkeyForm($mods, $vk)
$form.add_Pressed({
  # Toggle. If Nimbus is what you are looking at, put him away; otherwise open
  # him, or bring the window already open to the front. nimbus.ps1 knows the
  # difference, so this stays one call either way.
  if ([NimbusHotkeyForm]::NimbusIsInFront()) {
    [NimbusHotkeyForm]::MinimizeFront()
  } else {
    Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$vbs""" -WindowStyle Hidden
  }
})

# Creating the handle is what claims the chord, so do it before the loop and
# check. Failing loudly once beats a listener that runs forever doing nothing.
$null = $form.Handle
if (-not $form.Registered) {
  [System.Windows.Forms.MessageBox]::Show(
    "$Chord is already taken by another program, so Nimbus could not claim it. Install a different chord, for example:`n`n  install-nimbus-hotkey.ps1 -Hotkey ""Ctrl+Alt+Space""",
    "Nimbus") | Out-Null
  exit 1
}

[System.Windows.Forms.Application]::Run($form)
$mutex.ReleaseMutex()
