# Build script for CUDA-only configuration
# Run from llama.cpp root directory

$ErrorActionPreference = "Stop"

$BuildDir = "out/cuda"
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

Write-Host "Build complete! Binaries in: $BuildDir/bin/$BuildType" -ForegroundColor Green
