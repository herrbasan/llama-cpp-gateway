# Llama Manager - Development Plan

**Deterministic Mind — Coding Philosophy**
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

## Phase 1: Foundation & Supervisor
*Reference: Spec Section 2 (Architecture), Section 3 (Strict Operating Rules)*
- [ ] **1.0 Setup**: Run `npm init -y` and add `nLogger` as a git submodule (`git submodule add https://github.com/herrbasan/nLogger.git llama-manager/nLogger`).
- [ ] **1.1 Scaffold Server Core**: Create `server.js` bringing up `node:http` API that listens on `127.0.0.1` and handles raw JSON body parsing, integrating `nLogger` for all requests.
- [ ] **1.2 Create Process Module**: Build `process.js` to wrap `node:child_process.spawn`, piping output to `nLogger`.
- [ ] **1.3 Implement Guaranteed Disposal**: Hook into Node lifecycle events (`SIGINT`, `SIGTERM`, `exit`, `uncaughtException`) and force-kill the underlying executable via tree-kill logic if needed.

## Phase 2: API Execution
*Reference: Spec Section 4 (API Endpoints)*
- [ ] **2.1 `GET /models` Implementation**: Add recursive directory scanning matching LM Studio's structure to discover and return valid `.gguf` and `.mmproj` vision files.
- [ ] **2.2 `POST /start` Implementation**: Map JSON payloads to `llama-server.exe` raw arguments (`-m`, `--mmproj` for vision, `-c`, `-ngl`, `--port`, etc.). Include singleton checks.
- [ ] **2.3 `POST /stop` Implementation**: Link the kill function to an endpoint to allow gateway-driven halting.
- [ ] **2.4 `GET /status` Implementation**: Hook a base state machine (`idle`, `starting`, `running`) into the endpoint.

## Phase 3: Telemetry & Monitoring
*Reference: Spec Section 4.4 (GET /status)*
- [ ] **3.1 HTTP Poller**: Create an internal interval that hits `http://127.0.0.1:8081/metrics` when the server is `running`.
- [ ] **3.2 Server Health Check**: Ensure `/health` returns `{"status": "ok"}` before transitioning `/start` from `starting` to `running`.

## Phase 4: Local Testing
- [ ] **4.1 Boot Test**: Run `POST /start` pointing to the `Gemma-4-E4B-` test model to ensure Node.js correctly invokes the Vulkan/CUDA universal server build.
- [ ] **4.2 Status Test**: Verify `/status` returns real-time hardware metrics.
- [ ] **4.3 Kill Test**: Execute `/stop` or kill the Node instance from terminal, asserting the `llama-server` task vanishes cleanly from `Get-Process`.

**Key signal:** When you reach for an inherited pattern, ask — does the problem this solves actually exist in my context?

