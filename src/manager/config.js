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
  defaultEmbeddingFlashAttention: cfg.defaultEmbeddingFlashAttention ?? false,
  defaultParallelSlots: cfg.defaultParallelSlots ?? 1,
  defaultKvUnified: cfg.defaultKvUnified ?? false,
  defaultCtxCheckpoints: cfg.defaultCtxCheckpoints ?? 0,
  defaultCheckpointEveryTokens: cfg.defaultCheckpointEveryTokens ?? -1,
  embeddingMaxConcurrency: cfg.embeddingMaxConcurrency ?? 1,
  embeddingMaxRequestBytes: cfg.embeddingMaxRequestBytes ?? 2200,
  embeddingMaxCtxSize: cfg.embeddingMaxCtxSize ?? 8192,
  defaultEmbeddingBatchSize: cfg.defaultEmbeddingBatchSize ?? 256,
  embeddingFailureThreshold: cfg.embeddingFailureThreshold ?? 1,
  embeddingCircuitCooldownMs: cfg.embeddingCircuitCooldownMs ?? 60000,
  embeddingCrashCooldownMs: cfg.embeddingCrashCooldownMs ?? 300000,
  embeddingTraceBodyShape: cfg.embeddingTraceBodyShape ?? true,
  embeddingTraceBodyMaxBytes: cfg.embeddingTraceBodyMaxBytes ?? 262144,
  defaultBatchSize: cfg.defaultBatchSize ?? 2048,
  defaultUbatchSize: cfg.defaultUbatchSize ?? 512,
  defaultThreads: cfg.defaultThreads ?? 8,
  defaultThreadsBatch: cfg.defaultThreadsBatch ?? 8,
  detachOnShutdown: cfg.detachOnShutdown,

  modelsDir: cfg.modelsDir,
};
