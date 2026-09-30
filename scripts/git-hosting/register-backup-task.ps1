<#
register-backup-task.ps1: installs backup-bundles.sh as a daily Windows scheduled task.
The owner runs it: powershell -ExecutionPolicy Bypass -File scripts\git-hosting\register-backup-task.ps1
It prints what it will create, asks nothing, and is safe to re-run (same files, same task).
-DryRun prints only. -InstallOnly writes the files and registers nothing. Runbook: docs/GIT_HOSTING.md.
#>
[CmdletBinding()]
param(
  [string]$Dest = (Join-Path $env:USERPROFILE 'OneDrive\git-vault'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'git-hosting'),
  [string]$At = '03:30',
  [string]$TaskName = 'git-vault-backup',
  [switch]$DryRun,
  [switch]$InstallOnly
)
$ErrorActionPreference = 'Stop'

function ConvertTo-PosixPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($full -notmatch '^([A-Za-z]):\\(.*)$') { throw "not a drive path: $Path" }
  return '/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/')
}
function Format-Quoted([string]$Text) { return "'" + ($Text -replace "'", "''") + "'" }

$source = Join-Path $PSScriptRoot 'backup-bundles.sh'
if (-not (Test-Path -LiteralPath $source)) { throw "missing $source" }

$candidates = @()
$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if ($gitCmd) { $candidates += Join-Path (Split-Path (Split-Path $gitCmd.Source)) 'bin\bash.exe' }
$candidates += Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
$bash = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $bash) { throw 'Git Bash not found (Git\bin\bash.exe). Install Git for Windows first.' }

$installed = Join-Path $InstallDir 'backup-bundles.sh'
$runner = Join-Path $InstallDir 'run-backup.ps1'
$log = Join-Path $InstallDir 'backup.log'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$runnerText = @(
  '# Written by scripts/git-hosting/register-backup-task.ps1; re-run that script to change it.',
  ('$env:BACKUP_LOG = ' + (Format-Quoted (ConvertTo-PosixPath $log))),
  ('& ' + (Format-Quoted $bash) + ' ' + (Format-Quoted (ConvertTo-PosixPath $installed)) + ' ' + (Format-Quoted (ConvertTo-PosixPath $Dest))),
  'exit $LASTEXITCODE'
) -join "`r`n"
$argument = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
$verb = 'create'
if ($existing) { $verb = 'replace (same name, re-registered)' }

Write-Output 'This will:'
Write-Output "  1. copy   $source"
Write-Output "     to     $installed (overwrites an older copy)"
Write-Output "  2. write  $runner, which contains:"
$runnerText -split "`r`n" | ForEach-Object { Write-Output "       $_" }
if (-not $InstallOnly) {
  Write-Output "  3. $verb scheduled task \$TaskName"
  Write-Output "       daily at $At as $user, only while you are logged on; a missed run starts at the next chance"
  Write-Output "       action: powershell.exe $argument"
}
Write-Output "  Bundles go to $Dest. Log: $log"
Write-Output "  Sources: $(Join-Path $InstallDir 'backup-sources.txt') if you create it (one name=path per line), else the list in backup-bundles.sh."

if ($DryRun) { Write-Output 'DRY RUN: nothing was written or registered.'; exit 0 }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -LiteralPath $source -Destination $installed -Force
[System.IO.File]::WriteAllText($runner, $runnerText + "`r`n", (New-Object System.Text.ASCIIEncoding))
if ($InstallOnly) { Write-Output 'Files written; no task registered (-InstallOnly).'; exit 0 }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Daily git bundles of every repo copy. See docs/GIT_HOSTING.md.' -Force | Out-Null

Write-Output "Done. Run it now:  Start-ScheduledTask -TaskName $TaskName"
Write-Output "Check it:          Get-ScheduledTaskInfo -TaskName $TaskName   (LastTaskResult 0 = success)"
Write-Output "Read the log:      Get-Content $log -Tail 20"
