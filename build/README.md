# Build Scripts

PowerShell scripts for building llama.cpp with CUDA and Vulkan support.

## Scripts

| Script | Purpose | Output |
|--------|---------|--------|
| `build-universal.ps1` | CUDA + Vulkan | `dist/universal/` |

## Usage

```powershell
.\build\build-universal.ps1
```

The script updates the `llama.cpp` submodule, configures CMake with CUDA and Vulkan, builds with Ninja, and copies the full distribution to `dist/universal/`.

## Requirements

- **NVIDIA CUDA Toolkit 12.2+**
- **LunarG Vulkan SDK**
- **Visual Studio 2022** with C++ workload
