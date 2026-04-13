# Build script for Universal (CUDA + Vulkan) configuration
# Run from llama.cpp root directory

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BuildDir = "$ProjectRoot\out\universal"
$BaseDir = Split-Path -Parent $ProjectRoot
$RepoRoot = Join-Path $ProjectRoot "llama.cpp"

Write-Host "Building llama.cpp with CUDA + Vulkan support..." -ForegroundColor Green
Write-Host "Build directory: $BuildDir"

# Update llama.cpp submodule
Write-Host "Updating llama.cpp submodule..." -ForegroundColor Cyan
git submodule update --init --recursive

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

# Copy to dist folder
$SourceDir = "$BuildDir\bin"
if (Test-Path "$BuildDir\bin\Release") {
    $SourceDir = "$BuildDir\bin\Release"
}
$DistDir = "$ProjectRoot\dist\universal"

# Ensure LFS binaries are downloaded (not just pointer files)
if (Test-Path "$DistDir\llama-server.exe") {
    $FirstLine = Get-Content "$DistDir\llama-server.exe" -TotalCount 1 -Raw
    if ($FirstLine -match "version https://git-lfs") {
        Write-Host "" -ForegroundColor Yellow
        Write-Host "Git LFS binaries not downloaded. Running 'git lfs pull'..." -ForegroundColor Yellow
        git lfs pull
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to download LFS binaries. Check your LFS setup." -ForegroundColor Red
            exit 1
        }
    }
}

# Check if llama-server.exe is currently running from dist folder
$DistServerExe = "$DistDir\llama-server.exe"
if (Test-Path $DistServerExe) {
    $RunningProcesses = Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $DistServerExe }
    if ($RunningProcesses) {
        Write-Host "" -ForegroundColor Red
        Write-Host "ERROR: llama-server.exe is currently running from dist\universal." -ForegroundColor Red
        Write-Host "       The build cannot overwrite the file while it is in use." -ForegroundColor Yellow
        Write-Host "" -ForegroundColor Red
        Write-Host "       Please stop the server process and run this script again." -ForegroundColor Yellow
        Write-Host "" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Copying distribution to dist\universal..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Copy-Item -Path "$SourceDir\*" -Destination $DistDir -Recurse -Force

Write-Host "Universal CUDA + Vulkan build complete without Intel icx runtime dependencies!" -ForegroundColor Green
Write-Host "  Build artifacts: $BuildDir\bin\Release" -ForegroundColor Gray
Write-Host "  Distribution:    $DistDir" -ForegroundColor Gray
