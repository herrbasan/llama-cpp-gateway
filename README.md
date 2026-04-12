# LLaMA.cpp Gateway Build Project

A production-ready wrapper around llama.cpp providing reproducible builds with CUDA and Vulkan support, plus a zero-dependency Node.js management layer for process control.

## Overview

This project provides:

1. **Build System** — PowerShell scripts to compile llama.cpp with CUDA + Vulkan backends
2. **Management Layer** — HTTP API to safely start, stop, and monitor llama-server instances

```
┌─────────────┐     HTTP      ┌──────────────┐     spawn     ┌─────────────┐
│   Client    │◄─────────────►│   Manager    │──────────────►│ llama-server│
│  (Port 80)  │   Control     │  (Port 4080) │               │  (Port 4081)│
└─────────────┘               └──────────────┘               └──────┬──────┘
                                                                    │
                              Inference traffic bypasses manager    │
                              ◄─────────────────────────────────────┘
```

## Quick Start

```powershell
# 1. Build the universal binary (CUDA + Vulkan)
.\build\build-universal.ps1

# 2. Bundle for deployment
.\build\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -CreateLauncher

# 3. Start the manager
cd C:\Services\llama-manager
.\start.bat

# 4. In another terminal - list models
curl http://127.0.0.1:4080/models

# 5. Start a model
curl -X POST http://127.0.0.1:4080/start `
  -H "Content-Type: application/json" `
  -d '{"modelPath": "Publisher/Model/model.gguf", "gpuLayers": 99}'

# 6. Generate text (direct to llama-server)
curl -X POST http://127.0.0.1:4081/completion `
  -H "Content-Type: application/json" `
  -d '{"prompt": "Hello, world!", "n_predict": 50}'

# 7. Stop when done
curl -X POST http://127.0.0.1:4080/stop
```

## Updating

To update to a new version without losing config:

```powershell
# Re-run bundle with -Overwrite
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -Overwrite -CreateLauncher

# Your config.json is preserved
```

## Documentation

| Document | Purpose | Read This If... |
|----------|---------|-----------------|
| **[docs/QUICKSTART.md](docs/QUICKSTART.md)** | 5-minute setup guide | You're setting up for the first time |
| **[docs/OPERATIONS.md](docs/OPERATIONS.md)** | Production deployment | You want to run this as a service |
| **[docs/API.md](docs/API.md)** | API reference | You're writing client code |
| **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** | All config options | You need to customize ports, paths, etc. |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | System design | You want to understand how it works |
| **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** | Problem solving | Something isn't working |

> 📚 **Start here:** [docs/QUICKSTART.md](docs/QUICKSTART.md) for your first setup, then [docs/OPERATIONS.md](docs/OPERATIONS.md) for running in production.

## Project Structure

```
llama-cpp-gateway/
├── build-scripts/          # Build configurations
│   ├── build-cuda.ps1      # CUDA-only build
│   ├── build-vulkan.ps1    # Vulkan-only build
│   ├── build-universal.ps1 # CUDA + Vulkan build
│   └── README.md
├── llama-manager/          # Management layer
│   ├── server.js           # HTTP API server
│   ├── process.js          # Process supervisor
│   ├── models.js           # Model discovery & metadata
│   ├── config.js           # Configuration
│   ├── test.js             # Integration tests
│   ├── package.json
│   └── nLogger/            # Logging submodule
├── llama.cpp/              # Git submodule (upstream)
├── dist/                   # Compiled binaries
│   └── universal/
│       ├── llama-server.exe
│       └── ggml-*.dll
├── docs/                   # Documentation
│   ├── QUICKSTART.md
│   ├── OPERATIONS.md
│   ├── API.md
│   ├── CONFIGURATION.md
│   ├── ARCHITECTURE.md
│   ├── TROUBLESHOOTING.md
│   └── README.md
├── logs/                   # Runtime logs
├── out/                    # Build artifacts
└── README.md               # This file
```

## Prerequisites

1. **NVIDIA CUDA Toolkit 12.2+** — [Download](https://developer.nvidia.com/cuda-downloads)
2. **Vulkan SDK** — [Download](https://vulkan.lunarg.com/sdk/home) (for Intel Arc/AMD support)
3. **Visual Studio 2022** with C++ workload
4. **Node.js 18+** — [Download](https://nodejs.org/)
5. **Git** with LFS support

> **Note:** Restart your terminal after installing toolkits to refresh PATH.

## Build Options

### Universal Build (Recommended)
CUDA + Vulkan support for maximum hardware compatibility:

```powershell
.\build-scripts\build-universal.ps1
```

### CUDA Only
For NVIDIA-only systems:

```powershell
.\build-scripts\build-cuda.ps1
```

### Vulkan Only
For Intel Arc/AMD systems without NVIDIA:

```powershell
.\build-scripts\build-vulkan.ps1
```

Output goes to `dist/universal/` or `dist/cuda/` or `dist/vulkan/`.

## Deployment Bundling

The `bundle-deployment.ps1` script creates a clean, self-contained deployment outside the source repo:

```powershell
# Create deployment with launcher scripts
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -CreateLauncher

# Update existing deployment (preserves config.json)
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -Overwrite
```

This creates:
```
C:\Services\llama-manager\
├── server.js              # Manager code
├── config.json            # Easy configuration file
├── start.bat              # Double-click launcher
├── bin\                   # llama-server.exe + DLLs
├── nLogger\src\          # Logging module
└── logs\                  # Runtime logs
```

**Why bundle?**
- Clean separation from source repo
- Simple configuration via `config.json`
- Easy updates with `-Overwrite`
- Ready for process managers

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for integration with Local Process Manager, PM2, or Windows Services.

## Management API

The manager exposes a simple HTTP API on port 4080:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/models` | GET | List available GGUF models |
| `/start` | POST | Start llama-server with model |
| `/stop` | POST | Stop running server |
| `/status` | GET | Get current state and metrics |

Full API documentation: [docs/API.md](docs/API.md)

## Configuration

### Bundled Deployment (config.json)

When using `bundle-deployment.ps1`, edit `config.json`:

```json
{
  "port": 4080,
  "serverPort": 4081,
  "modelsDir": "D:\\# AI Stuff\\LMStudio_Models",
  "detachOnShutdown": false
}
```

### Environment Variables

Or use environment variables (override config.json):

```powershell
$env:MANAGER_PORT = 4080
$env:LLAMA_SERVER_PORT = 4081
$env:MODELS_DIR = "D:\Models"
$env:LOG_RETENTION_DAYS = 7
```

Full configuration guide: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## Key Features

- **Zero Dependencies** — Only Node.js standard library (no npm packages)
- **Flash Attention Support** — Run 64k+ context on 24GB VRAM (50% KV cache reduction)
- **Model Profiles** — Auto-apply optimized settings per model (context, GPU layers, FA)
- **Singleton Enforcement** — Only one llama-server instance at a time
- **Guaranteed Disposal** — Child process killed if manager crashes
- **LM Studio Compatible** — Supports `Publisher/Repo/Model.gguf` structure
- **GGUF Metadata Extraction** — Reads architecture, parameters, context length
- **Health Polling** — Automatic state transitions (starting → running)
- **Prometheus Metrics** — Forwards llama-server telemetry

## Production Deployment

### Local Process Manager (Recommended)

[Local Process Manager](https://github.com/herrbasan/local_pm) is an Electron tray app for managing CLI services.

**Step 1:** Bundle the deployment:
```powershell
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -CreateLauncher
```

**Step 2:** Add to `local_pm/config.json`:
```json
{
    "llama-manager":{
        "description":"LLaMA Manager",
        "path":"C:\\Services\\llama-manager",
        "exec":"start.bat",
        "args":"",
        "detachOnQuit":false
    }
}
```

### Other Options

- **PM2** — Node.js process manager with auto-restart
- **Windows Service (nssm)** — Native Windows service
- **Manual** — Direct `node server.js` execution

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for complete deployment instructions.

## Troubleshooting

Common issues:

| Issue | Solution |
|-------|----------|
| "Port already in use" | `Stop-Process -Name "node"` or change ports |
| "Cannot find llama-server.exe" | Run build script first |
| Model fails to load | Reduce `gpuLayers` or `ctxSize` |
| OOM errors | Use smaller quantization (Q4 → Q3) |

Full troubleshooting: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Updating

### Update Deployment

To update the bundled deployment after pulling new code:

```powershell
# Re-bundle with -Overwrite (preserves config.json)
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -Overwrite -CreateLauncher
```

### Update llama.cpp

To update the underlying llama.cpp submodule:

```powershell
cd llama.cpp
git pull origin master
cd ..
git add llama.cpp
git commit -m "Update llama.cpp to latest"

# Rebuild
Remove-Item -Recurse -Force out\*
.\build-scripts\build-universal.ps1

# Re-bundle
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -Overwrite

## Philosophy

This project follows **Deterministic Mind** principles:

- **Reliability > Performance > Everything else**
- **Fail Fast** — No defensive coding, clear errors
- **Zero Dependencies** — Build it ourselves
- **Block Until Truth** — State is authoritative
- **Guaranteed Disposal** — Every resource has cleanup

## License

See individual submodules:
- `llama.cpp/` — MIT License (ggml-org)
- `llama-manager/nLogger/` — MIT License
- Build scripts and manager — ISC License

---

📚 **Documentation:** [docs/QUICKSTART.md](docs/QUICKSTART.md) • [docs/OPERATIONS.md](docs/OPERATIONS.md) • [docs/API.md](docs/API.md) • [docs/CONFIGURATION.md](docs/CONFIGURATION.md) • [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

*For all documentation, see the [docs/](docs/) directory.*
