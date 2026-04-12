import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration for Llama Manager
export default {
  // Port the manager listens on
  port: parseInt(process.env.MANAGER_PORT || '4080', 10),
  
  // Port the underlying llama-server listens on
  serverPort: parseInt(process.env.LLAMA_SERVER_PORT || '4081', 10),
  
  // Directly targets the universal build from the previous steps
  llamaServerPath: process.env.LLAMA_SERVER_PATH || path.resolve(__dirname, '../../dist/universal/llama-server.exe'),
  
  // Default models directory. Set to match LM Studio's structure.
  modelsDir: process.env.MODELS_DIR || 'D:\\# AI Stuff\\LMStudio_Models',
  
  // Default context size for models (overridable per-model via API)
  // With Flash Attention, you can use much larger contexts efficiently.
  // 64k context at Q4 = ~4GB extra VRAM vs 2k context
  defaultCtxSize: parseInt(process.env.DEFAULT_CTX_SIZE || '8192', 10),
  
  // Default GPU layers to offload (-ngl). 99 = all layers.
  // Reduce if you need to fit multiple models or have VRAM constraints.
  defaultGpuLayers: parseInt(process.env.DEFAULT_GPU_LAYERS || '99', 10),
  
  // Enable Flash Attention (-fa flag). Reduces KV cache VRAM usage by ~50%.
  // Essential for large context sizes (32k+) on consumer GPUs.
  // Disable only if you encounter compatibility issues.
  flashAttention: process.env.FLASH_ATTENTION !== 'false',
  
  // When true, manager detaches from llama-server on shutdown instead of killing it.
  // This keeps the model loaded in VRAM when the manager restarts.
  // The manager will re-attach to the running server on next startup.
  detachOnShutdown: process.env.DETACH_ON_SHUTDOWN === 'true'
};
