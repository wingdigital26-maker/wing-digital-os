# Nimbus on your machine

Phase 1 of the build spec: Nimbus a keystroke away, in his own window, with no
console box.

## Install (one command)

```powershell
powershell -ExecutionPolicy Bypass -File .\install-nimbus-hotkey.ps1
```

That puts Nimbus on **Ctrl+Space**. Press it anywhere and he opens in a
frameless Chrome app window: **Nimbus alone, not the OS**, with his panel
filling the window and a small "Open the OS" link for when you do want the full
thing. Press it again while he is in front and he goes away.

Undo: `powershell -File .\install-nimbus-hotkey.ps1 -Remove`

**How Ctrl+Space works.** Windows shortcut hotkeys have to include Ctrl+Shift or
Ctrl+Alt, so Ctrl+Space cannot be a shortcut. A small listener
(`nimbus-hotkey.ps1`) claims the chord properly through RegisterHotKey and runs
hidden from a Startup shortcut. If something else already owns Ctrl+Space it
says so once and exits, rather than sitting there doing nothing. In that case
pick another chord:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-nimbus-hotkey.ps1 -Hotkey "Ctrl+Alt+Space"
```

Any `Ctrl+Shift+<letter>` or `Ctrl+Alt+<letter>` chord is installed the lighter
way instead, as a Start Menu shortcut Windows itself watches, with nothing
running in the background at all.

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

## Files

| File | What it does |
| --- | --- |
| `install-nimbus-hotkey.ps1` | Installs or removes the hotkey, either way. |
| `nimbus-hotkey.ps1` | The Ctrl+Space listener. Hidden message loop, toggles the window. |
| `nimbus-hotkey.vbs` | Starts the listener with no console box. |
| `nimbus.vbs` | Opens the window itself, also with no console box. |
| `nimbus.ps1` | Opens or focuses the app window. Says so plainly if the OS is not running. |
| `nimbus.ahk` | Optional AutoHotkey version of the same toggle, if you would rather use that. |

Set `NIMBUS_PORT` if the OS is not on 3000.

## What it does not do

The window needs the OS running on this machine. If the OS is off, the script
says that instead of opening a blank window. Nimbus in the cloud keeps working
in a browser with the smaller toolset.
