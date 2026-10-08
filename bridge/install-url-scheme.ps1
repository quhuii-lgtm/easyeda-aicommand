[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$protocolKey = 'HKCU:\Software\Classes\ai-command-proxy'
$commandKey = $protocolKey + '\shell\open\command'
$launcherPath = Join-Path $PSScriptRoot 'launch-proxy.ps1'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw 'launch-proxy.ps1 is missing. Register the URL from a complete repository.'
}
$expectedCommand = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -ShowErrorDialog -ProtocolUri "%1"' -f $powershellPath, $launcherPath
$existingCommand = if (Test-Path -LiteralPath $commandKey) { (Get-Item -LiteralPath $commandKey).GetValue('') } else { $null }
if ((Test-Path -LiteralPath $protocolKey) -and $existingCommand -ne $expectedCommand -and -not $Force) {
    throw 'ai-command-proxy is already registered to another location. Use -Force only if you intend to replace that registration. No change was made.'
}

if ($PSCmdlet.ShouldProcess($protocolKey, 'Register this repository as the current user URL launcher')) {
    New-Item -Path $commandKey -Force | Out-Null
    Set-Item -LiteralPath $protocolKey -Value 'URL:AI Command Proxy'
    New-ItemProperty -LiteralPath $protocolKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    Set-Item -LiteralPath $commandKey -Value $expectedCommand
    Write-Output 'Registered ai-command-proxy://start for this user. No service was started or stopped.'
}
