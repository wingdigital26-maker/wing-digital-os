# Nimbus on your machine

Phase 1 of the build spec: Nimbus a keystroke away, in his own window, with no
console box and nothing extra running in the background.

## Install (one command)

```powershell
powershell -ExecutionPolicy Bypass -File .\install-nimbus-hotkey.ps1
```

That creates a Start Menu shortcut whose hotkey is **Ctrl+Shift+N**. Windows
itself watches the key, so there is no daemon. Press it anywhere and Nimbus
opens in a frameless Chrome app window: **Nimbus alone, not the OS**, with his
panel filling the window and a small "Open the OS" link bottom right for when
you do want the full thing. Press it again while the window is behind something
and it comes to the front instead of opening a second one.

**No login.** The window carries a machine key (`NIMBUS_LOCAL_KEY` in
`.env.local`, generated on install) that opens the Nimbus page and his own API
and nothing else in the OS. The key exists only on this PC and the middleware
branch is skipped entirely on the cloud deploy, so the hosted OS still asks for
a password exactly as before. Clear it by deleting the line from `.env.local`.

**Two modes**, switched in the panel header:

* **Chat** is the OS tool set. He can read the whole business and every write
  stops at a confirmation card.
* **Agent** runs the turn through Claude Code on this PC, the same as a terminal
  session: he can read and change files and run commands. There are no
  confirmation cards in that mode, which is the trade for it being able to do
  real work. The choice is remembered per machine.

Undo: `powershell -File .\install-nimbus-hotkey.ps1 -Remove`

## Why not Ctrl+Space

Windows shortcut hotkeys have to include Ctrl+Shift or Ctrl+Alt, so Ctrl+Space
is not reachable without extra software. If you want that exact chord, install
AutoHotkey v2 and run `nimbus.ahk`, which toggles the window with Ctrl+Space.
Both routes end at the same `nimbus.vbs`.

## Files

| File | What it does |
| --- | --- |
| `install-nimbus-hotkey.ps1` | Creates or removes the hotkey shortcut. |
| `nimbus.vbs` | Hidden launcher. No console box, ever. |
| `nimbus.ps1` | Opens or focuses the app window. Says so plainly if the OS is not running. |
| `nimbus.ahk` | Optional Ctrl+Space toggle, needs AutoHotkey v2. |

Set `NIMBUS_PORT` if the OS is not on 3000.

## What it does not do

The window needs the OS running on this machine. If the OS is off, the script
says that instead of opening a blank window. Nimbus in the cloud keeps working
in a browser with the smaller toolset.
