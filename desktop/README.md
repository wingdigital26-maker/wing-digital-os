# Nimbus on your machine

Phase 1 of the build spec: Nimbus a keystroke away, in his own window, with no
console box and nothing extra running in the background.

## Install (one command)

```powershell
powershell -ExecutionPolicy Bypass -File .\install-nimbus-hotkey.ps1
```

That creates a Start Menu shortcut whose hotkey is **Ctrl+Shift+N**. Windows
itself watches the key, so there is no daemon. Press it anywhere and Nimbus
opens in a frameless Chrome app window at `localhost:3000/#nimbus`, with his
panel already up. Press it again while the window is behind something and it
comes to the front instead of opening a second one.

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
