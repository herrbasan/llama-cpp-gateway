# Build Scripts

PowerShell scripts for building llama.cpp with different configurations.

## Scripts

| Script | Purpose | Output |
|--------|---------|--------|
| `build-cuda.ps1` | NVIDIA CUDA only | out/cuda/ |
| `build-universal.ps1` | CUDA + Intel SYCL | out/universal/ |
| `download-prerequisites.ps1` | Open download pages for toolkits | - |

## Usage

### Download Prerequisites

```powershell
# Open browser to download pages for CUDA and Intel oneAPI
.\build-scripts\download-prerequisites.ps1
```

### Build

```powershell
# CUDA-only build (requires CUDA Toolkit)
.\build-scripts\build-cuda.ps1

# Universal build (requires CUDA + Intel oneAPI)
.\build-scripts\build-universal.ps1
```

## Requirements

See main README.md for full prerequisites.

## Installer Storage

Downloaded installers should be placed in `installers/` (gitignored).
