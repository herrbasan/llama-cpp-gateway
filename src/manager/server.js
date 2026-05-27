import http from 'node:http';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';
import {
  ensureModel,
  killInstance,
  killAll,
  getInstance,
  getAllInstances,
  restoreState,
} from './process.js';
import { discoverModels, resolveModelPath } from './models.js';

const log = createLogger();
const embeddingGates = new Map();
const embeddingFailureState = new Map();

function getEmbeddingFailureThreshold() {
  const parsed = Number(config.embeddingFailureThreshold);
  if (!Number.isFinite(parsed) || parsed < 1) return 3;
  return Math.floor(parsed);
}

function getEmbeddingCooldownMs() {
  const parsed = Number(config.embeddingCircuitCooldownMs);
  if (!Number.isFinite(parsed) || parsed < 1000) return 15000;
  return Math.floor(parsed);
}

function getEmbeddingCrashCooldownMs() {
  const parsed = Number(config.embeddingCrashCooldownMs);
  if (!Number.isFinite(parsed) || parsed < 1000) return 300000;
  return Math.floor(parsed);
}

function getEmbeddingCircuitState(modelPath) {
  const state = embeddingFailureState.get(modelPath);
  if (!state) {
    return { failures: 0, blockedUntil: 0 };
  }
  return state;
}

function resetEmbeddingFailures(modelPath) {
  const state = embeddingFailureState.get(modelPath);
  if (!state) return;
  if (state.failures !== 0 || state.blockedUntil !== 0) {
    embeddingFailureState.set(modelPath, { failures: 0, blockedUntil: 0 });
  }
}

function recordEmbeddingFailure(modelPath, reason, trace = null) {
  const now = Date.now();
  const threshold = getEmbeddingFailureThreshold();
  const cooldownMs = getEmbeddingCooldownMs();
  const crashCooldownMs = getEmbeddingCrashCooldownMs();
  const current = getEmbeddingCircuitState(modelPath);

  if (now < current.blockedUntil) {
    return;
  }

  const failures = current.failures + 1;
  if (failures >= threshold) {
    const reasonText = String(reason || '').toLowerCase();
    const isCrashLike =
      reasonText.includes('econnreset') ||
      reasonText.includes('econnrefused') ||
      reasonText.includes('bad gateway');
    const effectiveCooldownMs = isCrashLike ? Math.max(cooldownMs, crashCooldownMs) : cooldownMs;
    const blockedUntil = now + effectiveCooldownMs;
    embeddingFailureState.set(modelPath, { failures: 0, blockedUntil });
    log.warn(`Embedding circuit opened for model`, {
      modelPath,
      reason,
      threshold,
      cooldownMs: effectiveCooldownMs,
      crashLike: isCrashLike,
      blockedUntil,
      requestId: trace?.requestId || null,
    });
    return;
  }

  embeddingFailureState.set(modelPath, { failures, blockedUntil: 0 });
}

function getEmbeddingLimit() {
  const parsed = Number(config.embeddingMaxConcurrency);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

function getEmbeddingMaxRequestBytes() {
  const parsed = Number(config.embeddingMaxRequestBytes);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function runWithEmbeddingGate(modelPath, task, trace = null) {
  const limit = getEmbeddingLimit();

  if (!embeddingGates.has(modelPath)) {
    embeddingGates.set(modelPath, { active: 0, queue: [] });
  }

  const gate = embeddingGates.get(modelPath);

  return new Promise((resolve, reject) => {
    const runTask = () => {
      gate.active++;
      Promise.resolve()
        .then(task)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          gate.active--;
          const nextTask = gate.queue.shift();
          if (nextTask) {
            nextTask();
            return;
          }

          if (gate.active === 0 && gate.queue.length === 0) {
            embeddingGates.delete(modelPath);
          }
        });
    };

    if (trace && gate.active >= limit) {
      log.warn(`EmbedTrace ${trace.requestId} queued by embedding gate`, {
        requestId: trace.requestId,
        modelPath,
        active: gate.active,
        queued: gate.queue.length,
        limit,
      });
    }

    if (gate.active < limit) {
      runTask();
    } else {
      gate.queue.push(runTask);
    }
  });
}

function nextRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeEmbeddingInput(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const input = parsed?.input ?? parsed?.content;

    const flatten = (value) => {
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) {
        const out = [];
        for (const item of value) {
          if (typeof item === 'string') {
            out.push(item);
          } else if (Array.isArray(item)) {
            out.push(item.join(' '));
          } else if (item != null) {
            out.push(JSON.stringify(item));
          }
        }
        return out;
      }
      if (input == null) return [];
      return [JSON.stringify(value)];
    };

    const chunks = flatten(input);
    const lengths = chunks.map((s) => s.length);
    const totalChars = lengths.reduce((a, b) => a + b, 0);
    const maxChars = lengths.length ? Math.max(...lengths) : 0;
    const minChars = lengths.length ? Math.min(...lengths) : 0;
    const preview = chunks[0] ? chunks[0].slice(0, 120) : '';

    return {
      inputType: Array.isArray(input) ? 'array' : typeof input,
      itemCount: chunks.length,
      totalChars,
      maxChars,
      minChars,
      preview,
    };
  } catch {
    return null;
  }
}

function isEmbeddingsRoute(req) {
  return req.method === 'POST' && req.url === '/v1/embeddings';
}

function startup(msg) {
  console.log(msg);
  log.info(msg);
}

function fatal(msg) {
  console.error(msg);
  log.error(msg);
  process.exit(1);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function extractModelConfig(req) {
  const modelPath = req.headers['x-model-path'];
  if (!modelPath) return null;

  const parseHeaderInt = (h) => {
    const v = parseInt(req.headers[h], 10);
    return Number.isNaN(v) ? undefined : v;
  };

  return {
    modelPath,
    modelName: req.headers['x-model-name'] || undefined,
    ctxSize: parseHeaderInt('x-model-ctxsize'),
    gpuLayers: parseHeaderInt('x-model-gpulayers'),
    flashAttention: req.headers['x-model-flashattention'] ? req.headers['x-model-flashattention'] === 'true' : undefined,
    mmproj: req.headers['x-model-mmproj'] || undefined,
    embedding: req.headers['x-model-embedding'] === 'true',
    pooling: req.headers['x-model-pooling'] || undefined,
    batchSize: parseHeaderInt('x-model-batchsize'),
    mlock: req.headers['x-model-mlock'] === 'true',
  };
}

function proxyToInstance(req, res, instance, trace = null) {
  return new Promise((resolve) => {
    const targetUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${instance.port}${req.url}`;
    let completed = false;
    const startedAt = Date.now();

    const finish = () => {
      if (completed) return;
      completed = true;
      resolve();
    };

    if (trace) {
      log.info(`EmbedTrace ${trace.requestId} proxy start`, {
        requestId: trace.requestId,
        path: req.url,
        method: req.method,
        targetPort: instance.port,
        modelPath: trace.modelPath,
        contentLength: req.headers['content-length'] || null,
        userAgent: req.headers['user-agent'] || null,
        embeddingHeader: req.headers['x-model-embedding'] || null,
        poolingHeader: req.headers['x-model-pooling'] || null,
      });
    }

    const finishWithError = (statusCode, payload, logMessage) => {
      if (completed) return;
      if (logMessage) log.error(logMessage);

      if (trace?.isEmbedding && trace.modelPath) {
        recordEmbeddingFailure(trace.modelPath, payload?.details || payload?.error || 'proxy error', trace);
      }

      if (!res.headersSent) {
        sendJson(res, statusCode, payload);
        finish();
        return;
      }

      res.end();
      finish();
    };

    const headers = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      Accept: req.headers['accept'] || '*/*',
    };

    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

    const shouldTraceBody = trace?.isEmbedding && config.embeddingTraceBodyShape;
    const maxTraceBytes = Math.max(1024, Number(config.embeddingTraceBodyMaxBytes) || 262144);
    let tracedBytes = 0;
    const tracedChunks = [];
    let bodyShapeLogged = false;

    const logBodyShape = (stage) => {
      if (!shouldTraceBody || bodyShapeLogged) return;
      bodyShapeLogged = true;
      const bodyText = tracedChunks.length ? Buffer.concat(tracedChunks).toString('utf-8') : '';
      const summary = summarizeEmbeddingInput(bodyText);
      log.info(`EmbedTrace ${trace.requestId} body-shape`, {
        requestId: trace.requestId,
        stage,
        tracedBytes,
        truncated: tracedBytes > maxTraceBytes,
        summary,
      });
    };

    if (shouldTraceBody) {
      req.on('data', (chunk) => {
        tracedBytes += chunk.length;
        if (tracedBytes <= maxTraceBytes) {
          tracedChunks.push(Buffer.from(chunk));
        }
      });
      req.on('end', () => {
        logBodyShape('request-end');
      });
    }

    const proxyReq = http.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
      if (completed) return;
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.on('data', (chunk) => res.write(chunk));
      proxyRes.on('end', () => {
        if (completed) return;
        if (trace?.isEmbedding && trace.modelPath && proxyRes.statusCode < 500) {
          resetEmbeddingFailures(trace.modelPath);
        }
        if (trace) {
          logBodyShape('proxy-end');
          log.info(`EmbedTrace ${trace.requestId} proxy end`, {
            requestId: trace.requestId,
            statusCode: proxyRes.statusCode,
            durationMs: Date.now() - startedAt,
            targetPort: instance.port,
          });
        }
        res.end();
        finish();
      });
      proxyRes.on('error', (err) => {
        finishWithError(502, { error: 'Bad Gateway', details: err.message }, `Proxy response error (${instance.port}): ${err.message}`);
      });
    });

    proxyReq.on('error', (err) => {
      if (trace) {
        log.error(`EmbedTrace ${trace.requestId} proxy request error`, {
          requestId: trace.requestId,
          targetPort: instance.port,
          durationMs: Date.now() - startedAt,
          error: err.message,
        });
      }
      finishWithError(502, { error: 'Bad Gateway', details: err.message }, `Proxy error (${instance.port}): ${err.message}`);
    });

    req.on('aborted', () => {
      if (trace) {
        log.warn(`EmbedTrace ${trace.requestId} client aborted`, {
          requestId: trace.requestId,
          targetPort: instance.port,
          durationMs: Date.now() - startedAt,
        });
      }
      proxyReq.destroy();
      finish();
    });

    res.on('close', () => {
      if (!completed) {
        if (trace) {
          log.warn(`EmbedTrace ${trace.requestId} response closed early`, {
            requestId: trace.requestId,
            targetPort: instance.port,
            durationMs: Date.now() - startedAt,
          });
        }
        proxyReq.destroy();
        finish();
      }
    });

    req.pipe(proxyReq);
  });
}

async function handleInference(req, res) {
  const modelConfig = extractModelConfig(req);
  const embeddingsRoute = isEmbeddingsRoute(req);
  const trace = isEmbeddingsRoute(req)
    ? {
      requestId: nextRequestId(),
      modelPath: modelConfig?.modelPath || null,
      isEmbedding: true,
    }
    : null;

  if (trace) {
    log.info(`EmbedTrace ${trace.requestId} ingress`, {
      requestId: trace.requestId,
      path: req.url,
      method: req.method,
      contentType: req.headers['content-type'] || null,
      contentLength: req.headers['content-length'] || null,
      userAgent: req.headers['user-agent'] || null,
      modelPath: modelConfig?.modelPath || null,
      modelName: modelConfig?.modelName || null,
      embeddingHeader: req.headers['x-model-embedding'] || null,
      poolingHeader: req.headers['x-model-pooling'] || null,
    });
  }

  if (!modelConfig) {
    if (trace) {
      log.warn(`EmbedTrace ${trace.requestId} missing model headers`, { requestId: trace.requestId });
    }
    return sendJson(res, 400, {
      error: 'Bad Request',
      details: 'Missing X-Model-Path header. The Gateway must send model config via headers.',
    });
  }

  let resolved;
  try {
    resolved = await resolveModelPath(modelConfig.modelPath, modelConfig.modelName);
  } catch (err) {
    if (trace) {
      log.error(`EmbedTrace ${trace.requestId} model resolution failed`, {
        requestId: trace.requestId,
        modelPath: modelConfig.modelPath,
        modelName: modelConfig.modelName || null,
        error: err.message,
      });
    }
    return sendJson(res, 400, { error: 'Model Resolution Failed', details: err.message });
  }

  const finalModelPath = resolved.ggufPath;
  const finalMmproj = modelConfig.mmproj || resolved.mmprojPath;

  const runInference = async () => {
    if (embeddingsRoute) {
      const latestCircuit = getEmbeddingCircuitState(finalModelPath);
      if (Date.now() < latestCircuit.blockedUntil) {
        const retryAfterMs = latestCircuit.blockedUntil - Date.now();
        if (trace) {
          log.warn(`EmbedTrace ${trace.requestId} rejected by circuit (pre-run)`, {
            requestId: trace.requestId,
            modelPath: finalModelPath,
            retryAfterMs,
          });
        }
        return sendJson(res, 503, {
          error: 'Embedding backend temporarily unavailable',
          details: 'Recent backend failures detected; retry shortly.',
          retryAfterMs,
        });
      }

      const maxBytes = getEmbeddingMaxRequestBytes();
      const contentLength = Number(req.headers['content-length'] || 0);
      if (maxBytes > 0 && Number.isFinite(contentLength) && contentLength > maxBytes) {
        if (trace) {
          log.warn(`EmbedTrace ${trace.requestId} rejected by size guard`, {
            requestId: trace.requestId,
            modelPath: finalModelPath,
            contentLength,
            maxBytes,
          });
        }
        return sendJson(res, 413, {
          error: 'Embedding input too large',
          details: `Request body exceeds gateway safety limit (${contentLength} > ${maxBytes} bytes).`,
          maxBytes,
        });
      }
    }

    const existing = getInstance(finalModelPath);
    if (existing && existing.state === 'running') {
      return proxyToInstance(req, res, existing, trace ? { ...trace, modelPath: finalModelPath } : null);
    }

    try {
      const result = await ensureModel(finalModelPath, {
        ctxSize: modelConfig.ctxSize ?? config.defaultCtxSize,
        gpuLayers: modelConfig.gpuLayers ?? config.defaultGpuLayers,
        flashAttention: modelConfig.flashAttention,
        mmprojPath: finalMmproj,
        embedding: modelConfig.embedding,
        pooling: modelConfig.pooling,
        batchSize: modelConfig.batchSize,
        mlock: modelConfig.mlock,
      });

      if (!result.alreadyRunning) {
        log.info(`Waiting for model to load: ${finalModelPath}...`);
        const maxWait = 120_000;
        const pollMs = 1000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, pollMs));
          const inst = getInstance(finalModelPath);
          if (inst && inst.state === 'running') break;
          if (inst && inst.state === 'error') {
            return sendJson(res, 500, {
              error: 'Model failed to start',
              details: 'llama-server exited with an error',
            });
          }
        }
        const inst = getInstance(finalModelPath);
        if (!inst || inst.state !== 'running') {
          return sendJson(res, 504, {
            error: 'Model startup timeout',
            details: `Model did not become healthy within ${maxWait / 1000}s`,
          });
        }
        log.info(`Model ready: ${finalModelPath}`);
        return proxyToInstance(req, res, inst, trace ? { ...trace, modelPath: finalModelPath } : null);
      }

      const runningInstance = getInstance(finalModelPath);
      return proxyToInstance(req, res, runningInstance, trace ? { ...trace, modelPath: finalModelPath } : null);
    } catch (err) {
      if (trace) {
        log.error(`EmbedTrace ${trace.requestId} startup/proxy failed`, {
          requestId: trace.requestId,
          modelPath: finalModelPath,
          error: err.message,
        });
      }
      return sendJson(res, 500, {
        error: 'Failed to start model',
        details: err.message,
      });
    }
  };

  if (embeddingsRoute) {
    const circuit = getEmbeddingCircuitState(finalModelPath);
    if (Date.now() < circuit.blockedUntil) {
      const retryAfterMs = circuit.blockedUntil - Date.now();
      if (trace) {
        log.warn(`EmbedTrace ${trace.requestId} rejected by circuit`, {
          requestId: trace.requestId,
          modelPath: finalModelPath,
          retryAfterMs,
        });
      }
      return sendJson(res, 503, {
        error: 'Embedding backend temporarily unavailable',
        details: 'Recent backend failures detected; retry shortly.',
        retryAfterMs,
      });
    }

    return runWithEmbeddingGate(finalModelPath, runInference, trace);
  }

  return runInference();
}

async function handleHealth(res) {
  const instances = getAllInstances();
  const running = instances.filter(i => i.state === 'running');
  if (running.length === 0) {
    return sendJson(res, 503, { status: 'error', message: 'No models loaded' });
  }

  const results = await Promise.all(running.map(async (inst) => {
    try {
      const r = await fetch(`http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${inst.port}/health`, { timeout: 3000 });
      return { model: inst.modelPath, port: inst.port, healthy: r.ok };
    } catch {
      return { model: inst.modelPath, port: inst.port, healthy: false };
    }
  }));

  const allHealthy = results.every(r => r.healthy);
  return sendJson(res, allHealthy ? 200 : 503, { status: allHealthy ? 'ok' : 'degraded', models: results });
}

const server = http.createServer(async (req, res) => {
  log.info(`${req.method} ${req.url}`);

  try {
    if (req.method === 'GET' && req.url === '/models') {
      const modelsList = await discoverModels();
      return sendJson(res, 200, { data: modelsList });
    }

    if (req.method === 'GET' && req.url === '/health') {
      return handleHealth(res);
    }

    if (req.method === 'GET' && req.url === '/status') {
      return sendJson(res, 200, {
        instances: getAllInstances(),
      });
    }

    if (req.method === 'POST' && req.url === '/stop') {
      killAll({ force: true });
      return sendJson(res, 200, { message: 'All models stopped' });
    }

    // All other requests are inference — read headers, auto-start model, proxy body raw
    return handleInference(req, res);
  } catch (err) {
    sendJson(res, 400, { error: 'Bad Request', details: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fatal(`Port ${config.port} is already in use.`);
  } else {
    fatal(`Server error: ${err.message}`);
  }
});

server.listen(config.port, config.host, async () => {
  const bindAddr = config.host === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : config.host;
  startup(`Llama Manager running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  startup(`Binding to: ${bindAddr}`);
  startup(`Server binary: ${config.llamaServerPath}`);
  startup(`Models dir: ${config.modelsDir}`);
  startup(`Max concurrent instances: ${config.maxInstances}`);

  await restoreState();
});

function gracefulShutdown(signal) {
  startup(`Received ${signal}, shutting down...`);
  if (!config.detachOnShutdown) killAll();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('exit', () => {
  if (!config.detachOnShutdown) killAll();
});

process.on('uncaughtException', (err) => {
  fatal(`Uncaught Exception: ${err.message}`);
});
