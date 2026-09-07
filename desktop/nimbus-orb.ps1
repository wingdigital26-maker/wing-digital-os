# Nimbus, always there.
#
# A small always-on-top orb that sits in the bottom right corner of the screen
# over whatever Jack is doing, the way a chat widget sits on a website. No
# taskbar button, no alt-tab entry, no window chrome. Click it to open the
# Nimbus window; right click it for the menu.
#
# It also watches. Every few minutes it asks the OS whether anything is broken.
# When the answer changes for the worse it shows a popup and wears an alert
# badge for five seconds, then settles back to calm, because an orb that is
# permanently alarmed stops meaning anything.
#
# Started at login by install-nimbus-hotkey.ps1. Stop it with that script's
# -Remove, or from the orb's own right-click menu.

param(
  [int]$PollSeconds = 300,
  [int]$Size = 68
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs  = Join-Path $here "nimbus.vbs"
$repo = Split-Path -Parent $here

# One orb only.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\WingNimbusOrb", [ref]$createdNew)
if (-not $createdNew) { exit 0 }

# The window key, read the same way nimbus.ps1 reads it and never printed.
$Key = $env:NIMBUS_LOCAL_KEY
if (-not $Key) {
  $envFile = Join-Path $repo ".env.local"
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*NIMBUS_LOCAL_KEY\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) { $Key = ($line.Line -split "=", 2)[1].Trim().Trim('"') }
  }
}
$Port = if ($env:NIMBUS_PORT) { $env:NIMBUS_PORT } else { "3000" }

# ── State ───────────────────────────────────────────────────────────────────
$script:problems  = $null    # $null means unknown, which is NOT the same as zero
$script:lastKnown = $null
$script:mood      = "calm"   # calm | alert | offline
$script:phase     = 0.0

# ── The window ──────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = "None"
$form.ShowInTaskbar   = $false      # no taskbar button, this is the whole point
$form.TopMost         = $true
$form.StartPosition   = "Manual"
$form.Width           = $Size
$form.Height          = $Size
$form.BackColor       = [System.Drawing.Color]::Black

# Bottom right, clear of the taskbar, with a small margin.
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $wa.Right - $Size - 18
$form.Top  = $wa.Bottom - $Size - 18

# Remembered position, so Jack can put it where he wants it once.
$posFile = Join-Path $env:LOCALAPPDATA "Nimbus\orb-position.txt"
if (Test-Path $posFile) {
  try {
    $xy = (Get-Content $posFile -Raw).Split(",")
    $x = [int]$xy[0]; $y = [int]$xy[1]
    # Only trust it if it is still on a screen; monitors get unplugged.
    if ($x -ge $wa.Left -and $x -lt $wa.Right -and $y -ge $wa.Top -and $y -lt $wa.Bottom) {
      $form.Left = $x; $form.Top = $y
    }
  } catch { }
}

# Keep it above full-screen apps without stealing focus when it repaints.
$sig = @'
using System;
using System.Runtime.InteropServices;
public class OrbWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int val);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool UpdateLayeredWindow(
      IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc,
      ref POINT pprSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION {
    public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat;
  }

  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint NOMOVE = 0x0002, NOSIZE = 0x0001, NOACTIVATE = 0x0010;
  const int GWL_EXSTYLE = -20;
  const int WS_EX_LAYERED = 0x00080000, WS_EX_TOOLWINDOW = 0x00000080;

  public static void Raise(IntPtr h) { SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE); }

  /// Layered for real alpha, and TOOLWINDOW so it never appears in alt-tab.
  public static void MakeLayered(IntPtr h) {
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_LAYERED | WS_EX_TOOLWINDOW);
  }

  /// Push an ARGB bitmap onto the window, alpha and all.
  public static void Paint(IntPtr hwnd, System.Drawing.Bitmap bmp, int x, int y) {
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(screen);
    IntPtr hBitmap = bmp.GetHbitmap(System.Drawing.Color.FromArgb(0));
    IntPtr old = SelectObject(mem, hBitmap);
    SIZE size; size.cx = bmp.Width; size.cy = bmp.Height;
    POINT src; src.X = 0; src.Y = 0;
    POINT pos; pos.X = x; pos.Y = y;
    BLENDFUNCTION blend;
    blend.BlendOp = 0;            // AC_SRC_OVER
    blend.BlendFlags = 0;
    blend.SourceConstantAlpha = 255;
    blend.AlphaFormat = 1;        // AC_SRC_ALPHA
    UpdateLayeredWindow(hwnd, screen, ref pos, ref size, mem, ref src, 0, ref blend, 2);
    SelectObject(mem, old);
    DeleteObject(hBitmap);
    DeleteDC(mem);
    ReleaseDC(IntPtr.Zero, screen);
  }
}
'@
if (-not ("OrbWin" -as [type])) { Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing }

# ── Drawing: the same character as the web orb, in GDI+ ─────────────────────
function Render-Orb {
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

  $pad = 7
  $d = $Size - ($pad * 2)
  $rect = New-Object System.Drawing.Rectangle($pad, $pad, $d, $d)

  # Breathing glow behind the core.
  $glowAlpha = [int](44 + 18 * [Math]::Sin($script:phase))
  $glowRect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
  $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glowPath.AddEllipse($glowRect)
  $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
  $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb($glowAlpha, 90, 140, 255)
  $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 90, 140, 255))
  $g.FillEllipse($glowBrush, $glowRect)

  # The core, lit from the upper left so it reads as a sphere.
  $corePath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $corePath.AddEllipse($rect)
  $core = New-Object System.Drawing.Drawing2D.PathGradientBrush($corePath)
  $core.CenterPoint = New-Object System.Drawing.PointF(($rect.X + $d * 0.36), ($rect.Y + $d * 0.32))
  $core.CenterColor = [System.Drawing.Color]::FromArgb(255, 150, 185, 255)
  $core.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 22, 44, 118))
  $g.FillEllipse($core, $rect)

  # Atmosphere rim. Warm when something needs attention, the same language the
  # web orb uses, grey when the status could not be read at all.
  $rimColor = if ($script:mood -eq "alert") {
    [System.Drawing.Color]::FromArgb(210, 240, 180, 120)
  } elseif ($script:mood -eq "offline") {
    [System.Drawing.Color]::FromArgb(130, 130, 140, 160)
  } else {
    [System.Drawing.Color]::FromArgb(160, 130, 170, 255)
  }
  $pen = New-Object System.Drawing.Pen($rimColor, 1.7)
  $g.DrawEllipse($pen, $rect)

  # Eyes.
  $eyeW = [Math]::Max(3, [int]($d * 0.11))
  $eyeH = [Math]::Max(6, [int]($d * 0.27))
  $eyeY = $rect.Y + [int]($d * 0.33)
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242, 245, 250, 255))
  $g.FillEllipse($white, ($rect.X + [int]($d * 0.30)), $eyeY, $eyeW, $eyeH)
  $g.FillEllipse($white, ($rect.X + [int]($d * 0.57)), $eyeY, $eyeW, $eyeH)

  # Orbit ring, tilted, slowly turning.
  $ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 190, 210, 255), 1.3)
  $state = $g.Save()
  $g.TranslateTransform(($Size / 2), ($Size / 2))
  $g.RotateTransform((-24 + 14 * [Math]::Sin($script:phase * 0.35)))
  $g.DrawEllipse($ringPen, (-$d / 2 - 2), (-$d / 5), ($d + 4), ($d / 2.5))
  $g.Restore($state)

  # The badge is only ever drawn from a number that was really read. Unknown
  # stays unknown: no badge, grey rim.
  if ($null -ne $script:problems -and $script:problems -gt 0) {
    $bd = [int]($Size * 0.32)
    $bx = $Size - $bd - 1
    $by = 0
    $amber = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 232, 163, 61))
    $g.FillEllipse($amber, $bx, $by, $bd, $bd)
    $font = New-Object System.Drawing.Font("Segoe UI", ($bd * 0.55), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $text = if ($script:problems -gt 9) { "9+" } else { [string]$script:problems }
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = "Center"; $sf.LineAlignment = "Center"
    $g.DrawString($text, $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($bx, $by, $bd, $bd)), $sf)
    $font.Dispose()
  }

  $g.Dispose()
  try { [OrbWin]::Paint($form.Handle, $bmp, $form.Left, $form.Top) } catch { }
  $bmp.Dispose()
}

$form.Add_Shown({ [OrbWin]::MakeLayered($form.Handle); Render-Orb })

# ── Breathing, and the five second decay back to calm ───────────────────────
$anim = New-Object System.Windows.Forms.Timer
$anim.Interval = 120
$anim.Add_Tick({
  $script:phase += 0.12
  if ($script:moodUntil -and (Get-Date) -gt $script:moodUntil) {
    # Wear the feeling, then let it go.
    $script:mood = if ($script:problems -gt 0) { "calm" } else { "calm" }
    $script:moodUntil = $null
  }
  Render-Orb
})
$anim.Start()

# ── The watch ───────────────────────────────────────────────────────────────
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $false   # only ever shown to carry a balloon, never as a tray icon

function Show-Popup([string]$title, [string]$text) {
  try {
    $notify.Visible = $true
    $notify.BalloonTipTitle = $title
    $notify.BalloonTipText = $text
    $notify.ShowBalloonTip(6000)
  } catch { }
}

function Poll-Status {
  if (-not $Key) { return }
  try {
    $u = "http://localhost:$Port/api/nimbus/glance"
    $req = [System.Net.HttpWebRequest]::Create($u)
    $req.Timeout = 12000
    $req.Headers.Add("Cookie", "nimbus_local=$Key")
    $res = $req.GetResponse()
    $body = (New-Object System.IO.StreamReader($res.GetResponseStream())).ReadToEnd()
    $res.Close()
    $json = $body | ConvertFrom-Json

    # NULL means the check could not be read. That is not zero, and it must not
    # be drawn as a clean orb.
    if ($null -eq $json.watch) {
      $script:problems = $null
      $script:mood = "offline"
      Render-Orb
      return
    }
    $n = [int]$json.watch.problems
    $was = $script:lastKnown
    $script:problems = $n
    $script:lastKnown = $n

    if ($n -gt 0 -and ($null -eq $was -or $n -gt $was)) {
      # Only popup when it got worse, so a standing problem does not nag.
      $script:mood = "alert"
      $script:moodUntil = (Get-Date).AddSeconds(5)
      $word = if ($n -eq 1) { "1 thing needs" } else { "$n things need" }
      Show-Popup "Nimbus" "$word attention. Click the orb to see them."
    } elseif ($script:mood -eq "offline") {
      $script:mood = "calm"
    }
    Render-Orb
  } catch {
    $script:problems = $null
    $script:mood = "offline"
    Render-Orb
  }
}

$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = [Math]::Max(30, $PollSeconds) * 1000
$poll.Add_Tick({ Poll-Status })
$poll.Start()

# First read shortly after login, once the OS has had a chance to come up.
$first = New-Object System.Windows.Forms.Timer
$first.Interval = 20000
$first.Add_Tick({ $first.Stop(); Poll-Status })
$first.Start()

# ── Interaction ─────────────────────────────────────────────────────────────
function Open-Nimbus([string]$hash) {
  $env:NIMBUS_OPEN_HASH = $hash
  Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$vbs""" -WindowStyle Hidden
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Open Nimbus", $null, { Open-Nimbus "" })
[void]$menu.Items.Add("Show problems", $null, { Open-Nimbus "#problems" })
[void]$menu.Items.Add("Check now", $null, { Poll-Status })
[void]$menu.Items.Add("-")
[void]$menu.Items.Add("Quit the orb", $null, {
  $anim.Stop(); $poll.Stop(); $notify.Visible = $false; $form.Close()
})
$form.ContextMenuStrip = $menu

$script:drag = $false
$script:dragFrom = New-Object System.Drawing.Point(0, 0)
$script:moved = $false
$form.Add_MouseDown({
  param($s, $e)
  if ($e.Button -eq "Left") {
    $script:drag = $true
    $script:moved = $false
    $script:dragFrom = $e.Location
  }
})
$form.Add_MouseMove({
  param($s, $e)
  if ($script:drag) {
    $dx = $e.X - $script:dragFrom.X
    $dy = $e.Y - $script:dragFrom.Y
    if ([Math]::Abs($dx) + [Math]::Abs($dy) -gt 3) { $script:moved = $true }
    $form.Left += $dx
    $form.Top += $dy
  }
})
$form.Add_MouseUp({
  param($s, $e)
  if ($e.Button -ne "Left") { return }
  $script:drag = $false
  if ($script:moved) {
    try {
      New-Item -ItemType Directory -Force -Path (Split-Path $posFile) | Out-Null
      "$($form.Left),$($form.Top)" | Out-File -FilePath $posFile -Encoding utf8 -Force
    } catch { }
    return
  }
  # A click, not a drag: open him, on the problems list when there are any.
  if ($script:problems -ne $null -and $script:problems -gt 0) { Open-Nimbus "#problems" } else { Open-Nimbus "" }
})

$notify.Add_BalloonTipClicked({ Open-Nimbus "#problems" })

# Windows drops a topmost window behind full-screen apps now and then; nudge it.
$raise = New-Object System.Windows.Forms.Timer
$raise.Interval = 15000
$raise.Add_Tick({ try { [OrbWin]::Raise($form.Handle) } catch { } })
$raise.Start()

$form.Add_FormClosed({ try { $notify.Dispose() } catch { } })

[System.Windows.Forms.Application]::Run($form)
$mutex.ReleaseMutex()
