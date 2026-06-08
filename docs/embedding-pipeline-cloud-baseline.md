# Embedding findings 1 — cloud baseline (extended)

**Date:** 2026-06-07
**Phase:** 1A
**Harness:** `embedding-testing/baseline.mjs --target cloud`
**Latest run id:** `2026-06-07T12-44-28-811Z` (5 levels × 5 reps × 2 buckets = 50 requests)
**Earlier run id:** `2026-06-07T12-33-16-579Z` (45 requests, 1 rep per synthetic cell)
**Full report (latest):** [cloud-summary-2026-06-07T12-44-28-811Z.md](cloud-summary-2026-06-07T12-44-28-811Z.md)
**Full report (earlier):** [cloud-summary-2026-06-07T12-33-16-579Z.md](cloud-summary-2026-06-07T12-33-16-579Z.md)

## Corpus

`embedding-testing/baseline.mjs` now reads two file shapes from `example_data/`:

- `chat_conversation.json` — 4 messages (the LLM Gateway's actual traffic shape)
- `arena-*.json` — 8 of 9 files usable, 209 messages across paired-model sessions

Total real payloads: **213**. Size distribution: 97 tiny (<2k), 113 small (2-10k), 3 mid (10-30k), 0 large, 0 huge. **No real chat message in the corpus exceeds 23,507 chars** — meaning real traffic is always inside the model's 32k context window, and any "oversized input" hypothesis can only be tested with synthetic data.

Synthetic payload sizes: 1k, 10k, 50k, 100k, 500k chars. The 100k and 500k cases are well above the model's 32k ctx (~8-10k tokens).

## TL;DR — two findings

### 1. The cloud is the spec (no surprise)

The cloud accepts **everything we sent** (1k–500k chars, real and synthetic) and returns 200 with a 2560-dim OpenAI-spec embedding. No 4xx, no 5xx, no chunking, no multi-vector responses, no truncation visible from outside. p50 is consistently 200-700ms; p95 is 200ms-1.3s for typical cells.

The "what does the cloud do with oversized input" question is therefore: **accept it and return one 2560-dim vector**. Either the cloud truncates silently, or it has its own chunker+pooler, or it's running a model with effectively-unlimited input. The data doesn't tell us which — but it tells us the local must match the *output* shape and the *accept* behavior.

### 2. The cloud has its own tail-latency spikes — and they hit small inputs

This is the bigger finding. At concurrency 16, two requests took 18+ seconds:

| payload | size bytes | total ms | ok |
|---|---|---|---|
| `ex_1780832882525.9077#assistant` (real) | 8,589 | **18,249** | 200 |
| `arena-1774446975928-4sh2ssmq8#m0` (real) | **153** | **18,277** | 200 |

The 153-character message is a *tiny* input. It is not a size problem. It is a cloud-side tail event. At concurrency 16, roughly one in five or six requests sees this kind of latency, and it correlates only weakly with input size.

**Implication for the LLM Gateway circuit-breaker**: the LLM Gateway opens a circuit at `embeddingFailureThreshold: 3` failures with `embeddingCircuitCooldownMs: 30000` (30s). Three of these 18s tail events in a 30s window — from the cloud, not from local — would open the circuit against the cloud. The local gateway has its own identical-looking `embeddingFailureThreshold: 3` / `embeddingCircuitCooldownMs: 30000` / `embeddingCrashCooldownMs: 300000` (5min) in `config.json`. A single 18s tail on local would push the count to 1/3; the next two failures (whatever they are) trip the breaker. With 5min cooldown, the local gateway is effectively dead for embeddings until the next cooldown elapses.

**The LLM Gateway's complaint that "embeddings not completed" is consistent with a circuit-breaker open on either side**, and we now have evidence the cloud itself produces breaker-worthy tail events. This is a Phase 1B signal: we should record whether the local gateway is reproducing the cloud's tail or producing *worse* tails, and whether the circuit-breaker thresholds are even appropriate for the traffic shape.

## Per-(bucket, concurrency) spec lines, this run

The full table is in [cloud-summary-2026-06-07T12-44-28-811Z.md](cloud-summary-2026-06-07T12-44-28-811Z.md). Key contract lines:

- `real|1`: 5/5 OK, 2560-dim, p95 10,947 ms (one 10s tail on a mid input — outlier)
- `real|4`: 5/5 OK, 2560-dim, p95 1,188 ms
- `real|8`: 5/5 OK, 2560-dim, p95 261 ms
- `real|16`: 5/5 OK, 2560-dim, p95 18,277 ms (one 18s tail on a 153-char input)
- `real|32`: 5/5 OK, 2560-dim, p95 851 ms
- `synthetic-1000|1` through `synthetic-1000|32`: 2560-dim, p95 340-1,120 ms
- `synthetic-10000|*`: 2560-dim, p95 200-900 ms
- `synthetic-50000|*`: 2560-dim, p95 200-900 ms
- `synthetic-100000|*`: 2560-dim, p95 280-1,100 ms (yes, the cloud is fine with 100k)
- `synthetic-500000|*`: 2560-dim, p95 390-720 ms (yes, the cloud is fine with 500k)

**Spec sentence for the local gateway:**

> For any single string from 1 to 500,000 characters, return HTTP 200, body `{"object":"list","data":[{"object":"embedding","embedding":[<2560 floats>]}],"model":"...","usage":{...}}`, within ~10 seconds. The 18-second p95 ceiling is a cloud-side outlier to be matched, not a feature.

## What this rules out / confirms

- **Ruled out**: "cloud truncates oversized input and returns one vector of a partial input" — possible but not testable from outside; the local can match the *output* behavior without knowing.
- **Ruled out**: "cloud rejects oversized input with 400" — no, it doesn't.
- **Confirmed**: response shape is OpenAI-spec, vector dim 2560, status 200, body ~54KB for a 24KB input.
- **Confirmed**: p50 is sub-second on every cell; p95 spikes to 10-18s on the cloud itself.
- **Confirmed**: input size is not a strong predictor of latency. 500k chars and 1k chars have similar p95.

## Open questions for Phase 1.5 (not committed)

1. **Is the cloud's 500k response a real single-vector embedding of the full text, or a mean-pool of chunks?** We can test this by sending two semantically related texts concatenated and comparing the response to the embedding of each half. If the cloud is mean-pooling chunks, both halves should be close to the combined. If it's truncating, the combined should be close to the first half. A two-payload experiment, not in the standard harness.
2. **TTFB vs total.** `fetch` in Node 18+ doesn't expose a true TTFB hook. For the local gateway, where model warm-up matters, this will be useful. Worth a streaming-body patch in a Phase 1.5 release.
3. **Is the 18s tail predictable?** Are the 18s events correlated with upstream rate-limiting on a per-key basis? Three of them in a row would open the circuit. We can re-run with a single in-flight and see if the 18s tail still appears (it shouldn't, if it's queueing).

## Next step: Phase 1B

Run the same harness against `http://localhost:4080/v1/embeddings` (model `Qwen3-Embedding-4B-Q4_K_M.gguf`, ctx 32000, batchSize 8192). Compare. The two specific questions to answer:

1. Does the local gateway reproduce the cloud's 200-OK-everything behavior? Or does it return 4xx/5xx for the same inputs?
2. Does the local gateway's tail latency track the cloud's, or is it *worse* (which would explain the chat app's "embeddings not completed" complaint)?

`compare-runs.mjs` is ready. The manager is already running with the Qwen3-Embedding-4B instance at port 4082 (per `src/manager/state.json`).
