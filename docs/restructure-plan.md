# Project Restructuring Plan

## Current State Analysis

The project has grown through several pivots, resulting in a messy structure:

### What This Project Actually Is
1. **llama.cpp wrapper** — Builds llama.cpp from source (CUDA/Vulkan/SYCL)
2. **llama-manager** — Node.js HTTP API to start/stop/monitor llama-server processes
3. **Model Tuner CLI** — One-shot test script to find optimal llama-server launch params per model

### What This Project Is NOT
- A UI component library host (nui_wc2 belongs to LLM Gateway Chat, not here)
- A profile persistence system (profiles live in llm_gateway's config.json)

### Problems Identified

| Problem | Details |
|---------|---------|
| **nui_wc2 at root** | Separate project (own .git, .gitmodules, AGENTS.md). Used by LLM Gateway Chat, not this project. Should be removed. |
| **Tuner is overkill** | Web UI (NUI-based) for something that should be a CLI script. Tight coupling to nui_wc2. |
| **`tuner-ui.html` duplicate** | Both `llama-manager/tuner-ui.html` and `llama-manager/tuner/` exist. Both obsolete. |
| **`model-profiles.js`** | JS object that gets programmatically edited. Redundant — profiles belong in llm_gateway config. |
| **`model-profile-editor.js`** | Editor for the above. Obsolete with CLI approach. |
| **`dummy-models/`** | Test data in llama-manager with no clear purpose. |
| **`installers/` at root** | Large installer EXEs (CUDA, Vulkan, VS, Intel SDK) — dev setup artifacts, not source. Move to `_Archive/`. |
| **`_Archive/` at root** | Old notes and artifacts. Kept as designated archive folder. |
| **`dist/`** | Build output at root. `dist/` has the real binaries. |
| **`logs/` at root** | Runtime logs at project root. |
| **Build scripts reference everything** | `bundle-deployment.ps1` hardcodes paths to `llama-manager/`, `dist/`, `nLogger/`. |
| **No `.gitignore` discipline** | Build artifacts, logs, installers all tracked or sitting in repo. |

---

## Proposed Structure

```
llama-cpp-gateway/
├── src/
│   └── manager/                    # Node.js management layer (was llama-manager/)
│       ├── server.js               # HTTP API server
│       ├── process.js              # Process supervisor
│       ├── models.js               # Model discovery & GGUF parser
│       ├── config.js               # Configuration loader
│       ├── modules/                # Third-party dependencies
│       │   └── nLogger/            # git submodule (logging library)
│       ├── test/
│       │   ├── integration.js      # Was test.js
│       │   └── full-test.js        # Was full-test.js
│       └── package.json
│
├── scripts/
│   └── tune-model.js               # CLI: pick model → set params → test → output config
│
├── build/                          # Build system (was build-scripts/)
│   ├── build-cuda.ps1
│   ├── build-vulkan.ps1
│   ├── build-universal.ps1
│   ├── build-sycl.ps1
│   ├── bundle-deployment.ps1
│   └── README.md
│
├── dist/                           # Compiled binaries (output, gitignored)
│   └── universal/                  # (or cuda/, vulkan/)
│       ├── llama-server.exe
│       └── ggml-*.dll
│
├── llama.cpp/                      # Git submodule (upstream) — stays as-is
│
├── docs/
│   ├── spec.md                     # Existing
│   ├── dev_plan.md                 # Existing
│   ├── API.md
│   ├── ARCHITECTURE.md
│   ├── CONFIGURATION.md
│   ├── OPERATIONS.md
│   ├── QUICKSTART.md
│   ├── TROUBLESHOOTING.md
│   └── README.md
│
├── _Archive/                       # Designated archive for obsolete files (kept)
├── .gitignore                      # Updated
├── README.md
└── kilo.json                       # Project config

# REMOVED / RELOCATED:
# - installers/              → Move to _Archive/installers/ (dev setup artifacts)
# - logs/                    → Add to .gitignore, create at runtime
# - out/                     → Stays at root (build output + notes)
# - llama-manager/           → Moved to src/manager/
# - nui_wc2/                 → Move to _Archive/nui_wc2/ (belongs to LLM Gateway Chat)
# - build-scripts/           → Moved to build/
# - llama-manager/tuner/     → Move to _Archive/old-tuner-ui/ (replaced by CLI script)
# - llama-manager/tuner-ui.html → Move to _Archive/old-tuner-ui.html
# - llama-manager/dummy-models/ → Move to _Archive/dummy-models/
# - llama-manager/model-profiles.js → Move to _Archive/model-profiles.js
# - llama-manager/model-profile-editor.js → Move to _Archive/model-profile-editor.js
# - llama-manager/nLogger/   → Moved to src/manager/modules/nLogger/
```

---

## Implementation Steps

### Phase 1: Preparation
1. **Update `.gitignore`** to exclude:
   - `logs/`
   - `dist/`
   - `installers/`
   - `out/`
   - `*.exe` (except llama-server.exe in dist)
   - `node_modules/`

2. **Create new directory structure**:
   ```
   mkdir src
   mkdir src/manager/test
   mkdir src/manager/modules
   mkdir scripts
   mkdir build
   ```

### Phase 2: Move llama-manager → src/manager
3. **Move core files**:
   - `llama-manager/server.js` → `src/manager/server.js`
   - `llama-manager/process.js` → `src/manager/process.js`
   - `llama-manager/models.js` → `src/manager/models.js`
   - `llama-manager/config.js` → `src/manager/config.js`
   - `llama-manager/package.json` → `src/manager/package.json`

4. **Move nLogger**:
   - `llama-manager/nLogger/` → `src/manager/modules/nLogger/` (git submodule)
   - Update imports from `./nLogger/src/logger.js` to `./modules/nLogger/src/logger.js`

5. **Move tests**:
   - `llama-manager/test.js` → `src/manager/test/integration.js`
   - `llama-manager/full-test.js` → `src/manager/test/full-test.js`

6. **Archive obsolete** (move to `_Archive/` — never delete):
   - `llama-manager/tuner/` → `_Archive/old-tuner-ui/` (replaced by CLI script)
   - `llama-manager/tuner-ui.html` → `_Archive/old-tuner-ui.html`
   - `llama-manager/model-profiles.js` → `_Archive/model-profiles.js`
   - `llama-manager/model-profile-editor.js` → `_Archive/model-profile-editor.js`
   - `llama-manager/dummy-models/` → `_Archive/dummy-models/`

### Phase 3: Archive nui_wc2
7. **Move nui_wc2 to archive**:
   - nui_wc2 is a separate project used by LLM Gateway Chat
   - It has its own `.git` directory — move to `_Archive/nui_wc2/`
   - If `.gitmodules` references it, remove that entry too

### Phase 4: Create tune-model.js CLI
8. **Create `scripts/tune-model.js`**:
   - Interactive CLI: select model → set context/gpuLayers → start llama-server → run test prompt → report metrics
   - Outputs suggested `localInference` config block for llm_gateway's config.json
   - Uses only Node.js stdlib (no npm deps, no NUI)
   - Leverages existing `models.js` for GGUF discovery and metadata

### Phase 5: Move build scripts
9. **Move build scripts**:
   - `build-scripts/*.ps1` → `build/*.ps1`
   - `build-scripts/README.md` → `build/README.md`

10. **Update bundle-deployment.ps1** paths:
    - `$SourceManager` → `$ProjectRoot/src/manager`
    - Update all path references

### Phase 6: Clean up root
11. **Delete/move root-level clutter**:
    - `installers/` → Move to `_Archive/installers/`
    - `_Archive/` → Keep as designated archive folder
    - `out/` → Move build notes to docs/, rest to `_Archive/out/`
    - `logs/` → Add to .gitignore, recreate at runtime

12. **Update all import paths** in:
    - `src/manager/server.js` (nLogger path)
    - `src/manager/config.js` (llamaServerPath relative to new location)
    - `build/bundle-deployment.ps1` (all source paths)

### Phase 7: Update documentation
13. **Update README.md** project structure diagram
14. **Update docs/ARCHITECTURE.md** if it references paths
15. **Update docs/QUICKSTART.md** if it references paths

---

## Decisions Made

### 1. NUI removed from this project
**Decision:** nui_wc2 is a dependency of LLM Gateway Chat, not llama-cpp-gateway. Remove it entirely. The manager has no web UI needs.

### 2. Tuner replaced with CLI script
**Decision:** A web UI for tuning llama-server params is overkill. A one-shot CLI script (`scripts/tune-model.js`) is sufficient. You pick a model, set params, run a test, and copy the output into llm_gateway's config.json.

### 3. Model profiles eliminated
**Decision:** No persistent profile storage in this project. The `model-profiles.js` and editor are archived. Profile data belongs in llm_gateway's `config.json` under each model's `localInference` block.

### 4. Archive convention
**Decision:** Nothing gets deleted. Obsolete files go to `_Archive/`. This preserves history and allows recovery if needed.

### 4. dist/ tracking
**Decision:** Gitignore dist/. Binaries are large and rebuildable from source.

### 5. installers/
**Decision:** Move to `_Archive/installers/`. These are downloadable installers, not source code, but keeping them locally avoids re-downloading.

### 6. _Archive/
**Decision:** Keep at root as a designated archive folder for obsolete files. Prevents deletion while keeping active source clean.

### 7. llama.cpp submodule
**Decision:** Keep as-is at root. It's an upstream dependency and its position is conventional.

---

## Risks

1. **Import path breakage** — Every file that imports from a relative path needs updating. Must test thoroughly.
2. **Bundle script breakage** — `bundle-deployment.ps1` hardcodes paths. Must update and test.
3. **Config path references** — `config.js` has `llamaServerPath` pointing to `../dist/universal/llama-server.exe`. This needs updating to new relative path.
4. **nui_wc2 removal** — Must verify nothing in llama-manager actually imports from nui_wc2 at runtime (tuner was the only consumer).
