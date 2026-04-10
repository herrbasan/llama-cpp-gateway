# Build script for SYCL (Intel Arc) only
# Run from llama.cpp root directory

$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
if ($PSScriptRoot -like "*build-scripts*") {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$BuildDir = "$ProjectRoot\out\sycl"
$BuildType = "Release"

Write-Host "Building llama.cpp with SYCL support (Intel Arc)..." -ForegroundColor Green
Write-Host "Build directory: $BuildDir"
Write-Host "Build type: $BuildType"

# Try to find Intel oneAPI
$OneAPIPath = "C:\Program Files (x86)\Intel\oneAPI"
$SetVarsBat = "$OneAPIPath\setvars.bat"
$MKLPath = "$OneAPIPath\mkl\latest"

if (-not (Test-Path $SetVarsBat)) {
    Write-Error "Intel oneAPI not found at $OneAPIPath. Please install oneAPI Base Toolkit."
    exit 1
}

# Get number of CPU cores for parallel build
$Cores = (Get-CimInstance Win32_Processor).NumberOfLogicalProcessors
Write-Host "Using $Cores parallel jobs for build"

# Find MKL CMake path
$MKLCmakePath = "$MKLPath\lib\cmake\mkl"
if (-not (Test-Path $MKLCmakePath)) {
    Write-Warning "MKL CMake files not found at expected location, trying to find..."
    $MKLCmakeFile = Get-ChildItem "$OneAPIPath\mkl" -Recurse -Filter "MKLConfig.cmake" | Select-Object -First 1
    if ($MKLCmakeFile) {
        $MKLCmakePath = $MKLCmakeFile.Directory.FullName
    }
}
Write-Host "MKL CMake path: $MKLCmakePath"

# Potential VS locations
$VS2022Path = "C:\Program Files\Microsoft Visual Studio\2022\Community"
if (-not (Test-Path $VS2022Path)) {
    $VS2022Path = "C:\Program Files\Microsoft Visual Studio\2022\Professional"
}
if (-not (Test-Path $VS2022Path)) {
    $VS2022Path = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
}

# Source oneAPI environment and build in the same cmd session
Write-Host "Sourcing Intel oneAPI environment..."
$LlamaCppDir = "$ProjectRoot\llama.cpp"

# Configure with SYCL enabled (CUDA disabled)
$CMakeCmd = @"
call "$SetVarsBat" intel64 && cmake -S "$LlamaCppDir" -B "$BuildDir" -G "Ninja" -DGGML_SYCL=ON -DGGML_SYCL_F16=ON -DGGML_CUDA=OFF -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icx -DCMAKE_BUILD_TYPE=$BuildType -DMKLROOT="$MKLPath" -DCMAKE_PREFIX_PATH="$MKLCmakePath"
"@

# Build with all CPU cores
$BuildCmd = @"
call "$SetVarsBat" intel64 && cmake --build "$BuildDir" --config $BuildType --parallel $Cores
"@

cmd /c $CMakeCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

cmd /c $BuildCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Copy to dist folders
$DistDirMinimal = "$ProjectRoot\dist\sycl"
$SourceDir = "$BuildDir\bin\$BuildType"

# Minimal distribution (essential files only)
Write-Host "Copying minimal distribution..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $DistDirMinimal | Out-Null
$EssentialFiles = @(
    "llama-cli.exe",
    "llama-server.exe",
    "llama-bench.exe",
    "llama-quantize.exe",
    "llama-ls-sycl-device.exe",
    "ggml-base.dll",
    "ggml-cpu.dll",
    "ggml-sycl.dll",
    "ggml.dll",
    "llama.dll"
)
foreach ($file in $EssentialFiles) {
    $src = Join-Path $SourceDir $file
    if (Test-Path $src) {
        Copy-Item $src $DistDirMinimal -Force
    }
}
