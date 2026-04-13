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
import { discoverModels } from './models.js';

const log = createLogger();

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

function proxyToInstance(req, res, instance) {
  const targetUrl = `http://127.0.0.1:${instance.port}${req.url}`;

  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    Accept: req.headers['accept'] || '*/*',
  };

  if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

  const proxyReq = http.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.on('data', (chunk) => res.write(chunk));
    proxyRes.on('end', () => res.end());
  });

  proxyReq.on('error', (err) => {
    log.error(`Proxy error (${instance.port}): ${err.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'Bad Gateway', details: err.message });
    } else {
      res.end();
    }
  });

  req.pipe(proxyReq);
}

async function handleInference(req, res) {
  const modelConfig = extractModelConfig(req);

  if (!modelConfig) {
    return sendJson(res, 400, {
      error: 'Bad Request',
      details: 'Missing X-Model-Path header. The Gateway must send model config via headers.',
    });
  }

  const existing = getInstance(modelConfig.modelPath);
  if (existing && existing.state === 'running') {
    return proxyToInstance(req, res, existing);
  }

  try {
    const result = await ensureModel(modelConfig.modelPath, {
      ctxSize: modelConfig.ctxSize ?? config.defaultCtxSize,
      gpuLayers: modelConfig.gpuLayers ?? config.defaultGpuLayers,
      flashAttention: modelConfig.flashAttention ?? config.flashAttention,
      mmprojPath: modelConfig.mmproj,
      embedding: modelConfig.embedding,
      pooling: modelConfig.pooling,
      batchSize: modelConfig.batchSize,
      mlock: modelConfig.mlock,
    });

    if (!result.alreadyRunning) {
      log.info(`Waiting for model to load: ${modelConfig.modelPath}...`);
      const maxWait = 120_000;
      const pollMs = 1000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, pollMs));
        const inst = getInstance(modelConfig.modelPath);
        if (inst && inst.state === 'running') break;
        if (inst && inst.state === 'error') {
          return sendJson(res, 500, {
            error: 'Model failed to start',
            details: 'llama-server exited with an error',
          });
        }
      }
      const inst = getInstance(modelConfig.modelPath);
      if (!inst || inst.state !== 'running') {
        return sendJson(res, 504, {
          error: 'Model startup timeout',
          details: `Model did not become healthy within ${maxWait / 1000}s`,
        });
      }
      log.info(`Model ready: ${modelConfig.modelPath}`);
      return proxyToInstance(req, res, inst);
    }

    return proxyToInstance(req, res, existing);
  } catch (err) {
    return sendJson(res, 500, {
      error: 'Failed to start model',
      details: err.message,
    });
  }
}

async function handleHealth(res) {
  const instances = getAllInstances();
  const running = instances.filter(i => i.state === 'running');
  if (running.length === 0) {
    return sendJson(res, 503, { status: 'error', message: 'No models loaded' });
  }

  const results = await Promise.all(running.map(async (inst) => {
    try {
      const r = await fetch(`http://127.0.0.1:${inst.port}/health`, { timeout: 3000 });
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
