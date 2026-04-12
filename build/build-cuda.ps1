# Build script for CUDA-only configuration
# Run from llama.cpp root directory

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BuildDir = "$ProjectRoot\out\cuda"
$BuildType = "Release"

Write-Host "Building llama.cpp with CUDA support..." -ForegroundColor Green
Write-Host "Build directory: $BuildDir"
Write-Host "Build type: $BuildType"

# Check prerequisites
if (-not (Get-Command nvcc -ErrorAction SilentlyContinue)) {
    Write-Error "CUDA not found. Please install CUDA Toolkit and ensure nvcc is in PATH."
    exit 1
}

# Configure
cmake -B $BuildDir `
    -DGGML_CUDA=ON `
    -DCMAKE_BUILD_TYPE=$BuildType

# Build
cmake --build $BuildDir --config $BuildType -j

# Copy to dist folders
$DistDirFull = "$ProjectRoot\dist\cuda-full"
$DistDirMinimal = "$ProjectRoot\dist\cuda"
$SourceDir = "$BuildDir\bin\$BuildType"

# Full distribution
Write-Host "Copying full distribution..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $DistDirFull | Out-Null
Copy-Item -Path "$SourceDir\*" -Destination $DistDirFull -Recurse -Force

# Minimal distribution (essential files only)
Write-Host "Copying minimal distribution..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $DistDirMinimal | Out-Null
$EssentialFiles = @(
    "llama-cli.exe",
    "llama-server.exe",
    "llama-bench.exe",
    "llama-quantize.exe",
    "ggml-base.dll",
    "ggml-cpu.dll",
    "ggml-cuda.dll",
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

Write-Host "Build complete!" -ForegroundColor Green
Write-Host "  Build artifacts: $BuildDir\bin\$BuildType" -ForegroundColor Gray
Write-Host "  Full dist:       $DistDirFull" -ForegroundColor Gray
Write-Host "  Minimal dist:    $DistDirMinimal" -ForegroundColor Gray
