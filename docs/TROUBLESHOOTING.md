# Troubleshooting Guide

Common issues and their solutions.

## Quick Diagnostics

Run these commands to gather information about any issue:

```powershell
# Check if manager is running
Get-Process | Where-Object {$_.ProcessName -match "node"}

# Check if llama-server is running  
Get-Process | Where-Object {$_.ProcessName -match "llama"}

# Check ports in use
Get-NetTCPConnection -LocalPort 4080, 4081 | Select-Object LocalPort, OwningProcess, @{Name="ProcessName";Expression={(Get-Process -Id $_.OwningProcess).ProcessName}}

# View recent logs
cat (Get-ChildItem logs\*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1)

# Test manager API
curl http://127.0.0.1:4080/status

# Test server directly (if running)
curl http://127.0.0.1:4081/health
```

---

## Build Issues

### "CMake not found"

**Symptom:**
```
cmake : The term 'cmake' is not recognized
```

**Solution:**
```powershell
# Install Visual Studio 2022 with C++ workload
# Or install CMake from https://cmake.org/download/
# Make sure to restart PowerShell after installation
```

### "nvcc not found" (CUDA builds)

**Symptom:**
```
CUDA wrapper nvcc not found in PATH
```

**Solution:**
```powershell
# Check if CUDA is installed
ls "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.*\bin\nvcc.exe"

# Add to PATH (temporary)
$env:PATH += ";C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.2\bin"

# Or permanent
[Environment]::SetEnvironmentVariable("PATH", $env:PATH + ";C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.2\bin", "User")
```

### "VULKAN_SDK not found"

**Symptom:**
```
VULKAN_SDK environment variable not found
```

**Solution:**
```powershell
# Install Vulkan SDK from https://vulkan.lunarg.com/sdk/home
# Then restart PowerShell

# Verify
$env:VULKAN_SDK
# Should show: C:\VulkanSDK\1.3.xxx.x
```

### Build fails with "cannot open include file"

**Symptom:**
```
fatal error C1083: Cannot open include file: 'cuda_runtime.h'
```

**Causes:**
- CUDA Toolkit not installed
- Wrong Visual Studio version
- Missing Windows SDK

**Solution:**
```powershell
# 1. Verify CUDA installation
nvcc --version

# 2. Use correct vcvarsall.bat path in build script
# Edit build-scripts/build-universal.ps1:
$VcvarsBat = "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
# or
$VcvarsBat = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
```

### "ggml-cuda.dll not found" after successful build

**Symptom:**
Binary builds but CUDA doesn't work at runtime.

**Solution:**
```powershell
# Check build actually produced CUDA DLL
ls .\out\universal\bin\Release\ggml-cuda.dll

# If missing, build may have silently skipped CUDA
# Check build output for CUDA-related warnings
```

---

## Startup Issues

### "Cannot find llama-server.exe"

**Symptom:**
```
Error: spawn ... ENOENT
```

**Diagnosis:**
```powershell
# Check the configured path
cat .\llama-manager\config.js | findstr llamaServerPath

# Verify file exists
ls $env:LLAMA_SERVER_PATH
# or
ls .\dist\universal\llama-server.exe
```

**Solutions:**

1. **Build the binary:**
```powershell
.\build-scripts\build-universal.ps1
```

2. **Set correct path:**
```powershell
$env:LLAMA_SERVER_PATH = "D:\llama-cpp-gateway\dist\universal\llama-server.exe"
```

3. **Check relative path:**
```powershell
# From llama-manager directory, verify:
ls ..\dist\universal\llama-server.exe
```

### "Port 4080 already in use"

**Symptom:**
```
Error: listen EADDRINUSE: address already in use 127.0.0.1:4080
```

**Diagnosis:**
```powershell
# Find process using the port
Get-NetTCPConnection -LocalPort 4080 | Select-Object OwningProcess, @{Name="Name";Expression={(Get-Process -Id $_.OwningProcess).ProcessName}}

# Check if it's another llama-manager instance
Get-Process | Where-Object {$_.ProcessName -eq "node"}
```

**Solutions:**

1. **Kill existing process:**
```powershell
Stop-Process -Name "node" -Force
```

2. **Use different port:**
```powershell
$env:MANAGER_PORT = 8090
$env:LLAMA_SERVER_PORT = 8091
node server.js
```

### "Models directory not found"

**Symptom:**
```
Failed to scan directory D:\# AI Stuff\LMStudio_Models: ENOENT
```

**Solution:**
```powershell
# Create the directory
mkdir "D:\# AI Stuff\LMStudio_Models"

# Or set custom path
$env:MODELS_DIR = "C:\Path\To\Your\Models"
```

### "uncaughtException: Cannot find module"

**Symptom:**
```
Error: Cannot find module './nLogger/src/logger.js'
```

**Cause:** Git submodule not initialized.

**Solution:**
```powershell
# Initialize submodules
git submodule update --init --recursive

# Verify
ls .\llama-manager\nLogger\src\logger.js
```

---

## Runtime Issues

### Model fails to load (OOM)

**Symptom:**
- Request to `/start` returns 200
- Status stays on `starting` or goes to `error`
- Logs show: `ggml_cuda_host_malloc: failed to allocate ...`

**Solutions:**

1. **Reduce GPU layers:**
```powershell
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "gpuLayers": 20}'
```

2. **Reduce context size:**
```powershell
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "ctxSize": 2048}'
```

3. **Use smaller quantization:**
- Q4_K_M → Q3_K_S → Q2_K (trade quality for memory)

4. **Check available VRAM:**
```powershell
# NVIDIA
nvidia-smi

# Should show available memory. Model needs:
# ~4GB for 7B Q4, ~8GB for 13B Q4, etc.
```

### Server stuck in "starting" state

**Symptom:**
```json
{"state": "starting", "pid": 12345, "metrics": {}}
```

**For more than 30 seconds**

**Diagnosis:**
```powershell
# Check if llama-server process exists
Get-Process | Where-Object {$_.Id -eq 12345}

# Check logs
cat logs\main-0.log | jq 'select(.level == "ERROR")'

# Try health endpoint directly
curl http://127.0.0.1:4081/health
```

**Common Causes:**

1. **Model loading is slow:** Large models on HDD can take 30-60s
2. **Port binding failed:** Check if 4081 is in use
3. **Missing DLL:** Check Windows Event Viewer

**Solutions:**

```powershell
# Wait longer for large models on slow storage

# Check port conflict
Get-NetTCPConnection -LocalPort 4081

# If stuck, stop and restart
curl -X POST http://127.0.0.1:4080/stop
Start-Sleep -Seconds 3
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf"}'
```

### "Conflict: Server already running"

**Symptom:**
```json
{"error": "Conflict: Server already running"}
```

**Solution:**
```powershell
# Check status
curl http://127.0.0.1:4080/status

# Stop if needed
curl -X POST http://127.0.0.1:4080/stop

# Wait a moment, then start again
Start-Sleep -Seconds 3
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf"}'
```

If `/stop` doesn't work:
```powershell
# Force kill
Get-Process | Where-Object {$_.ProcessName -like "*llama*"} | Stop-Process -Force
```

### Inference requests fail with 404

**Symptom:**
```
curl: (7) Failed to connect to 127.0.0.1 port 4081
```

**Diagnosis:**
```powershell
# Check if server is running
curl http://127.0.0.1:4080/status

# Check if it's actually listening
Get-NetTCPConnection -LocalPort 4081
```

**Solutions:**

1. **Server not started:**
```powershell
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf"}'
```

2. **Wrong port:**
```powershell
# Check actual port in config
cat .\llama-manager\config.js | findstr serverPort
```

### High memory usage / Memory leak

**Symptom:**
Memory grows over time and isn't released after `/stop`

**Diagnosis:**
```powershell
# Monitor process memory
while ($true) { Get-Process llama-server | Select-Object WorkingSet; Start-Sleep -Seconds 5 }

# Check for zombie processes
Get-Process | Where-Object {$_.ProcessName -like "*llama*"}
```

**Solutions:**

1. **Ensure proper shutdown:**
```powershell
# Always use /stop, don't just kill manager
curl -X POST http://127.0.0.1:4080/stop
```

2. **Kill zombie processes:**
```powershell
Get-Process | Where-Object {$_.ProcessName -eq "llama-server"} | Stop-Process -Force
```

3. **Reduce context size:** Large contexts consume more memory

4. **Limit concurrent requests:** Too many parallel generations can OOM

---

## Performance Issues

### Slow token generation

**Symptom:**
< 10 tokens/second on GPU

**Diagnosis:**
```powershell
# Check if GPU is actually being used
nvidia-smi -l 1
# Watch for GPU utilization %

# Check GPU layers loaded
curl http://127.0.0.1:4080/status
# Then check logs for layer offloading info
```

**Solutions:**

1. **Increase GPU layers:**
```powershell
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "gpuLayers": 99}'
```

2. **Use quantization:**
- F16 → Q8_0 → Q4_K_M (faster, less VRAM)

3. **Reduce context size:**
- Smaller context = faster generation

4. **Check CPU throttling:**
```powershell
# Monitor CPU
Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 10
```

### "Failed to fetch metrics" warnings

**Symptom:**
Logs show periodic warnings about metrics polling.

**This is normal during:**
- Server startup (before health check passes)
- Brief periods of high load

**Concerning if:**
- Continuous during `running` state
- Accompanied by slow/no generation

**Solution:**
```powershell
# Check if server is responsive
curl http://127.0.0.1:4081/health

# If unresponsive, may need restart
curl -X POST http://127.0.0.1:4080/stop
Start-Sleep -Seconds 3
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf"}'
```

---

## Log Issues

### Logs not being written

**Symptom:**
`logs/` directory is empty or missing

**Solution:**
```powershell
# Create logs directory
mkdir logs

# Check permissions
test-path logs

# Verify nLogger is working
cat .\llama-manager\nLogger\src\logger.js

# Check for errors in console output
```

### "Failed to parse metadata" warnings

**Symptom:**
```
[WARN] Failed to parse metadata for model.gguf: Unexpected end of file
```

**Cause:** GGUF header parser couldn't read complete metadata

**Impact:** Model will still work, just without metadata in `/models` response

**Solution:**
```powershell
# Usually safe to ignore
# If concerned, verify model file integrity
Get-FileHash .\model.gguf
# Compare with expected hash from download source
```

---

## Windows-Specific Issues

### Windows Defender / Antivirus blocking

**Symptom:**
Binary immediately terminates or is quarantined

**Solution:**
```powershell
# Add exclusion for the project directory
# Windows Security → Virus & threat protection → Exclusions
# Add: D:\llama-cpp-gateway\
```

### "The application was unable to start correctly (0xc000007b)"

**Symptom:**
DLL initialization error

**Cause:** Mix of 32-bit and 64-bit DLLs, or missing Visual C++ Redistributable

**Solution:**
```powershell
# Install Visual C++ Redistributable
# https://aka.ms/vs/17/release/vc_redist.x64.exe

# Rebuild clean
Remove-Item -Recurse -Force .\out\universal
.\build-scripts\build-universal.ps1
```

### Long path issues

**Symptom:**
Build fails with file not found errors

**Solution:**
```powershell
# Enable long path support (requires admin)
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force

# Or move project to shorter path
# C:\llama-gateway\ instead of D:\Very\Long\Path\llama-cpp-gateway\
```

---

## Recovery Procedures

### Complete Reset

```powershell
# 1. Stop all related processes
Get-Process | Where-Object {$_.ProcessName -match "node|llama"} | Stop-Process -Force

# 2. Clear logs (optional)
Remove-Item logs\*.log

# 3. Clean build artifacts (if corruption suspected)
Remove-Item -Recurse -Force .\out\universal

# 4. Rebuild
.\build-scripts\build-universal.ps1

# 5. Restart
cd llama-manager
node server.js
```

### Verify Complete Installation

```powershell
# Run this diagnostic script
Write-Host "=== LLaMA Gateway Diagnostics ===" -ForegroundColor Green

Write-Host "`n1. Node.js version:" -ForegroundColor Cyan
node --version

Write-Host "`n2. Binary exists:" -ForegroundColor Cyan
Test-Path .\dist\universal\llama-server.exe

Write-Host "`n3. CUDA available:" -ForegroundColor Cyan
Get-Command nvcc -ErrorAction SilentlyContinue | ForEach-Object { nvcc --version }

Write-Host "`n4. Vulkan SDK:" -ForegroundColor Cyan
$env:VULKAN_SDK

Write-Host "`n5. Models directory:" -ForegroundColor Cyan
$env:MODELS_DIR
Test-Path $env:MODELS_DIR

Write-Host "`n6. Submodule initialized:" -ForegroundColor Cyan
Test-Path .\llama-manager\nLogger\src\logger.js

Write-Host "`n7. Ports available:" -ForegroundColor Cyan
Get-NetTCPConnection -LocalPort 4080 -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess
Get-NetTCPConnection -LocalPort 4081 -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess

Write-Host "`n8. Logs directory:" -ForegroundColor Cyan
Test-Path .\logs

Write-Host "`n=== Diagnostics Complete ===" -ForegroundColor Green
```

---

## Getting Help

If none of these solutions work:

1. **Run diagnostics above** and collect output
2. **Get recent logs:**
   ```powershell
   cat (Get-ChildItem logs\*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
   ```
3. **Check Windows Event Viewer:**
   - Windows Logs → Application
   - Look for errors from `llama-server.exe` or `node.exe`
4. **File an issue** with:
   - Diagnostic output
   - Relevant log excerpts
   - Steps to reproduce
   - System specs (GPU, RAM, Windows version)
