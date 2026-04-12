# API Reference

Complete reference for the llama-manager HTTP API.

**Base URL:** `http://127.0.0.1:4080` (configurable via `MANAGER_PORT`)

**Content-Type:** `application/json` for all request/response bodies

---

## Endpoints Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models` | List available GGUF models |
| POST | `/start` | Start llama-server with a model |
| POST | `/stop` | Stop running llama-server |
| GET | `/status` | Get current state and metrics |

---

## GET /models

List all available models in the configured `modelsDir`.

### Request

```bash
curl http://127.0.0.1:4080/models
```

### Response

```json
{
  "data": [
    {
      "name": "llama-2-7b.Q4_K_M.gguf",
      "path": "TheBloke/Llama-2-7B-GGUF/llama-2-7b.Q4_K_M.gguf",
      "fullPath": "D:\\# AI Stuff\\LMStudio_Models\\TheBloke\\Llama-2-7B-GGUF\\llama-2-7b.Q4_K_M.gguf",
      "type": "llm",
      "architecture": "llama",
      "model_name": "LLaMA v2",
      "parameter_count": 7000000000,
      "file_type": 15,
      "context_length": 4096,
      "block_count": 32
    },
    {
      "name": "mmproj-llava-v1.5-7b.gguf",
      "path": "vision/mmproj-llava-v1.5-7b.gguf",
      "fullPath": "D:\\# AI Stuff\\LMStudio_Models\\vision\\mmproj-llava-v1.5-7b.gguf",
      "type": "vision-projector"
    }
  ]
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Filename |
| `path` | string | Relative path from modelsDir |
| `fullPath` | string | Absolute filesystem path |
| `type` | string | `"llm"` or `"vision-projector"` |
| `architecture` | string | Model architecture (LLM only) |
| `model_name` | string | Human-readable name (LLM only) |
| `parameter_count` | number | Total parameters (LLM only) |
| `file_type` | number | Quantization type code (LLM only) |
| `context_length` | number | Max context in tokens (LLM only) |
| `block_count` | number | Number of layers (LLM only) |

### Errors

| Status | Description |
|--------|-------------|
| 200 | Success (may return empty array if no models found) |

---

## POST /start

Start the llama-server with a specified model.

**Important:** Only one server can run at a time. Returns 409 if already running.

### Request

```bash
curl -X POST http://127.0.0.1:4080/start \
  -H "Content-Type: application/json" \
  -d '{
    "modelPath": "TheBloke/Llama-2-7B-GGUF/llama-2-7b.Q4_K_M.gguf",
    "gpuLayers": 99,
    "ctxSize": 4096
  }'
```

### Request Body

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `modelPath` | string | Yes | - | Relative path to .gguf file |
| `gpuLayers` | number | No | Model default | GPU offload layers (0-99) |
| `ctxSize` | number | No | Model default | Context window in tokens |
| `flashAttention` | boolean | No | Model default | Enable Flash Attention (reduces VRAM usage by ~50%) |
| `port` | number | No | 4081 | Port for llama-server |
| `mmprojPath` | string | No | - | Path to vision projector |

### Response (Success)

```json
{
  "message": "Server started",
  "pid": 12345,
  "args": [
    "-m", "D:\\# AI Stuff\\LMStudio_Models\\TheBloke\\Llama-2-7B-GGUF\\llama-2-7b.Q4_K_M.gguf",
    "--port", "4081",
    "-c", "4096",
    "-ngl", "99"
  ]
}
```

### Response (Already Running)

```json
{
  "error": "Conflict: Server already running"
}
```
Status: **409 Conflict**

### Response (Missing Model)

```json
{
  "error": "Bad Request: modelPath is required"
}
```
Status: **400 Bad Request**

### Response (Spawn Failed)

```json
{
  "error": "Failed to start server",
  "message": "ENOENT: llama-server.exe not found"
}
```
Status: **400 Bad Request**

### Examples

#### Basic Start

```bash
curl -X POST http://127.0.0.1:4080/start \
  -H "Content-Type: application/json" \
  -d '{"modelPath": "model.gguf"}'
```

#### Full GPU Offload

```bash
curl -X POST http://127.0.0.1:4080/start \
  -H "Content-Type: application/json" \
  -d '{
    "modelPath": "TheBloke/Mixtral-8x7B/mixtral.Q4_K_M.gguf",
    "gpuLayers": 99,
    "ctxSize": 32768
  }'
```

#### Vision Model

```bash
curl -X POST http://127.0.0.1:4080/start \
  -H "Content-Type: application/json" \
  -d '{
    "modelPath": "llava/llava-v1.5-7b.gguf",
    "mmprojPath": "llava/mmproj-llava-v1.5-7b.gguf",
    "gpuLayers": 99
  }'
```

#### CPU Only

```bash
curl -X POST http://127.0.0.1:4080/start \
  -H "Content-Type: application/json" \
  -d '{
    "modelPath": "small-model.gguf",
    "gpuLayers": 0
  }'
```

#### Large Context with Flash Attention

```bash
# 64k context with Flash Attention enabled (requires ~50% less VRAM)
curl -X POST http://127.0.0.1:4080/start \
  -H "Content-Type: application/json" \
  -d '{
    "modelPath": "Qwen/Qwen3.5-35B/model.gguf",
    "ctxSize": 65536,
    "flashAttention": true
  }'
```

---

## GET /profiles

List all available model profiles with optimized defaults.

### Request

```bash
curl http://127.0.0.1:4080/profiles
```

### Response

```json
{
  "data": [
    {
      "key": "qwen3.5-35b-a3b",
      "name": "Qwen 3.5 35B A3B (MoE)",
      "description": "35B MoE model optimized for 24GB VRAM",
      "defaults": {
        "ctxSize": 65536,
        "gpuLayers": 99,
        "flashAttention": true
      },
      "vramEstimateGB": 17,
      "tags": ["moe", "uncensored", "large-context"]
    }
  ]
}
```

### Model Profiles

The llama-manager includes pre-configured profiles for popular models. When you start a model without specifying parameters, the manager automatically applies optimized defaults based on the model filename.

**Profile matching** is done by substring (case-insensitive). For example, a model path containing `qwen3.5-35b-a3b` will match the Qwen 3.5 profile.

**Override behavior:** Any parameters you provide in the request override the profile defaults.

---

## POST /stop

Stop the running llama-server.

### Request

```bash
# Normal stop (respects DETACH_ON_SHUTDOWN setting)
curl -X POST http://127.0.0.1:4080/stop

# Force kill (always stops server, frees VRAM)
curl -X POST http://127.0.0.1:4080/stop \
  -H "Content-Type: application/json" \
  -d '{"force": true}'
```

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `force` | boolean | No | If `true`, always kill server even if DETACH_ON_SHUTDOWN is enabled |

### Response (Success)

```json
{
  "message": "Server stopped",
  "previousPid": 12345,
  "detached": false
}
```

### Response (Nothing Running)

```json
{
  "message": "Server stopped",
  "previousPid": null,
  "detached": false
}
```

### Response (Force Kill)

```json
{
  "message": "Server force-killed",
  "previousPid": 12345,
  "detached": false
}
```

### Behavior

| Mode | DETACH_ON_SHUTDOWN | Result |
|------|-------------------|--------|
| Normal stop | `false` (default) | Kills server, frees VRAM |
| Normal stop | `true` | Detaches, keeps model loaded |
| Force stop | any | Always kills server, frees VRAM |

1. Sends SIGINT to llama-server process (or detaches if configured)
2. Sets state to `idle`
3. Stops health/metrics polling
4. Returns immediately (does not wait for process exit)

---

## GET /status

Get the current state of the llama-manager and running server.

### Request

```bash
curl http://127.0.0.1:4080/status
```

### Response (Idle)

```json
{
  "state": "idle",
  "pid": null,
  "metrics": {}
}
```

### Response (Starting)

```json
{
  "state": "starting",
  "pid": 12345,
  "metrics": {}
}
```

### Response (Running with Metrics)

```json
{
  "state": "running",
  "pid": 12345,
  "metrics": {
    "raw": "# HELP llama_tokens_predicted_total\n# TYPE llama_tokens_predicted_total counter\nllama_tokens_predicted_total 1234\n..."
  }
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `state` | string | `"idle"`, `"starting"`, `"running"`, or `"error"` |
| `pid` | number\|null | Process ID of llama-server (null if idle) |
| `metrics` | object | Forwarded Prometheus metrics from llama-server |

### State Transitions

```
POST /start ───► starting ───► /health OK ───► running
                    │                            │
                    │ spawn fails                │
                    ▼                            │
                 error ◄─────────────────────────┘
                    │         crash
                    │
POST /stop ────────┴────────────────────────────► idle
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error Type",
  "details": "Additional information"
}
```

### Common HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Bad Request (invalid JSON, missing field, spawn failed) |
| 404 | Endpoint not found |
| 409 | Conflict (server already running) |

---

## Direct llama-server API

Once running, send inference requests directly to llama-server (bypasses manager):

**Base URL:** `http://127.0.0.1:4081` (configurable via `LLAMA_SERVER_PORT`)

### POST /completion

Generate text completion.

```bash
curl -X POST http://127.0.0.1:4081/completion \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Once upon a time",
    "n_predict": 100,
    "temperature": 0.7,
    "stop": ["\n", "User:"]
  }'
```

Response:
```json
{
  "content": " there was a brave knight who...",
  "generation_settings": { ... },
  "tokens_cached": 4,
  "tokens_predicted": 100,
  "timings": {
    "predicted_per_token_ms": 8.5,
    "predicted_per_second": 117.6
  }
}
```

### POST /chat/completions (OpenAI-compatible)

```bash
curl -X POST http://127.0.0.1:4081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "temperature": 0.7
  }'
```

### GET /health

```bash
curl http://127.0.0.1:4081/health
```

Response:
```json
{"status": "ok"}
```

### GET /metrics

```bash
curl http://127.0.0.1:4081/metrics
```

Returns Prometheus-format metrics including:
- `llama_tokens_predicted_total` — Total tokens generated
- `llama_tokens_drafted_total` — Total draft tokens
- `llama_load_time_ms` — Model load time

---

## Complete Workflow Example

```bash
#!/bin/bash

MANAGER_URL="http://127.0.0.1:4080"
SERVER_URL="http://127.0.0.1:4081"
MODEL="TheBloke/Llama-2-7B-GGUF/llama-2-7b.Q4_K_M.gguf"

echo "1. Checking available models..."
curl -s "$MANAGER_URL/models" | jq '.data[0]'

echo -e "\n2. Starting server with model..."
curl -s -X POST "$MANAGER_URL/start" \
  -H "Content-Type: application/json" \
  -d "{\"modelPath\": \"$MODEL\", \"gpuLayers\": 99}"

echo -e "\n\n3. Waiting for server to be ready..."
while true; do
  STATUS=$(curl -s "$MANAGER_URL/status" | jq -r '.state')
  echo "  Status: $STATUS"
  if [ "$STATUS" = "running" ]; then
    break
  fi
  sleep 2
done

echo -e "\n4. Generating completion..."
curl -s -X POST "$SERVER_URL/completion" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "The capital of France is", "n_predict": 10}' \
  | jq '.content'

echo -e "\n5. Stopping server..."
curl -s -X POST "$MANAGER_URL/stop"

echo -e "\nDone!"
```

---

## Client Libraries

### Python

```python
import requests

MANAGER_URL = "http://127.0.0.1:4080"
SERVER_URL = "http://127.0.0.1:4081"

class LlamaManager:
    def __init__(self, manager_url=MANAGER_URL):
        self.manager_url = manager_url
        
    def list_models(self):
        return requests.get(f"{self.manager_url}/models").json()
    
    def start(self, model_path, gpu_layers=99, ctx_size=None):
        payload = {"modelPath": model_path, "gpuLayers": gpu_layers}
        if ctx_size:
            payload["ctxSize"] = ctx_size
        return requests.post(f"{self.manager_url}/start", json=payload).json()
    
    def stop(self):
        return requests.post(f"{self.manager_url}/stop").json()
    
    def status(self):
        return requests.get(f"{self.manager_url}/status").json()

# Usage
manager = LlamaManager()
manager.start("model.gguf", gpu_layers=99)
```

### JavaScript/TypeScript

```typescript
class LlamaManager {
  constructor(private baseUrl = 'http://127.0.0.1:4080') {}
  
  async listModels() {
    const res = await fetch(`${this.baseUrl}/models`);
    return res.json();
  }
  
  async start(modelPath: string, options?: { gpuLayers?: number; ctxSize?: number }) {
    const res = await fetch(`${this.baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath, ...options })
    });
    return res.json();
  }
  
  async stop() {
    const res = await fetch(`${this.baseUrl}/stop`, { method: 'POST' });
    return res.json();
  }
  
  async status() {
    const res = await fetch(`${this.baseUrl}/status`);
    return res.json();
  }
}
```
