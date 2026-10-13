param([string]$TargetDirectory = '', [switch]$Installer)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$app = Join-Path $project 'apps/app'
if (!$TargetDirectory) { $TargetDirectory = Join-Path (Split-Path $project -Parent) '.build/desktop-windows' }
$TargetDirectory = [System.IO.Path]::GetFullPath($TargetDirectory)
if (!(Test-Path -LiteralPath (Join-Path $app 'build/index.html'))) { throw 'Build and verify the frontend first. No old frontend is substituted automatically.' }
$node = Join-Path $env:ProgramFiles 'nodejs/node.exe'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'MSVC Build Tools are required.' }
$devShell = Join-Path $vs 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll'
Import-Module $devShell
$enter = Get-Command Enter-VsDevShell
$shellArgs = @{VsInstanceId=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property instanceId)}
if ($enter.Parameters.ContainsKey('DevCmdArguments')) { $shellArgs.DevCmdArguments='-arch=x64 -host_arch=x64' }
if ($enter.Parameters.ContainsKey('SkipAutomaticLocation')) { $shellArgs.SkipAutomaticLocation=$true }
Enter-VsDevShell @shellArgs | Out-Null
$env:Path = "$(Split-Path $node);$env:USERPROFILE/.cargo/bin;$env:Path"
$env:CARGO_TARGET_DIR = $TargetDirectory
# Preview builds never publish updater metadata or contact a release service.
$override = Join-Path $TargetDirectory 'packaging/preview-config.json'
New-Item -ItemType Directory -Path (Split-Path $override) -Force | Out-Null
@{build=@{beforeBuildCommand=''};bundle=@{createUpdaterArtifacts=$false};plugins=@{updater=@{endpoints=@()}}} |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $override -Encoding utf8
$cli = Join-Path $project 'node_modules/@tauri-apps/cli/tauri.js'
if (!(Test-Path -LiteralPath $cli)) {
    $cachedCli = Get-ChildItem (Join-Path $project 'node_modules/.pnpm') -Directory -Filter '@tauri-apps+cli@*' |
        ForEach-Object { Join-Path $_.FullName 'node_modules/@tauri-apps/cli/tauri.js' } |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($cachedCli) { $cli = $cachedCli }
}
if (!(Test-Path -LiteralPath $cli)) { throw 'Install the locked native Windows frontend dependencies before packaging.' }
Push-Location $app
try {
    $arguments = @($cli,'build','--config',$override)
    if ($Installer) { $arguments += @('--bundles','nsis') } else { $arguments += '--no-bundle' }
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed.' }
} finally { Pop-Location }
$binary = Join-Path $TargetDirectory 'release/whisperme.exe'
if (!(Test-Path -LiteralPath $binary)) { throw 'No executable was produced.' }
$result = [ordered]@{version=(Get-Content (Join-Path $app 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version;
    channel='private-preview'; createdAt=[DateTime]::UtcNow.ToString('o'); sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();
    executable=$binary; authenticode=(Get-AuthenticodeSignature -LiteralPath $binary).Status.ToString(); published=$false}
if ($Installer) {
    $setup = Get-ChildItem -LiteralPath (Join-Path $TargetDirectory 'release/bundle/nsis') -Filter '*_x64-setup.exe' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (!$setup) { throw 'The requested NSIS installer was not produced.' }
    $result.installer = $setup.FullName
    $result.installerSha256 = (Get-FileHash -LiteralPath $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.installerAuthenticode = (Get-AuthenticodeSignature -LiteralPath $setup.FullName).Status.ToString()
}
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $TargetDirectory 'packaging/windows-manifest.json') -Encoding utf8
$result
