import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration for Llama Manager
export default {
  // Port the manager listens on
  port: parseInt(process.env.MANAGER_PORT || '8080', 10),
  
  // Port the underlying llama-server listens on
  serverPort: parseInt(process.env.LLAMA_SERVER_PORT || '8081', 10),
  
  // Directly targets the universal build from the previous steps
  llamaServerPath: process.env.LLAMA_SERVER_PATH || path.resolve(__dirname, '../dist/universal/llama-server.exe'),
  
  // Default models directory. Set to match LM Studio's structure.
  modelsDir: process.env.MODELS_DIR || 'D:\\# AI Stuff\\LMStudio_Models'
};
