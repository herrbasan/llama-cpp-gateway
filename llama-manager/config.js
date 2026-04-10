const path = require('node:path');

// Configuration for Llama Manager
module.exports = {
  // Port the manager listens on
  port: parseInt(process.env.MANAGER_PORT || '8080', 10),
  
  // Port the underlying llama-server listens on
  serverPort: parseInt(process.env.LLAMA_SERVER_PORT || '8081', 10),
  
  // Directly targets the universal build from the previous steps
  llamaServerPath: process.env.LLAMA_SERVER_PATH || path.resolve(__dirname, '../dist/universal/llama-server.exe'),
  
  // Default models directory. Set to match LM Studio's structure.
  modelsDir: process.env.MODELS_DIR || 'E:\\LM Studio Models'
};
