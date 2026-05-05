# X-Model-Path Header Causing Per-Request Model Reload (~300ms Overhead)

## Summary

Every embedding request sent with the `X-Model-Path` header triggers a ~300ms model reload/verification cycle, even when the requested model is already loaded and active. This caps throughput at ~4.3 RPS regardless of concurrency.

## Reproduction

```bash
# With X-Model-Path — 300ms+ per request
curl -X POST http://192.168.0.145:4080/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "X-Model-Path: E:\LM Studio Models\Qwen\Qwen3-Embedding-8B-GGUF\Qwen3-Embedding-8B-Q4_K_M.gguf" \
  -d '{"input":["Hello world"],"model":"x","dimensions":4096}'

# Without X-Model-Path — 1ms per request (but currently returns 400)
curl -X POST http://192.168.0.145:4080/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":["Hello world"],"model":"x","dimensions":4096}'
```

## Measured Impact

| Header Sent       | Avg Latency | Notes                          |
|-------------------|-------------|--------------------------------|
| `X-Model-Path`    | ~305ms      | Model reload on every request  |
| No `X-Model-Path` | ~1ms        | Returns 400 (header required)  |

All other `X-Model-*` headers (`X-Model-CtxSize`, `X-Model-GpuLayers`, `X-Model-Embedding`, `X-Model-Pooling`, `X-Model-BatchSize`, `X-Model-Mlock`) add **zero** overhead (~1ms).

## Concurrent Throughput (64 requests, via LLM Gateway)

| Concurrency | Wall Time | Avg Latency | Throughput |
|-------------|-----------|-------------|------------|
| 4           | 15.0s     | 913ms       | 4.3 RPS    |
| 16          | 15.0s     | 3,304ms     | 4.3 RPS    |
| 64          | 15.0s     | 7,625ms     | 4.3 RPS    |
| 128         | 15.0s     | 7,632ms     | 4.3 RPS    |

Throughput is flat — the server serializes all requests. Higher concurrency only increases queue wait time.

## Expected Behavior

When `X-Model-Path` matches the currently loaded model, the server should skip reload and serve the request immediately. The model path should only trigger a load when the model differs from what's active.

## Suggested Fix

In the `X-Model-Path` handler, compare the incoming path against the currently loaded model before initiating any load sequence:

```pseudo
if (incoming_model_path == currently_loaded_model_path) {
    skip reload, serve request
}
```

This should reduce per-request latency from ~305ms to ~1ms when the model is already active.

## Context

- Gateway: LLM Gateway on `localhost:3400`
- Upstream: llama-server on `192.168.0.145:4080`
- Model: `Qwen3-Embedding-8B-Q4_K_M.gguf`
- Adapter: `llamacpp` (gateway sends `X-Model-Path` + other `X-Model-*` headers per request)
- The header is mandatory — server returns 400 without it
