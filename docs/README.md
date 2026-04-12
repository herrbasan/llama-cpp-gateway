# LLaMA.cpp Gateway Documentation

Complete documentation for the LLaMA.cpp Gateway build system and management layer.

## Quick Navigation

| Document | Purpose | Read If... |
|----------|---------|------------|
| **[QUICKSTART.md](QUICKSTART.md)** | Get running in 5 minutes | You're new here |
| **[OPERATIONS.md](OPERATIONS.md)** | Running in production | You need to deploy/maintain the service |
| **[API.md](API.md)** | API reference | You're writing client code |
| **[CONFIGURATION.md](CONFIGURATION.md)** | All config options | You need to customize behavior |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How it works | You want to understand the system |
| **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** | Fix common issues | Something is broken |

## Documentation by Task

### I want to...

**...set this up for the first time**
→ [QUICKSTART.md](QUICKSTART.md)

**...add this to Local Process Manager**
→ [OPERATIONS.md](OPERATIONS.md) → Running as a Service

**...run this as a service that starts on boot**
→ [OPERATIONS.md](OPERATIONS.md) → Running as a Service

**...know what API endpoints are available**
→ [API.md](API.md)

**...change the ports or model directory**
→ [CONFIGURATION.md](CONFIGURATION.md)

**...understand how the manager controls llama-server**
→ [ARCHITECTURE.md](ARCHITECTURE.md)

**...fix "Port already in use" or model loading errors**
→ [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

**...monitor the service health**
→ [OPERATIONS.md](OPERATIONS.md) → Monitoring & Health Checks

**...set up logging and log rotation**
→ [OPERATIONS.md](OPERATIONS.md) → Log Management

## Project Overview

The LLaMA.cpp Gateway consists of two main parts:

1. **Build System** (`build-scripts/`)
   - Compiles llama.cpp from source with CUDA + Vulkan support
   - Produces `llama-server.exe` binary

2. **Management Layer** (`llama-manager/`)
   - Node.js HTTP API for process control
   - Model discovery and metadata extraction
   - Health monitoring and telemetry

```
┌─────────────┐     HTTP      ┌──────────────┐     spawn     ┌─────────────┐
│   Client    │◄─────────────►│   Manager    │──────────────►│ llama-server│
│  (Port 80)  │   Control     │  (Port 4080) │               │  (Port 4081)│
└─────────────┘               └──────────────┘               └──────┬──────┘
                                                                    │
                              Inference traffic bypasses manager    │
                              ◄─────────────────────────────────────┘
```

## Key Concepts

### Singleton Enforcement
Only one `llama-server.exe` can run at a time. The manager enforces this to prevent VRAM exhaustion and port conflicts.

### Separation of Concerns
- **Manager** handles process lifecycle only
- **llama-server** handles inference only
- Inference traffic goes **directly** to llama-server, bypassing the manager

### Zero Dependencies
- No npm packages (except nLogger submodule)
- Only Node.js standard library
- Single binary for llama-server

## Common Commands

```powershell
# Build
.\build-scripts\build-universal.ps1

# Start manager
cd llama-manager
node server.js

# List models
curl http://127.0.0.1:4080/models

# Start a model
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "gpuLayers": 99}'

# Check status
curl http://127.0.0.1:4080/status

# Stop
curl -X POST http://127.0.0.1:4080/stop

# Run inference (direct to llama-server)
curl -X POST http://127.0.0.1:4081/completion -H "Content-Type: application/json" -d '{"prompt": "Hello", "n_predict": 50}'
```

## Support

- Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues
- Run the diagnostic script in TROUBLESHOOTING.md to gather info
- Include logs when reporting issues

---

*This documentation follows the Deterministic Mind philosophy: Reliability > Performance > Everything else.*
