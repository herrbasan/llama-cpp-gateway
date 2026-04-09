# Build Scripts

PowerShell scripts for building llama.cpp with different configurations.

## Scripts

| Script | Purpose | Output |
|--------|---------|--------|
| uild-cuda.ps1 | NVIDIA CUDA only | out/cuda/ |
| uild-universal.ps1 | CUDA + Intel SYCL | out/universal/ |

## Usage

Run from project root:

`powershell
.\build-scripts\build-cuda.ps1
`

## Requirements

See main README.md for full prerequisites.
