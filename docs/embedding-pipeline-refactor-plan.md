# Embedding Pipeline Refactor — Plan

> **Status:** Proposed, not yet executed. This document is intended to be
> read in a fresh session so the work is not contaminated by the failed
> attempts documented in commit history.

## Context for the next session

If you are reading this in a fresh session, the only things you need
to know are below. Everything else in this document is background,
rationale, and non-goals. Read this section, then ask the user the
four open questions, then start Phase 1.

### Files in this repo the next session needs

- [`docs/embedding-pipeline-refactor-plan.md`](docs/embedding-pipeline-refactor-plan.md )
  — this file (the plan)
- [`example_data/chat_conversation.json`](example_data/chat_conversation.json )
  — real chat history captured from the chat app. Each exchange
  has a `user.content` and an `assistant.content` (each is a string
  to embed). User messages are up to ~24k chars; assistant messages
  up to ~9.6k chars.
- [`.openrouter-key.local.json`](.openrouter-key.local.json )
  — `{ baseUrl, apiKey, model }` for the OpenRouter cloud endpoint.
  **Untracked, gitignored.** Read it but do not commit it. Contains
  the real API key in plain text.
- The OpenRouter docs: <https://openrouter.ai/qwen/qwen3-embedding-4b/api>
- The gateway source (do not change in Phase 1):
  - [`src/manager/server.js`](src/manager/server.js ) — HTTP entry,
    `handleInference()`, raw-pipe `proxyToInstance()` for `/v1/embeddings`
  - [`src/manager/process.js`](src/manager/process.js ) — `ensureModel()`,
    `getInstance()`, `normalizeConfig()`, state
  - [`src/manager/config.js`](src/manager/config.js ) — `config.json` reader
  - [`src/manager/models.js`](src/manager/models.js ) — model resolution
  - [`config.json`](config.json ), [`config-example.json`](config-example.json ),
    [`AGENTS.md`](AGENTS.md ) — read but do not change

### Constraints

- **Do not write any code that changes the gateway in Phase 1.**
  Phase 1 is profiling only. Code changes start in Phase 3.
- **Do not commit the API key.** The `.openrouter-key.local.json` file
  is in `.gitignore`. The pattern `*.local.json` is also in
  `.gitignore` for future key files of the same convention.
- **Do not commit `example_data/chat_conversation.json`.** It contains
  real chat content; keep it untracked unless the user explicitly
  asks to commit it.
- **Do not write test code that hits OpenRouter until the user
  answers the four open questions** (at the bottom of this document).

### What we are doing in one sentence

The local `llama-cpp-gateway` is the production endpoint for
embeddings. The cloud endpoint (OpenRouter running the same model) is
a fallback. The LLM Gateway does the routing. The local gateway's
only contract is: emit responses that the LLM Gateway can treat as
identical to OpenRouter's for the same input.

### Order of operations

1. Read the rest of this document (Context, Goal, Non-goals, Phases).
2. Ask the user the four open questions. Wait for answers.
3. Write `scripts/baseline-test.mjs` (or whatever the user prefers for
   location). It POSTs each payload to the cloud endpoint, captures
   status/latency/body/error, writes JSONL.
4. Run the size spectrum: real chat messages + synthetic extremes
   (100k, 500k chars). No health checks.
5. Write `docs/baseline-results.md` summarizing what the cloud does
   per payload shape. This becomes the spec.
6. Stop. Do not start Phase 2 without checking with the user.



## Context

The `/v1/embeddings` endpoint on the `llama-cpp-gateway` manager is
failing for some real-world inputs (the chat app reports "embeddings not
completed"). The previous attempts to fix this — adding chunking,
batching, circuit-breaker logic, fallback batch-size tuning — repeatedly
introduced new bugs and have been reverted.

This plan restarts the work with a data-first approach: build a baseline
from a real cloud endpoint before changing any gateway code.

## Why we are restarting

The earlier work made assumptions that did not hold against the real
traffic pattern:

- Synthetic test payloads did not reproduce the production failure
  (timing, error pattern, or both).
- The "obvious" fix (chunking oversized inputs) was on the right track,
  but the implementation repeatedly failed in subtle ways: empty error
  objects, 38-second latencies on inputs that should take milliseconds,
  circuit-breakers that opened against a model that wasn't actually
  broken.
- The hardware concern (Intel Arc A770 Vulkan throughput) was a
  red herring. A 22k-character input should take single-digit
  milliseconds on that hardware; the seconds-to-minutes observed
  latencies were from the gateway code, not the model.

We need a baseline against a known-working endpoint to know what
"correct" actually looks like.

## Goal

The local `llama-cpp-gateway` is the **production** endpoint for
embedding traffic. The cloud endpoint (OpenRouter running the same
model) is a **fallback** for when local is down, rate-limited, or
unavailable. The economic goal is to do as much embedding work locally
as possible to avoid cloud token costs.

The local gateway must therefore produce **identical** responses to
the cloud for the same input: same status code, same JSON shape, same
error messages. Any drift is a bug, because the LLM Gateway's
fallover logic depends on the local and cloud endpoints being
interchangeable from the client side.

The local gateway does not need to be faster than the cloud — it only
needs to behave the same. A 24k-character input that the cloud
handles in 200ms but the local handles in 2s is fine. A 24k-character
input that the cloud accepts and the local rejects (or vice versa) is
a bug.

The principle, stated once and clearly: **the spec is the contract,
not the implementation**. After this work is done, the LLM Gateway
should not need to know — and should not care — whether a given
embedding call was served by the local manager or the cloud
endpoint. The two are interchangeable.

The fallback / routing logic itself lives in the LLM Gateway, not
in this repo. The local gateway's only contract is: emit responses
that the LLM Gateway can treat as identical to OpenRouter's. If the
LLM Gateway gets a 500 from local, it falls back to cloud. If the
LLM Gateway gets a 200 from local, it stores the embedding and moves
on. Whatever the cloud does for the same input is the local's
target. If the cloud rejects an input with a specific error, local
must reject the same input with the same status code and a
compatible error body. If the cloud chunks and mean-pools, local
must do the same.

## Critical observation about the actual traffic shape

Previous debugging sessions assumed the LLM Gateway was sending a single
`POST /v1/embeddings` with `input: [a, b, c]` — one HTTP call per chat
turn with multiple messages bundled together. That assumption is
**wrong**. The real traffic is a stream of single-string requests, one
per message, fired in parallel (per the user's correction in the
handoff session). The captured `example_data/chat_conversation.json`
confirms this: each exchange has separate `user.content` and
`assistant.content` strings, and the chat app's `embedStatus` is
per-message.

This changes the failure mode being debugged:

- The original error `input (8696 tokens) is too large to process`
  fires on a **single-message** request (one chat message is 24k chars,
  ~8.7k tokens, exceeds the 8,192 `batchSize`).
- A chunker that handles **per-string** oversized input is the right
  shape — not a per-request batcher, not a cross-request collector.
- Concurrency on the manager side is fine: the chat app issues N
  parallel calls; llama-server processes them sequentially; the
  manager's existing `runWithEmbeddingGate` (limit 1 per model) keeps
  the queue stable.

The OpenAI-spec contract for embeddings is single-string or
array-of-strings; the LLM Gateway normalizes to single-string per
request. So the local gateway must handle: a single string up to N
tokens, where N can exceed the spawn-time `batchSize`.

The local gateway's chunker must therefore be **input-size agnostic**:
it must accept a string of any length, from a few characters to the
size of a large JSON file, and produce a single embedding for the
whole string. Anything less and we are designing for one traffic
shape and breaking the others.

## Non-goals

- Do not re-introduce cross-request batching at the HTTP layer. Real
  OpenAI-compatible services (vLLM, OpenAI, Cohere) do dynamic batching
  at the *scheduler* layer inside the inference engine. `llama-server`
  processes one HTTP call at a time. Adding a 25ms flush + collector at
  the HTTP layer was a reinvention that did not match how cloud
  endpoints behave and is not needed.
- Do not change the response shape. OpenAI-spec response
  (`{ object: "list", data: [...], model, usage }`) is fixed by
  convention; the local gateway must match it.
- Do not change the model startup defaults. The LLM Gateway sends
  `X-Model-BatchSize: 8192`; the local model starts with
  `--batch-size 8192`. That is the working configuration on the current
  hardware. A previous attempt to set batch size to `ctxSize` (32000)
  caused llama-server to hang during scheduler initialization on Vulkan
  and is not safe without further hardware testing.

- Confirm what the cloud endpoint actually does for oversized inputs.
  Per OpenAI's API contract, an input string that exceeds the model's
  context window should return a `400 BadRequestError` — the cloud
  endpoint rejects rather than chunking. The OpenRouter docs do not
  document a max-input-length for `qwen3-embedding-4b` and there is
  no upstream chunker. So the contract we're matching may be: "reject
  oversized inputs with an error" — and our local gateway may already
  be doing the right thing for some payloads. The Phase 1 baseline run
  on a real 22k-character input will confirm this.

## Phases

The phases are ordered so that **the cloud endpoint is profiled
first**, and the local gateway is built by mirroring what the cloud
does. We do not design the local gateway in the abstract; we copy
the cloud's behavior, including its limits, error codes, and
chunking strategy. If the cloud rejects an oversized input, local
rejects. If the cloud chunks and mean-pools, local does the same.
After this work, a tester that doesn't know which endpoint served
a request should not be able to tell.

### Phase 1: Build a baseline (no gateway changes)

**Inputs needed from the user:**

1. A real chat history from the chat app, with the same payload
   structure the chat app sends to the gateway. Capture a representative
   set of messages: short, mid-length, long chat-history
   concatenations, and the occasional 20k-40k character input. Maybe
   50-200 messages total.
2. The exact request envelope the LLM Gateway sends. Captured
   during the previous session:
   - URL path: `/v1/embeddings`
   - Headers: `Content-Type: application/json`,
     `X-Model-Path: <absolute .gguf path>`,
     `X-Model-CtxSize: 32000`, `X-Model-Embedding: true`,
     `X-Model-Pooling: mean`, `X-Model-BatchSize: 8192`,
     plus the LLM Gateway's own authorization header.
   - Request body shape: the chat app embeds each message as a
     *single string* in its own HTTP request, so the LLM Gateway
     issues one HTTP call per message rather than batching multiple
     strings in `input: [a, b, c]`. The real traffic is therefore a
     stream of single-string embedding requests, fired roughly in
     parallel (one per message produced by the chat app). Example
     payloads from the captured conversation (`example_data/
     chat_conversation.json`): user messages up to ~24k chars,
     assistant messages up to ~9.6k chars. Per exchange, the chat
     app's `embedStatus` field is `pending` then either resolves to
     an embedding or stays pending.
3. An OpenRouter (or equivalent) endpoint URL + key + model name
   running the same `Qwen/Qwen3-Embedding-4B` model. Captured
   during the previous session:
   - URL: `https://openrouter.ai/api/v1/embeddings`
   - API key: stored at `.openrouter-key.local.json` (untracked, do not
     commit)
   - Model: `qwen/qwen3-embedding-4b`
   - Docs: <https://openrouter.ai/qwen/qwen3-embedding-4b/api>
   - Context: 33K
   - API: OpenAI-compatible embeddings. Request body shape:
     `{ model, input: string | string[], encodingFormat?: "float" }`.
     Optional headers: `HTTP-Referer`, `X-Title`.
   - The docs do not state a max-input-length; behavior on oversized
     input is not documented. Phase 1 baseline run will determine it
     empirically.

**Deliverables:**

- `scripts/baseline-test.mjs` — a test harness that POSTs the real
  payload to both the cloud endpoint and the local gateway, captures
  latency, status, response body, and any errors. Logs results to
  `logs/baseline-<timestamp>.jsonl`.
- The harness must cover a size spectrum, not just real traffic:
  - **Real chat messages**: each `user.content` and `assistant.content`
    in `example_data/chat_conversation.json` sent as a separate
    single-string request (matches the LLM Gateway's actual shape).
    Fire in parallel, observe per-message latency. (Health checks
    are not a useful signal — they're tiny probes that succeed
    even when the gateway is broken on real inputs. Don't bother.)
  - **Synthetic extremes**: a 100k-character single string, a 500k
    string, etc. to stress the chunker / contract. These are *not*
    the real traffic but they confirm the gateway is input-size
    agnostic.
- A written summary of what the cloud endpoint actually does for each
  payload shape — this is the **spec the local gateway will mirror**:
  - Mid inputs (~4-20KB): response shape, latency, vector dim.
  - Large inputs (~20-40KB): does the cloud accept them? truncate?
  error? chunk? mean-pool? return multiple vectors?
  - Extreme inputs (~100k+): what does the cloud do? This is the
    critical question — if it errors, the gateway should match; if
    it chunks silently, the gateway should match.

**What we will learn:**

- The exact contract we have to match.
- Whether chunking is even needed, or whether the cloud truncates and
  we should match that.
- The realistic latency budget on real hardware (for a 22k input
  on the A770, what does the cloud say is "normal"?).

### Phase 2: Reproduce locally

**Deliverable:**

- Run the same test harness against the local
  `llama-cpp-gateway` (`http://localhost:4080/v1/embeddings`) with the
  current code, no changes.

**What we will learn:**

- Where the local gateway actually diverges from the cloud.
- Which specific payloads fail or hang.
- Whether the failure is the same as the chat app's "embeddings not
  completed" report.
- The actual latency distribution on local hardware for inputs that
  succeed.

### Phase 3: Implement what the cloud does

**Decision rule:** Implement *exactly* what the cloud does, no more,
no less. The cloud is the spec. If the cloud truncates, the local
truncates. If the cloud rejects, the local rejects. If the cloud
chunks and mean-pools, the local chunks and mean-pools with the
same chunk size and overlap. We do not invent behavior the cloud
doesn't have.

**Likely minimal change** (subject to what Phase 1 actually shows):

- A chunker that splits a string that exceeds the model's
  `batchSize` into non-overlapping windows, embeds each, mean-pools the
  result. Activated only when the input string is larger than what
  fits the spawn-time batch size.
- The chunker must:
  - Read the actual `batchSize` from the running instance (not guess).
  - Surface real error messages (not empty `{}`).
  - Be exercised on the actual chat-app payload in Phase 2 before
  declaring it done.
  - Not introduce cross-request batching, circuit-breaker changes,
  flush timers, or any of the speculative complexity from the
  reverted attempts.

**What we will NOT do:**

- Do not add a 25ms flush + collector (re-introduces a pattern that
  doesn't exist in real OpenAI-compatible services).
- Do not add per-call sub-budgets with retry-with-halve (the model's
  `batchSize` is the contract; the chunker respects it directly).
- Do not change `process.js` `normalizeConfig` defaults (the LLM
  Gateway's explicit `batchSize: 8192` is the source of truth).

### Phase 4: Validate against real payload

- Re-run the Phase 1 harness on the local gateway with the new
  chunker. Confirm:
  - All payloads that succeed on the cloud succeed locally.
  - All payloads that error on the cloud error locally with the same
    error.
  - Latency on local is within an order of magnitude of the cloud for
    the same payload.
  - Response shape matches byte-for-byte (modulo `model` string).

### Phase 5: Integrate and stop

- Plug the chunker into the existing `handleInference` path in
  `src/manager/server.js`. The existing raw-pipe path stays for
  small inputs.
- Re-test with the chat app directly.
- If embeddings start showing up correctly: stop. Do not iterate.
- If they don't: the bug is in the LLM Gateway or the chat app, not
  here.

## Test artifacts

- `scripts/baseline-test.mjs` — Phase 1 harness.
- `logs/baseline-<timestamp>.jsonl` — per-request records:
  - timestamp
  - target (cloud | local)
  - payload id (index into the captured chat history)
  - request body size in bytes
  - response status
  - response latency in ms
  - response body (truncated to 1KB for log size)
  - any error message

- `docs/baseline-results.md` — written summary after Phase 1, before
  any code change.

## Review questions for the user

Before starting Phase 1, confirm:

1. Is there an OpenRouter (or equivalent) account with API key already
   configured? If so, do you want me to use the same
   `Qwen/Qwen3-Embedding-4B` model or a different one?
2. How should the chat history be captured — a single dump from
   the chat app's database, or a script that pulls from the running
   gateway's recent traffic?
3. Do you want the test harness to be committed to the repo
   (`scripts/baseline-test.mjs`) or kept out of tree?
4. Is there a target latency budget (e.g., "any single embedding
   should complete in under 2s")? Or is correctness the only
   criterion?

## What this plan explicitly avoids

- Building speculative infrastructure (collectors, flush timers,
  circuit-breakers, retry-with-halve, sub-budget math) before there is
  evidence the simpler approach fails.
- Tuning hardware-specific settings (`--batch-size`, `--parallel`)
  without first confirming the local code is doing the right thing
  on the current settings.
- Re-running the same test loop that produced the reverted
  complexity. The test surface is real payloads against a real cloud
  endpoint, not synthetic text.
