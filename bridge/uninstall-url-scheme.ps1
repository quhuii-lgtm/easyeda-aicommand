[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$protocolKey = 'HKCU:\Software\Classes\ai-command-proxy'
$commandKey = $protocolKey + '\shell\open\command'
if (-not (Test-Path -LiteralPath $protocolKey)) {
    Write-Output 'The URL scheme is not registered for this user.'
    exit 0
}

$launcherPath = Join-Path $PSScriptRoot 'launch-proxy.ps1'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$expectedCommand = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -ShowErrorDialog -ProtocolUri "%1"' -f $powershellPath, $launcherPath
$existingCommand = if (Test-Path -LiteralPath $commandKey) { (Get-Item -LiteralPath $commandKey).GetValue('') } else { $null }
if ($existingCommand -ne $expectedCommand) {
    throw 'The URL scheme belongs to another location. It was not removed.'
}

if ($PSCmdlet.ShouldProcess($protocolKey, 'Remove only this repository URL registration')) {
    # Delete known keys without recursion; unexpected child keys are not removed.
    Remove-Item -LiteralPath $commandKey
    Remove-Item -LiteralPath ($protocolKey + '\shell\open')
    Remove-Item -LiteralPath ($protocolKey + '\shell')
    Remove-Item -LiteralPath $protocolKey
    Write-Output 'Removed the URL registration. No service was stopped and no repository files were deleted.'
}
