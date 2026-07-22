# Wing Digital OS — Morning Competitor Research
# Scheduled to run at 7:00 AM daily via Windows Task Scheduler
# Setup: run scripts/setup-competitor-cron.ps1 once to register the task

$url = "http://localhost:3000/api/agents/competitor-research"
$logFile = "$PSScriptRoot\competitor-research.log"

try {
    $response = Invoke-RestMethod -Uri $url -Method POST -ContentType "application/json"
    $msg = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] OK — updated competitors.md (${($response.previewLength)} chars)"
    Add-Content -Path $logFile -Value $msg
    Write-Host $msg
} catch {
    $msg = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] ERROR — $($_.Exception.Message)"
    Add-Content -Path $logFile -Value $msg
    Write-Host $msg
}
