# AGENTS.md — Development Notes

## Architecture

Multi-instance manager: up to `maxInstances` (default 4) `llama-server` processes running concurrently. Each unique `X-Model-Path` gets its own process on an auto-incremented port starting at `serverPort` (4081). Instances are tracked in an in-memory `Map<modelPath, instance>`.

## Key Files

- `src/manager/server.js` — HTTP server, header extraction, proxy logic. `handleInference()` is the hot path.
- `src/manager/process.js` — Process lifecycle. `ensureModel()` is the entry point: checks existing instance, validates config match, spawns if needed. `configsMatch()` compares all options — if any differ, the instance restarts.
- `src/manager/models.js` — GGUF header parser. Reads first 2MB of file, extracts metadata keys (architecture, context_length, parameter_count, etc.). Also enriches model list with `tune-results.json` benchmark data.
- `src/manager/config.js` — Reads `config.json` from project root. All defaults are defined here.

## Hot Path (Inference Request)

1. `extractModelConfig(req)` reads `X-Model-*` headers
2. `getInstance(modelPath)` checks if model already running → instant proxy (≤1ms)
3. `ensureModel()` — config match check, spawn if needed
4. Health poll loop (1s interval, 120s timeout) waits for `starting` → `running`
5. `proxyToInstance()` pipes req body → llama-server, pipes response back. Zero parsing.

## Proxy Error Handling

`proxyToInstance` uses a `completed` flag to guarantee exactly-once response. Prevents cascading 502 errors when llama-server crashes mid-request (error/close/aborted all fire simultaneously).

## Conservative Defaults (Stability)

`llama-server` is prone to `code=3221226505` (Windows Access Violation) with experimental features. Defaults in `config.js`:
- `defaultParallelSlots: 1` — sequential queuing, no race conditions
- `defaultKvUnified: false` — no unified KV buffers
- `defaultCtxCheckpoints: 0` — no context checkpointing
- `defaultCheckpointEveryTokens: -1` — disabled

Do NOT change these without load testing. See `docs/_Archive/troubleshooting-econnreset-crash.md`.

## State Persistence

`src/manager/state.json` stores running instance info (port, options, detached flag). On restart, `restoreState()` re-attaches to any detached instances that are still alive. This file is auto-generated — do not edit manually.

## Detach / Reattach

When `detachOnShutdown: true`:
- Manager stop leaves `llama-server` processes running
- `killInstance()` sets `detached: true`, stops polling, but doesn't kill the process
- On next startup, `restoreState()` checks each detached instance's `/health` and re-attaches

## Model Config Normalization

`normalizeConfig()` in `process.js` applies defaults and computes derived values:
- Embedding models: `batchSize` and `ubatchSize` default to `ctxSize` (not the global default)
- Non-embedding models: use `defaultBatchSize` / `defaultUbatchSize` from config

## Port Allocation

`allocatePort()` is a simple counter starting at `serverPort`. Ports increment and never decrement. If the manager runs for a long time with many model swaps, ports will grow. This is intentional — avoids port conflicts with lingering sockets.

## Model Discovery

`discoverModels()` recursively scans `modelsDir` for `.gguf` and `.mmproj` files. GGUF metadata is read from the first 2MB. Vision models are detected by architecture containing `mllm` or from `tune-results.json` benchmark data.

## Model Tuner

`scripts/tune-model.js` is an interactive CLI that benchmarks models. Results are stored in `scripts/tune-results.json` and automatically enrich the `/models` endpoint response with benchmark data (tok/s, VRAM, etc.).

## Integration Tests

`src/manager/test/` contains test files. Note: these tests reference older API endpoints (`POST /start`, `GET /profiles`) that no longer exist. They need to be rewritten to use the current header-driven inference flow:
- Use `X-Model-*` headers instead of `POST /start`
- Remove references to `GET /profiles`
- Test the actual proxy flow through `handleInference()`

## Adding New Config Fields

1. Add to `config.json` with a default value
2. Add to `config.js` export with `cfg.fieldName ?? defaultValue`
3. Add to `normalizeConfig()` in `process.js` if it affects llama-server args
4. Add to `configsMatch()` so config changes trigger instance restart
5. Add to `buildArgs()` to pass it to llama-server
6. Add to `extractModelConfig()` in `server.js` if it should be overridable per-request via headers

## Logging

Uses `nLogger` (git submodule at `src/manager/modules/nLogger/). Must run `git submodule update --init --recursive` after cloning. Logs go to `logs/` with session-based filenames and rolling JSON Lines.

## Windows-Specific Notes

- `process.detach: false` and `windowsHide: true` — llama-server runs as a hidden child process
- `SIGINT` is used for graceful shutdown (not `SIGTERM` — unreliable on Windows)
- Access violations from llama-server manifest as `code=3221226505` (0xC0000005)
