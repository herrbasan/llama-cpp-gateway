# Build script for Universal (CUDA + Vulkan) configuration
# Run from llama.cpp root directory

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BuildDir = "$ProjectRoot\out\universal"
$BaseDir = Split-Path -Parent $ProjectRoot
$RepoRoot = Join-Path $ProjectRoot "llama.cpp"

Write-Host "Building llama.cpp with CUDA + Vulkan support..." -ForegroundColor Green
Write-Host "Build directory: $BuildDir"

# Check prerequisites
if (-not (Get-Command nvcc -ErrorAction SilentlyContinue)) {
    Write-Warning "CUDA wrapper nvcc not found in PATH. Ensure CUDA Toolkit is installed."
}

if (-not $env:VULKAN_SDK) {
    if ([System.Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine")) {
        $env:VULKAN_SDK = [System.Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine")
    } else {
        Write-Warning "VULKAN_SDK environment variable not found. Ensure LunarG Vulkan SDK is installed."
    }
}

# Clean existing build directory if needed to avoid cache issues
if (Test-Path $BuildDir) {
    Remove-Item -Recurse -Force $BuildDir
}

# Get number of CPU cores for parallel build
$Cores = (Get-CimInstance Win32_Processor).NumberOfLogicalProcessors
Write-Host "Using $Cores parallel jobs for build"

# Locate MSVC environment script to load CMake and compiler paths
$VcvarsBat = "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $VcvarsBat)) {
    $VcvarsBat = "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
}

# Configure with MSVC Environment but use Ninja for a rock-solid build
# Here we enable both CUDA and VULKAN for dynamic backend building
$CMakeCmd = "`"$VcvarsBat`" && cmake -S `"$RepoRoot`" -B `"$BuildDir`" -G `"Ninja`" -DGGML_CUDA=ON -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release"

# Build with all CPU cores
$BuildCmd = "`"$VcvarsBat`" && cmake --build `"$BuildDir`" --config Release --parallel $Cores"

Write-Host "Configuring CMake for CUDA and Vulkan using MSVC..."
cmd /c $CMakeCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Compiling binaries..."
cmd /c $BuildCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Minimal distribution (essential files only)
$SourceDir = "$BuildDir\bin"
if (Test-Path "$BuildDir\bin\Release") {
    $SourceDir = "$BuildDir\bin\Release"
}
$DistDirMinimal = "$ProjectRoot\dist\universal"

Write-Host "Copying minimal distribution to dist\universal..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $DistDirMinimal | Out-Null
$EssentialFiles = @(
    "llama-cli.exe",
    "llama-server.exe",
    "llama-bench.exe",
    "ggml-base.dll",
    "ggml-cpu.dll",
    "ggml-cuda.dll",
    "ggml-vulkan.dll",
    "ggml-rpc.dll",
    "ggml-sycl.dll",
    "ggml.dll",
    "llama.dll",
    "mtmd.dll"
)
foreach ($file in $EssentialFiles) {
    $src = Join-Path $SourceDir $file
    if (Test-Path $src) {
        Copy-Item $src $DistDirMinimal -Force
    }
}

Write-Host "Universal CUDA + Vulkan build complete without Intel icx runtime dependencies!" -ForegroundColor Green

Write-Host "Build complete!" -ForegroundColor Green
Write-Host "  Build artifacts: $BuildDir\bin\$BuildType" -ForegroundColor Gray
Write-Host "  Full dist:       $DistDirFull" -ForegroundColor Gray
Write-Host "  Minimal dist:    $DistDirMinimal" -ForegroundColor Gray
