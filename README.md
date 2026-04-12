# LLaMA.cpp Gateway

Production-ready wrapper around llama.cpp: reproducible builds with CUDA/Vulkan/SYCL support, plus a zero-dependency Node.js management layer with transparent SSE streaming proxy for process control and inference.

---

## Quick Start

### Prerequisites

1. **NVIDIA CUDA Toolkit 12.2+** (or Vulkan SDK for Intel Arc/AMD)
2. **Visual Studio 2022** with C++ workload
3. **Node.js 18+**
4. **Git**

### Build

```powershell
# Universal build (CUDA + Vulkan)
.\build\build-universal.ps1

# Or CUDA-only / Vulkan-only
.\build\build-cuda.ps1
.\build\build-vulkan.ps1
```

### Start the Manager

```powershell
node src/manager/server.js
```

Output:
```
Llama Manager running at http://127.0.0.1:4080
Models dir: D:\# AI Stuff\LMStudio_Models
Server target: D:\DEV\llama-cpp-gateway\dist\universal\llama-server.exe
```

Press `Ctrl+C` to stop.

### Test

```powershell
# List models
curl http://127.0.0.1:4080/models

# Start a model
curl -X POST http://127.0.0.1:4080/start `
  -H "Content-Type: application/json" `
  -d '{"modelPath": "Publisher/Repo/model.gguf", "gpuLayers": 99}'

# Check status
curl http://127.0.0.1:4080/status

# Inference (through manager, SSE streaming supported)
curl -X POST http://127.0.0.1:4080/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{"model": "model.gguf", "messages": [{"role": "user", "content": "Hello!"}], "stream": true}'

# Stop
curl -X POST http://127.0.0.1:4080/stop
```

---

## Architecture

```
┌─────────────┐     HTTP      ┌──────────────┐     spawn     ┌─────────────┐
│   Client    │◄─────────────►│   Manager    │──────────────►│ llama-server│
│             │   All traffic │  (Port 4080) │               │  (Port 4081)│
└─────────────┘               └──────────────┘               └────────────┘
                                    │                               ▲
                                    │  Proxy (zero transformation)  │
                                    └───────────────────────────────┘
```

### Components

| Component | Responsibility |
|-----------|---------------|
| **server.js** | HTTP API, request routing, SSE proxy |
| **process.js** | Child process supervisor, health polling, state machine |
| **models.js** | Model discovery, GGUF header metadata extraction |
| **nLogger** | Structured logging (git submodule) |

### Request Routing

The manager handles four endpoints directly and proxies everything else:

| Route | Handler | Description |
|-------|---------|-------------|
| `GET /models` | Manager | List available GGUF models |
| `POST /start` | Manager | Spawn llama-server |
| `POST /stop` | Manager | Kill llama-server |
| `GET /status` | Manager | Process state |
| **Everything else** | **Proxy** | Forwarded to llama-server unchanged |

### SSE Streaming Proxy

All inference requests flow through the manager with **zero transformation latency**. SSE streams (`text/event-stream`) are piped directly from llama-server to the client — no parsing, no serialization, no buffering.

```
Client ──POST /v1/chat/completions (stream: true)──► Manager ──► llama-server
Client ◄──────────── SSE token stream ◄───────────── Manager ◄── llama-server
```

Supported through proxy:
- `POST /completions`, `/v1/completions` — with SSE streaming
- `POST /chat/completions`, `/v1/chat/completions` — OpenAI-compatible
- `POST /api/chat` — Ollama-compatible
- `POST /v1/messages` — Anthropic-compatible
- `POST /embeddings`, `/v1/embeddings`
- `POST /rerank`, `/v1/rerank`
- `GET /health`, `/metrics`, `/slots`, `/props`
- All other llama-server endpoints

Progress updates (`return_progress: true`) pass through unchanged.

### State Machine

```
idle ──(POST /start)──► starting ──(health OK)──► running
  ▲                                              │
  └──────────────(POST /stop or crash)───────────┘
```

### Design Principles

- **Singleton**: Only one `llama-server.exe` at a time
- **Zero dependencies**: Node.js stdlib only (except nLogger)
- **Fail-fast**: Invalid config = crash, missing model = 400
- **Transparent proxy**: Inference traffic flows through manager with zero transformation

---

## Configuration

All settings via environment variables or `src/manager/config.js`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_PORT` | `4080` | Manager API port |
| `LLAMA_SERVER_PORT` | `4081` | llama-server port |
| `LLAMA_SERVER_PATH` | `../../dist/universal/llama-server.exe` | Binary path (relative to `src/manager/`) |
| `MODELS_DIR` | `D:\# AI Stuff\LMStudio_Models` | GGUF models directory |
| `DEFAULT_CTX_SIZE` | `8192` | Default context window |
| `DEFAULT_GPU_LAYERS` | `99` | Default GPU offload layers |
| `FLASH_ATTENTION` | `true` | Enable Flash Attention |
| `DETACH_ON_SHUTDOWN` | `false` | Keep model in VRAM on restart |
| `LOG_RETENTION_DAYS` | `1` | Session log retention |

### Common Scenarios

```powershell
# Custom model directory
$env:MODELS_DIR = "E:\AI\Models"

# Port conflicts
$env:MANAGER_PORT = 8180
$env:LLAMA_SERVER_PORT = 8181

# Keep model loaded (fast restarts)
$env:DETACH_ON_SHUTDOWN = "true"

# Debug logging
$env:NODE_ENV = "development"
$env:DEBUG = "true"
```

### Flash Attention

Reduces KV cache VRAM by ~50%. Enabled by default. Disable per-request:

```json
POST /start
{ "modelPath": "model.gguf", "flashAttention": false }
```

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

**Local Process Manager:**
```json
{
    "llama-manager": {
        "description": "LLaMA Manager",
        "path": "C:\\Services\\llama-manager",
        "exec": "node server.js",
        "detachOnQuit": false
    }
}
```

**PM2:**
```powershell
pm2 start src/manager/server.js --name llama-manager
pm2 save
pm2 startup
```

**Windows Task Scheduler (auto-start on login):**
```powershell
$action = New-ScheduledTaskAction -Execute "node" `
    -Argument "D:\DEV\llama-cpp-gateway\src\manager\server.js" `
    -WorkingDirectory "D:\DEV\llama-cpp-gateway"
$trigger = New-ScheduledTaskTrigger -AtLogon
Register-ScheduledTask -TaskName "LlamaManager" -Action $action -Trigger $trigger -RunLevel Highest
```

### Monitoring

```powershell
# Check status
curl http://127.0.0.1:4080/status

# Health check (through manager proxy)
curl http://127.0.0.1:4080/health

# Metrics (Prometheus format, through proxy)
curl http://127.0.0.1:4080/metrics

# Simple monitor loop
while ($true) {
    $status = Invoke-RestMethod http://127.0.0.1:4080/status
    Write-Host "$(Get-Date) - State: $($status.state)"
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
Get-NetTCPConnection -LocalPort 4080, 4081

# View latest log
Get-ChildItem logs\*-gw-*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content
```

### Common Issues

| Symptom | Fix |
|---------|-----|
| Port 4080 in use | `Get-NetTCPConnection -LocalPort 4080` then kill or change port |
| Cannot find llama-server.exe | Check `LLAMA_SERVER_PATH` or run `build\build-universal.ps1` |
| Model fails to load (OOM) | Reduce `gpuLayers` or `ctxSize` |
| Server stuck in "starting" | Check logs, verify model path, check port 4081 not in use |
| "Cannot find module nLogger" | `git submodule update --init --recursive` |
| Empty log files | Previous crash before logger wrote anything, safe to delete |

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
7. **Outputs** a suggested `localInference` config block for llm_gateway

### Vision Test Image

Place a test image at `scripts/test_image.jpg`. The vision test uses this image for all benchmarks.

### Results Storage

Results persist in `scripts/tune-results.json` keyed by model path. Previous results show in the model list for quick comparison.

---

## API Reference

### Manager Endpoints (Port 4080)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models` | List available GGUF models |
| POST | `/start` | Start llama-server with a model |
| POST | `/stop` | Stop running llama-server |
| GET | `/status` | Get current state |

### GET /models

```json
{
  "data": [
    {
      "name": "model-Q4_K_M.gguf",
      "path": "Publisher/Repo/model-Q4_K_M.gguf",
      "fullPath": "D:\\Models\\Publisher\\Repo\\model-Q4_K_M.gguf",
      "type": "llm",
      "architecture": "llama",
      "parameter_count": 8000000000,
      "context_length": 8192
    }
  ]
}
```

### POST /start

```bash
curl -X POST http://127.0.0.1:4080/start \
  -H "Content-Type: application/json" \
  -d '{"modelPath": "Publisher/Repo/model.gguf", "gpuLayers": 99, "ctxSize": 8192}'
```

**Parameters:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `modelPath` | string | Yes | — | Relative path from `modelsDir` |
| `gpuLayers` | number | No | 99 | GPU offload layers (0-99) |
| `ctxSize` | number | No | 8192 | Context window in tokens |
| `flashAttention` | boolean | No | true | Enable Flash Attention |
| `port` | number | No | 4081 | Port for llama-server |
| `mmprojPath` | string | No | — | Vision projector path |

**Response (200):**
```json
{
  "message": "Server started",
  "pid": 12345,
  "args": ["-m", "...", "--port", "4081", "-c", "8192", "-ngl", "99"],
  "settings": { "ctxSize": 8192, "gpuLayers": 99, "flashAttention": true }
}
```

**Response (409):** `{ "error": "Conflict: Server already running" }`

### POST /stop

```bash
# Normal stop
curl -X POST http://127.0.0.1:4080/stop

# Force kill (ignores DETACH_ON_SHUTDOWN)
curl -X POST http://127.0.0.1:4080/stop \
  -H "Content-Type: application/json" \
  -d '{"force": true}'
```

### GET /status

```json
{ "state": "running", "pid": 12345, "metrics": { "raw": "..." }, "detached": false }
```

States: `idle`, `starting`, `running`, `error`

### llama-server Direct API (Port 4081)

All llama-server endpoints are accessible through the manager proxy on port 4080. You can use either:

```powershell
# Through manager proxy (recommended - single endpoint)
curl http://127.0.0.1:4080/v1/chat/completions

# Direct to llama-server (bypasses manager)
curl http://127.0.0.1:4081/v1/chat/completions
```

**Key endpoints available through proxy:**

| Endpoint | Description |
|----------|-------------|
| `POST /completion` | Legacy text generation |
| `POST /completions` | Text generation |
| `POST /v1/completions` | OpenAI-compatible completions |
| `POST /chat/completions` | Chat generation |
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `POST /api/chat` | Ollama-compatible chat |
| `POST /v1/messages` | Anthropic-compatible chat |
| `POST /embeddings` | Embedding generation |
| `POST /v1/embeddings` | OpenAI-compatible embeddings |
| `POST /rerank` | Reranking |
| `POST /v1/rerank` | OpenAI-compatible reranking |
| `POST /tokenize` | Tokenize text |
| `POST /detokenize` | Detokenize IDs |
| `GET /health` | Health status |
| `GET /metrics` | Prometheus metrics |
| `GET /slots` | Slot status |
| `GET /props` | Server properties |

### Streaming

All generation endpoints support SSE streaming via `"stream": true`:

```powershell
curl -X POST http://127.0.0.1:4080/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{
    "model": "model.gguf",
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
| 400 | Bad Request |
| 404 | Endpoint not found |
| 409 | Conflict |

---

## Project Structure

```
llama-cpp-gateway/
├── src/manager/          # Node.js management layer
│   ├── server.js         # HTTP API
│   ├── process.js        # Process supervisor
│   ├── models.js         # Model discovery & GGUF parser
│   ├── config.js         # Configuration
│   ├── modules/nLogger/  # Logging (git submodule)
│   └── test/             # Integration tests
├── build/                # Build scripts
├── scripts/              # CLI tools
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
