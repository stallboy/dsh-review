[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Distribution,
    [Parameter(Mandatory)]
    [ValidatePattern('^/(?:[A-Za-z0-9._-]+/)*bin/node$')]
    [string]$LinuxNodePath
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw '此安装脚本在 Windows 上运行。' }
$source = Join-Path $PSScriptRoot 'audit-gate-wsl'
$windows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$compilerDirectory = Join-Path $windows 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $compilerDirectory 'csc.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw '找不到 .NET Framework 4.x C# 编译器。' }
$wsl = Join-Path $windows 'System32/wsl.exe'
$listing = (& $wsl --list --verbose | Out-String) -replace '\x00',''
if ($LASTEXITCODE -ne 0 -or $listing -notmatch ('(?im)^\s*\*?\s*' + [regex]::Escape($Distribution) + '\s+.+?\s+2\s*$')) {
    throw "未发现 WSL2 发行版 $Distribution。"
}

$utf8 = [Text.UTF8Encoding]::new($false)
$settings = @($Distribution, $LinuxNodePath, '') -join [char]10
$launcherSource = Join-Path $source 'launcher.cs'
$gateSource = Join-Path $source 'gate.py'
$parts = @(
    (Get-FileHash -LiteralPath $launcherSource).Hash
    (Get-FileHash -LiteralPath $gateSource).Hash
    $settings
)
$sha = [Security.Cryptography.SHA256]::Create()
try { $version = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes(($parts -join '|')))).Replace('-','').Substring(0,16) }
finally { $sha.Dispose() }
$localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$installRoot = Join-Path $localData 'dsh-audit-gate-wsl'
$install = Join-Path $installRoot $version
$launcher = Join-Path $install 'launcher.exe'
if (!(Test-Path -LiteralPath $install)) {
    $null = New-Item -ItemType Directory -Path $installRoot -Force
    $candidate = Join-Path $installRoot ('install-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $candidate
    try {
        $output = Join-Path $candidate 'launcher.exe'
        $compression = Join-Path $compilerDirectory 'System.IO.Compression.dll'
        & $compiler /nologo /codepage:65001 /target:exe /optimize+ "/reference:$compression" "/out:$output" $launcherSource
        if ($LASTEXITCODE -ne 0) { throw "门禁启动器编译失败（退出码 $LASTEXITCODE）。" }
        Copy-Item -LiteralPath $gateSource -Destination (Join-Path $candidate 'gate.py')
        [IO.File]::WriteAllText((Join-Path $candidate 'settings.txt'), $settings, $utf8)
        & $output --probe
        if ($LASTEXITCODE -ne 0) { throw "隔离自检失败（退出码 $LASTEXITCODE）。" }
        [IO.Directory]::Move($candidate, $install)
    } finally {
        if (Test-Path -LiteralPath $candidate) {
            foreach ($file in 'launcher.exe', 'gate.py', 'settings.txt') {
                $ownedFile = Join-Path $candidate $file
                if (Test-Path -LiteralPath $ownedFile -PathType Leaf) { Remove-Item -LiteralPath $ownedFile }
            }
            Remove-Item -LiteralPath $candidate
        }
    }
} else {
    if ((Get-FileHash -LiteralPath (Join-Path $install 'gate.py')).Hash -ne (Get-FileHash -LiteralPath $gateSource).Hash -or
        [IO.File]::ReadAllText((Join-Path $install 'settings.txt')) -ne $settings) { throw '已安装的门禁文件与预期版本不符。' }
    & $launcher --probe
    if ($LASTEXITCODE -ne 0) { throw "已有安装的隔离自检失败（退出码 $LASTEXITCODE）。" }
}

$previous = [Environment]::GetEnvironmentVariable('DSH_AUDIT_GATE_SANDBOX', 'User')
[Environment]::SetEnvironmentVariable('DSH_AUDIT_GATE_SANDBOX', $launcher, 'User')
$env:DSH_AUDIT_GATE_SANDBOX = $launcher
[pscustomobject]@{ Launcher = $launcher; PreviousUserValue = $previous; Distribution = $Distribution }
