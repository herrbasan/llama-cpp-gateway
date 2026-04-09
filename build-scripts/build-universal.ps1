# Build script for Universal (CUDA + SYCL) configuration
# Run from llama.cpp root directory

$ErrorActionPreference = "Stop"

$BuildDir = "out/universal"
$BuildType = "Release"

Write-Host "Building llama.cpp with CUDA + SYCL support..." -ForegroundColor Green
Write-Host "Build directory: $BuildDir"
Write-Host "Build type: $BuildType"

# Check prerequisites
if (-not (Get-Command nvcc -ErrorAction SilentlyContinue)) {
    Write-Error "CUDA not found. Please install CUDA Toolkit."
    exit 1
}

# Try to find Intel oneAPI
$OneAPIPath = "C:\Program Files (x86)\Intel\oneAPI"
$SetVarsBat = "$OneAPIPath\setvars.bat"

if (-not (Test-Path $SetVarsBat)) {
    Write-Error "Intel oneAPI not found at $OneAPIPath. Please install oneAPI Base Toolkit."
    exit 1
}

# Source oneAPI environment and build in the same cmd session
Write-Host "Sourcing Intel oneAPI environment..."
$CMakeCmd = @"
call "$SetVarsBat" intel64 && cmake -B $BuildDir -DGGML_CUDA=ON -DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx -DCMAKE_BUILD_TYPE=$BuildType
"@

$BuildCmd = @"
call "$SetVarsBat" intel64 && cmake --build $BuildDir --config $BuildType -j
"@

cmd /c $CMakeCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

cmd /c $BuildCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Build complete! Binaries in: $BuildDir/bin/$BuildType" -ForegroundColor Green
