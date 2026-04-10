
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseDir = Split-Path -Parent $ScriptDir
$RepoRoot = Join-Path $BaseDir "llama.cpp"
$OutDir = Join-Path $BaseDir "out\vulkan"

Write-Host "Building llama.cpp with Vulkan support..."

if (Test-Path $OutDir) {
    Remove-Item -Recurse -Force $OutDir
}

# Enforce standard MSVC compiler instead of grabbing Intel icx silently
$CMakeCmd = "cmake -S `"$RepoRoot`" -B `"$OutDir`" -G `"Visual Studio 17 2022`" -A x64 -T v143 -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release"
$BuildCmd = "cmake --build `"$OutDir`" --config Release --parallel 16"

Invoke-Expression $CMakeCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Invoke-Expression $BuildCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Vulkan build complete!"

