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

## The orb

After installing, a small Nimbus sits in the bottom right corner of the screen,
over whatever you are doing, the way a chat widget sits on a website. No taskbar
button and no alt-tab entry.

* **Click it** to open the Nimbus window. When something is broken it opens
  straight onto the problems list.
* **Right click it** for Open, Show problems, Check now, and Quit.
* **Drag it** anywhere; it remembers where you put it.
* It checks the OS every five minutes. When something NEW breaks it shows a
  popup and wears an amber badge with the count, then settles back to calm after
  five seconds. A standing problem keeps its badge but stops nagging.
* A grey rim means the status could not be read at all. That is different from
  a clean orb, on purpose: unknown is never drawn as fine.

The Nimbus window itself no longer takes a taskbar button either, since the orb
is the permanent presence. Set `NIMBUS_TASKBAR=1` if you want the button back.

## Handling problems

The window's problems list is the thing to open when something is wrong. Each
problem shows what broke, the suggested fix, and three buttons:

* **Look into it** hands it to Nimbus. He investigates on this PC, fixes what is
  safe to fix, and reports what he found with the steps he took.
* **Ask me** takes it into the chat.
* The third button opens the part of the OS where the problem lives.

What he will not do on his own, whatever he concludes: send anything to a real
person, arm or unpause a sender, spend money, delete data, push, deploy, or
touch a client's live site. Those come back as "Needs you" with the exact
command. A fix he cannot show evidence for is reported as needing your eyes, not
as done.

## Files

| File | What it does |
| --- | --- |
| `install-nimbus-hotkey.ps1` | Installs or removes the hotkey, either way. |
| `nimbus-hotkey.ps1` | The Ctrl+Space listener. Hidden message loop, toggles the window. |
| `nimbus-hotkey.vbs` | Starts the listener with no console box. |
| `nimbus.vbs` | Opens the window itself, also with no console box. |
| `nimbus.ps1` | Opens or focuses the app window. Says so plainly if the OS is not running. |
| `nimbus-orb.ps1` | The always-there orb: draws it, watches for problems, shows the popup. |
| `nimbus-orb.vbs` | Starts the orb with no console box. |
| `nimbus.ahk` | Optional AutoHotkey version of the same toggle, if you would rather use that. |

Set `NIMBUS_PORT` if the OS is not on 3000.

## What it does not do

The window needs the OS running on this machine. If the OS is off, the script
says that instead of opening a blank window. Nimbus in the cloud keeps working
in a browser with the smaller toolset.
