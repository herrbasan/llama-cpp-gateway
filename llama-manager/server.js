import http from 'node:http';
import path from 'node:path';
import config from './config.js';
import { createLogger } from './nLogger/src/logger.js'; 
import { spawnLlamaServer, killLlamaServer, getStatus } from './process.js';
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

// Scaffold the HTTP Server
const server = http.createServer(async (req, res) => {
  log.info(`${req.method} ${req.url}`);

  try {
    // Phase 2 implementation placeholders
    if (req.method === 'GET' && req.url === '/models') {
      const modelsList = await discoverModels();
      return sendJson(res, 200, { data: modelsList });
    }

    if (req.method === 'POST' && req.url === '/start') {
      const body = await readJsonBody(req);
      const status = getStatus();
      if (status.pid) {
          return sendJson(res, 409, { error: 'Conflict: Server already running' });
      }

      if (!body.modelPath) {
          return sendJson(res, 400, { error: 'Bad Request: modelPath is required' });
      }

      const port = body.port || config.serverPort;
      const absoluteModelPath = path.resolve(config.modelsDir, body.modelPath);

      const args = [
          '-m', absoluteModelPath,
          '--port', port.toString(),
      ];

      if (body.ctxSize) args.push('-c', body.ctxSize.toString());
      if (body.gpuLayers) args.push('-ngl', body.gpuLayers.toString());
      if (body.mmprojPath) {
          const absoluteVlmPath = path.resolve(config.modelsDir, body.mmprojPath);
          args.push('--mmproj', absoluteVlmPath);
      }

      try {
          const pid = spawnLlamaServer(args, port);
          return sendJson(res, 200, { message: "Server started", pid, args });
      } catch(err) {
          return sendJson(res, 400, { error: 'Failed to start server', message: err.message });
      }
    }

    if (req.method === 'POST' && req.url === '/stop') {
      const pidBefore = getStatus().pid;
      killLlamaServer();
      return sendJson(res, 200, { message: "Server stopped", previousPid: pidBefore });
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

server.listen(config.port, '127.0.0.1', () => {
  log.info(`Llama Manager started on http://127.0.0.1:${config.port}`);
  log.info(`Configured Models Directory: ${config.modelsDir}`);
  log.info(`Configured Server Target: ${config.llamaServerPath}`);
});

// Guaranteed Disposal Hooks (Phase 1.3 Placeholder)
function gracefulShutdown(signal) {
  log.info(`Received ${signal}, shutting down manager...`);
  // Add strict process kill logic here for Phase 1.3
  killLlamaServer();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('exit', () => killLlamaServer());
process.on('uncaughtException', (err) => {
  log.error(`Uncaught Exception: ${err.message}`);
  gracefulShutdown('uncaughtException');
});
