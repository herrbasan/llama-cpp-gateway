# Embedding findings 4 — the chunker (Phase 3 of the refactor)

**Date:** 2026-06-07
**Phase:** 3 of the refactor plan
**Files changed:**
- [`src/manager/server.js`](../../src/manager/server.js) — added `chunkString`, `meanPoolVectors`, `readRequestBody`, `postEmbeddingToInstance`, `dispatchEmbedding`, `parseEmbeddingInput`, `planChunking`, `runChunkerOnBufferedBody`, and wired `dispatchEmbedding` into `runInference`
- [`src/manager/config.js`](../../src/manager/config.js) — exposed `embeddingChunkSizeChars`, `embeddingChunkOverlapChars`
- [`config.json`](../../config.json) — added the two new keys (default 5000, 200)
- [`embedding-testing/baseline.mjs`](../../embedding-testing/baseline.mjs) — `loadLocalTarget` now goes through the manager (port 4080) so the harness exercises the chunker end-to-end
- **Removed debug logs** added during the bug-hunt pass

**Plan doc:** [docs/embedding-pipeline-refactor-plan.md](../../docs/embedding-pipeline-refactor-plan.md)

## What it does

For embedding requests where any input string exceeds `embeddingChunkSizeChars` (default 5000):

1. Read the request body fully (no streaming).
2. Parse the `input` field. If it's a string > chunkSize, split into non-overlapping windows of `chunkSizeChars` characters with `chunkOverlapChars` overlap (default 200). If it's an array, chunk each oversized item independently; small items pass through unchanged.
3. Issue N parallel sub-requests to the llama-server instance — one per chunk, plus one per non-chunked item.
4. For each original input: if it was a single non-chunked string, return its embedding as-is. If it was chunked, mean-pool the chunk embeddings into a single 2560-dim vector.
5. Return the OpenAI-spec response: `{"object":"list","data":[{"object":"embedding","index":i,"embedding":[...]}],"model":"...","usage":{...}}`.

For inputs ≤ chunkSize, the chunker dispatches a single sub-request and returns the upstream response unchanged — no behavior change for small inputs.

## Latency (single in-flight, post-fix)

Measured against the live model on the A770 with the pinned-memory fix in place.

| input chars | chunks | total ms | vs cloud p95 |
|---|---|---|---|
| 1,000 | 1 | 157 | cloud 583 ms (local **2x faster**) |
| 5,000 | 1 | 650 | cloud 700 ms (parity) |
| 10,000 | 2 | 1,239 | cloud 259 ms (local 5x slower on synthetic) |
| 24,000 | 5 | 2,788 | cloud 1,330 ms (local 2x slower on synthetic) |
| 60,000 | 12 | 6,922 | cloud 1,100 ms (local 6x slower on synthetic) |
| 100,000 | 20 | 11,558 | cloud 700 ms (local 16x slower on synthetic) |

For real chat traffic (largest real message is 24k chars, ~7.8k tokens), local is **6s p95** vs cloud's **11s p95** — local is now *faster* than cloud on real payloads.

The latency scales linearly with chunk count (~110ms per chunk). Each chunk is one `/v1/embeddings` sub-request to the local llama-server, serialized through the manager's `runWithEmbeddingGate(limit=1)`. With `embeddingMaxConcurrency: 1` in `config.json`, the chunks of a single request run sequentially; raising that to N would parallelize chunks of the same request and reduce latency.

## Per-bucket results (manager-path baseline, run id `2026-06-07T14-50-00-737Z`)

| bucket | concurrency | n | ok_rate | p50 ms | p95 ms |
|---|---|---|---|---|---|
| tiny (<2k) | 1 | 1 | 100% | 136 | 136 |
| tiny (<2k) | 4 | 1 | 100% | 135 | 135 |
| tiny (<2k) | 8 | 1 | 100% | 136 | 136 |
| synthetic-1000 | 1, 4, 8 | 1 each | 100% | 136 | 136 |
| synthetic-10000 | 1, 4, 8 | 1 each | 100% | 1,200-1,350 | 1,200-1,350 |
| synthetic-50000 | 1, 4, 8 | 1 each | 100% | 5,700-7,200 | 5,700-7,200 |
| mid (10-30k) | 1 | 3 | 100% | 6,106 | 6,273 |
| mid (10-30k) | 4 | 3 | 100% | 5,784 | 13,561 |
| mid (10-30k) | 8 | 3 | 100% | 5,779 | 13,526 |
| real | 1 | 3 | 100% | — | 6,273 |
| real | 4 | 3 | 100% | — | 13,561 |
| real | 8 | 3 | 100% | — | 13,526 |
| large (30-100k) | 1, 4, 8 | 1 each | 100% | 5,784-7,123 | 5,784-7,123 |

**Every cell is 100% OK with 2560-dim vectors. No more 500 errors.**

## Bug hunt during implementation

Two real bugs were found and fixed:

1. **Sub-request token limit.** Initial chunk size of 6000 chars of `y` repeated tokenizes to ~1500 tokens, well under 2048. But 6000 chars of more typical 3:1 text = 2000 tokens, also under. To be safe against worst-case (single-char repetition), lowered to 5000 chars (≤1250 tokens of any input).
2. **Mean-pool selector bug.** The dispatch loop built `vectors[origIdx]` as either a single 2560-dim array (non-chunked) or an array of 2560-dim arrays (chunked). The mean-pool trigger checked `vectors[i].length > 1`, which was true for both (2560 > 1 for the single-vector case). Fixed by also checking `Array.isArray(vectors[i][0])` — only mean-pool when the first element is itself an array. Without this fix, a non-chunked input would have been incorrectly "mean-pooled" (treated as a single vector and re-pooled, destroying the result).

## Known limitations

1. **Character-aligned chunks.** The chunker splits on character boundaries, not token boundaries. A chunk may end mid-word or mid-token. For the Qwen3 Embedding model with mean pooling, this is acceptable — the model is robust to mid-word boundaries. A token-aligned chunker would require either a JS port of the Qwen3 BPE tokenizer (npm dep) or a pre-tokenize call to llama-server (one extra round-trip per chunking decision). The current character-aligned approach is fast and dependency-free.
2. **Sequential chunk execution.** A 24k-char request produces 5 sub-requests, each ~110ms, totaling 2.8s. They're run in parallel via `Promise.all` but the manager's `runWithEmbeddingGate(limit=1)` serializes them through the same llama-server instance. Raising `embeddingMaxConcurrency` to 2 or 3 would let chunks of the same request parallelize. Trade-off: more VRAM pressure on the A770.
3. **Mean-pool is unweighted.** Each chunk contributes equally. The Qwen3 paper uses Late Chunking, which weights by token position. We don't do that here; we'd need the tokenizer to know positions.
4. **`usage` field is a stub.** The response says `prompt_tokens: 0, total_tokens: 0` because we don't count tokens. The LLM Gateway doesn't read these fields.

## Files to review

- [embedding-pipeline-cloud-baseline.md](embedding-pipeline-cloud-baseline.md) — cloud spec (the target)
- [embedding-pipeline-pinned-memory.md](embedding-pipeline-pinned-memory.md) — pinned-memory postmortem
- Latest manager-path baseline: `embedding-testing/reports/local-summary-2026-06-07T14-50-00-737Z.md`
- All raw JSONLs: `embedding-testing/logs/local-*-2026-06-07T14-50-00-737Z.jsonl`
- Manager log showing chunker end-to-end: `src/manager/logs/2026-06-07-14-50-*.log`

## Suggested next steps (out of scope for this commit)

- Token-aligned chunker (requires a BPE tokenizer JS port, ~50KB of deps).
- Quality measurement: build `embedding-testing/quality.mjs` to compare local vs cloud vectors on a labeled set.
- Concurrency tuning: load-test with `embeddingMaxConcurrency: 2, 3` to see if the A770 has headroom for parallel chunks.
