import http from 'node:http';
import path from 'node:path';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';
import { spawnLlamaServer, killLlamaServer, getStatus, checkExistingServer, attachToServer } from './process.js';
import { discoverModels } from './models.js';

const log = createLogger();

// A barebones JSON body parser
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        log.error(`Failed to parse JSON body: ${err.message}`);
        reject(err);
      }
    });
    req.on('error', err => {
      log.error(`Request stream error: ${err.message}`);
      reject(err);
    });
  });
}

// Send standard JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Check for existing server on startup (if detachOnShutdown was used)
async function attemptReattach() {
  if (await checkExistingServer(config.serverPort)) {
    log.info('Re-attaching to existing llama-server (DETACH_ON_SHUTDOWN was used)');
    attachToServer(config.serverPort);
  }
}

// Scaffold the HTTP Server
const server = http.createServer(async (req, res) => {
  log.info(`${req.method} ${req.url}`);

  try {
    if (req.method === 'GET' && req.url === '/models') {
      const modelsList = await discoverModels();
      return sendJson(res, 200, { data: modelsList });
    }

    if (req.method === 'POST' && req.url === '/start') {
      const body = await readJsonBody(req);
      const status = getStatus();
      
      // If detached, we can re-attach or spawn new
      // If actually running with process handle, reject
      if (status.pid && !status.detached) {
          return sendJson(res, 409, { error: 'Conflict: Server already running' });
      }
      
      // Check if actually running (health probe)
      if (status.detached && await checkExistingServer(body.port || config.serverPort)) {
        return sendJson(res, 409, { error: 'Conflict: Server already running (detached)' });
      }

      if (!body.modelPath) {
          return sendJson(res, 400, { error: 'Bad Request: modelPath is required' });
      }

      const port = body.port || config.serverPort;
      const absoluteModelPath = path.resolve(config.modelsDir, body.modelPath);

      // Use explicit params or fall back to config defaults
      const ctxSize = body.ctxSize ?? config.defaultCtxSize;
      const gpuLayers = body.gpuLayers ?? config.defaultGpuLayers;
      const flashAttention = body.flashAttention ?? config.flashAttention;

      const args = [
          '-m', absoluteModelPath,
          '--port', port.toString(),
          '-c', ctxSize.toString(),
          '-ngl', gpuLayers.toString(),
      ];

      if (flashAttention) {
        args.push('--flash-attn', 'on');
      }
      
      if (body.mmprojPath) {
          const absoluteVlmPath = path.resolve(config.modelsDir, body.mmprojPath);
          args.push('--mmproj', absoluteVlmPath);
      }

      try {
          const pid = spawnLlamaServer(args, port);
          return sendJson(res, 200, {
            message: "Server started",
            pid,
            args,
            settings: { ctxSize, gpuLayers, flashAttention }
          });
      } catch(err) {
          return sendJson(res, 400, { error: 'Failed to start server', message: err.message });
      }
    }

    if (req.method === 'POST' && req.url === '/stop') {
      const body = await readJsonBody(req);
      const pidBefore = getStatus().pid;
      const force = body.force === true;
      
      killLlamaServer({ force });
      return sendJson(res, 200, { 
        message: force ? "Server force-killed" : "Server stopped", 
        previousPid: pidBefore,
        detached: !force && config.detachOnShutdown
      });
    }

    if (req.method === 'GET' && req.url === '/status') {
      return sendJson(res, 200, getStatus());
    }

    // Fallback for unknown routes
    sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    sendJson(res, 400, { error: 'Bad Request', details: err.message });
  }
});

server.listen(config.port, '127.0.0.1', async () => {
  log.info(`Llama Manager started on http://127.0.0.1:${config.port}`);
  log.info(`Configured Models Directory: ${config.modelsDir}`);
  log.info(`Configured Server Target: ${config.llamaServerPath}`);
  
  if (config.detachOnShutdown) {
    log.info('DETACH_ON_SHUTDOWN enabled. Will preserve model in VRAM on restart.');
    await attemptReattach();
  }
});

// Graceful shutdown
function gracefulShutdown(signal) {
  log.info(`Received ${signal}, shutting down manager...`);
  
  if (config.detachOnShutdown) {
    log.info('DETACH_ON_SHUTDOWN enabled. Detaching from server without killing.');
  }
  
  killLlamaServer();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Only kill on exit if not detaching
process.on('exit', () => {
  if (!config.detachOnShutdown) {
    killLlamaServer();
  }
});

process.on('uncaughtException', (err) => {
  log.error(`Uncaught Exception: ${err.message}`);
  gracefulShutdown('uncaughtException');
});
