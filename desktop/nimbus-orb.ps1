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
  [int]$PollSeconds = 90,
  [int]$Size = 68
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  delegate bool EnumProc(IntPtr h, IntPtr p);
  const int SW_HIDE = 0, SW_SHOW = 5, SW_RESTORE = 9;

  /// The Nimbus window, if one exists. Title match, because it is a Chrome app
  /// window and has no class of its own worth keying on.
  public static IntPtr FindNimbus() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var sb = new System.Text.StringBuilder(256);
      GetWindowText(h, sb, sb.Capacity);
      string t = sb.ToString();
      if (t.Length > 0 && t.IndexOf("Nimbus", StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /// Show and focus an existing window. Returns false when there is none, and
  /// the caller falls back to launching one.
  public static bool ShowNimbus() {
    IntPtr h = FindNimbus();
    if (h == IntPtr.Zero || !IsWindow(h)) return false;
    // A hidden window needs SW_SHOW; SW_RESTORE alone leaves it hidden.
    ShowWindow(h, IsIconic(h) ? SW_RESTORE : SW_SHOW);
    SetForegroundWindow(h);
    return true;
  }

  /// True when Nimbus is the window the user is looking at.
  public static bool NimbusInFront() {
    IntPtr h = FindNimbus();
    return h != IntPtr.Zero && h == GetForegroundWindow();
  }

  public static bool HideNimbus() {
    IntPtr h = FindNimbus();
    if (h == IntPtr.Zero) return false;
    ShowWindow(h, SW_HIDE);
    return true;
  }

  /// Layered for real alpha, and TOOLWINDOW so it never appears in alt-tab.
  public static void MakeLayered(IntPtr h) {
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_LAYERED | WS_EX_TOOLWINDOW);
  }

  /// Push an ARGB bitmap onto the window, alpha and all.
  ///
  /// UpdateLayeredWindow with AC_SRC_ALPHA requires PREMULTIPLIED alpha, and
  /// GDI+ hands back straight alpha. Skip this step and the window draws
  /// nothing at all, which is exactly what happened the first time.
  static System.Drawing.Bitmap Premultiply(System.Drawing.Bitmap src) {
    var rect = new System.Drawing.Rectangle(0, 0, src.Width, src.Height);
    var copy = new System.Drawing.Bitmap(src.Width, src.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    var s = src.LockBits(rect, System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    var d = copy.LockBits(rect, System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    int n = src.Width * src.Height * 4;
    byte[] buf = new byte[n];
    Marshal.Copy(s.Scan0, buf, 0, n);
    for (int i = 0; i < n; i += 4) {
      int a = buf[i + 3];
      buf[i] = (byte)(buf[i] * a / 255);
      buf[i + 1] = (byte)(buf[i + 1] * a / 255);
      buf[i + 2] = (byte)(buf[i + 2] * a / 255);
    }
    Marshal.Copy(buf, 0, d.Scan0, n);
    src.UnlockBits(s);
    copy.UnlockBits(d);
    return copy;
  }

  /// Bake a bitmap into a premultiplied GDI handle. Done once per frame, at
  /// startup, so the animation loop never touches pixels again.
  public static IntPtr Bake(System.Drawing.Bitmap bmp) {
    System.Drawing.Bitmap pm = Premultiply(bmp);
    IntPtr h = pm.GetHbitmap(System.Drawing.Color.FromArgb(0));
    pm.Dispose();
    return h;
  }

  public static void Free(IntPtr hBitmap) {
    if (hBitmap != IntPtr.Zero) DeleteObject(hBitmap);
  }

  /// Show an already baked frame. This is the whole per-frame cost.
  public static void PaintBaked(IntPtr hwnd, IntPtr hBitmap, int w, int h, int x, int y) {
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(screen);
    IntPtr old = SelectObject(mem, hBitmap);
    SIZE size; size.cx = w; size.cy = h;
    POINT src; src.X = 0; src.Y = 0;
    POINT pos; pos.X = x; pos.Y = y;
    BLENDFUNCTION blend;
    blend.BlendOp = 0;
    blend.BlendFlags = 0;
    blend.SourceConstantAlpha = 255;
    blend.AlphaFormat = 1;
    UpdateLayeredWindow(hwnd, screen, ref pos, ref size, mem, ref src, 0, ref blend, 2);
    SelectObject(mem, old);
    DeleteDC(mem);
    ReleaseDC(IntPtr.Zero, screen);
  }
}
'@
if (-not ("OrbWin" -as [type])) { Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing }

# ── Drawing ─────────────────────────────────────────────────────────────────
#
# Every frame of the loop is baked ONCE, at startup, into a small film strip of
# premultiplied bitmaps. The timer then does nothing but hand the next one to
# the window. Drawing a sphere with gradients, a blurred glow and two rings
# thirty times a second in GDI+ is what made the first version drag; blitting a
# ready-made bitmap costs almost nothing.
#
# The artwork is drawn at 4x and scaled down with a high quality filter, which
# is where the clean edges come from: GDI+ anti-aliasing alone is coarse at
# 68px, and this orb is mostly curves.

$FrameCount = 36          # one full breath, and one slow ring revolution
$SS     = 4           # supersample factor

# frames[mood + ":" + badge] -> Bitmap[]. Rebuilt only when the state changes.
$script:strip    = @{}
$script:stripKey = ""
$script:frame    = 0

function New-OrbFrame([int]$i, [string]$mood, $badge) {
  $big = $Size * $SS
  $bmp = New-Object System.Drawing.Bitmap($big, $big, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

  $t = ($i / $FrameCount) * 2 * [Math]::PI
  $breath = [Math]::Sin($t)

  # Colours per mood. Alert warms the rim and the glow, it never repaints the
  # core red: this is Nimbus paying attention, not Nimbus broken.
  $warm = $mood -eq "alert"
  $dim  = $mood -eq "offline"

  $pad = [int]($big * 0.175)
  $d = $big - ($pad * 2)
  $rect = New-Object System.Drawing.Rectangle($pad, $pad, $d, $d)
  $cx = $big / 2.0
  $cy = $big / 2.0

  # 1. Outer glow. Two passes: a wide soft halo and a tighter brighter one, so
  #    the falloff is not the single flat ramp a lone gradient gives.
  $glowA = if ($dim) { 26 } elseif ($warm) { 74 } else { 58 }
  $glowA = [int]($glowA + 12 * $breath)
  $glowCol = if ($warm) { [System.Drawing.Color]::FromArgb($glowA, 235, 165, 90) }
             elseif ($dim) { [System.Drawing.Color]::FromArgb($glowA, 120, 132, 156) }
             else { [System.Drawing.Color]::FromArgb($glowA, 90, 140, 255) }
  foreach ($spread in @(1.0, 0.72)) {
    $gw = [int]($big * $spread)
    $gr = New-Object System.Drawing.Rectangle([int]($cx - $gw / 2), [int]($cy - $gw / 2), $gw, $gw)
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddEllipse($gr)
    $gb = New-Object System.Drawing.Drawing2D.PathGradientBrush($gp)
    $gb.CenterColor = $glowCol
    $gb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $glowCol.R, $glowCol.G, $glowCol.B))
    $gb.FocusScales = New-Object System.Drawing.PointF(0.28, 0.28)
    $g.FillEllipse($gb, $gr)
    $gb.Dispose(); $gp.Dispose()
  }

  # 2. The back half of the orbit ring, so the sphere sits INSIDE the orbit
  #    rather than on top of a flat hoop. Two rings, counter turning.
  $ringCol = if ($warm) { [System.Drawing.Color]::FromArgb(150, 240, 205, 150) }
             elseif ($dim) { [System.Drawing.Color]::FromArgb(70, 150, 160, 185) }
             else { [System.Drawing.Color]::FromArgb(120, 175, 205, 255) }
  $ringSpec = @(
    @{ tilt = -22.0; rw = 1.30; rh = 0.46; speed = 1.0 },
    @{ tilt = 28.0;  rw = 1.16; rh = 0.34; speed = -0.62 }
  )
  function Draw-Ring($g, $spec, $t, $cx, $cy, $d, $col, $half) {
    $st = $g.Save()
    $g.TranslateTransform($cx, $cy)
    $g.RotateTransform($spec.tilt + 22 * [Math]::Sin($t * $spec.speed))
    $rw = $d * $spec.rw
    $rh = $d * $spec.rh
    $pen = New-Object System.Drawing.Pen($col, ($SS * 1.25))
    $r = New-Object System.Drawing.RectangleF((-$rw / 2), (-$rh / 2), $rw, $rh)
    if ($half -eq "back") { $g.DrawArc($pen, $r, 180, 180) } else { $g.DrawArc($pen, $r, 0, 180) }
    $pen.Dispose()
    $g.Restore($st)
  }
  foreach ($spec in $ringSpec) { Draw-Ring $g $spec $t $cx $cy $d $ringCol "back" }

  # 3. The sphere. A radial gradient offset to the upper left for the lit side,
  #    then a darkened lower right limb, then a specular gleam. Three cheap
  #    layers that read as one lit ball.
  $core = New-Object System.Drawing.Drawing2D.GraphicsPath
  $core.AddEllipse($rect)
  $cb = New-Object System.Drawing.Drawing2D.PathGradientBrush($core)
  $cb.CenterPoint = New-Object System.Drawing.PointF(($rect.X + $d * 0.34), ($rect.Y + $d * 0.30))
  if ($dim) {
    $cb.CenterColor = [System.Drawing.Color]::FromArgb(255, 108, 122, 150)
    $cb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 26, 34, 52))
  } else {
    $cb.CenterColor = [System.Drawing.Color]::FromArgb(255, 190, 214, 255)
    $cb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 46, 84, 205))
  }
  $g.FillEllipse($cb, $rect)
  $cb.Dispose(); $core.Dispose()

  # Limb darkening on the far side.
  $limb = New-Object System.Drawing.Drawing2D.GraphicsPath
  $limb.AddEllipse($rect)
  $lb = New-Object System.Drawing.Drawing2D.PathGradientBrush($limb)
  $lb.CenterPoint = New-Object System.Drawing.PointF(($rect.X + $d * 0.72), ($rect.Y + $d * 0.76))
  $lb.CenterColor = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)
  $lb.SurroundColors = @([System.Drawing.Color]::FromArgb(88, 6, 14, 40))
  $g.FillEllipse($lb, $rect)
  $lb.Dispose(); $limb.Dispose()

  # Specular gleam, breathing very slightly.
  $spec = 0.30 + 0.03 * $breath
  $sw = $d * $spec
  $sh = $d * ($spec * 0.62)
  $sr = New-Object System.Drawing.RectangleF(($rect.X + $d * 0.20), ($rect.Y + $d * 0.14), $sw, $sh)
  $sp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sp.AddEllipse($sr)
  $sb2 = New-Object System.Drawing.Drawing2D.PathGradientBrush($sp)
  $sb2.CenterColor = [System.Drawing.Color]::FromArgb(150, 255, 255, 255)
  $sb2.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
  $g.FillEllipse($sb2, $sr)
  $sb2.Dispose(); $sp.Dispose()

  # 4. Atmosphere rim: a lit edge, warm when something needs attention.
  $rimCol = if ($warm) { [System.Drawing.Color]::FromArgb(225, 245, 190, 125) }
            elseif ($dim) { [System.Drawing.Color]::FromArgb(120, 150, 162, 190) }
            else { [System.Drawing.Color]::FromArgb(175, 150, 190, 255) }
  $rp = New-Object System.Drawing.Pen($rimCol, ($SS * 1.1))
  $g.DrawEllipse($rp, $rect)
  $rp.Dispose()

  # 5. Eyes, with a soft glow behind each so they read as lit rather than
  #    painted on. Blink on two frames of the cycle.
  $blink = ($i -eq 8 -or $i -eq 9)
  $eyeW = $d * 0.115
  $eyeH = if ($blink) { $d * 0.035 } else { $d * 0.275 }
  $eyeY = $rect.Y + $d * 0.34 + (($d * 0.275 - $eyeH) / 2)
  foreach ($ex in @(0.295, 0.59)) {
    $x = $rect.X + $d * $ex
    $halo = New-Object System.Drawing.RectangleF(($x - $eyeW * 0.7), ($eyeY - $eyeH * 0.35), ($eyeW * 2.4), ($eyeH * 1.7))
    $hp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $hp.AddEllipse($halo)
    $hb = New-Object System.Drawing.Drawing2D.PathGradientBrush($hp)
    $hb.CenterColor = [System.Drawing.Color]::FromArgb(90, 200, 225, 255)
    $hb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 200, 225, 255))
    $g.FillEllipse($hb, $halo)
    $hb.Dispose(); $hp.Dispose()
    $eb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(246, 248, 252, 255))
    $g.FillEllipse($eb, (New-Object System.Drawing.RectangleF($x, $eyeY, $eyeW, $eyeH)))
    $eb.Dispose()
  }

  # 6. The front half of the rings, over the sphere, with a travelling dot.
  foreach ($spec2 in $ringSpec) {
    Draw-Ring $g $spec2 $t $cx $cy $d $ringCol "front"
    $st = $g.Save()
    $g.TranslateTransform($cx, $cy)
    $g.RotateTransform($spec2.tilt + 22 * [Math]::Sin($t * $spec2.speed))
    $ang = $t * 2 * $spec2.speed
    $dx = ($d * $spec2.rw / 2) * [Math]::Cos($ang)
    $dy = ($d * $spec2.rh / 2) * [Math]::Sin($ang)
    $dot = $SS * 2.2
    $db = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 225, 238, 255))
    $g.FillEllipse($db, ($dx - $dot / 2), ($dy - $dot / 2), $dot, $dot)
    $db.Dispose()
    $g.Restore($st)
  }

  # 7. The badge. Only ever drawn from a count that was really read.
  if ($null -ne $badge -and $badge -gt 0) {
    $bd = [int]($big * 0.34)
    $bx = $big - $bd - [int]($big * 0.02)
    $by = [int]($big * 0.01)
    $br = New-Object System.Drawing.Rectangle($bx, $by, $bd, $bd)
    $shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, 0, 0, 0))
    $g.FillEllipse($shadow, ($bx + $SS), ($by + $SS), $bd, $bd)
    $shadow.Dispose()
    $bp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bp.AddEllipse($br)
    $bb = New-Object System.Drawing.Drawing2D.PathGradientBrush($bp)
    $bb.CenterPoint = New-Object System.Drawing.PointF(($bx + $bd * 0.35), ($by + $bd * 0.3))
    $bb.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 205, 120)
    $bb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 226, 146, 40))
    $g.FillEllipse($bb, $br)
    $bb.Dispose(); $bp.Dispose()
    $text = if ($badge -gt 9) { "9+" } else { [string]$badge }
    $font = New-Object System.Drawing.Font("Segoe UI", ($bd * 0.56), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $tb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 40, 26, 4))
    $g.DrawString($text, $font, $tb, (New-Object System.Drawing.RectangleF($bx, $by, $bd, $bd)), $sf)
    $tb.Dispose(); $font.Dispose(); $sf.Dispose()
  }
  $g.Dispose()

  # Down to real size with a good filter. This is what makes it look drawn
  # rather than plotted.
  $out = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $og = [System.Drawing.Graphics]::FromImage($out)
  $og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $og.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $og.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $og.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)))
  $og.Dispose()
  $bmp.Dispose()
  return $out
}

# PowerShell hands back an Object[] for some JSON shapes, and comparing that to
# a number throws. Everything that reads the count goes through here.
function Get-Count {
  if ($null -eq $script:problems) { return $null }
  $v = @($script:problems)[0]
  if ($null -eq $v) { return $null }
  try { return [int]$v } catch { return $null }
}

function Get-Strip {
  $n = Get-Count
  $badge = if ($null -ne $n -and $n -gt 0) { $n } else { 0 }
  $key = "$($script:mood):$badge"
  if ($script:stripKey -eq $key -and $script:strip.ContainsKey($key)) { return $script:strip[$key] }
  if (-not $script:strip.ContainsKey($key)) {
    $frames = New-Object 'System.Collections.Generic.List[System.IntPtr]'
    for ($i = 0; $i -lt $FrameCount; $i++) {
      $f = @(New-OrbFrame $i $script:mood $badge)[-1]
      $frames.Add([OrbWin]::Bake($f))
      $f.Dispose()
    }
    # Only a handful of states ever occur (three moods x a small badge count),
    # but do not let the cache grow without limit if the count keeps changing.
    if ($script:strip.Count -ge 6) {
      foreach ($k in @($script:strip.Keys)) {
        if ($k -ne $key) { foreach ($f in $script:strip[$k]) { [OrbWin]::Free($f) }; $script:strip.Remove($k); break }
      }
    }
    $script:strip[$key] = $frames
  }
  $script:stripKey = $key
  return $script:strip[$key]
}

# Anything that goes wrong in a WinForms event handler is swallowed silently,
# which is how an invisible orb happened twice. Failures land in this file.
$script:logPath = Join-Path $env:LOCALAPPDATA "Nimbus\orb.log"
function Write-OrbLog([string]$msg) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $script:logPath) | Out-Null
    Add-Content -Path $script:logPath -Value ("{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $msg)
  } catch { }
}

function Render-Orb {
  try {
    $frames = Get-Strip
    $h = $frames[$script:frame % $FrameCount]
    if ($null -eq $h -or $h -eq [IntPtr]::Zero) { Write-OrbLog "no frame at index $($script:frame % $FrameCount)"; return }
    [OrbWin]::PaintBaked($form.Handle, $h, $Size, $Size, $form.Left, $form.Top)
  } catch {
    Write-OrbLog ("render failed at [" + $_.InvocationInfo.Line.Trim() + "] line " + $_.InvocationInfo.ScriptLineNumber + ": " + $_.Exception.Message)
  }
}

$form.Add_HandleCreated({ [OrbWin]::MakeLayered($form.Handle) })
$form.Add_Shown({
  [OrbWin]::MakeLayered($form.Handle)
  Render-Orb
})

# ── The loop ────────────────────────────────────────────────────────────────
# 20 frames a second while there is something to animate. When Nimbus is calm
# and nothing is wrong he still breathes, so the strip keeps playing, but every
# tick is one blit of a bitmap that already exists.
$anim = New-Object System.Windows.Forms.Timer
$anim.Interval = 83
$anim.Add_Tick({
  $script:frame++
  if ($script:moodUntil -and (Get-Date) -gt $script:moodUntil) {
    # Wear the feeling, then let it go. The badge stays, because the count is a
    # fact; the mood is just how he is holding it.
    $script:mood = "calm"
    $script:moodUntil = $null
  }
  Render-Orb
})
$anim.Start()

# ── The watch ───────────────────────────────────────────────────────────────
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $false   # only ever shown to carry a balloon, never as a tray icon

$script:toast = $null
$script:toastTimer = $null

function Show-Popup([string]$title, [string]$text) {
  try {
    if ($script:toast -and -not $script:toast.IsDisposed) { $script:toast.Close(); $script:toast = $null }

    # This process is per-monitor DPI aware, so window sizes are real pixels
    # while point-sized fonts are scaled by Windows. Mixing the two is what made
    # the first toast overlap its own title. Everything below is in pixels, and
    # the whole card is scaled by the display's factor.
    $tmp = New-Object System.Drawing.Bitmap(1, 1)
    $gg = [System.Drawing.Graphics]::FromImage($tmp)
    $scale = $gg.DpiX / 96.0
    $gg.Dispose(); $tmp.Dispose()
    if ($scale -lt 1) { $scale = 1 }

    $padX = [int](14 * $scale)
    $w = [int](330 * $scale)

    $t = New-Object System.Windows.Forms.Form
    $t.FormBorderStyle = "None"
    $t.ShowInTaskbar = $false
    $t.TopMost = $true
    $t.StartPosition = "Manual"
    $t.BackColor = [System.Drawing.Color]::FromArgb(11, 15, 22)
    $t.Width = $w

    $headFont = New-Object System.Drawing.Font("Segoe UI Semibold", (12.5 * $scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $bodyFont = New-Object System.Drawing.Font("Segoe UI", (13 * $scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

    $head = New-Object System.Windows.Forms.Label
    $head.Text = $title
    $head.ForeColor = [System.Drawing.Color]::FromArgb(150, 182, 255)
    $head.Font = $headFont
    $head.AutoSize = $false
    $head.BackColor = [System.Drawing.Color]::Transparent
    $head.SetBounds($padX, [int](12 * $scale), ($w - $padX * 2), [int](18 * $scale))
    $t.Controls.Add($head)

    # Measure the body so the card is exactly as tall as the words need, and
    # nothing is ever cut off mid sentence.
    $tmp2 = New-Object System.Drawing.Bitmap(1, 1)
    $g2 = [System.Drawing.Graphics]::FromImage($tmp2)
    $measured = $g2.MeasureString($text, $bodyFont, ($w - $padX * 2))
    $g2.Dispose(); $tmp2.Dispose()
    $bodyH = [int]([Math]::Ceiling($measured.Height)) + [int](4 * $scale)

    $body = New-Object System.Windows.Forms.Label
    $body.Text = $text
    $body.ForeColor = [System.Drawing.Color]::FromArgb(210, 218, 234)
    $body.Font = $bodyFont
    $body.AutoSize = $false
    $body.BackColor = [System.Drawing.Color]::Transparent
    $body.SetBounds($padX, [int](34 * $scale), ($w - $padX * 2), $bodyH)
    $t.Controls.Add($body)

    $t.Height = [int](34 * $scale) + $bodyH + [int](14 * $scale)

    $t.Add_Paint({
      param($snd, $e)
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 110, 200), 1)
      $e.Graphics.DrawRectangle($pen, 0, 0, ($snd.Width - 1), ($snd.Height - 1))
      $pen.Dispose()
    })

    # Rounded corners, so it reads as Nimbus rather than as a system dialog.
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [int](14 * $scale)
    $path.AddArc(0, 0, $r, $r, 180, 90)
    $path.AddArc(($t.Width - $r), 0, $r, $r, 270, 90)
    $path.AddArc(($t.Width - $r), ($t.Height - $r), $r, $r, 0, 90)
    $path.AddArc(0, ($t.Height - $r), $r, $r, 90, 90)
    $path.CloseFigure()
    $t.Region = New-Object System.Drawing.Region($path)

    # Just above the orb, and never hanging off the screen.
    $wa2 = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $tx = [Math]::Min([Math]::Max(($form.Left + $Size - $t.Width), ($wa2.Left + 8)), ($wa2.Right - $t.Width - 8))
    $ty = [Math]::Max(($form.Top - $t.Height - [int](10 * $scale)), ($wa2.Top + 8))
    $t.Location = New-Object System.Drawing.Point($tx, $ty)

    $openList = {
      Open-Nimbus "#problems"
      try { if ($script:toast -and -not $script:toast.IsDisposed) { $script:toast.Close(); $script:toast = $null } } catch { }
    }
    $t.Add_Click($openList)
    $head.Add_Click($openList)
    $body.Add_Click($openList)

    $t.Show()
    try { [OrbWin]::Raise($t.Handle) } catch { }
    $script:toast = $t

    if ($script:toastTimer) { $script:toastTimer.Stop() }
    $script:toastTimer = New-Object System.Windows.Forms.Timer
    $script:toastTimer.Interval = 10000
    $script:toastTimer.Add_Tick({
      $script:toastTimer.Stop()
      try { if ($script:toast -and -not $script:toast.IsDisposed) { $script:toast.Close(); $script:toast = $null } } catch { }
    })
    $script:toastTimer.Start()
  } catch {
    Write-OrbLog ("toast failed: " + $_.Exception.Message)
  }
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
    $n = [int](@($json.watch.problems)[0])
    $was = $script:lastKnown
    $script:problems = $n
    $script:lastKnown = $n

    if ($n -gt 0 -and ($null -eq $was -or $n -gt $was)) {
      # Only speak up when it got WORSE. A standing problem keeps its badge and
      # stops nagging; a new one is what deserves interrupting Jack.
      $script:mood = "alert"
      $script:moodUntil = (Get-Date).AddSeconds(5)
      $label = ""
      try {
        $newest = @($json.watch.newest)[0]
        if ($newest) { $label = [string]$newest }
      } catch { }
      $word = if ($n -eq 1) { "1 thing needs attention" } else { "$n things need attention" }
      $text = if ($label) { "$label. ($word in total.)" } else { "$word. Click to see them." }
      Show-Popup "Something just broke" $text
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
  # An existing window is shown directly from this process, which is instant.
  # Only a missing window pays for a launch.
  try { if ([OrbWin]::ShowNimbus()) { return } } catch { }
  $env:NIMBUS_OPEN_HASH = $hash
  Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$vbs""" -WindowStyle Hidden
}

# Open one quietly in the background a little after login and hide it, so the
# first real click is as fast as every click after it. Costs one idle Chrome
# window; set NIMBUS_NO_PREWARM=1 to skip it.
$prewarm = New-Object System.Windows.Forms.Timer
$prewarm.Interval = 45000
$prewarm.Add_Tick({
  $prewarm.Stop()
  if ($env:NIMBUS_NO_PREWARM -eq "1") { return }
  try {
    if ([OrbWin]::FindNimbus() -ne [IntPtr]::Zero) { return }
    $env:NIMBUS_OPEN_HASH = ""
    Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$vbs""" -WindowStyle Hidden
    # Give it time to draw once, then put it away until it is wanted.
    $hide = New-Object System.Windows.Forms.Timer
    $hide.Interval = 9000
    $hide.Add_Tick({ $hide.Stop(); try { [void][OrbWin]::HideNimbus() } catch { } })
    $hide.Start()
  } catch {
    Write-OrbLog "prewarm failed"
  }
})
$prewarm.Start()

# Closing the window with its X quits Chrome, and the next click would pay the
# full launch again. Keep exactly one window ready at all times: if none exists,
# open one hidden. Jack never sees it happen, and every click stays instant.
$keepwarm = New-Object System.Windows.Forms.Timer
$keepwarm.Interval = 60000
$keepwarm.Add_Tick({
  if ($env:NIMBUS_NO_PREWARM -eq "1") { return }
  try {
    if ([OrbWin]::FindNimbus() -ne [IntPtr]::Zero) { return }
    $env:NIMBUS_OPEN_HASH = ""
    Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$vbs""" -WindowStyle Hidden
    $hide2 = New-Object System.Windows.Forms.Timer
    $hide2.Interval = 9000
    $hide2.Add_Tick({ $hide2.Stop(); try { [void][OrbWin]::HideNimbus() } catch { } })
    $hide2.Start()
  } catch {
    Write-OrbLog "keepwarm failed"
  }
})
$keepwarm.Start()

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

$form.Add_FormClosed({
  try { $notify.Dispose() } catch { }
  # GDI handles are not garbage collected, so give them back explicitly.
  try { foreach ($k in @($script:strip.Keys)) { foreach ($f in $script:strip[$k]) { [OrbWin]::Free($f) } } } catch { }
})

[System.Windows.Forms.Application]::Run($form)
$mutex.ReleaseMutex()
