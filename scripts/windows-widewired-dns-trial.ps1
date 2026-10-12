#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
Local, time-limited DNS trial. Trial is an explicit request to start WideWired.
The SYSTEM watchdog ALWAYS stops WideWired and removes this trial's changes.
It is registered BEFORE DNS or route changes, independent of this console/chat.
Run Status or Restore locally to inspect or immediately end the trial.
Not a permanent configuration: private overlay names and independent application
DNS need a separate acceptance test before retaining a whole-machine policy.
#>
[CmdletBinding()]
param([ValidateSet('Trial','Restore','Status')][string]$Action='Status')

$ErrorActionPreference='Stop'
$guardDir=Join-Path $env:ProgramData 'WideWired-DnsTrial'
$stateFile=Join-Path $guardDir 'state.json'
$installedScript=Join-Path $guardDir 'trial.ps1'
$logFile=Join-Path $guardDir 'trial.log'
$taskName='WideWired-DnsTrial-AutoRestore'
$ruleComment='WideWired-DnsTrial-Owned'

function Write-TrialLog([string]$Message) {
    $line='{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'),$Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
    Write-Host $line
}
function Save-TrialState($State) {
    $temporary=Join-Path $guardDir 'state.next.json'
    $State | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $stateFile -Force
}
function Read-TrialState {
    if(-not (Test-Path -LiteralPath $stateFile)) { throw 'No trial state exists.' }
    Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
}
function Test-TrialHttps([bool]$UseProxy) {
    Add-Type -AssemblyName System.Net.Http
    $handler=New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy=$UseProxy
    if($UseProxy) { $handler.Proxy=[System.Net.WebRequest]::GetSystemWebProxy() }
    $client=New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout=[TimeSpan]::FromSeconds(5)
    $label=if($UseProxy) { 'system-proxy' } else { 'direct' }
    $response=$null
    try {
        $clock=[System.Diagnostics.Stopwatch]::StartNew()
        $response=$client.GetAsync('https://www.microsoft.com/',
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        Write-TrialLog ('HTTPS '+$label+' HTTP '+[int]$response.StatusCode+' '+$clock.ElapsedMilliseconds+'ms')
    } catch { Write-TrialLog ('HTTPS FAIL '+$label+' '+$_.Exception.Message) }
    finally {
        if($null -ne $response) { $response.Dispose() }
        $client.Dispose()
    }
}
function Restore-Trial {
    # Stop the disruptive component first; restore DNS even if a route cleanup fails.
    $failures=@()
    try {
        Stop-Service -Name wwnet -Force -ErrorAction Stop
        Write-TrialLog 'WideWired stopped.'
    } catch {
        $failures+=$_.Exception.Message
        Write-TrialLog ('STOP ERROR: '+$_.Exception.Message)
    }
    try {
        Get-DnsClientNrptRule | Where-Object { $_.Comment -eq $ruleComment } |
            ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }
        Clear-DnsClientCache
        Write-TrialLog 'Only trial-owned NRPT rules removed; DNS cache cleared.'
    } catch {
        $failures+=$_.Exception.Message
        Write-TrialLog ('DNS RESTORE ERROR: '+$_.Exception.Message)
    }
    $state=Read-TrialState
    foreach($route in @($state.CreatedRoutes)) {
        try {
            Get-NetRoute -PolicyStore ActiveStore -AddressFamily IPv4 `
                -DestinationPrefix $route.Prefix -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.InterfaceIndex -eq $route.InterfaceIndex -and
                    $_.NextHop -eq $route.NextHop -and $_.RouteMetric -eq $route.Metric
                } | Remove-NetRoute -Confirm:$false
        } catch {
            $failures+=$_.Exception.Message
            Write-TrialLog ('ROUTE RESTORE ERROR: '+$_.Exception.Message)
        }
    }
    $state.Completed=($failures.Count -eq 0)
    $state.RestoreErrors=@($failures)
    Save-TrialState $state
    if($failures.Count -gt 0) { throw ($failures -join '; ') }
    Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    Write-TrialLog 'Trial ended. Original network settings restored; evidence retained.'
}

if($Action -eq 'Status') {
    Get-Service wwnet | Format-List Name,Status,StartType
    if(Test-Path -LiteralPath $stateFile) { Read-TrialState | ConvertTo-Json -Depth 10 }
    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
        Format-List TaskName,State
    Get-DnsClientNrptPolicy -Effective | Format-List Namespace,NameServers
    if(Test-Path -LiteralPath $logFile) { Get-Content -LiteralPath $logFile -Tail 30 }
    return
}
if($Action -eq 'Restore') { Restore-Trial; return }

if((Get-Service wwnet).Status -ne 'Stopped') {
    throw 'WideWired must already be stopped before this trial.'
}
$existingTask=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($null -ne $existingTask -and
   (@($existingTask.Actions).Count -ne 1 -or
    $existingTask.Actions[0].Arguments -notlike ('*-File "'+$installedScript+'" -Action Restore'))) {
    throw 'A different task owns the guard task name; refusing to overwrite it.'
}
if(Test-Path -LiteralPath $guardDir) {
    if((Get-Item -LiteralPath $guardDir).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'The guard directory cannot be a junction or symbolic link.'
    }
}
if(Test-Path -LiteralPath $stateFile) {
    $prior=Read-TrialState
    if(-not $prior.Completed) { throw 'Previous trial is unfinished. Run -Action Restore first.' }
}
# A root NRPT must not silently replace an existing VPN or organizational policy.
if(@(Get-DnsClientNrptPolicy -Effective).Count -gt 0 -or
   @(Get-DnsClientNrptRule).Count -gt 0) {
    throw 'Existing NRPT rules detected. Review them before a whole-machine DNS trial.'
}
$physicalIndexes=@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' |
    ForEach-Object { $_.InterfaceIndex })
$gateways=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
    Where-Object { $_.InterfaceIndex -in $physicalIndexes -and $_.NextHop -ne '0.0.0.0' })
if($gateways.Count -ne 1) { throw 'Expected exactly one active physical IPv4 gateway.' }
$gateway=$gateways[0]
$dns=@((Get-DnsClientServerAddress -InterfaceIndex $gateway.InterfaceIndex `
    -AddressFamily IPv4).ServerAddresses)
if($dns.Count -eq 0) { throw 'The physical interface has no IPv4 DNS servers.' }
foreach($server in $dns) {
    $parsed=[System.Net.IPAddress]::Parse($server)
    if($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
       [System.Net.IPAddress]::IsLoopback($parsed)) {
        throw ('Not a physical IPv4 DNS destination: '+$server)
    }
    $answers=@(Resolve-DnsName -Name 'www.microsoft.com' -Server $server `
        -DnsOnly -QuickTimeout -ErrorAction Stop | Where-Object IPAddress)
    if($answers.Count -eq 0) { throw ('DNS preflight returned no addresses: '+$server) }
    $existing=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix ($server+'/32') `
        -PolicyStore ActiveStore -ErrorAction SilentlyContinue)
    if(@($existing | Where-Object {
        $_.InterfaceIndex -ne $gateway.InterfaceIndex -or $_.NextHop -ne $gateway.NextHop
    }).Count -gt 0) { throw ('Conflicting DNS host route: '+$server) }
}

New-Item -ItemType Directory -Path $guardDir -Force | Out-Null
# SYSTEM will execute the copied script: make the directory administrator-only.
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$adminSid=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$systemSid=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.SetOwner($adminSid)
foreach($sid in @($adminSid,$systemSid)) {
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $guardDir -AclObject $acl
if([IO.Path]::GetFullPath($PSCommandPath) -ne [IO.Path]::GetFullPath($installedScript)) {
    Copy-Item -LiteralPath $PSCommandPath -Destination $installedScript -Force
}
$deadline=(Get-Date).AddMinutes(2)
$state=[pscustomobject]@{
    Started=(Get-Date).ToString('o'); Deadline=$deadline.ToString('o')
    Completed=$false; InterfaceIndex=[int]$gateway.InterfaceIndex
    Gateway=$gateway.NextHop; Dns=$dns; CreatedRoutes=@(); RestoreErrors=@()
}
Save-TrialState $state
$taskCommand=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$installedScript+'" -Action Restore'
$taskAction=New-ScheduledTaskAction -Execute $taskCommand -Argument $taskArgs
$taskTrigger=New-ScheduledTaskTrigger -Once -At $deadline
$taskPrincipal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$taskSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
# Do not cancel this task on success: the first trial is deliberately reversible.
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger `
    -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
try {
    if((Get-ScheduledTask -TaskName $taskName).State -ne 'Ready') {
        throw 'Automatic restore task is not ready. WideWired will not be started.'
    }
    Write-TrialLog ('Automatic restore armed for '+$deadline.ToString('HH:mm:ss'))
    foreach($server in $dns) {
        $prefix=$server+'/32'
        $existing=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix `
            -PolicyStore ActiveStore -ErrorAction SilentlyContinue)
        if($existing.Count -eq 0) {
            # Journal before mutation so an interrupted console remains recoverable.
            $record=[pscustomobject]@{Prefix=$prefix;InterfaceIndex=$gateway.InterfaceIndex;
                NextHop=$gateway.NextHop;Metric=7}
            $state.CreatedRoutes=@($state.CreatedRoutes)+$record
            Save-TrialState $state
            New-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix `
                -InterfaceIndex $gateway.InterfaceIndex -NextHop $gateway.NextHop `
                -RouteMetric 7 -PolicyStore ActiveStore | Out-Null
        }
    }
    Add-DnsClientNrptRule -Namespace '.' -NameServers $dns `
        -DisplayName 'WideWired whole-machine DNS trial' -Comment $ruleComment
    Clear-DnsClientCache
    Write-TrialLog ('Global system DNS protected via '+($dns -join ', '))
    Start-Service -Name wwnet
    Write-TrialLog 'WideWired start requested. Automatic stop and undo remain armed.'
    Test-TrialHttps $false
    if((Get-Date) -lt $deadline.AddSeconds(-15)) { Test-TrialHttps $true }
    $domains=@('www.microsoft.com','api.live.bilibili.com','github.com','www-api.widewired.com.cn')
    for($iteration=0;$iteration -lt 12;$iteration++) {
        if((Get-Date) -ge $deadline.AddSeconds(-10)) { break }
        foreach($domain in $domains) {
            if((Get-Date) -ge $deadline.AddSeconds(-10)) { break }
            $clock=[System.Diagnostics.Stopwatch]::StartNew()
            try {
                $result=@(Resolve-DnsName -Name $domain -DnsOnly -QuickTimeout `
                    -ErrorAction Stop | Where-Object IPAddress)
                if($result.Count -eq 0) { throw 'No address returned.' }
                Write-TrialLog ('DNS OK '+$domain+' '+$clock.ElapsedMilliseconds+'ms')
            } catch { Write-TrialLog ('DNS FAIL '+$domain+' '+$_.Exception.Message) }
        }
        Start-Sleep -Seconds 3
    }
    if((Get-Date) -lt $deadline.AddSeconds(-15)) { Test-TrialHttps $false }
    if((Get-Date) -lt $deadline.AddSeconds(-10)) { Test-TrialHttps $true }
    Write-TrialLog 'Probe finished. Wait for the scheduled automatic stop/restore.'
} catch {
    Write-TrialLog ('TRIAL ERROR: '+$_.Exception.Message)
    Restore-Trial
    throw
}
