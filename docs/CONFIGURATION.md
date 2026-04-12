# Configuration Reference

All configuration options for the LLaMA.cpp Gateway.

## Configuration Sources

Configuration is loaded in this priority (later overrides earlier):

1. **Default values** (hardcoded in `config.js`)
2. **Environment variables** (override defaults)
3. **Modified config.js** (direct file edit)

## Environment Variables

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_PORT` | `4080` | Port for llama-manager HTTP API |
| `LLAMA_SERVER_PORT` | `4081` | Port for llama-server inference API |
| `LLAMA_SERVER_PATH` | `../dist/universal/llama-server.exe` | Path to llama-server binary |
| `MODELS_DIR` | `D:\# AI Stuff\LMStudio_Models` | Directory containing GGUF models |
| `DETACH_ON_SHUTDOWN` | `false` | Keep model loaded in VRAM when manager restarts |
| `DEFAULT_CTX_SIZE` | `8192` | Default context size for models |
| `DEFAULT_GPU_LAYERS` | `99` | Default GPU layers to offload (0-99) |
| `FLASH_ATTENTION` | `true` | Enable Flash Attention by default |

### Logging Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_RETENTION_DAYS` | `1` | Days to keep session logs before auto-delete |
| `DEBUG` | `false` | Enable debug-level logging |
| `NODE_ENV` | - | Set to `development` to enable debug logging |

## Setting Environment Variables

### Windows PowerShell (Current Session)

```powershell
$env:MANAGER_PORT = 8090
$env:MODELS_DIR = "C:\Models"
$env:LOG_RETENTION_DAYS = 7
node server.js
```

### Windows PowerShell (Persistent - User)

```powershell
[Environment]::SetEnvironmentVariable("MANAGER_PORT", "8090", "User")
[Environment]::SetEnvironmentVariable("MODELS_DIR", "C:\Models", "User")
[Environment]::SetEnvironmentVariable("LOG_RETENTION_DAYS", "7", "User")
# Restart PowerShell to apply
```

### Windows Command Prompt

```cmd
set MANAGER_PORT=8090
set MODELS_DIR=C:\Models
node server.js
```

### System Environment Variables (GUI)

```powershell
# Open System Properties → Environment Variables
rundll32 sysdm.cpl,EditEnvironmentVariables
```

## Config File Reference

Location: `llama-manager/config.js`

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  // Port the manager listens on
  port: parseInt(process.env.MANAGER_PORT || '4080', 10),
  
  // Port the underlying llama-server listens on
  serverPort: parseInt(process.env.LLAMA_SERVER_PORT || '4081', 10),
  
  // Path to llama-server executable
  llamaServerPath: process.env.LLAMA_SERVER_PATH || 
    path.resolve(__dirname, '../dist/universal/llama-server.exe'),
  
  // Models directory (supports LM Studio structure)
  modelsDir: process.env.MODELS_DIR || 'D:\\# AI Stuff\\LMStudio_Models'
};
```

## Deployment Configuration (config.json)

When using `bundle-deployment.ps1`, a `config.json` file is created for easy configuration:

```json
{
  "port": 4080,
  "serverPort": 4081,
  "modelsDir": "D:\\# AI Stuff\\LMStudio_Models",
  "detachOnShutdown": false,
  "llamaServerPath": ".\\bin\\llama-server.exe"
}
```

Simply edit this file — no environment variables needed. The bundled `start.bat` reads this file automatically.

## Common Configuration Scenarios

### Scenario 1: Custom Model Directory

**Using config.json (bundled deployment):**
```json
{
  "modelsDir": "E:\\AI\\Models"
}
```

**Using environment variables:**
```powershell
$env:MODELS_DIR = "E:\AI\Models"
node server.js
```

### Scenario 2: Port Conflicts (Something on 4080)

```powershell
# Shift both ports up by 100
$env:MANAGER_PORT = 8180
$env:LLAMA_SERVER_PORT = 8181
node server.js
```

### Scenario 3: Different Binary Location

```powershell
# Using CUDA-only build instead of universal
$env:LLAMA_SERVER_PATH = "D:\llama-cpp-gateway\dist\cuda\llama-server.exe"
node server.js
```

### Scenario 4: Keep Model Loaded (Fast Restarts)

```powershell
# Prevent unloading model when manager restarts
# Server will re-attach on startup if still running
$env:DETACH_ON_SHUTDOWN = "true"
node server.js

# To actually stop the server and free VRAM:
curl -X POST http://127.0.0.1:4080/stop -H "Content-Type: application/json" -d '{"force": true}'
```

**Use case:** You're restarting the manager frequently for development or config changes, but don't want to wait for the model to reload into VRAM each time.

**Behavior:**
- Manager shutdown: Detaches from server, keeps model loaded
- Manager startup: Re-attaches to existing server if healthy
- Force stop: Use `{"force": true}` in `/stop` request to actually kill server

### Scenario 5: Development with Debug Logging

```powershell
$env:NODE_ENV = "development"
$env:DEBUG = "true"
$env:LOG_RETENTION_DAYS = 7
node server.js
```

### Scenario 5: Production Deployment

Create `start-production.ps1`:

```powershell
$env:NODE_ENV = "production"
$env:MANAGER_PORT = 4080
$env:LLAMA_SERVER_PORT = 4081
$env:MODELS_DIR = "D:\Models"
$env:LOG_RETENTION_DAYS = 30
$env:LLAMA_SERVER_PATH = "D:\llama-cpp-gateway\dist\universal\llama-server.exe"

node server.js
```

## API Request Parameters

When calling `POST /start`, these parameters control the llama-server:

### Required Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `modelPath` | string | Relative path from `modelsDir` to the GGUF file |

### Optional Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `port` | number | 4081 | Port for llama-server to bind |
| `ctxSize` | number | (model default) | Context window size in tokens |
| `gpuLayers` | number | (model default) | Number of layers to offload to GPU |
| `mmprojPath` | string | - | Path to multimodal projector (.mmproj file) |

### Parameter Examples

```powershell
# Minimal request
{"modelPath": "model.gguf"}

# Full GPU offload
{"modelPath": "model.gguf", "gpuLayers": 99}

# Large context window
{"modelPath": "model.gguf", "ctxSize": 32768, "gpuLayers": 99}

# Vision/multimodal
{
  "modelPath": "vision-model.gguf",
  "mmprojPath": "mmproj-model.gguf",
  "gpuLayers": 99
}

# Custom ports for multiple instances (not recommended)
# Note: Manager still enforces singleton, this just changes which port
# the llama-server binds to internally
{"modelPath": "model.gguf", "port": 8082}
```

## GGUF Model Path Resolution

The `modelPath` is resolved relative to `modelsDir`:

```
Config: modelsDir = "D:\Models"
Request: { "modelPath": "TheBloke/Llama-2-7B/llama-2-7b.Q4_K_M.gguf" }
Resolved: "D:\Models\TheBloke\Llama-2-7B\llama-2-7b.Q4_K_M.gguf"
```

Supports LM Studio folder structure:
```
modelsDir/
├── publisher/
│   └── repo/
│       └── model.gguf
```

## nLogger Configuration

Logging is configured via the `createLogger()` call in each module.

### Environment Variables

| Variable | Default | Effect |
|----------|---------|--------|
| `LOG_RETENTION_DAYS` | 1 | Auto-delete session logs older than N days |
| `DEBUG` | false | Enable DEBUG level logging |
| `NODE_ENV` | - | If 'development', enables debug logging |

### Programmatic Configuration

In your code (if you want custom settings):

```javascript
import { createLogger } from './nLogger/src/logger.js';

const log = createLogger({
  logsDir: '/custom/log/path',
  sessionPrefix: 'custom',
  enableMainLog: true,
  maxFileSizeBytes: 50 * 1024 * 1024,  // 50MB
  maxMainLogFiles: 5,
  flushIntervalMs: 5000  // 5 seconds
});
```

## llama-server Arguments

The manager maps JSON parameters to llama-server CLI arguments:

| JSON Parameter | CLI Argument | Example |
|----------------|--------------|---------|
| `modelPath` | `-m` | `-m D:\Models\model.gguf` |
| `port` | `--port` | `--port 4081` |
| `ctxSize` | `-c` | `-c 4096` |
| `gpuLayers` | `-ngl` | `-ngl 99` |
| `flashAttention` | `--flash-attn` | `--flash-attn on` |
| `mmprojPath` | `--mmproj` | `--mmproj D:\Models\proj.gguf` |

### Full Generated Command Example

```powershell
# Request
POST /start
{
  "modelPath": "TheBloke/llama-2-7b.Q4_K_M.gguf",
  "ctxSize": 4096,
  "gpuLayers": 33
}

# Results in spawn:
llama-server.exe `
  -m "D:\# AI Stuff\LMStudio_Models\TheBloke\llama-2-7b.Q4_K_M.gguf" `
  --port 4081 `
  -c 4096 `
  -ngl 33
```

## Configuration Validation

The system validates configuration at startup:

| Check | Failure Behavior |
|-------|-----------------|
| Binary exists at `llamaServerPath` | Process exit with error |
| `modelsDir` exists | Warning logged, empty model list |
| Port numbers valid integers | Uses default value |
| Port available | llama-server spawn will fail |

## Troubleshooting Configuration Issues

### "Cannot find llama-server.exe"

```powershell
# Check the path
ls $env:LLAMA_SERVER_PATH
# or
ls ..\dist\universal\llama-server.exe

# If missing, build it:
..\build-scripts\build-universal.ps1
```

### "Models directory not found"

```powershell
# Check if directory exists
Test-Path $env:MODELS_DIR

# Create or set correct path
mkdir "D:\Models"
$env:MODELS_DIR = "D:\Models"
```

### "Port already in use"

```powershell
# Find what's using the port
Get-NetTCPConnection -LocalPort 4080

# Kill the process or use different port
$env:MANAGER_PORT = 8090
$env:LLAMA_SERVER_PORT = 8091
```

## Flash Attention

Flash Attention is an optimized attention algorithm that reduces VRAM usage for the KV cache by approximately **50%**, while also being faster. This enables running models with much larger context windows on consumer GPUs.

### Benefits

| Without Flash Attention | With Flash Attention |
|------------------------|---------------------|
| 64k context ≈ 30-35GB VRAM | 64k context ≈ 15-18GB VRAM |
| Limited to 4k-8k context on 24GB cards | 64k+ context feasible on 24GB cards |
| Slower prompt processing | Faster attention computation |

### Configuration

**Global default (config.js):**
```javascript
export default {
  flashAttention: true  // Enable for all models by default
}
```

**Environment variable:**
```powershell
$env:FLASH_ATTENTION = "true"   # Enable (default)
$env:FLASH_ATTENTION = "false"  # Disable
```

**Per-request override:**
```json
POST /start
{
  "modelPath": "model.gguf",
  "flashAttention": false  # Disable for this specific model
}
```

### When to Disable

- **Compatibility issues** with specific models (rare)
- **Small models** where VRAM isn't a concern and you want minimal overhead
- **Debugging** performance issues

### VRAM Usage Examples (Qwen 3.5 35B A3B)

| Context | Flash Attention | VRAM Usage | Performance |
|---------|----------------|------------|-------------|
| 2,048 | Off | ~12GB | 157 tok/s |
| 2,048 | On | ~12GB | 157 tok/s |
| 65,536 | Off | ~35GB+ | OOM (fails) |
| 65,536 | On | ~17GB | 153 tok/s |

## Model Profiles

Model profiles provide optimized default settings for specific models. When you start a model without specifying parameters, the manager automatically applies the best-known configuration for that model.

### How It Works

1. You send a minimal request:
   ```json
   POST /start
   { "modelPath": "Qwen3.5-35B-A3B/model.gguf" }
   ```

2. Manager matches the model name to a profile:
   - Contains `qwen3.5-35b-a3b` → Uses Qwen 3.5 35B profile

3. Manager applies optimized defaults:
   - `ctxSize`: 65536 (64k context)
   - `gpuLayers`: 99 (full GPU offload)
   - `flashAttention`: true

4. Response shows what was applied:
   ```json
   {
     "profile": {
       "name": "Qwen 3.5 35B A3B (MoE)",
       "vramEstimateGB": 17
     },
     "appliedDefaults": {
       "ctxSize": 65536,
       "flashAttention": true
     }
   }
   ```

### Override Behavior

Any parameters you provide override the profile:

```json
POST /start
{
  "modelPath": "Qwen3.5-35B-A3B/model.gguf",
  "ctxSize": 32768  # Use 32k instead of profile's 64k
}
```

### Available Profiles

Query all profiles:
```bash
curl http://127.0.0.1:4080/profiles
```

**Current profiles include:**
- Qwen 3.5 series (9B, 27B, 35B A3B MoE)
- Gemma 4 series (4B, 26B)
- Embedding models (Gemma Embedding, mxbai, Nomic, BERT)

### Adding Custom Profiles

Edit `llama-manager/model-profiles.js`:

```javascript
export const modelProfiles = {
  'your-model-key': {
    name: 'Your Model Name',
    description: 'Description here',
    defaults: {
      ctxSize: 16384,
      gpuLayers: 99,
      flashAttention: true
    },
    vramEstimateGB: 12,
    tags: ['custom', 'your-tag']
  },
  // ... existing profiles
}
```

Profile matching is by substring (case-insensitive), so `your-model-key` will match any model path containing that string.

## Complete Environment Setup Script

```powershell
# setup-env.ps1 - Run before starting server

# Core settings
$env:MANAGER_PORT = 4080
$env:LLAMA_SERVER_PORT = 4081
$env:LLAMA_SERVER_PATH = "D:\llama-cpp-gateway\dist\universal\llama-server.exe"
$env:MODELS_DIR = "D:\Models"

# Logging
$env:LOG_RETENTION_DAYS = 7
$env:NODE_ENV = "production"

# Optional: GPU settings
$env:CUDA_VISIBLE_DEVICES = "0"  # Use only first GPU

# Flash Attention (enabled by default, set to 'false' to disable)
$env:FLASH_ATTENTION = "true"

# Default model settings
$env:DEFAULT_CTX_SIZE = "8192"
$env:DEFAULT_GPU_LAYERS = "99"

Write-Host "Environment configured for LLaMA Manager"
Write-Host "Manager Port: $env:MANAGER_PORT"
Write-Host "Server Port: $env:LLAMA_SERVER_PORT"
Write-Host "Models: $env:MODELS_DIR"
```
