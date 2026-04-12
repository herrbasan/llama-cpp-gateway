# Architecture Overview

How the LLaMA.cpp Gateway is structured and how data flows through the system.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT APPLICATION                              │
│                   (Your LLM Gateway, CLI tool, Chat UI)                      │
└────────────────────┬────────────────────────────────────────────────────────┘
                     │
                     │ HTTP Requests
                     │ (Control Plane)
                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         LLAMA-MANAGER (Port 4080)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  HTTP Server │  │   Process    │  │    Models    │  │   nLogger        │ │
│  │   (API)      │──│  Supervisor  │──│   Scanner    │──│  (Logging)       │ │
│  └──────────────┘  └──────┬───────┘  └──────────────┘  └──────────────────┘ │
│                           │                                                  │
│                           │ spawn / kill / monitor                           │
│                           │                                                  │
└───────────────────────────┼──────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      LLAMA-SERVER.EXE (Port 4081)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │   GGML       │  │   Vulkan     │  │    CUDA      │  │    CPU Backend   │ │
│  │   Backend    │  │   Backend    │  │   Backend    │  │    (Fallback)    │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                       │
│  │   /health    │  │   /metrics   │  │  /completion │                       │
│  │   Endpoint   │  │   Endpoint   │  │   Endpoint   │                       │
│  └──────────────┘  └──────────────┘  └──────────────┘                       │
└─────────────────────────────────────────────────────────────────────────────┘
                            │
                            │ Direct Inference Traffic
                            │ (Bypasses Manager)
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GGUF MODEL FILES                                   │
│    (LM Studio Structure: Publisher/Repository/model-Q4_K_M.gguf)             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Design Principles

### Separation of Concerns

| Component | Responsibility | What It Does NOT Do |
|-----------|---------------|---------------------|
| **llama-manager** | Process lifecycle, model discovery, telemetry | Proxy inference tokens |
| **llama-server** | Model loading, token generation, context management | Process management |
| **Client** | Send inference requests, handle responses | Spawn/kill server processes |

### Zero-Dependency Philosophy

- **llama-manager**: Only uses Node.js standard library (`node:http`, `node:child_process`, `node:fs`)
- **nLogger**: Custom logging (git submodule), no npm dependencies
- **llama-server**: Single executable with bundled backends

### Fail-Fast Design

- No defensive coding with fallbacks
- Invalid config = immediate crash with clear error
- Missing model file = 400 error, not silent fallback
- Port conflict = immediate exit

## Component Deep Dive

### 1. llama-manager/server.js

**Purpose:** HTTP API frontend

**Key Functions:**
- Parses JSON request bodies
- Routes to appropriate handlers
- Validates inputs
- Returns JSON responses

**Lifecycle Hooks:**
```javascript
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('exit', killLlamaServer);
process.on('uncaughtException', gracefulShutdown);
```

### 2. llama-manager/process.js

**Purpose:** Child process supervisor

**State Machine:**
```
┌──────┐  spawn()   ┌──────────┐  /health OK  ┌─────────┐
│ idle │ ─────────► │ starting │ ───────────► │ running │
└──────┘            └──────────┘              └────┬────┘
   ▲                                               │
   └───────────────────────────────────────────────┘
            kill() or process exit
```

**Polling Logic:**
- Every 2 seconds while `activeProcess` exists
- In `starting`: Polls `http://127.0.0.1:4081/health`
- In `running`: Polls `http://127.0.0.1:4081/metrics`

### 3. llama-manager/models.js

**Purpose:** Model discovery and metadata extraction

**Directory Traversal:**
```
modelsDir/
├── PublisherA/
│   └── ModelRepo/
│       └── model.gguf      →  PublisherA/ModelRepo/model.gguf
├── standalone.gguf         →  standalone.gguf
└── vision/
    └── projector.mmproj    →  vision/projector.mmproj (type: vision-projector)
```

**GGUF Header Parser:**
Reads first 2MB of file to extract:
- `general.architecture` (e.g., "llama", "qwen2")
- `general.name` (model name)
- `general.parameter_count` (parameter count)
- `general.file_type` (quantization level)
- `*.context_length` (max context)
- `*.block_count` (layer count)

### 4. llama-manager/nLogger

**Purpose:** Structured logging

**Output:**
- Session logs (human-readable, per-run)
- Main log (JSON Lines, rolling)

**Log Levels:** DEBUG, INFO, WARN, ERROR

### 5. llama-server.exe

**Purpose:** llama.cpp inference engine

**Backends (Universal Build):**
| Backend | Hardware | Priority |
|---------|----------|----------|
| CUDA | NVIDIA GPUs | Highest |
| Vulkan | Intel Arc, AMD GPUs | High |
| CPU | Any | Fallback |

**Endpoints:**
- `GET /health` → `{"status": "ok"}`
- `GET /metrics` → Prometheus format
- `POST /completion` → Text generation
- `POST /infill` → Code completion
- `POST /embedding` → Vector embeddings

## Data Flow Examples

### Starting a Model

```
1. Client          POST /start {modelPath: "model.gguf"}
                        │
2. server.js  ◄─────────┘
     │
3. Validates request
     │
4. Calls spawnLlamaServer()
     │
5. process.js  ◄────────┘
     │
6. spawn("llama-server.exe", ["-m", "model.gguf", "--port", "4081"])
     │
7. llama-server.exe ────► loads model into VRAM
     │
8. Poll /health (every 2s)
     │
9. Health OK
     │
10. state = "running"
     │
11. Returns 200 {pid: 12345}
```

### Inference Request (Bypasses Manager)

```
1. Client          POST http://127.0.0.1:4081/completion
                        │
2. llama-server.exe ◄───┘ (direct connection)
     │
3. Generates tokens
     │
4. Returns JSON response
     │
5. Client ◄─────────────┘
```

### Status Check

```
1. Client          GET /status
                        │
2. server.js  ◄─────────┘
     │
3. Calls getStatus()
     │
4. process.js  ◄────────┘
     │
5. Returns {state, pid, metrics}
     │
6. JSON response ◄──────┘
```

### Shutdown

```
1. SIGINT received
     │
2. gracefulShutdown()
     │
3. killLlamaServer()
     │
4. process.kill('SIGINT')
     │
5. llama-server.exe ────► exits, frees VRAM
     │
6. server.close()
     │
7. process.exit(0)
```

## Singleton Enforcement

**The Rule:** Only one `llama-server.exe` instance can run at a time.

**Enforcement Points:**
1. `spawnLlamaServer()` checks `activeProcess` — throws if already running
2. `POST /start` returns 409 Conflict if `getStatus().pid` exists

**Why:**
- VRAM exhaustion prevention
- Port binding conflicts (4081)
- Predictable resource usage

## Port Allocation

| Port | Service | Configurable |
|------|---------|--------------|
| 4080 | llama-manager API | `MANAGER_PORT` env |
| 4081 | llama-server API | `LLAMA_SERVER_PORT` env |

**Binding:** Both bind to `127.0.0.1` (localhost only) for security.

## Security Model

### Trust Boundaries

```
[Untrusted Internet] ──X──► [llama-manager:4080] ◄─── [Trusted LAN/Localhost]
                                      │
                                      └── Only accepts from localhost
```

### Why No Authentication?

The manager is designed to run alongside a trusted gateway on the same machine. Authentication should be handled by:
- Your main LLM Gateway
- Reverse proxy (nginx, etc.)
- Network isolation (bind to localhost only)

## Error Handling Strategy

### Manager Errors

| Error | Response | Action |
|-------|----------|--------|
| Model not found | 400 Bad Request | Client fixes path |
| Server already running | 409 Conflict | Client calls /stop first |
| Spawn fails | 400 Bad Request | Check binary path, permissions |
| Invalid JSON | 400 Bad Request | Client fixes payload |

### Server Errors

| Error | Manager Response | Action |
|-------|------------------|--------|
| Model load OOM | process exits, state → error | Use smaller model, reduce ctxSize |
| Port in use | spawn fails | Check for zombie process |
| CUDA OOM | process exits | Reduce gpuLayers |

## Build Architecture

### CMake Configuration

```cmake
# Universal Build Flags
-GGML_CUDA=ON      # NVIDIA GPU support
-GGML_VULKAN=ON    # Intel Arc/AMD GPU support
-DCMAKE_BUILD_TYPE=Release
```

### Output Binaries

```
dist/universal/
├── llama-server.exe    # HTTP API server (use this)
├── llama-cli.exe       # Command-line tool
├── llama-bench.exe     # Benchmarking tool
├── llama.dll           # Core library
├── ggml.dll            # Tensor operations
├── ggml-cuda.dll       # CUDA backend
├── ggml-vulkan.dll     # Vulkan backend
├── ggml-cpu.dll        # CPU fallback
└── mtmd.dll            # Multi-modal support
```

## Performance Considerations

### Startup Time

| Phase | Typical Duration |
|-------|-----------------|
| Process spawn | < 100ms |
| Model load to RAM | 1-5s (depends on model size) |
| GPU offload | 2-10s (depends on gpuLayers) |
| **Total to ready** | **5-20s** |

### Memory Model

```
System RAM:
├── llama-manager (Node.js)     ~50MB
└── llama-server.exe
    ├── Model weights (if CPU)  Model size (e.g., 4GB for Q4 7B)
    └── KV cache                ctxSize × layers × bytes

GPU VRAM:
├── Model weights (if GPU)      Model size
└── KV cache (if GPU)           ctxSize × layers × bytes
```

### Throughput

Inference speed depends on:
- Model quantization (Q4_K_M faster than F16)
- GPU layers (more = faster)
- Context size (larger = slower)
- Batch size (concurrent requests)

Example (RTX 4090, Llama-3-8B-Q4_K_M):
- Full GPU offload: ~120 tokens/sec
- CPU only: ~15 tokens/sec
