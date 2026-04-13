# Troubleshooting: `ECONNRESET` and `code=3221226505` Crashes

## Symptoms
When running the manager under load, you may observe the following sequence of errors in the proxy logs (e.g., inside `src/manager/logs/`):
1. `read ECONNRESET`
2. `connect ECONNREFUSED`
3. `llama-server exited ... code=3221226505`

The proxy may also generate excessive noise, attempting to handle the upstream failure multiple times for a single request. 

## Root Cause
The `code=3221226505` (0xC0000005 in hex) translates to a standard Windows Access Violation. This indicates an out-of-bounds memory pointer or memory corruption within the upstream `llama-server` process. 

This is most commonly triggered by experimental features in the inference engine, specifically:
- Aggressive KV caching across parallel slots (concurrent generation streams).
- Unified K/V caching buffers fragmenting.
- Context check-pointing attempting to save token/KV states to disk concurrently.

The excessive logging noise is a secondary symptom: when the engine crashes and drops the socket, the Gateway proxy event pipelines (`error`, `close`, `aborted`) all trigger almost simultaneously, causing redundant `502 Bad Gateway` drafts to the same Express/HTTP request.

## The Fix

To resolve this issue and stabilize the gateway, we implemented a two-part fix:

### 1. Conservative Engine Defaults
We patched `src/manager/process.js` and `src/manager/config.js` to default to a conservative, stable execution profile:
- `--parallel 1`: Enforces sequential queuing, dodging race conditions in multi-token-state batching.
- `--no-kv-unified`: Disables unified K/V caching buffers.
- `--ctx-checkpoints 0` & `--checkpoint-every-n-tokens -1`: Explicitly disables experimental context check-pointing.

These defaults ensure that `llama-server` is highly stable out-of-the-box. 

### 2. Hardened Proxy Error Handling
We hardened the `proxyToInstance` method in `src/manager/server.js`.
By binding a local `completed` state flag to the request lifecycle closure, the Gateway now strictly guarantees that the proxy socket is destroyed cleanly and client responses (like `502 Bad Gateway`) are completed exactly **once**. This squashes the cascading log noise completely.

## Overriding the Defaults
If you are running a custom or updated build of `llama-server` where these experimental features are secure, you can re-enable them. 

Adjust these parameters in your `config.json` file:
```json
{
  "defaultParallelSlots": 4,
  "defaultKvUnified": true,
  "defaultCtxCheckpoints": 1,
  "defaultCheckpointEveryTokens": 100
}
```
*Note: If `code=3221226505` crashes return, revert to `defaultParallelSlots: 1` and `defaultKvUnified: false`.*
