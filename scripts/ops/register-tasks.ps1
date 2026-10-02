#Requires -Version 5.1
# Registers the ops jobs as Windows scheduled tasks in \Tegridy\ (docs/OPS_SCHEDULER.md).
# Day to day GitHub runs the schedules and this PC only pulls the backups (backup-pull).
# -Failover (GitHub gone) registers the six jobs GitHub ran and removes backup-pull; running
# without it switches back. Idempotent. -DryRun changes nothing; -Remove removes every task.
#   powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1 -DryRun
[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path $env:USERPROFILE 'tegridy-ops-env\ops.env'),
  [string]$BackupEnvFile = (Join-Path $env:USERPROFILE 'tegridy-ops-env\backup.env'),
  [string]$RepoRoot = '',
  [string]$NodePath = '',
  [string]$TaskFolder = '\Tegridy\',
  [ValidateSet('', 'S4U', 'Interactive')][string]$LogonType = '',
  [switch]$Failover,
  [switch]$DryRun,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

# Failover cadences are the GitHub workflows'; nothing runs more often than every 15 minutes.
# This PC is off at night, so daily and weekly jobs run in the early afternoon, local time.
# backup-pull runs Wednesday, so one missed Monday backup is already 9 days old. Each
# LimitMinutes exceeds its job's own timeouts plus two pings (run-job.test.mjs pins it).
$Jobs = @(
  @{ Name = 'backup-pull'; Mode = 'normal'; WeeklyAt = 'Wednesday 12:53'; LimitMinutes = 20 },
  @{ Name = 'arb-linkage-monitor'; Mode = 'failover'; EveryMinutes = 15; AtMinute = 0; LimitMinutes = 14 },
  @{ Name = 'synthetic-monitor'; Mode = 'failover'; EveryMinutes = 30; AtMinute = 0; LimitMinutes = 5 },
  @{ Name = 'revenue-watch'; Mode = 'failover'; EveryMinutes = 60; AtMinute = 17; LimitMinutes = 12 },
  @{ Name = 'registry-onchain'; Mode = 'failover'; DailyAt = '12:41'; LimitMinutes = 30 },
  @{ Name = 'npm-advisories'; Mode = 'failover'; DailyAt = '13:37'; LimitMinutes = 20 },
  @{ Name = 'supabase-backup'; Mode = 'failover'; WeeklyAt = 'Monday 12:23'; LimitMinutes = 30 }
)
$BackupSecrets = @('SUPABASE_SERVICE_KEY', 'BACKUP_PASSPHRASE')
$ModeName = if ($Failover) { 'failover' } else { 'normal' }
$Selected = @($Jobs | Where-Object { $_.Mode -eq $ModeName })
$Others = @($Jobs | Where-Object { $_.Mode -ne $ModeName })
# gh keeps its login in the Windows credential store, which a task that runs while you are
# signed out (S4U) is not expected to read; so backup-pull runs only while you are signed in.
if (-not $LogonType) { $LogonType = if ($Failover) { 'S4U' } else { 'Interactive' } }

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

# The env file's full path, after refusing one that git or OneDrive would copy somewhere.
function Resolve-EnvFile([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $repoAbove = Get-GitWorkTreeAbove $full
  if ($repoAbove) { throw "Refusing: the env file $full is inside the git work tree $repoAbove. Keep it outside every repo." }
  if (Test-UnderOneDrive $full) { throw "Refusing: the env file $full is inside OneDrive, which would sync your secrets to the cloud." }
  return $full
}

# The NAMEs an env file gives a value to (never the values).
function Read-EnvNames([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    return @(Get-Content -LiteralPath $Path | ForEach-Object { if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S') { $Matches[1] } })
  }
  if ($DryRun) { Write-Warning "The env file $Path does not exist yet. Create it before registering (docs/OPS_SCHEDULER.md)."; return @() }
  throw "The env file $Path does not exist. Create it first (docs/OPS_SCHEDULER.md), or pass its path."
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
  if ($job.DailyAt) {
    return @{ Trigger = New-ScheduledTaskTrigger -Daily -At $job.DailyAt; Text = "daily at $($job.DailyAt) local" }
  }
  $day, $time = $job.WeeklyAt.Split(' ')
  return @{ Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $day -At $time; Text = "weekly $day $time local" }
}

function Get-PingName([string]$job) { 'HC_PING_URL_' + ($job.ToUpper() -replace '[^A-Z0-9]', '_') }

# A dry run names every task it would remove, registered or not, so the list can be checked.
function Remove-JobTask($job, [string]$why, [switch]$Quiet) {
  $existing = Get-ScheduledTask -TaskPath $TaskFolder -TaskName $job.Name -ErrorAction SilentlyContinue
  if ($DryRun) { Write-Host ('  would remove{0}: {1}{2}{3}' -f $(if ($existing) { '' } else { ' if present' }), $TaskFolder, $job.Name, $why); return }
  if (-not $existing) { if (-not $Quiet) { Write-Host "  not registered: $TaskFolder$($job.Name)" }; return }
  Unregister-ScheduledTask -TaskPath $TaskFolder -TaskName $job.Name -Confirm:$false
  Write-Host "  removed: $TaskFolder$($job.Name)$why"
}

# ---- Remove ------------------------------------------------------------------------------
if ($Remove) {
  foreach ($job in $Jobs) { Remove-JobTask $job '' }
  return
}

# ---- Checks ------------------------------------------------------------------------------
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
if (Test-UnderOneDrive $RepoRoot) { throw "$RepoRoot is inside OneDrive, which hollows node_modules. Use a checkout outside OneDrive (CLAUDE.md law 14)." }
$runJob = Join-Path $RepoRoot 'scripts\ops\run-job.mjs'
if (-not (Test-Path -LiteralPath $runJob)) { throw "No scripts\ops\run-job.mjs under $RepoRoot. Pass -RepoRoot <a checkout that has it>." }

$EnvFile = Resolve-EnvFile $EnvFile
$envNames = Read-EnvNames $EnvFile
$leaked = @($BackupSecrets | Where-Object { $envNames -contains $_ })
if ($leaked.Count) { throw "Refusing: $EnvFile holds $($leaked -join ', '). Every task reads that file; move them to $BackupEnvFile, which only the backup task reads." }
$backupNames = @()
if ($Failover) {
  $BackupEnvFile = Resolve-EnvFile $BackupEnvFile
  if ($EnvFile -eq $BackupEnvFile) { throw 'Refusing: -EnvFile and -BackupEnvFile are the same file. The backup secrets need a file only the backup task reads.' }
  $backupNames = Read-EnvNames $BackupEnvFile
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
  throw 'S4U tasks (run whether or not you are signed in, no window) must be registered from an elevated PowerShell. Re-run as administrator, or pass -LogonType Interactive (runs only while you are signed in, in a console window for each run).'
}

# Read-only look for the old faucet task. This script never deletes it; the owner does.
$faucet = Get-ScheduledTask -TaskName 'SolanaDevnetFaucet' -ErrorAction SilentlyContinue
if ($faucet) {
  Write-Warning ("The old SolanaDevnetFaucet task is still registered (state: {0}). Delete it before this PC hosts monitors: Unregister-ScheduledTask -TaskName 'SolanaDevnetFaucet' -Confirm:`$false" -f $faucet.State)
}
if ($Failover -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot 'frontend\node_modules\viem'))) {
  Write-Warning "frontend\node_modules is missing in $RepoRoot, so registry-onchain will fail until you run: cd frontend; npm ci --ignore-scripts"
}
if (-not $Failover -and -not ($envNames -contains 'GH_BIN') -and -not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Warning 'The GitHub CLI (gh) is not on PATH, so backup-pull will fail. Install it and run gh auth login once.'
}
$missing = @($Selected | ForEach-Object { Get-PingName $_.Name } | Where-Object { $envNames -notcontains $_ })
if ($Failover) { foreach ($n in @('SUPABASE_URL') + $BackupSecrets) { if ($backupNames -notcontains $n) { $missing += $n } } }
if ($missing.Count) { Write-Warning ('The env files have no value for: ' + ($missing -join ', ') + '. Jobs still run; those without a ping URL reach no alarm.') }

# ---- Register ----------------------------------------------------------------------------
$why = if ($Failover) { ' (GitHub is gone; nothing to pull from)' } else { ' (GitHub runs this one again)' }
foreach ($job in $Others) { Remove-JobTask $job $why -Quiet }
$how = if ($LogonType -eq 'S4U') { 'runs whether or not you are signed in, no window' } else { 'runs only while you are signed in, in a console window: leave it open' }
Write-Host ("{0} {1} {2} task(s) in {3} as {4}\{5} ({6})" -f $(if ($DryRun) { 'Would register' } else { 'Registering' }), $Selected.Count, $ModeName, $TaskFolder, $env:USERDOMAIN, $env:USERNAME, $how)
foreach ($job in $Selected) {
  $schedule = New-JobSchedule $job
  $arguments = '"{0}" {1} --env-file "{2}"' -f $runJob, $job.Name, $EnvFile
  if ($job.Name -eq 'supabase-backup') { $arguments += ' --env-file "{0}"' -f $BackupEnvFile }
  # Read back from the task's own argument string, so the listing cannot drift from it.
  $reads = ([regex]::Matches($arguments, '--env-file "([^"]+)"') | ForEach-Object { Split-Path -Leaf $_.Groups[1].Value }) -join ' + '
  $action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $RepoRoot
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $job.LimitMinutes) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType $LogonType -RunLevel Limited
  Write-Host ('  {0,-20} {1,-32} limit {2,2} min  reads {3}' -f $job.Name, $schedule.Text, $job.LimitMinutes, $reads)
  if (-not $DryRun) {
    Register-ScheduledTask -TaskPath $TaskFolder -TaskName $job.Name -Action $action -Trigger $schedule.Trigger -Settings $settings -Principal $principal -Description "tegridy ops: node scripts/ops/run-job.mjs $($job.Name)" -Force | Out-Null
  }
}
Write-Host ''
Write-Host ('Each task runs: "{0}" {1}' -f $NodePath, ('"{0}" <job> --env-file "{1}"' -f $runJob, $EnvFile))
if ($Failover) { Write-Host ('The backup task alone also reads: --env-file "{0}"' -f $BackupEnvFile) }
Write-Host 'Task Scheduler stores each start time in UTC, so after a daylight-saving change the tasks run an hour earlier or later by the clock.'
if (-not $DryRun) {
  $first = $Selected[0].Name
  if ($Failover) { $first = 'synthetic-monitor' }
  Write-Host ''
  Write-Host 'Next: run one now and check it reached healthchecks.io:'
  Write-Host ("  Start-ScheduledTask -TaskPath '{0}' -TaskName '{1}'" -f $TaskFolder, $first)
  Write-Host ("  Get-ScheduledTaskInfo -TaskPath '{0}' -TaskName '{1}'   # LastTaskResult 0 = passed" -f $TaskFolder, $first)
}
