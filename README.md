# LLaMA.cpp Gateway Build Project

This project provides reproducible build configurations for llama.cpp with CUDA and SYCL support.

## Structure

`
llama-cpp-gateway/
├── llama.cpp/          # Git submodule (upstream, untouched)
├── build-scripts/      # Build configuration scripts
├── out/               # Build artifacts (gitignored)
└── README.md          # This file
`

## Quick Start

### Prerequisites

1. **NVIDIA CUDA Toolkit 13.2+**
   - https://developer.nvidia.com/cuda-downloads

2. **Intel oneAPI Base Toolkit** (for SYCL builds)
   - https://www.intel.com/content/www/us/en/developer/tools/oneapi/base-toolkit.html

3. **Visual Studio 2022** with C++ workload

### Build

`powershell
# CUDA-only build
.\build-scripts\build-cuda.ps1

# Universal build (CUDA + SYCL)
.\build-scripts\build-universal.ps1
`

Binaries will be in out/cuda/bin/Release/ or out/universal/bin/Release/.

## Updating llama.cpp

`ash
# Update to latest upstream
cd llama.cpp
git pull origin master
cd ..
git add llama.cpp
git commit -m "Update llama.cpp to latest"
`

## Clean Builds

`powershell
# Remove all build artifacts
Remove-Item -Recurse out\*

# Rebuild from scratch
.\build-scripts\build-cuda.ps1
`

---

*This is a build configuration wrapper around llama.cpp.*
