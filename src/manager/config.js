import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  port: parseInt(process.env.MANAGER_PORT || '4080', 10),
  serverPort: parseInt(process.env.LLAMA_SERVER_PORT || '4081', 10),
  maxInstances: parseInt(process.env.MAX_INSTANCES || '4', 10),

  llamaServerPath: process.env.LLAMA_SERVER_PATH || path.resolve(__dirname, '../../dist/universal/llama-server.exe'),

  defaultCtxSize: parseInt(process.env.DEFAULT_CTX_SIZE || '8192', 10),
  defaultGpuLayers: parseInt(process.env.DEFAULT_GPU_LAYERS || '99', 10),
  flashAttention: process.env.FLASH_ATTENTION !== 'false',
  detachOnShutdown: process.env.DETACH_ON_SHUTDOWN === 'true',

  modelsDir: process.env.MODELS_DIR || 'D:\\# AI Stuff\\LMStudio_Models',
};
