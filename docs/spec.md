# Llama Manager Specification

> **Deterministic Mind — Coding Philosophy**
>
> **Core Maxims**
> - **Reliability > Performance > Everything else.**
> - **LLM-Native Codebase:** Optimize for what an LLM can most efficiently understand and modify. No human-readability goals.
> - **Vanilla JS everywhere.** No TypeScript (`.d.ts` for context only, never runtime).
> - **Zero Dependencies.** Build it ourselves with raw standard libraries unless a dependency is truly necessary.
> - **Fail Fast, Always.** No defensive coding, no mock data, no fallback defaults, no swallowed exceptions. Let it crash; fix the root cause.
>
> **Design Principles**
> - **Design Failures Away:** Prevention over handling. Eliminate failure conditions at the design level so they can never occur.
> - **Disposal is Mandatory and Verifiable:** Every resource created must have a proven, confirmed disposal path.
> - **Block Until Truth:** State is authoritative. UI reflects truth, never intent. Block inputs during transitions — race conditions must be structurally impossible.
> - **Abstraction From Evidence:** First use case: write direct. Second: copy-modify. Third (pattern is now visible): abstract. Wrong abstraction is harder to remove than no abstraction.
> - **Single Responsibility:** If you need "and" or "or" to describe a function, it has multiple responsibilities.
> - **Immutability by Default:** Mutation creates temporal dependencies. Start immutable; optimize only when measurement proves it necessary.
> - **Measure Before Optimizing.** Intuition about performance is frequently wrong. Profile first.
> - **Test Reality Early:** The moment we have a surface area that can be tested against the real world (e.g., spawning the actual `.exe`), we run the test. No waiting for total feature completion.

## 1. Overview
A zero-dependency, Vanilla JS (Node.js) microservice acting as a thin control plane for the `llama.cpp` universal binary (`llama-server.exe`). It provides an HTTP API to safely start, stop, and monitor the AI hardware process, while exposing available local models. AI inference traffic flows directly from the Gateway to the `llama-server`, bypassing this manager entirely.

## 2. Architecture
- **Language**: Node.js (Vanilla JS).
- **Core Principle**: Zero external dependencies, with the single exception of the custom `nLogger` library (via git submodule) to maintain standardized log trails across the system.
- **Components**:
  - **Logger** (`nLogger`): Dedicated logging library (git submodule) to capture runtime events and stream outputs reliably during operations and testing.
  - **Control API Server** (`node:http`): Handles incoming JSON requests from the overarching LLM Gateway on port `8080`.
  - **Process Supervisor** (`node:child_process`): Spawns `llama-server.exe` (configurable to port `8081`), tracks its PID, and exclusively maps arguments.
  - **Telemetry Poller**: Periodically hits `llama-server.exe` native `/metrics` and `/health` endpoints to report status.

## 3. Strict Operating Rules (Deterministic Mind)
- **Singleton Enforcement**: Only one `llama-server.exe` instance is permitted to run horizontally at any time. A new request to `/start` while running will fail-fast with a 409 Conflict.
- **Guaranteed Disposal**: The Node application binds to `process.on('exit')`, `SIGINT`, `SIGTERM`, and `uncaughtException` to guarantee the child process is relentlessly killed if the wrapper dies.
- **Separation of Concerns**: The manager NEVER proxies inference tokens. It only manages hardware, models, and process lifecycles.

## 4. API Endpoints

### 4.1. `GET /models`
- **Behavior**: Recursively scans the configured `modelsDir` to support the LM Studio folder structure (`Publisher/Repository/Model.gguf`). Discovers both `.gguf` standard models and `.mmproj` vision projectors.
- **Returns**: JSON array of available models.

### 4.2. `POST /start`
- **Accepts**: JSON body with `modelPath` (required), optional `mmprojPath` (for Vision/Multimodal support), and CLI overrides (`ctxSize`, `gpuLayers`, `port` default 8081, etc.).
- **Behavior**: Validates model file existence. Spawns `llama-server.exe` with standard args and `--mmproj` if vision is requested. Polls `/health` until ready, then sets state to `running`.
- **Returns**: 200 OK or 400/409 error.

### 4.3. `POST /stop`
- **Behavior**: Issues a polite kill signal to the child. If unresponsive, invokes a system hard kill to forcefully clear VRAM. Sets internal state to `idle`.
- **Returns**: 200 OK.

### 4.4. `GET /status`
- **Behavior**: Returns the current truth state.
- **Returns JSON**: 
  - `state`: `idle` | `starting` | `running` | `error`
  - `pid`: current child process ID (or null)
  - `metrics`: Forwarded Prometheus metrics/stats from the running `llama-server.exe`.

## 5. Security Context
- Binds locally (e.g., `127.0.0.1:8080`) so only the trusted LLM Gateway running alongside it on the LAN or localhost can mandate hardware execution.

