# Run this ONCE to register the daily competitor research task in Windows Task Scheduler
# Open PowerShell as Administrator, then run: .\scripts\setup-competitor-cron.ps1

$taskName = "WingDigitalOS-CompetitorResearch"
$scriptPath = "$PSScriptRoot\competitor-research.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NonInteractive -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At "7:00AM"
# AllowStartIfOnBatteries + DontStopIfGoingOnBatteries are MANDATORY on every
# Wing task. Without them Windows silently SKIPS every fire while the laptop
# is unplugged -- no error, no log, the task just reads Ready forever.
# (2026-09-07: this script had created a task missing them.)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
Write-Host "Task '$taskName' registered. It will run daily at 7:00 AM."
Write-Host "Make sure the Wing Digital OS (npm run dev) is running when it fires."
