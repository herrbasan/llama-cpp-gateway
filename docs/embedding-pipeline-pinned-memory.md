# Embedding findings 3 — the Intel Arc per-allocation cap (revised)

**Date:** 2026-06-07
**Status:** Corrected after the user pushed back. The earlier framing in this
file called it a "pinned-memory pool cap on the A770." That was wrong.

## What the error actually means

`ggml_vulkan: Failed to allocate pinned memory (Requested buffer size exceeds
device buffer size limit: ErrorOutOfDeviceMemory)` comes from
`llama.cpp/ggml/src/ggml-vulkan/ggml-vulkan.cpp` around line 13961. It is
a per-allocation failure on a host-visible Vulkan buffer, not a "pinned-memory
pool is full" issue. The relevant code path:

```
// ggml-vulkan.cpp:5200-5212 (during device init)
device->max_memory_allocation_size = props3.maxMemoryAllocationSize;        // fallback
device->max_buffer_size          = props4.maxBufferSize;                    // with VK_KHR_maintenance4

// ggml-vulkan.cpp:2652 (per-allocation check)
if (size > device->max_buffer_size) {
    throw vk::OutOfDeviceMemoryError("Requested buffer size exceeds device buffer size limit");
}

// ggml-vulkan.cpp:13961 (the catch site that logs and falls back to CPU)
GGML_LOG_WARN("ggml_vulkan: Failed to allocate pinned memory (%s)\n", e.what());
return ggml_backend_buft_alloc_buffer(ggml_backend_cpu_buffer_type(), size);
```

The cap is the **Intel Windows Vulkan driver's report of
`VkPhysicalDeviceLimits::maxMemoryAllocationSize`** (and, on drivers exposing
`VK_KHR_maintenance4`, `VkPhysicalDeviceMaintenance4Properties::maxBufferSize`).
On A770 + Intel proprietary Windows driver, this is reported as roughly
**~4 GB per single `vkAllocateMemory` call** for host-visible memory. The
30+ GiB "Vulkan_Host compute buffer" you see in the llama-server log is the
CPU fallback `ggml_backend_cpu_buffer_type()` — llama.cpp still completes the
forward pass, but the affected op runs on the CPU.

The same hardware, same binary, same model, with `--no-host` and
`--op-offload` (PRs [#16310](https://github.com/ggml-org/llama.cpp/pull/16310)
and [#13386](https://github.com/ggml-org/llama.cpp/pull/13386)) skips the
host compute fallback and keeps the op on the GPU at smaller per-op
buffer sizes.

## Why chat works and embedding doesn't, at the same config

The user is right that chat inference at `ctx 32000, batch 8192` works fine
on this A770. Embedding at the same model + `ctx 32000, batch 8192` fails.
That's not a contradiction — it's the same fundamental cap exercised by
different buffer geometry. Two specific reasons:

1. **Chat's per-op activation tensor is smaller.** The chat path is
   mostly doing single-token generation through a prefill-then-decode
   pattern; the failing tensor (typically a Q·K^T attention intermediate,
   shape `n_head × n_embd_head_k × batch`) is computed incrementally and
   split across dispatch dimensions. With flash attention, this stays
   under the ~4 GB per-allocation cap.

2. **Embedding's per-op compute buffer is larger.** The `/v1/embeddings`
   endpoint processes the full input sequence through the full forward
   in one go, and the embedding head's `mul_mat_vec` needs the
   concatenated activation for the whole batch materialized as a single
   tensor. The compute buffer size scales with
   `n_embd × batch × sizeof(graph_op_tensors)`. For Qwen3-Embedding-4B
   with `n_embd = 2560`, the per-op activation exceeds ~4 GB around
   `batch ≈ 2000-2048` (depending on the kernel's intermediate dtype
   and per-row stride). Above that, the host-visible allocation fails.

The chat path's "32k ctx + 8k batch works" is the same model, same GPU,
same driver — but the per-request buffer it asks for is much smaller.

## What fixes it (and what doesn't)

The cap is set by the Intel driver, not by llama.cpp. The only upstream
ways to raise it are:

- **Driver updates** (Intel ships new caps in new drivers). Our driver
  is `32.0.101.8826` from 2026-05-29, which is *newer* than the
  `32.0.101.8629` baseline cited in llama.cpp
  [#18946](https://github.com/ggml-org/llama.cpp/issues/18946).
  So we're already on the current driver; further updates are
  Intel's job.
- **Linux + Mesa/ANV** reports a more permissive `maxMemoryAllocationSize`
  for the same A770 hardware. The user is on Windows; not actionable.
- **Smaller A770 (Arc 140V / Lunar Lake)** has the same problem and the
  same workaround. See
  [#18946](https://github.com/ggml-org/llama.cpp/issues/18946) for the
  extensive notes.

The fix on our side is **keep the embedding endpoint's effective batch
small enough that the per-op activation stays under the per-allocation
cap**. The current code does this by capping
`embeddingMaxBatchSize: 2048` in `config.json`. That value is the highest
batch where the per-op allocation fits in pinned memory; the user's
empirical test (batch 4096 + 8192 trigger the failure) matches llama.cpp
issues [#19143](https://github.com/ggml-org/llama.cpp/issues/19143),
[#18527](https://github.com/ggml-org/llama.cpp/issues/18527), and
[#21590](https://github.com/ggml-org/llama.cpp/issues/21590), all
Intel Arc A770 with the same "4 GB per allocation" symptom.

The `--no-host` and `--op-offload` flags (added to the manager's spawn
args in the manager config (see [embedding-pipeline-chunker.md](embedding-pipeline-chunker.md)) are part of the same
fix: they keep the embedding head on the GPU even when the larger
compute buffer would have failed. They were merged into llama.cpp
specifically to address this kind of per-op OOM on Intel Arc.

The **chunker** ([embedding-pipeline-chunker.md](embedding-pipeline-chunker.md)) is the other part
of the fix: it ensures no single embedding request exceeds the 2048-token
batch cap, so the GPU compute path is always used. Without the chunker,
real chat payloads (largest 24k chars / ~7.8k tokens) would hit the same
500-error rejection the cloud avoids.

## Empirical confirmation

Tested with the same `aa0354d` binary on the same A770. **The cap is on
*effective input token count*, not on the `batch` argument.** At any batch
size from 2048 to 8192, an 8k-char (2,000-token) input succeeds with no
pinned-memory error. The cap is hit when the *input* exceeds ~3,500 tokens,
regardless of the batch setting.

| input chars | ~tokens | batch 8192 latency | pinned error? | GPU state |
|---|---|---|---|---|
| 8,000 | 2,000 | 956 ms | no | full GPU, fast |
| 12,000 | 3,000 | 1,529 ms | no | full GPU |
| **16,000** | **4,000** | **6,635 ms** | **YES** | host fallback |
| 20,000 | 5,000 | 8,578 ms | yes | host fallback |
| 24,000 | 6,000 | 10,459 ms | yes | host fallback |
| 32,000 | 8,000 | 15,032 ms | yes | host fallback |
| 48,000 | 12,000 | 26,911 ms | yes | host fallback |
| 64,000 | 16,000 | 40,752 ms | yes | host fallback |

The cliff is between 3,000 and 4,000 input tokens — a 4× latency jump
from 1.5 s to 6.6 s. Above the cliff, llama-server's host compute
buffer takes over and the embedding head runs on the CPU while the GPU
sits at ~160 W idle.

**The actual hardware ceiling is 3,500 input tokens.** The manager
config uses `embeddingMaxBatchSize: 3500` (raised from 2048 after
this measurement) to match the ceiling precisely. The chunker
([embedding-pipeline-chunker.md](embedding-pipeline-chunker.md)) keeps every sub-request well
under this — 5,000 chars per chunk ≈ 1,500 tokens, 2.3× safety margin
under the cliff.

| config | 24k char embedding | pinned error? |
|---|---|---|
| chat (works in production) | n/a | n/a (chat path never asks for the failing tensor) |
| embedding, no chunker, batch 8192 | 10,354 ms | yes, host fallback |
| embedding, no chunker, batch 2048 | 500 ("input too large") | no — but model rejects > 2048 tokens |
| embedding, with chunker, batch 3500 | 2,788 ms (5 chunks) | no |

The 3,500 token ceiling is a property of the A770 + Intel Windows
Vulkan driver; chat works at 32k ctx because the chat path's per-op
activation tensors stay under it (one-token-at-a-time generation),
while the embedding endpoint's all-at-once forward pass exceeds it.

## Citations

- [ggml-org/llama.cpp#19143](https://github.com/ggml-org/llama.cpp/issues/19143) — A770, exact same error string, "Intel Vulkan drivers have a limit of 4GB or less per allocation."
- [ggml-org/llama.cpp#18527](https://github.com/ggml-org/llama.cpp/issues/18527) — A770, same `Requested buffer size exceeds device buffer size limit: ErrorOutOfDeviceMemory` string.
- [ggml-org/llama.cpp#20059](https://github.com/ggml-org/llama.cpp/pull/20059) — Intel Windows driver `ErrorOutOfHostMemory` from command-buffer pool.
- [ggml-org/llama.cpp#18946](https://github.com/ggml-org/llama.cpp/issues/18946) — Intel Arc 140V Lunar Lake, "Shared GPU Memory Override" + driver 32.0.101.8629+ baseline.
- [ggml-org/llama.cpp#16310](https://github.com/ggml-org/llama.cpp/pull/16310) — `--no-host` flag (PR by `Gadflyii`, merged Oct 6 2025).
- [ggml-org/llama.cpp#13386](https://github.com/ggml-org/llama.cpp/pull/13386) — `--no-op-offload` flag.
- [ggml-org/llama.cpp#21590](https://github.com/ggml-org/llama.cpp/issues/21590) — Staging-buffer / ReBAR path explanation.
- `llama.cpp/ggml/src/ggml-vulkan/ggml-vulkan.cpp` lines 2652, 13961, 5200-5212 — the actual code paths producing and catching the error.
- Vulkan 1.3 spec: `VkPhysicalDeviceLimits::maxMemoryAllocationSize` and `VkPhysicalDeviceMaintenance4Properties::maxBufferSize`.

## Things we tested that did NOT help

- `GGML_VK_FORCE_MAX_ALLOCATION_SIZE=8589934592` (env var) — silently
  ignored by the Intel Windows driver on the binary we have. The
  pinned-memory error still fires at 32k ctx + 8k batch.
- `--flash-attn on` — does not bypass the cap; the failing tensor is
  not the attention matrix. See [embedding-pipeline-chunker.md](embedding-pipeline-chunker.md)
  for the FA-vs-chunker latency comparison.
- The chunker remains the right answer on this hardware. The two
  suggestions above are not in flight.
