; Optional: true Ctrl+Space toggle. Needs AutoHotkey v2 installed.
; Without AutoHotkey, install-nimbus-hotkey.ps1 gives you Ctrl+Shift+N using
; only built-in Windows, which is why that is the default.
#Requires AutoHotkey v2.0
#SingleInstance Force

^Space:: {
    if WinExist("ahk_exe chrome.exe") and WinActive("ahk_exe chrome.exe") and InStr(WinGetTitle("A"), "Wing") {
        WinMinimize("A")          ; hide rather than close, so it comes back instantly
        return
    }
    Run(A_ScriptDir "\nimbus.vbs", , "Hide")
}
