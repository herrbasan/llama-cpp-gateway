# Build-Machine Handover (Pinned Llama.cpp)

This file is for building on a second machine that has the required toolchain installed.

## Goal

Build `dist/universal` binaries from the pinned `llama.cpp` revision and bring them back to this repo.

Pinned revision:
- `llama.cpp` tag: `b9119`
- `llama.cpp` commit: `ef93e98d0`
- Superproject commit containing this handover: `2ec92e8`

## 1. Prepare Build Machine

Required on the build machine:
- Visual Studio 2022 Build Tools with C++ workload
- CMake and Ninja
- CUDA Toolkit (for `GGML_CUDA=ON`)
- Vulkan SDK (set `VULKAN_SDK`)
- Git LFS enabled

Clone and sync:

```powershell
git clone https://github.com/herrbasan/llama-cpp-gateway.git
cd llama-cpp-gateway
git checkout master
git pull --ff-only
git submodule update --init --recursive
git lfs pull
```

Verify pin before building:

```powershell
git -C llama.cpp rev-parse --short HEAD
git -C llama.cpp describe --tags --always
```

Expected:
- `ef93e98d0`
- `b9119`

## 2. Build Universal Binaries

Run from repository root:

```powershell
.\build\build-universal.ps1
```

Expected output artifacts in:
- `dist/universal`

Minimum critical files to copy back if you do not move the full folder:
- `dist/universal/llama-server.exe`
- `dist/universal/llama.dll`
- `dist/universal/ggml.dll`
- `dist/universal/ggml-cpu.dll`
- `dist/universal/ggml-cuda.dll`
- `dist/universal/ggml-vulkan.dll`
- `dist/universal/mtmd.dll`

## 3. Return Artifacts

Choose one method:

Method A (preferred): commit built `dist/universal` updates on build machine and push.

Method B: manually copy built files back to this machine into `dist/universal`.

## 4. Validate On Runtime Machine

Restart gateway:

```powershell
node src/manager/server.js
```

Verify in logs:
- server starts cleanly
- no immediate `ECONNRESET`
- no `llama-server exited ... code=3221225477` during embedding traffic

## 5. Current Gateway Safeguards Already In Repo

These are already committed in `2ec92e8`:
- embedding circuit breaker and crash backoff
- embedding size guard (`embeddingMaxRequestBytes`)
- embedding context clamp (`embeddingMaxCtxSize`)
- explicit `--flash-attn off` handling for embedding defaults

Primary config file to tune after build:
- `config.json`