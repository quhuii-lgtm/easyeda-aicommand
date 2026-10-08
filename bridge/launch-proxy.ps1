[CmdletBinding()]
param(
    [string]$ProtocolUri = 'ai-command-proxy://start',
    [switch]$ShowErrorDialog
)

$ErrorActionPreference = 'Stop'

function Get-ProxyHealth {
    param([int]$Port = 49720)
    # Check the local listener first: Windows HTTP stacks may report a closed port
    # as a timeout/UnknownError rather than WebExceptionStatus.ConnectFailure.
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (-not ($listeners | Where-Object { $_.Port -eq $Port })) {
        return $null
    }
    $request = [System.Net.HttpWebRequest]::Create(('http://127.0.0.1:{0}/health' -f $Port))
    $request.Proxy = $null
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    try {
        $response = $request.GetResponse()
    }
    catch [System.Net.WebException] {
        $connectionError = $_.Exception
        while ($connectionError) {
            if (($connectionError -is [System.Net.WebException] -and $connectionError.Status -eq [System.Net.WebExceptionStatus]::ConnectFailure) -or
                ($connectionError -is [System.Net.Sockets.SocketException] -and $connectionError.SocketErrorCode -eq [System.Net.Sockets.SocketError]::ConnectionRefused)) {
                return $null
            }
            $connectionError = $connectionError.InnerException
        }
        throw 'Port 49720 did not provide a valid health response. Check the existing service; no second process was started.'
    }
    try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try {
            $healthValue = $reader.ReadToEnd() | ConvertFrom-Json
            if ($null -eq $healthValue) {
                throw 'Port 49720 returned an empty health response; no second process was started.'
            }
            return $healthValue
        }
        finally { $reader.Dispose() }
    }
    finally { $response.Dispose() }
}

try {
    if ($ProtocolUri -notmatch '^ai-command-proxy://start/?$') {
        throw 'Unsupported URL. Only ai-command-proxy://start is accepted.'
    }

    $health = Get-ProxyHealth
    if ($null -ne $health) {
        if ($health.ok -ne $true -or $health.service -ne 'ai-command-proxy' -or $health.lifecycleProtocol -ne 1) {
            throw 'Port 49720 is occupied by a different or older service. Update the bridge together with the plugin after its tasks have finished; no service was stopped.'
        }
        Write-Output 'AI Command Proxy is already running; no second process was started.'
        exit 0
    }

    $repoRoot = Split-Path -Parent $PSScriptRoot
    $proxyPath = Join-Path $PSScriptRoot 'command-proxy.mjs'
    if (-not (Test-Path -LiteralPath $proxyPath -PathType Leaf)) {
        throw 'command-proxy.mjs is missing. Keep the bridge files inside the complete repository.'
    }
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) {
        throw 'Node.js 20.17.0 or newer was not found on PATH. Install it before starting the bridge.'
    }
    $nodePath = $nodeCommand.Source
    & $nodePath -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 17) ? 0 : 1)"
    if ($LASTEXITCODE -ne 0) {
        throw 'Node.js 20.17.0 or newer is required.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules/ws/package.json') -PathType Leaf)) {
        throw 'The ws dependency is missing. Run npm ci from the repository root first.'
    }

    # The plugin and registered URL use 49720. Restore the caller's environment afterwards.
    $previousProxyPort = $env:PORT
    try {
        $env:PORT = '49720'
        $proxyProcess = Start-Process -FilePath $nodePath -ArgumentList ('"{0}"' -f $proxyPath) -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    }
    finally {
        $env:PORT = $previousProxyPort
    }
    Write-Output "Bridge startup requested (PID $($proxyProcess.Id)). Check the plugin's bridge status for connection confirmation."
}
catch {
    $message = $_.Exception.Message
    if ($ShowErrorDialog) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show($message, 'AI Command Proxy could not start')
        }
        catch { Write-Warning 'The startup error dialog could not be displayed.' }
    }
    Write-Error $message -ErrorAction Continue
    exit 1
}
