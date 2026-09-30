#Requires -Version 5.1
# Registers the ops jobs as Windows scheduled tasks (the PC stopgap; docs/OPS_SCHEDULER.md).
# Idempotent: re-running replaces the tasks in \Tegridy\. -DryRun prints and registers nothing;
# -Remove unregisters them. Refuses an env file inside a git work tree or OneDrive.
#   powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1 -DryRun
[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path $env:USERPROFILE 'tegridy-ops-env\ops.env'),
  [string]$RepoRoot = '',
  [string]$NodePath = '',
  [string]$TaskFolder = '\Tegridy\',
  [ValidateSet('S4U', 'Interactive')][string]$LogonType = 'S4U',
  [switch]$DryRun,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

# Cadences from the GitHub workflows' crons. Nothing may run more often than every 15 minutes.
$Jobs = @(
  @{ Name = 'arb-linkage-monitor'; EveryMinutes = 15; AtMinute = 0; LimitMinutes = 6 },
  @{ Name = 'synthetic-monitor'; EveryMinutes = 30; AtMinute = 0; LimitMinutes = 5 },
  @{ Name = 'revenue-watch'; EveryMinutes = 60; AtMinute = 17; LimitMinutes = 6 },
  @{ Name = 'registry-onchain'; DailyUtc = '06:41'; LimitMinutes = 15 },
  @{ Name = 'npm-advisories'; DailyUtc = '07:37'; LimitMinutes = 15 },
  @{ Name = 'supabase-backup'; WeeklyUtc = 'Monday 04:23'; LimitMinutes = 30 }
)

function Get-GitWorkTreeAbove([string]$Path) {
  $dir = [IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { $dir = Split-Path -Parent $dir }
  while ($dir) {
    if (Test-Path -LiteralPath (Join-Path $dir '.git')) { return $dir }
    $parent = Split-Path -Parent $dir
    if (-not $parent -or $parent -eq $dir) { return $null }
    $dir = $parent
  }
  return $null
}

function Test-UnderOneDrive([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  foreach ($root in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
    if ($root -and $full.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return ($full -match '\\OneDrive( - [^\\]+)?\\')
}

function ConvertFrom-UtcSlot([string]$HHmm, [string]$Day) {
  $parts = $HHmm.Split(':')
  $utc = [DateTime]::SpecifyKind([DateTime]::UtcNow.Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1]), [DateTimeKind]::Utc)
  if ($Day) { while ($utc.DayOfWeek -ne [DayOfWeek]$Day) { $utc = $utc.AddDays(1) } }
  return $utc.ToLocalTime()
}

function New-JobSchedule($job) {
  if ($job.EveryMinutes) {
    if ($job.EveryMinutes -lt 15) { throw "$($job.Name): every $($job.EveryMinutes) minutes is more often than the 15-minute floor." }
    $start = (Get-Date).Date.AddMinutes($job.AtMinute)
    return @{
      Trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes $job.EveryMinutes)
      Text = 'every {0} min from {1:HH:mm} local' -f $job.EveryMinutes, $start
    }
  }
  if ($job.DailyUtc) {
    $t = ConvertFrom-UtcSlot $job.DailyUtc ''
    return @{ Trigger = New-ScheduledTaskTrigger -Daily -At $t; Text = 'daily at {0:HH:mm} local ({1} UTC)' -f $t, $job.DailyUtc }
  }
  $day, $time = $job.WeeklyUtc.Split(' ')
  $t = ConvertFrom-UtcSlot $time $day
  return @{ Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $t.DayOfWeek -At $t; Text = 'weekly {0} {1:HH:mm} local ({2} UTC)' -f $t.DayOfWeek, $t, $job.WeeklyUtc }
}

function Get-PingName([string]$job) { 'HC_PING_URL_' + ($job.ToUpper() -replace '[^A-Z0-9]', '_') }

# ---- Remove ------------------------------------------------------------------------------
if ($Remove) {
  foreach ($job in $Jobs) {
    $existing = Get-ScheduledTask -TaskPath $TaskFolder -TaskName $job.Name -ErrorAction SilentlyContinue
    if (-not $existing) { Write-Host "  not registered: $TaskFolder$($job.Name)"; continue }
    if ($DryRun) { Write-Host "  would remove: $TaskFolder$($job.Name)" }
    else { Unregister-ScheduledTask -TaskPath $TaskFolder -TaskName $job.Name -Confirm:$false; Write-Host "  removed: $TaskFolder$($job.Name)" }
  }
  return
}

# ---- Checks ------------------------------------------------------------------------------
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
if (Test-UnderOneDrive $RepoRoot) { throw "$RepoRoot is inside OneDrive, which hollows node_modules. Use a checkout outside OneDrive (CLAUDE.md law 14)." }
$runJob = Join-Path $RepoRoot 'scripts\ops\run-job.mjs'
if (-not (Test-Path -LiteralPath $runJob)) { throw "No scripts\ops\run-job.mjs under $RepoRoot. Pass -RepoRoot <a checkout that has it>." }

$EnvFile = [IO.Path]::GetFullPath($EnvFile)
$repoAbove = Get-GitWorkTreeAbove $EnvFile
if ($repoAbove) { throw "Refusing: the env file $EnvFile is inside the git work tree $repoAbove. Keep it outside every repo." }
if (Test-UnderOneDrive $EnvFile) { throw "Refusing: the env file $EnvFile is inside OneDrive, which would sync your secrets to the cloud." }
$envNames = @()
if (Test-Path -LiteralPath $EnvFile) {
  $envNames = @(Get-Content -LiteralPath $EnvFile | ForEach-Object { if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S') { $Matches[1] } })
} elseif ($DryRun) {
  Write-Warning "The env file $EnvFile does not exist yet. Create it before registering (docs/OPS_SCHEDULER.md)."
} else {
  throw "The env file $EnvFile does not exist. Create it first (docs/OPS_SCHEDULER.md), or pass -EnvFile."
}

if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node is not on PATH. Pass -NodePath <full path to node.exe>.' }
  $NodePath = $cmd.Source
}
$nodeVersion = [version]((& $NodePath --version).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'20.0.0') { throw "node $nodeVersion is too old; the ops scripts need 20 or newer." }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($LogonType -eq 'S4U' -and -not $isAdmin -and -not $DryRun) {
  throw 'S4U tasks (run whether or not you are signed in, no window) must be registered from an elevated PowerShell. Re-run as administrator, or pass -LogonType Interactive (runs only while you are signed in, and flashes a window).'
}

# Read-only look for the old faucet task. This script never deletes it; the owner does.
$faucet = Get-ScheduledTask -TaskName 'SolanaDevnetFaucet' -ErrorAction SilentlyContinue
if ($faucet) {
  Write-Warning ("The old SolanaDevnetFaucet task is still registered (state: {0}). Delete it before this PC hosts monitors: Unregister-ScheduledTask -TaskName 'SolanaDevnetFaucet' -Confirm:`$false" -f $faucet.State)
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'frontend\node_modules\viem'))) {
  Write-Warning "frontend\node_modules is missing in $RepoRoot, so registry-onchain will fail until you run: cd frontend; npm ci --ignore-scripts"
}
$missing = @($Jobs | ForEach-Object { Get-PingName $_.Name } | Where-Object { $envNames -notcontains $_ })
foreach ($n in @('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'BACKUP_PASSPHRASE')) { if ($envNames -notcontains $n) { $missing += $n } }
if ($missing.Count) { Write-Warning ('The env file has no value for: ' + ($missing -join ', ') + '. Jobs still run; those without a ping URL reach no alarm.') }

# ---- Register ----------------------------------------------------------------------------
$mode = if ($LogonType -eq 'S4U') { 'runs whether or not you are signed in, no window' } else { 'runs only while you are signed in' }
Write-Host ("{0} {1} tasks in {2} as {3}\{4} ({5})" -f $(if ($DryRun) { 'Would register' } else { 'Registering' }), $Jobs.Count, $TaskFolder, $env:USERDOMAIN, $env:USERNAME, $mode)
foreach ($job in $Jobs) {
  $schedule = New-JobSchedule $job
  $arguments = '"{0}" {1} --env-file "{2}"' -f $runJob, $job.Name, $EnvFile
  $action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $RepoRoot
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $job.LimitMinutes) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType $LogonType -RunLevel Limited
  Write-Host ('  {0,-20} {1,-44} limit {2} min' -f $job.Name, $schedule.Text, $job.LimitMinutes)
  if (-not $DryRun) {
    Register-ScheduledTask -TaskPath $TaskFolder -TaskName $job.Name -Action $action -Trigger $schedule.Trigger -Settings $settings -Principal $principal -Description "tegridy ops: node scripts/ops/run-job.mjs $($job.Name)" -Force | Out-Null
  }
}
Write-Host ''
Write-Host ('Each task runs: "{0}" {1}' -f $NodePath, ('"{0}" <job> --env-file "{1}"' -f $runJob, $EnvFile))
Write-Host 'Daily and weekly times follow UTC as of today; a daylight-saving change moves them by an hour.'
if (-not $DryRun) {
  Write-Host ''
  Write-Host 'Next: run one now and check it reached healthchecks.io:'
  Write-Host ("  Start-ScheduledTask -TaskPath '{0}' -TaskName 'synthetic-monitor'" -f $TaskFolder)
  Write-Host ("  Get-ScheduledTaskInfo -TaskPath '{0}' -TaskName 'synthetic-monitor'   # LastTaskResult 0 = passed" -f $TaskFolder)
}
