# LLaMA.cpp Gateway

Production-ready wrapper around llama.cpp: reproducible CUDA + Vulkan builds, plus a zero-dependency Node.js management layer that acts as a self-managing LLM endpoint. Send inference requests with model config in headers — the manager loads, swaps, and proxies automatically.

---

## Quick Start

### Prerequisites

1. **NVIDIA CUDA Toolkit 12.2+** (or Vulkan SDK for Intel Arc/AMD)
2. **Visual Studio 2022** with C++ workload
3. **Node.js 18+**
4. **Git**

### Build

```powershell
.\build\build-universal.ps1
```

### Start the Manager

```powershell
node src/manager/server.js
```

Output:
```
Llama Manager running at http://127.0.0.1:4080
Server binary: D:\DEV\llama-cpp-gateway\dist\universal\llama-server.exe
Models dir: D:\# AI Stuff\LMStudio_Models
```

The manager starts idle. It loads a model on the first inference request, or auto-resumes the last-loaded model if `DETACH_ON_SHUTDOWN=true` was set.

### Use It

```powershell
# Inference — model config in headers, body is proxied unchanged
curl -X POST http://127.0.0.1:4080/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "X-Model-Path: D:/models/Qwen-35B-Q3_K_M.gguf" `
  -H "X-Model-CtxSize: 64000" `
  -H "X-Model-GpuLayers: 99" `
  -H "X-Model-FlashAttention: true" `
  -d '{"model": "qwen", "messages": [{"role": "user", "content": "Hello!"}], "stream": true}'

# List available models (scans models dir, reads GGUF headers)
curl http://127.0.0.1:4080/models

# Check status
curl http://127.0.0.1:4080/status

# Stop the loaded model
curl -X POST http://127.0.0.1:4080/stop
```

Press `Ctrl+C` to stop the manager.

---

## Architecture

```
┌──────────┐  inference + model config  ┌─────────────┐  spawn/proxy  ┌─────────────┐
│ Gateway  │───────────────────────────►│  Manager    │──────────────►│ llama-server│
│          │  headers: X-Model-*        │  (Port 4080)│               │  (dynamic)  │
└──────────┘                            └─────────────┘               └─────────────┘
                                              │  auto-starts model from headers
                                              │  swaps on model path change
                                              │  proxies SSE unchanged
```

The manager is a **dumb but capable service**. It knows nothing about models until a client tells it what to load via headers. The Gateway owns all model configuration — file paths, context size, GPU layers, everything. The manager just executes.

### Components

| Component | Responsibility |
|-----------|---------------|
| **server.js** | HTTP API, header-based model resolution, SSE proxy |
| **process.js** | Child process supervisor, health polling, model lifecycle |
| **models.js** | GGUF file discovery and header metadata scanning |
| **config.js** | Global defaults only (no model registry) |
| **nLogger** | Structured logging (git submodule) |

### Request Flow

| Route | Handler | Description |
|-------|---------|-------------|
| `GET /models` | Manager | Scan models dir, return GGUF metadata |
| `GET /health` | Manager | Delegate to llama-server health |
| `GET /status` | Manager | Process state + loaded model path |
| `POST /stop` | Manager | Kill loaded model |
| **Everything else** | **Header-driven proxy** | Reads `X-Model-*` headers, starts/swaps model if needed, proxies body unchanged |

### SSE Streaming Proxy

All inference requests flow through with **zero transformation**. The request body is piped directly to llama-server — no JSON parse, no re-serialize, no buffering. SSE response streams are piped back the same way.

**Proxy overhead: ≤1ms** for text requests. Large payloads (base64 images) also pass through at ~0ms CPU since the body is never parsed.

Supported endpoints (all proxied):
- `POST /v1/chat/completions` — OpenAI-compatible chat
- `POST /chat/completions` — Chat generation
- `POST /v1/completions` — OpenAI-compatible completions
- `POST /completions` — Legacy text generation
- `POST /v1/embeddings` — Embedding generation
- `POST /embeddings` — Embedding generation
- `POST /v1/messages` — Anthropic-compatible
- `POST /api/chat` — Ollama-compatible
- `GET /health`, `/metrics`, `/slots`, `/props`
- All other llama-server endpoints

### State Machine

```
idle ──(inference with X-Model-Path)──► starting ──(health OK)──► running
  ▲                                                          │
  └────(different X-Model-Path or /stop)─────────────────────┘
```

### Design Principles

- **No model registry**: Gateway sends full config via headers, manager executes
- **Auto-start**: Model loads on first request, stays loaded
- **Auto-swap**: Different `X-Model-Path` stops current model, starts new
- **Zero dependencies**: Node.js stdlib only (except nLogger)
- **Transparent proxy**: Body is piped raw — no parse, no transform
- **Fail-fast**: Missing `X-Model-Path` = 400, invalid path = 500

---

## Configuration

All settings via `src/manager/config.js` (global defaults only).

### Model Config Headers

The Gateway sends these headers with every inference request:

| Header | Required | Description |
|--------|----------|-------------|
| `X-Model-Path` | Yes | Absolute path to the `.gguf` file |
| `X-Model-CtxSize` | No | Context window (default: from config) |
| `X-Model-GpuLayers` | No | GPU offload layers (default: from config) |
| `X-Model-FlashAttention` | No | `true`/`false` (default: from config) |
| `X-Model-Mmproj` | No | Vision projector path |
| `X-Model-Embedding` | No | `true` for embedding models |
| `X-Model-Pooling` | No | Pooling strategy (`mean`, `cls`, etc.) |
| `X-Model-BatchSize` | No | Batch size for embeddings |
| `X-Model-Mlock` | No | `true` to lock model in RAM |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_PORT` | `4080` | Manager API port |
| `LLAMA_SERVER_PATH` | `../../dist/universal/llama-server.exe` | Binary path (relative to `src/manager/`) |
| `MODELS_DIR` | `D:\# AI Stuff\LMStudio_Models` | GGUF models directory (for `/models` scanning) |
| `DEFAULT_CTX_SIZE` | `8192` | Default context window (overridden by header) |
| `DEFAULT_GPU_LAYERS` | `99` | Default GPU offload layers (overridden by header) |
| `FLASH_ATTENTION` | `true` | Enable Flash Attention by default |
| `DETACH_ON_SHUTDOWN` | `false` | Keep model in VRAM on manager restart |

### Common Scenarios

```powershell
# Custom model directory
$env:MODELS_DIR = "E:\AI\Models"

# Port conflict
$env:MANAGER_PORT = 8180

# Keep model loaded across manager restarts
$env:DETACH_ON_SHUTDOWN = "true"
```

---

## Gateway Integration

The Gateway's `llamacpp` adapter reads `modelConfig.localInference` and forwards it as `X-Model-*` headers. The manager executes — no registry, no duplication.

### Gateway config.json

```json
{
  "models": {
    "badkid-llama-chat": {
      "type": "chat",
      "adapter": "llamacpp",
      "endpoint": "http://localhost:4080",
      "localInference": {
        "enabled": true,
        "modelPath": "D:/models/Qwen-35B-Q3_K_M.gguf",
        "mmproj": "D:/models/mmproj-f16.gguf",
        "contextSize": 64000,
        "gpuLayers": 99,
        "flashAttention": true,
        "mlock": true
      },
      "capabilities": {
        "contextWindow": 64000,
        "vision": true,
        "streaming": true
      }
    }
  }
}
```

The `localInference` block is the **source of truth** for model config. The adapter reads it and adds the appropriate headers to every request.

### What Happens

1. Gateway receives a request for model `badkid-llama-chat`
2. Adapter reads `localInference` config, adds `X-Model-*` headers
3. POSTs to `http://localhost:4080/v1/chat/completions`
4. Manager checks if `X-Model-Path` matches the currently loaded model
5. If not, stops current model (if any), starts new one, waits for health
6. Proxies the request body unchanged to llama-server, streams response back
7. Next request with same path → instant proxy, no startup delay

### Adding a New Local Model

1. Add an entry to the Gateway's `config.json` with `adapter: "llamacpp"` and a `localInference` block
2. That's it. The manager needs no changes — it reads config from headers.

---

## Operations

### Logging

Logs written to `logs/` at project root:

```
logs/
├── 2026-04-12-10-30-00-gw-abc123.log   # Session log (human-readable)
└── main-0.log                           # Rolling log (JSON Lines)
```

Session logs older than `LOG_RETENTION_DAYS` are auto-deleted. Main log rotates at 10MB.

### Running as a Service

**PM2:**
```powershell
pm2 start src/manager/server.js --name llama-manager
pm2 save
pm2 startup
```

**Windows Task Scheduler:**
```powershell
$action = New-ScheduledTaskAction -Execute "node" `
    -Argument "D:\DEV\llama-cpp-gateway\src\manager\server.js" `
    -WorkingDirectory "D:\DEV\llama-cpp-gateway"
$trigger = New-ScheduledTaskTrigger -AtLogon
Register-ScheduledTask -TaskName "LlamaManager" -Action $action -Trigger $trigger -RunLevel Highest
```

### Monitoring

```powershell
# Check status (includes loaded model path)
curl http://127.0.0.1:4080/status

# Health check
curl http://127.0.0.1:4080/health

# Metrics (Prometheus format)
curl http://127.0.0.1:4080/metrics

# Monitor loop
while ($true) {
    $status = Invoke-RestMethod http://127.0.0.1:4080/status
    Write-Host "$(Get-Date) - State: $($status.state) Model: $($status.model)"
    Start-Sleep -Seconds 30
}
```

---

## Troubleshooting

### Quick Diagnostics

```powershell
# Check processes
Get-Process | Where-Object {$_.ProcessName -match "node|llama"}

# Check ports
Get-NetTCPConnection -LocalPort 4080

# View latest log
Get-ChildItem logs\*-gw-*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content
```

### Common Issues

| Symptom | Fix |
|---------|-----|
| Port 4080 in use | `Get-NetTCPConnection -LocalPort 4080` then kill or change port |
| Cannot find llama-server.exe | Check `LLAMA_SERVER_PATH` or run `build\build-universal.ps1` |
| Model fails to load (OOM) | Reduce `X-Model-GpuLayers` or `X-Model-CtxSize` |
| "Missing X-Model-Path" | Gateway adapter not sending headers — check `localInference` config |
| Server stuck in "starting" | Check logs, verify model path exists |
| "Cannot find module nLogger" | `git submodule update --init --recursive` |

### Complete Reset

```powershell
Get-Process | Where-Object {$_.ProcessName -match "node|llama"} | Stop-Process -Force
Remove-Item logs\*.log
.\build\build-universal.ps1
node src/manager/server.js
```

---

## Model Tuner

`scripts/tune-model.js` — Interactive CLI to benchmark models and find optimal settings.

### Usage

```powershell
node scripts/tune-model.js
```

### What It Does

1. **Scans** `MODELS_DIR` for `.gguf` files, reads GGUF headers for metadata
2. **Lists** models with type badges: `[V]` vision, `[E]` embedding, max context, previous results
3. **Prompts** for context size and GPU layers
4. **Spawns** `llama-server` on port 4082 (no conflict with manager)
5. **Runs tests** based on model type:
   - **Completion**: 1000-token generation → tok/s, P50, P95, VRAM
   - **Embedding**: 100 iterations single-threaded + optional concurrency sweep (1-128) → req/s, dimensions
   - **Vision**: Text-only completion + vision pipeline (image encode + generation) → both tok/s, VRAM
6. **Saves** results to `scripts/tune-results.json` (overwrites previous per model)
7. **Outputs** a suggested `localInference` config block for the Gateway

### Vision Test Image

Place a test image at `scripts/test_image.jpg`. The vision test uses this image for all benchmarks.

### Results Storage

Results persist in `scripts/tune-results.json` keyed by model path. Previous results show in the model list for quick comparison.

---

## API Reference

### Manager Endpoints (Port 4080)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models` | Scan models dir, return GGUF metadata |
| GET | `/health` | Health check (delegates to llama-server) |
| GET | `/status` | Process state + loaded model info |
| POST | `/stop` | Kill the loaded model |
| Any | `/v1/*`, `/chat/*`, etc. | Inference — reads `X-Model-*` headers, auto-starts model, proxies body |

### GET /models

```json
{
  "data": [
    {
      "name": "Qwen3.5-35B-A3B-Uncensored-Q3_K_M.gguf",
      "path": "D:/models/Qwen3.5-35B-A3B-Uncensored-Q3_K_M.gguf",
      "type": "llm",
      "architecture": "qwen3",
      "parameter_count": 35000000000,
      "context_length": 131072,
      "vision": false
    }
  ]
}
```

### GET /status

```json
{
  "state": "running",
  "pid": 12345,
  "port": 4081,
  "model": "D:/models/Qwen-35B-Q3_K_M.gguf",
  "metrics": { "raw": "..." },
  "detached": false
}
```

States: `idle`, `starting`, `running`, `error`

### POST /stop

```bash
# Normal stop
curl -X POST http://127.0.0.1:4080/stop

# Force kill (ignores DETACH_ON_SHUTDOWN)
curl -X POST http://127.0.0.1:4080/stop `
  -H "Content-Type: application/json" `
  -d '{"force": true}'
```

### Streaming

All generation endpoints support SSE streaming via `"stream": true`:

```powershell
curl -X POST http://127.0.0.1:4080/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "X-Model-Path: D:/models/Qwen-35B-Q3_K_M.gguf" `
  -H "X-Model-CtxSize: 64000" `
  -H "X-Model-GpuLayers: 99" `
  -d '{
    "model": "qwen",
    "messages": [{"role": "user", "content": "Count to 5"}],
    "stream": true
  }'
```

Response (SSE format):
```
data: {"id":"...","choices":[{"delta":{"role":"assistant","content":"1"},"index":0}]}

data: {"id":"...","choices":[{"delta":{"role":"assistant","content":"2"},"index":0}]}

...

data: [DONE]
```

### Progress Updates

Add `"return_progress": true` to receive prompt processing progress during streaming:

```json
{
  "prompt": "Hello",
  "stream": true,
  "return_progress": true
}
```

Progress is included in each SSE event:
```json
{
  "content": "...",
  "prompt_progress": {
    "total": 100,
    "cache": 50,
    "processed": 75,
    "time_ms": 234
  }
}
```

### Error Format

```json
{ "error": "Message", "details": "Optional details" }
```

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Missing `X-Model-Path` header |
| 500 | llama-server failed to start |
| 504 | Model startup timeout (>120s) |
| 502 | llama-server crashed mid-request |

---

## Project Structure

```
llama-cpp-gateway/
├── src/manager/          # Node.js management layer
│   ├── server.js         # HTTP API, header-driven model resolution, proxy
│   ├── process.js        # Process supervisor, model lifecycle
│   ├── models.js         # Model discovery & GGUF parser
│   ├── config.js         # Global defaults (no model registry)
│   ├── modules/nLogger/  # Logging (git submodule)
│   └── test/             # Integration tests
├── build/                # Build scripts
├── scripts/              # CLI tools (tune-model.js)
├── dist/                 # Compiled binaries (gitignored)
├── llama.cpp/            # Upstream submodule
├── docs/                 # Documentation
├── _Archive/             # Obsolete files
└── logs/                 # Runtime logs (gitignored)
```

---

## Updating

### Update llama.cpp

```powershell
cd llama.cpp
git pull origin master
cd ..
git add llama.cpp
git commit -m "Update llama.cpp"

# Rebuild
.\build\build-universal.ps1
```

---

## Philosophy

**Deterministic Mind** principles:

- **Reliability > Performance > Everything else**
- **Fail Fast** — No defensive coding, clear errors
- **Zero Dependencies** — Build it ourselves
- **Block Until Truth** — State is authoritative
- **Guaranteed Disposal** — Every resource has cleanup

---

## License

- `llama.cpp/` — MIT License (ggml-org)
- `nLogger/` — MIT License
- Build scripts and manager — ISC License
