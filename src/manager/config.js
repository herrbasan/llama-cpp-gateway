import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const configFile = path.join(projectRoot, 'config.json');
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

export default {
  host: cfg.host || '127.0.0.1',
  port: cfg.port,
  serverPort: cfg.serverPort,
  maxInstances: cfg.maxInstances,

  llamaServerPath: path.resolve(projectRoot, cfg.llamaServerPath),

  defaultCtxSize: cfg.defaultCtxSize,
  defaultGpuLayers: cfg.defaultGpuLayers,
  flashAttention: cfg.flashAttention,
  detachOnShutdown: cfg.detachOnShutdown,

  modelsDir: cfg.modelsDir,
};
