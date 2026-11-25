param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$app = Join-Path $root 'rust-app'
$output = Join-Path $root 'dist\rust-native'
$logs = Join-Path $root '.test-output\rust-release'
$target = 'x86_64-pc-windows-msvc'

# Pick up user-scoped settings even when this terminal predates installation.
foreach ($name in @('CARGO_HOME', 'RUSTUP_HOME')) {
    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
        if ($value) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
    }
}
$cargo = if ($env:CARGO_HOME -and (Test-Path (Join-Path $env:CARGO_HOME 'bin\cargo.exe'))) {
    Join-Path $env:CARGO_HOME 'bin\cargo.exe'
} else { (Get-Command cargo.exe -ErrorAction Stop).Source }
$env:PATH = (Split-Path $cargo -Parent) + ';' + $env:PATH
New-Item -ItemType Directory -Force $output, $logs | Out-Null

function Invoke-Cargo([string[]]$CargoArguments) {
    & $cargo @CargoArguments
    if ($LASTEXITCODE -ne 0) { throw "Cargo failed ($LASTEXITCODE): $CargoArguments" }
}

Push-Location $app
try {
    # CWD is important: Cargo must load rust-app/.cargo/config.toml.
    if (-not $SkipTests) {
        Invoke-Cargo -CargoArguments @('fmt', '--check')
        Invoke-Cargo -CargoArguments @('clippy', '--locked', '--all-targets', '--target', $target, '--', '-D', 'warnings')
        Invoke-Cargo -CargoArguments @('test', '--locked', '--target', $target)
    }
    Invoke-Cargo -CargoArguments @('build', '--release', '--locked', '--target', $target)

    $source = Join-Path $app "target\$target\release\board-cut-optimizer.exe"
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { throw 'vswhere.exe is required for the PE dependency check.' }
    $dumpbin = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe') | Select-Object -First 1
    if (-not $dumpbin) { throw 'MSVC dumpbin.exe was not found.' }
    $dependencies = & $dumpbin /dependents $source
    if ($LASTEXITCODE -ne 0) { throw 'dumpbin failed.' }
    $dependencies | Set-Content -Encoding UTF8 (Join-Path $logs 'dependencies.txt')
    $dlls = @($dependencies | ForEach-Object { if ($_ -match '^\s+([A-Za-z0-9_.-]+\.dll)\s*$') { $matches[1] } })
    if ($dlls.Count -eq 0) { throw 'No PE imports were detected.' }
    $allowed = @('advapi32.dll','bcrypt.dll','bcryptprimitives.dll','comctl32.dll','comdlg32.dll','combase.dll','crypt32.dll','dwmapi.dll','gdi32.dll','imm32.dll','kernel32.dll','ntdll.dll','ole32.dll','oleaut32.dll','opengl32.dll','secur32.dll','shell32.dll','shcore.dll','shlwapi.dll','user32.dll','uxtheme.dll','version.dll','winmm.dll','ws2_32.dll','msvcrt.dll','ucrtbase.dll')
    foreach ($dll in $dlls) {
        if ($allowed -notcontains $dll.ToLowerInvariant() -and $dll -notmatch '^(api-ms-win-|ext-ms-win-).+\.dll$') {
            throw "Unexpected non-system dependency: $dll"
        }
    }
    $bytes = [IO.File]::ReadAllBytes($source)
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    $machine = [BitConverter]::ToUInt16($bytes, $pe + 4)
    $subsystem = [BitConverter]::ToUInt16($bytes, $pe + 24 + 68)
    if ($machine -ne 0x8664 -or $subsystem -ne 2) { throw 'Expected an AMD64 Windows GUI executable.' }

    # The only runtime artifact copied is the EXE. Never copy or overwrite data/.
    $filename = [string][char]0x677F + [char]0x4F18 + [char]0x6392 + '.exe'
    $destination = Join-Path $output $filename
    Copy-Item $source $destination -Force
    Copy-Item (Join-Path $app 'RELEASE_NOTES.md') (Join-Path $output 'README.md') -Force
    Copy-Item (Join-Path $app 'FEATURE_PARITY.md') (Join-Path $output 'FEATURE_PARITY.md') -Force

    $env:BOARD_CUT_SMOKE_DIRECTORY = Join-Path $logs 'screenshots'
    $env:BOARD_CUT_SMOKE_SIZE = '1440x920'
    $process = Start-Process -FilePath $destination -ArgumentList '--smoke' -WorkingDirectory $output -PassThru
    if (-not $process.WaitForExit(45000)) {
        $process.Kill()
        throw 'Release GUI smoke test timed out.'
    }
    if ($process.ExitCode -ne 0) { throw "Release GUI smoke failed ($($process.ExitCode))." }
    $screenshots = @(Get-ChildItem $env:BOARD_CUT_SMOKE_DIRECTORY -Filter 'rust-ui-*.png')
    if ($screenshots.Count -ne 7) { throw "Expected seven release GUI screenshots, got $($screenshots.Count)." }
    $hash = (Get-FileHash $destination -Algorithm SHA256).Hash
    $info = [ordered]@{
        target = $target
        machine = 'AMD64'
        subsystem = 'Windows GUI'
        executable = $filename
        bytes = (Get-Item $destination).Length
        sha256 = $hash
        directSystemDependencies = $dlls
        nativeGuiSmoke = 'passed'
        cleanWindowsMachine = 'not verified'
    }
    $info | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $output 'build-info.json')
    Write-Output "Release ready: $destination"
    Write-Output "Size: $([math]::Round($info.bytes / 1MB, 2)) MiB"
    Write-Output "SHA256: $hash"
} finally { Pop-Location }
