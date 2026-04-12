import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';
import { spawnLlamaServer, killLlamaServer, getStatus, checkExistingServer, attachToServer } from './process.js';
import { discoverModels } from './models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger({ logsDir: path.resolve(__dirname, '../../logs') });

function startup(msg) {
  console.log(msg);
  log.info(msg);
}

function fatal(msg) {
  console.error(msg);
  log.error(msg);
  process.exit(1);
}

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

// Proxy SSE/streaming requests to llama-server with zero transformation
function proxyToLlamaServer(req, res, body) {
  const targetUrl = `http://127.0.0.1:${config.serverPort}${req.url}`;
  
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Accept': req.headers['accept'] || '*/*',
  };
  
  if (req.headers['authorization']) {
    headers['Authorization'] = req.headers['authorization'];
  }
  
  const proxyReq = http.request(targetUrl, {
    method: req.method,
    headers,
  }, (proxyRes) => {
    // Forward status and headers
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    
    // Pipe response chunks directly - SSE streams flow through unchanged
    proxyRes.on('data', (chunk) => {
      res.write(chunk);
    });
    
    proxyRes.on('end', () => {
      res.end();
    });
  });
  
  proxyReq.on('error', (err) => {
    log.error(`Proxy error: ${err.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'Bad Gateway', details: err.message });
    } else {
      res.end();
    }
  });
  
  // Forward request body if present
  if (body !== undefined) {
    proxyReq.write(JSON.stringify(body));
  }
  proxyReq.end();
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

    // Proxy all other requests to llama-server (SSE streaming, completions, embeddings, etc.)
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    return proxyToLlamaServer(req, res, body);
  } catch (err) {
    sendJson(res, 400, { error: 'Bad Request', details: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fatal(`Port ${config.port} is already in use. Is another instance running?`);
  } else {
    fatal(`Server error: ${err.message}`);
  }
});

server.listen(config.port, '127.0.0.1', async () => {
  startup(`Llama Manager running at http://127.0.0.1:${config.port}`);
  startup(`Models dir: ${config.modelsDir}`);
  startup(`Server target: ${config.llamaServerPath}`);
  
  if (config.detachOnShutdown) {
    startup('DETACH_ON_SHUTDOWN enabled. Will preserve model in VRAM on restart.');
    await attemptReattach();
  }
});

// Graceful shutdown
function gracefulShutdown(signal) {
  startup(`Received ${signal}, shutting down manager...`);
  
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
  fatal(`Uncaught Exception: ${err.message}`);
});
