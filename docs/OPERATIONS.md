# Operations Guide

How to run, manage, and monitor the LLaMA.cpp Gateway in production.

## Table of Contents

- [Running as a Service](#running-as-a-service)
- [Process Management](#process-management)
- [Monitoring & Health Checks](#monitoring--health-checks)
- [Log Management](#log-management)
- [Automatic Startup](#automatic-startup)
- [Restart Policies](#restart-policies)
- [Resource Management](#resource-management)

---

## Running as a Service

### Option 1: Local Process Manager (Recommended)

This project is designed to work with [Local Process Manager](https://github.com/herrbasan/local_pm) — an Electron-based tray application for managing local CLI services.

**Step 1: Bundle the Deployment**

First, create a clean deployment outside the repo:

```powershell
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager" -CreateLauncher
```

**Step 2: Add to Process Manager**

Edit `local_pm/config.json`:

```json
{
    "llama-manager":{
        "description":"LLaMA Manager",
        "path":"C:\\Services\\llama-manager",
        "exec":"node server.js",
        "args":"",
        "detachOnQuit":false
    }
}
```

Or use the generated launcher:
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

**Environment Variables:**

The process manager passes through environment variables. Set them before starting the tray app, or use a wrapper script:

```powershell
# wrapper.ps1 - Start this from Local Process Manager instead
$env:NODE_ENV = "production"
$env:MANAGER_PORT = 4080
$env:LLAMA_SERVER_PORT = 4081
$env:MODELS_DIR = "D:\\# AI Stuff\\LMStudio_Models"
$env:LOG_RETENTION_DAYS = 7
node D:\DEV\llama-cpp-gateway\llama-manager\server.js
```

Then update config.json:
```json
{
    "llama-manager":{
        "description":"LLaMA Manager",
        "path":"D:\\DEV\\llama-cpp-gateway\\llama-manager",
        "exec":"powershell.exe -File wrapper.ps1",
        "args":"",
        "detachOnQuit":false
    }
}
```

**Auto-Start:**

Enable auto-start in the tray app UI, or edit `local_pm/store.json`:
```json
{
  "autoStart": {
    "llama-manager": true
  }
}
```

**Key Points:**
- `detachOnQuit: false` — Manager stops when you quit the tray app (recommended)
- Process discovery works via `--pm-service=llama-manager` marker (auto-injected)
- Logs appear in tray UI (last 10 lines) and full logs in `llama-manager/logs/`

### Option 2: PM2 (Node.js Process Manager)

If you don't have a process manager yet:

```powershell
# First, bundle the deployment
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager"

# Then install PM2
npm install -g pm2

# Create ecosystem file in the deployment directory
cd C:\Services\llama-manager

@'
module.exports = {
  apps: [{
    name: 'llama-manager',
    script: './server.js',
    cwd: 'C:\\Services\\llama-manager',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      MANAGER_PORT: 4080,
      LLAMA_SERVER_PORT: 4081
    },
    log_file: './logs/pm2-combined.log',
    out_file: './logs/pm2-out.log',
    error_file: './logs/pm2-error.log',
    time: true
  }]
}
'@ | Out-File -FilePath ecosystem.config.cjs

pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # Generates command to auto-start on boot
```

### Option 3: Windows Service (nssm)

Alternative using Windows services:

```powershell
# First, bundle the deployment
.\build-scripts\bundle-deployment.ps1 -TargetDir "C:\Services\llama-manager"

# Download nssm from https://nssm.cc/download
nssm install LlamaManager
# Application path: C:\Program Files\nodejs\node.exe
# Arguments: C:\Services\llama-manager\server.js
# Working directory: C:\Services\llama-manager

nssm start LlamaManager
```

### Option 4: Manual / Development

```powershell
cd llama-manager
node server.js
```

Press `Ctrl+C` to stop. The manager will gracefully shutdown and kill any running llama-server.

---

## Process Manager Integration

When using Local Process Manager (or similar), understand the process hierarchy:

```
Local PM Tray App
    └── spawns ──► llama-manager (Node.js, port 4080)
                         └── spawns ──► llama-server.exe (C++, port 4081)
```

**What the Process Manager Sees:**
- Only tracks the `llama-manager` process
- Shows status: starting → running
- Can stop/restart the manager

**What the Manager Handles:**
- Spawns/kills `llama-server.exe` on demand
- Maintains state machine: idle → starting → running
- Auto-kills child on manager exit (guaranteed disposal)

**Important:** 
- Do NOT configure `llama-server.exe` as a separate service in your process manager
- The manager is the single point of control
- By default, stopping the manager automatically stops the server

**Preserving Model in VRAM:**

Set `DETACH_ON_SHUTDOWN=true` to keep the model loaded when the manager restarts:

```powershell
$env:DETACH_ON_SHUTDOWN = "true"
```

This is useful when:
- Restarting manager frequently for development
- Updating manager config without reloading model
- Process manager restarts the service

With this enabled:
- Manager shutdown detaches (doesn't kill) the server
- Model stays loaded in VRAM
- Manager re-attaches on startup if server is healthy
- Use `POST /stop {"force": true}` to actually kill server and free VRAM

### Integration Checklist

When integrating with your process manager:

- [ ] Configure only `llama-manager` (not `llama-server`)
- [ ] Set `path` to `llama-manager/` directory
- [ ] Set `exec` to `node server.js` (or wrapper script)
- [ ] Set `detachOnQuit: false` (manager should stop with tray app)
- [ ] Verify logs appear in both PM UI and `logs/` directory
- [ ] Test stop/start cycle from PM UI
- [ ] Enable auto-start if desired

---

## Process Management

### Understanding the Process Hierarchy

```
llama-manager (Node.js) ──► llama-server.exe (C++)
     port 4080                    port 4081
     HTTP API                     HTTP API + Inference
```

**Key Rule:** Always interact with llama-server through the manager. Never start/stop `llama-server.exe` directly — the manager maintains state and will get confused.

### Lifecycle States

| State | Meaning | Transitions To |
|-------|---------|----------------|
| `idle` | No server running | `starting` via `/start` |
| `starting` | Server spawned, warming up | `running` (health OK) or `error` (failed) |
| `running` | Server ready for inference | `idle` via `/stop` or crash |
| `error` | Spawn failed or crashed | `idle` after `/stop` |

### Health Check Polling

The manager polls `llama-server` every 2 seconds:
- **In `starting` state:** Hits `/health` endpoint
- **In `running` state:** Hits `/metrics` endpoint

Check status:
```powershell
curl http://127.0.0.1:4080/status
```

Response:
```json
{
  "state": "running",
  "pid": 12345,
  "metrics": {
    "raw": "# HELP llama_tokens_predicted_total..."
  }
}
```

### Force Kill Scenarios

If the manager crashes or is killed, it attempts to kill the child process. If that fails:

```powershell
# Find and kill manually
Get-Process | Where-Object {$_.ProcessName -like "*llama*"}
Stop-Process -Name "llama-server" -Force
```

---

## Monitoring & Health Checks

### HTTP Health Endpoint

```powershell
# Manager health
curl http://127.0.0.1:4080/status

# Direct server health (bypasses manager)
curl http://127.0.0.1:4081/health
```

### Key Metrics to Monitor

From `/status` endpoint:
- `state` should be `running` during operation
- `pid` should be non-null when active
- `metrics.raw` contains Prometheus-format data

### Prometheus Metrics (from llama-server)

When running, metrics include:
```
llama_tokens_predicted_total 1234
llama_tokens_drafted_total 567
llama_load_time_ms 12345
llama_eval_time_ms 67890
```

### Simple Monitoring Script

```powershell
# monitor.ps1 - Run as scheduled task every minute
$status = Invoke-RestMethod -Uri "http://127.0.0.1:4080/status"
if ($status.state -eq "error") {
    # Alert via your preferred method
    Write-EventLog -LogName Application -Source "LlamaManager" -EventId 1001 -EntryType Error -Message "LLaMA server in error state"
}
```

---

## Log Management

### Log Locations

Logs are written by `nLogger` to:
```
llama-cpp-gateway/logs/
├── 2026-04-11-10-30-00-gw-abc123.log   # Current session (readable format)
└── main-0.log                           # Combined rolling log (JSON Lines)
```

### Log Format

**Session logs** (human-readable):
```
[2026-04-11T10:30:00.123Z] [INFO] [LlamaManager] Server started {"pid":12345}
[2026-04-11T10:30:02.456Z] [WARN] [Process] Failed to fetch metrics: connect ECONNREFUSED
```

**Main log** (JSON Lines, machine-parseable):
```json
{"ts":"2026-04-11T10:30:00.123Z","level":"INFO","type":"LlamaManager","msg":"Server started","meta":{"pid":12345},"session":"gw-abc123"}
```

### Log Retention

Controlled by environment variable:
```powershell
$env:LOG_RETENTION_DAYS = 7  # Keep logs for 7 days (default: 1)
```

Old session logs are auto-deleted. Main logs roll by size (10MB default) and keep last 10 files.

### Querying Logs

```powershell
# View latest session log
cat (Get-ChildItem logs\*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1)

# Filter errors from main log (requires jq)
cat logs\main-0.log | jq 'select(.level == "ERROR")'

# Search for specific session
cat logs\main-0.log | jq 'select(.session == "gw-abc123")'
```

---

## Automatic Startup

### Windows Task Scheduler

```powershell
# Create task to start on user login
$action = New-ScheduledTaskAction -Execute "node" -Argument "D:\DEV\llama-cpp-gateway\llama-manager\server.js" -WorkingDirectory "D:\DEV\llama-cpp-gateway\llama-manager"
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "LlamaManager" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

### Docker (Future)

```dockerfile
# Dockerfile (not yet implemented)
FROM node:18-alpine
COPY . /app
WORKDIR /app/llama-manager
CMD ["node", "server.js"]
```

---

## Restart Policies

### Automatic Restart on Model Hang

If a model hangs (infinite generation, OOM), the manager won't auto-detect this. Implement external monitoring:

```powershell
# restart-if-stuck.ps1
$status = Invoke-RestMethod -Uri "http://127.0.0.1:4080/status"
if ($status.state -eq "running") {
    # Try a simple completion
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:4081/completion" -Method Post -Body '{"prompt":"test","n_predict":1}' -TimeoutSec 10
    } catch {
        # Server unresponsive, restart via manager
        Invoke-RestMethod -Uri "http://127.0.0.1:4080/stop" -Method Post
        Start-Sleep -Seconds 5
        # Restart with last known model (you'd need to track this)
    }
}
```

### Memory-Based Restart

Monitor GPU/VRAM usage and restart if critically low:
```powershell
# Check GPU memory (NVIDIA)
nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits
```

---

## Resource Management

### GPU Layer Configuration

Control GPU offload via `gpuLayers` parameter in `/start`:

```powershell
# Full GPU offload (fastest, most VRAM)
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "gpuLayers": 99}'

# Partial offload (balance VRAM/speed)
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "gpuLayers": 33}'

# CPU only (slowest, no VRAM)
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "gpuLayers": 0}'
```

### Context Size Management

Adjust context window via `ctxSize`:

```powershell
# Small context (less VRAM, faster)
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "ctxSize": 2048}'

# Large context (more VRAM, slower)
curl -X POST http://127.0.0.1:4080/start -H "Content-Type: application/json" -d '{"modelPath": "model.gguf", "ctxSize": 32768}'
```

### Port Configuration

Avoid conflicts with other services:

```powershell
# Custom ports via environment
$env:MANAGER_PORT = 8090        # Manager API
$env:LLAMA_SERVER_PORT = 8091   # Inference API
node server.js
```

---

## Checklist for Production Deployment

- [ ] Build universal binary with CUDA + Vulkan support
- [ ] Configure correct `MODELS_DIR` path
- [ ] Set `LOG_RETENTION_DAYS` appropriately
- [ ] Install as Windows Service or PM2
- [ ] Configure auto-start on boot
- [ ] Set up monitoring/alerting for `/status` endpoint
- [ ] Document which models are available and their resource requirements
- [ ] Test `/stop` and `/start` cycle to verify cleanup
- [ ] Verify graceful shutdown on system restart
- [ ] Set up log rotation/archival if needed
