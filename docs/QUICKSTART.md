# Quick Start Guide

Get the LLaMA.cpp Gateway running in 5 minutes.

## Prerequisites

1. **Node.js 18+** — [Download](https://nodejs.org/)
2. **CUDA Toolkit 12.2+** (for NVIDIA GPUs) — [Download](https://developer.nvidia.com/cuda-downloads)
3. **Vulkan SDK** (for Intel Arc/AMD GPUs) — [Download](https://vulkan.lunarg.com/sdk/home)
4. **Visual Studio 2022** with C++ workload

## Step 1: Build the llama-server Binary

```powershell
# Clone with submodules (includes llama.cpp and nLogger)
git clone --recursive <repo-url>
cd llama-cpp-gateway

# Build universal binary (CUDA + Vulkan)
.\build-scripts\build-universal.ps1
```

> **Note:** First build takes 5-15 minutes depending on your CPU.

Verify the build:
```powershell
ls .\dist\universal\
# Should show: llama-server.exe, llama-cli.exe, ggml-*.dll files
```

## Step 2: Bundle for Deployment (Recommended)

Instead of running directly from the repo, create a clean deployment:

```powershell
# Bundle all files to C:\Services\llama-manager
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -CreateLauncher

# Or for CUDA-only build:
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -BuildType cuda -CreateLauncher
```

This creates:
```
C:\Services\llama-manager\
├── server.js          # Manager code
├── config.json        # Configuration file
├── start.bat          # Easy launcher
├── bin\               # llama-server.exe and DLLs
│   ├── llama-server.exe
│   └── ggml-*.dll
├── nLogger\src\       # Logging module
└── logs\              # Runtime logs
```

## Step 3: Configure

Edit `C:\Services\llama-manager\config.json`:

```json
{
  "port": 4080,
  "serverPort": 4081,
  "modelsDir": "D:\\# AI Stuff\\LMStudio_Models",
  "detachOnShutdown": false
}
```

Or create the default models directory:
```powershell
mkdir "D:\# AI Stuff\LMStudio_Models"
```

## Step 4: Start the Manager

```powershell
cd C:\Services\llama-manager
.\start.bat
```

Or manually:
```powershell
cd C:\Services\llama-manager
node server.js
```

You should see:
```
[INFO] Llama Manager started on http://127.0.0.1:4080
[INFO] Configured Models Directory: D:\# AI Stuff\LMStudio_Models
[INFO] Configured Server Target: C:\Services\llama-manager\bin\llama-server.exe
```

## Step 5: Test It

Open another terminal and run:

```powershell
# List available models
curl http://127.0.0.1:4080/models

# Start a model (model profiles auto-apply optimized settings)
curl -X POST http://127.0.0.1:4080/start `
  -H "Content-Type: application/json" `
  -d '{"modelPath": "Publisher/ModelRepo/model-Q4_K_M.gguf"}'

# Or manually specify settings for full control:
# curl -X POST http://127.0.0.1:4080/start `
#   -H "Content-Type: application/json" `
#   -d '{"modelPath": "model.gguf", "ctxSize": 65536, "flashAttention": true}'

# Check status (poll until state is "running")
curl http://127.0.0.1:4080/status

# Now inference goes directly to llama-server on port 4081
curl -X POST http://127.0.0.1:4081/completion `
  -H "Content-Type: application/json" `
  -d '{"prompt": "Hello, world!", "n_predict": 50}'

# Stop when done
curl -X POST http://127.0.0.1:4080/stop
```

## Next Steps

- **[Configuration](CONFIGURATION.md)** — Customize ports, paths, logging
- **[Operations Guide](OPERATIONS.md)** — Production deployment, monitoring, auto-start
- **[API Reference](API.md)** — Full endpoint documentation
- **[Troubleshooting](TROUBLESHOOTING.md)** — Fix common issues

## Directory Structure (Bundled Deployment)

After running `bundle-deployment.ps1`:

```
C:\Services\llama-manager\    # Your deployment directory
├── server.js                  # Manager code
├── process.js                 # Process control
├── models.js                  # Model discovery
├── config.js                  # Config loader
├── config.json                # YOUR CONFIGURATION
├── start.bat                  # Easy launcher
├── start.ps1                  # PowerShell launcher
├── package.json
├── bin\                       # Compiled binaries
│   ├── llama-server.exe       # Main inference server
│   ├── llama-cli.exe
│   └── ggml-*.dll             # CUDA/Vulkan backends
├── nLogger\src\               # Logging module
│   └── logger.js
└── logs\                      # Runtime logs (auto-created)
```

Source repo remains untouched for updates:
```
D:\DEV\llama-cpp-gateway\      # Source/development
├── llama-manager\             # Source files
├── build-scripts\             # Build & bundle scripts
└── ...
```
