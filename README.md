# LLaMA.cpp Gateway Build Project

This project provides reproducible build configurations for llama.cpp with CUDA and Vulkan support (pivoted from SYCL for better Intel Arc compatibility).

## Structure

```text
llama-cpp-gateway/
├── llama.cpp/          # Git submodule (upstream, untouched)
├── build-scripts/      # Build configuration scripts
├── out/                # Build artifacts (gitignored)
└── README.md           # This file
```

## Quick Start

### Prerequisites

1. **NVIDIA CUDA Toolkit 13.2+**
   - https://developer.nvidia.com/cuda-downloads

2. **Vulkan SDK** (Required for Vulkan & Universal builds, replacing Intel oneAPI)
   - https://vulkan.lunarg.com/sdk/home

3. **Visual Studio 2022** with C++ workload

4. **Intel Arc Graphics Drivers** (Required for Intel GPU support)
   - https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html

> **Note:** Always remember to restart your terminal/PowerShell after installing any of these toolkits so that the new `PATH` environment variables take effect.

### Build

```powershell
# CUDA-only build
.\build-scripts\build-cuda.ps1

# Universal build (CUDA + Vulkan)
.\build-scripts\build-universal.ps1
```

Binaries will be in out/cuda/bin/Release/ or out/universal/bin/Release/.

## Updating llama.cpp

```bash
# Update to latest upstream
cd llama.cpp
git pull origin master
cd ..
git add llama.cpp
git commit -m "Update llama.cpp to latest"
```

## Clean Builds

```powershell
# Remove all build artifacts
Remove-Item -Recurse out\*

# Rebuild from scratch
.\build-scripts\build-cuda.ps1
```

## Intel Arc / Universal Build Notes

We recently pivoted from SYCL backends to **Vulkan** for Intel Arc support. Vulkan offers dramatically better generation performance (52+ t/s vs 24 t/s on A770) for k-quants without the Intel `icx.exe` compiler dependency hell (e.g., `sycl8.dll`).

For full findings, benchmarks, and details on why we dropped SYCL, see [intel_arc_testing_notes.md](intel_arc_testing_notes.md).

---

*This is a build configuration wrapper around llama.cpp.*
