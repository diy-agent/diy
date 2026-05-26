param(
    [Parameter(Position = 0)]
    [ValidateSet('doctor', 'unlock', 'rename', 'delete', 'move')]
    [string]$Command = 'doctor',

    [Parameter(Position = 1, Mandatory)]
    [string]$Path,

    [Parameter(Position = 2)]
    [string]$Target
)

<#
.SYNOPSIS
    Unlock a file/directory by closing handles, then optionally rename/move/delete it.
.DESCRIPTION
    Subcommands:
      doctor <path>             — diagnose only (no changes), report what's locking
      unlock <path>             — close handles only, no file operation
      rename <path> <newName>   — unlock + rename
      move   <path> <dest>      — unlock + move
      delete <path>             — unlock + delete
.EXAMPLE
    .\unlock.ps1 rename quant diyq
    .\unlock.ps1 delete .\locked
    .\unlock.ps1 move C:\tools\old C:\apps\new
    .\unlock.ps1 doctor .\stuck
    .\unlock.ps1 unlock .\stuck
#>

$ErrorActionPreference = "Stop"

# --- Validate ---
if ($Command -in @('rename', 'move') -and -not $Target) {
    Write-Host "ERROR: '$Command' requires a target path (position 2)." -ForegroundColor Red
    exit 1
}

# --- Resolve paths ---
$SrcPath = (Resolve-Path $Path -ErrorAction Stop).ProviderPath

if ($Target) {
    $DstPath = [System.IO.Path]::GetFullPath($Target)
    $srcParent = [System.IO.Path]::GetDirectoryName($SrcPath)
    $dstParent = [System.IO.Path]::GetDirectoryName($DstPath)
}

# ====================================================================
# Phase 0: Escape CWD trap
# ====================================================================
$EscapedFromCwd = $false
$cwd = [System.IO.Directory]::GetCurrentDirectory()
$srcNormalized = $SrcPath.TrimEnd('\') + '\'
$cwdNormalized = $cwd.TrimEnd('\') + '\'
$cwdInsideTarget = $cwdNormalized.StartsWith($srcNormalized, [StringComparison]::OrdinalIgnoreCase)
if ($cwdInsideTarget -and $Command -ne 'doctor') {
    $safeCwd = [System.IO.Path]::GetPathRoot($SrcPath)
    Write-Host "WARNING: Current directory is inside target path. Switching to $safeCwd ..." -ForegroundColor Yellow
    Set-Location $safeCwd
    $EscapedFromCwd = $true
}

# ====================================================================
# Ensure handle64.exe (shared by all modes)
# ====================================================================
$LocalBin = Join-Path $HOME ".local\bin"
$HandleExe = Join-Path $LocalBin "handle64.exe"
if (-not (Test-Path $HandleExe)) {
    if (-not (Test-Path $LocalBin)) { New-Item -ItemType Directory -Path $LocalBin -Force | Out-Null }
    Write-Host "Downloading handle64.exe from SysInternals..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri "https://live.sysinternals.com/handle64.exe" -OutFile $HandleExe -UseBasicParsing -ErrorAction Stop
    } catch {
        Write-Host ""
        Write-Host "ERROR: Cannot download handle64.exe automatically." -ForegroundColor Red
        Write-Host "  Reason: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
        Write-Host "Ask the user to download manually:" -ForegroundColor Yellow
        Write-Host "  https://learn.microsoft.com/en-us/sysinternals/downloads/handle" -ForegroundColor Gray
        Write-Host "  Extract handle64.exe to: $LocalBin" -ForegroundColor Gray
        Write-Host ""
        Write-Host "Without handle64.exe, scanning/closing handles is impossible." -ForegroundColor Red
        Write-Host "(No language/library can do this — only SysInternals handle has the" -ForegroundColor Gray
        Write-Host " required Native API calls. Do not attempt Python/Node/PS alternatives.)" -ForegroundColor Gray
        exit 1
    }
}

# ====================================================================
# Doctor mode: diagnose only, no changes
# ====================================================================
if ($Command -eq 'doctor') {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  DIAGNOSIS: $SrcPath" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    # 1. Basic info
    Write-Host "`n[1/5] Path info:" -ForegroundColor Yellow
    $exists = Test-Path $SrcPath
    if ($exists) {
        $item = Get-Item $SrcPath -Force
        Write-Host "  Type:       $($item.PSIsContainer ? 'Directory' : 'File')"
        Write-Host "  Exists:     Yes"
        Write-Host "  Attributes: $($item.Attributes)"
    } else {
        Write-Host "  Path does not exist." -ForegroundColor Red
        exit 1
    }

    # 2. CWD trap check
    Write-Host "`n[2/5] CWD trap check:" -ForegroundColor Yellow
    Write-Host "  Current CWD: $cwd"
    if ($cwdInsideTarget) {
        Write-Host "  ⚠️  CWD is inside target path! shell holds a persistent handle." -ForegroundColor Red
        Write-Host "     Fix: cd to $([System.IO.Path]::GetPathRoot($SrcPath)) before any operation."
    } else {
        Write-Host "  ✓  CWD is outside target path." -ForegroundColor Green
    }

    # 3. NTFS permissions
    Write-Host "`n[3/5] NTFS permissions:" -ForegroundColor Yellow
    $acl = Get-Acl $SrcPath -ErrorAction SilentlyContinue
    if ($acl) {
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        Write-Host "  Owner: $($acl.Owner)"
        Write-Host "  Current user: $currentUser"
        $accessRules = $acl.Access | Where-Object { $_.IdentityReference -eq $currentUser -or $_.IdentityReference -eq 'BUILTIN\Administrators' -or $_.IdentityReference -eq 'Everyone' }
        if ($accessRules) {
            $accessRules | ForEach-Object {
                $grant = if ($_.AccessControlType -eq 'Allow') { 'ALLOW' } else { 'DENY' }
                Write-Host "  $grant : $($_.IdentityReference) → $($_.FileSystemRights)"
            }
        } else {
            Write-Host "  ⚠️  No direct access rules found for current user." -ForegroundColor Red
        }
    } else {
        Write-Host "  Could not read ACL." -ForegroundColor Red
    }

    # 4. Handle scan (read-only)
    Write-Host "`n[4/5] Open file handles:" -ForegroundColor Yellow
    $handleOutput = & $HandleExe -accepteula -a $SrcPath 2>$null
    if ($handleOutput) {
        $handles = @()
        $handleOutput -split "`r`n|`n" | ForEach-Object {
            if ($_ -match '^(.+?)\s+pid:\s*(\d+)\s+type:\s*(\S+)\s+([0-9A-Fa-f]+):\s*(.+)$') {
                $handles += [PSCustomObject]@{
                    Process = $Matches[1].Trim()
                    PID     = $Matches[2]
                    Type    = $Matches[3]
                    Handle  = $Matches[4]
                    Path    = $Matches[5]
                }
            }
        }
        if ($handles.Count -gt 0) {
            Write-Host "  Found $($handles.Count) open handle(s):" -ForegroundColor Red
            $handles | Format-Table Process, PID, Type, Handle, Path -AutoSize | Out-String | Write-Host
            Write-Host "  To close all: unlock.ps1 unlock <path>" -ForegroundColor Gray
        }
    } else {
        Write-Host "  ✓  No open handles found." -ForegroundColor Green
    }

    # 5. DLL module scan
    Write-Host "`n[5/5] Loaded DLLs from this path:" -ForegroundColor Yellow
    $dllFound = $false
    Get-Process | ForEach-Object {
        $proc = $_
        try {
            $_.Modules | Where-Object { $_.FileName -like "$SrcPath*" } | ForEach-Object {
                if (-not $dllFound) { $dllFound = $true }
                Write-Host "  PID $($proc.Id) [$($proc.ProcessName)] → $($_.FileName)" -ForegroundColor Red
            }
        } catch {}
    }
    if (-not $dllFound) {
        Write-Host "  ✓  No DLLs loaded from this path." -ForegroundColor Green
    } else {
        Write-Host "  DLL locks cannot be closed via handle64. Kill these processes first." -ForegroundColor Yellow
    }

    # Summary
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  SUMMARY" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    $issues = @()
    if ($cwdInsideTarget) { $issues += "CWD is inside target — cd out first" }
    if ($handles.Count -gt 0) { $issues += "$($handles.Count) open handle(s) — run 'unlock' to close" }
    if ($dllFound) { $issues += "DLLs loaded — kill holding processes first" }
    if ($issues.Count -eq 0) {
        Write-Host "✓  No locking issues detected. Safe to operate." -ForegroundColor Green
    } else {
        Write-Host "Issues found:" -ForegroundColor Red
        $issues | ForEach-Object { Write-Host "  • $_" -ForegroundColor Yellow }
        Write-Host "`nRecommended steps:" -ForegroundColor Cyan
        if ($cwdInsideTarget) { Write-Host "  1. cd $([System.IO.Path]::GetPathRoot($SrcPath))" }
        if ($handles.Count -gt 0) { Write-Host "  $($issues.Count). powershell -File unlock.ps1 unlock '$SrcPath'" }
        if ($dllFound) { Write-Host "  $($issues.Count). Stop-Process -Id <PID> -Force (for DLL-holding processes)" }
    }
    return
}

# ====================================================================
# Phase 1: handle64 scan — close file handles
# ====================================================================
function Invoke-HandleScan {
    param([string]$ScanPath)
    $output = & $HandleExe -accepteula -a $ScanPath 2>$null
    return $output
}

function Invoke-HandleClose {
    param([string]$Output)
    $count = 0
    if (-not $Output) { return $count }
    Write-Host $Output
    $Output -split "`r`n|`n" | ForEach-Object {
        if ($_ -match 'pid:\s*(\d+).*?\s+([0-9A-Fa-f]+):') {
            $processId = $Matches[1]
            $handleNum = $Matches[2]
            Write-Host "Closing handle $handleNum from PID $processId..." -ForegroundColor Cyan
            & $HandleExe -accepteula -c $handleNum -p $processId -y 2>&1 | Out-Null
            $count++
        }
    }
    return $count
}

Write-Host "`n=== Phase 1: Scanning file handles: $SrcPath ===" -ForegroundColor Yellow
$handleOutput1 = Invoke-HandleScan -ScanPath $SrcPath
$handleCount = Invoke-HandleClose -Output $handleOutput1
Write-Host "Closed $handleCount handle(s)." -ForegroundColor Green

# Re-scan after a short pause to catch persistent CWD handles
Start-Sleep -Milliseconds 300
$handleOutput2 = Invoke-HandleScan -ScanPath $SrcPath
if ($handleOutput2) {
    Write-Host "Found additional handles (possibly re-acquired by shell CWD). Closing again..." -ForegroundColor Yellow
    $extraCount = Invoke-HandleClose -Output $handleOutput2
    $handleCount += $extraCount
    if ($extraCount -gt 0 -and -not $EscapedFromCwd) {
        $safeCwd = [System.IO.Path]::GetPathRoot($SrcPath)
        Write-Host "CWD handle re-acquired! Switching to $safeCwd and retrying..." -ForegroundColor Yellow
        Set-Location $safeCwd
        $EscapedFromCwd = $true
        Start-Sleep -Milliseconds 300
        $handleOutput3 = Invoke-HandleScan -ScanPath $SrcPath
        if ($handleOutput3) {
            $extraCount2 = Invoke-HandleClose -Output $handleOutput3
            $handleCount += $extraCount2
        }
    }
}
Write-Host "Total: $handleCount handle(s) closed." -ForegroundColor Green

# === Phase 2: DLL module scan ===
Write-Host "`n=== Phase 2: Scanning loaded DLLs from: $SrcPath ===" -ForegroundColor Yellow
$dllProcesses = @()
Get-Process | ForEach-Object {
    $proc = $_
    try {
        $_.Modules | Where-Object { $_.FileName -like "$SrcPath*" } | ForEach-Object {
            $dllProcesses += [PSCustomObject]@{
                PID         = $proc.Id
                ProcessName = $proc.ProcessName
                ModulePath  = $_.FileName
            }
        }
    } catch {}
}

if ($dllProcesses.Count -gt 0) {
    Write-Host "Found $($dllProcesses.Count) loaded DLL(s) from this path:" -ForegroundColor Red
    $dllProcesses | Format-Table PID, ProcessName, ModulePath -AutoSize | Out-String | Write-Host
    Write-Host "WARNING: DLL-loaded handles cannot be closed via handle64." -ForegroundColor Red
    Write-Host "Kill these processes and retry:" -ForegroundColor Yellow
    $dllProcesses | Select-Object -Unique PID, ProcessName | ForEach-Object {
        Write-Host "  Stop-Process -Id $($_.PID) -Force  # $($_.ProcessName)" -ForegroundColor Gray
    }
    if ($Command -ne 'scan') {
        Write-Host "Cannot $Command while DLL modules are loaded." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "No loaded DLLs found." -ForegroundColor Green
}

# ====================================================================
# Phase 3: Perform operation (with retry if needed)
# ====================================================================
if ($Command -eq 'unlock') {
    Write-Host "`n=== Unlock complete ===" -ForegroundColor Green
    if ($handleCount -gt 0) {
        Write-Host "Handles closed. You can now operate on: $SrcPath" -ForegroundColor Cyan
    } else {
        Write-Host "No locks detected. The path should be accessible." -ForegroundColor Green
    }
    return
}

function Invoke-Operation {
    param([string]$Cmd, [string]$Src, [string]$Dst)
    try {
        switch ($Cmd) {
            'rename' {
                Rename-Item -Path $Src -NewName $Dst -ErrorAction Stop
                Write-Host "SUCCESS: Renamed '$Src' → '$Dst'" -ForegroundColor Green
            }
            'move' {
                Move-Item -Path $Src -Destination $Dst -ErrorAction Stop
                Write-Host "SUCCESS: Moved '$Src' → '$Dst'" -ForegroundColor Green
            }
            'delete' {
                Remove-Item -Path $Src -Recurse -Force -ErrorAction Stop
                Write-Host "SUCCESS: Deleted '$Src'" -ForegroundColor Green
            }
        }
        return $true
    } catch {
        Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

Write-Host "`n=== Phase 3: $($Command.ToUpper()) ===" -ForegroundColor Yellow
$success = Invoke-Operation -Cmd $Command -Src $SrcPath -Dst $DstPath

if (-not $success -and -not $EscapedFromCwd) {
    # Retry: cd out first, close handles again, then retry
    $safeCwd = [System.IO.Path]::GetPathRoot($SrcPath)
    Write-Host "Retrying: switching to $safeCwd and re-scanning handles..." -ForegroundColor Yellow
    Set-Location $safeCwd
    Start-Sleep -Milliseconds 500
    $handleOutputRetry = Invoke-HandleScan -ScanPath $SrcPath
    if ($handleOutputRetry) {
        $retryCount = Invoke-HandleClose -Output $handleOutputRetry
        Write-Host "Closed $retryCount additional handle(s)." -ForegroundColor Green
        Start-Sleep -Milliseconds 500
        $handleOutputRetry2 = Invoke-HandleScan -ScanPath $SrcPath
        if ($handleOutputRetry2) {
            $retryCount2 = Invoke-HandleClose -Output $handleOutputRetry2
            Write-Host "Closed $retryCount2 more handle(s)." -ForegroundColor Green
        }
    }
    Write-Host "Retrying operation..." -ForegroundColor Yellow
    $success = Invoke-Operation -Cmd $Command -Src $SrcPath -Dst $DstPath
}

if (-not $success) {
    Write-Host "`n=== If all else fails, try one of these workarounds: ===" -ForegroundColor Cyan
    Write-Host "1. Run from a completely different working directory:" -ForegroundColor Gray
    Write-Host "   cd C:\" -ForegroundColor Gray
    Write-Host "   powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Command '$SrcPath'" -ForegroundColor Gray
    Write-Host "2. Use cmd start to launch in a new window (does not inherit CWD handles):" -ForegroundColor Gray
    Write-Host "   cmd /c 'start /wait \"\" powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Command \"$SrcPath\"'" -ForegroundColor Gray
    Write-Host "3. Schedule a task (runs as SYSTEM, completely isolated):" -ForegroundColor Gray
    Write-Host "   Register-ScheduledTask ..." -ForegroundColor Gray
    exit 1
}
