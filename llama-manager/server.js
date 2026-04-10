const http = require('node:http');
const config = require('./config');
const Logger = require('./nLogger/index.js'); // Custom git submodule logger

const log = new Logger('LlamaManager');

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
      return sendJson(res, 200, { message: "Not implemented yet", models: [] });
    }

    if (req.method === 'POST' && req.url === '/start') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { message: "Not implemented yet", request: body });
    }

    if (req.method === 'POST' && req.url === '/stop') {
      return sendJson(res, 200, { message: "Not implemented yet" });
    }

    if (req.method === 'GET' && req.url === '/status') {
      return sendJson(res, 200, { state: 'idle', pid: null, metrics: {} });
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
  // TODO: Add strict process kill logic here for Phase 1.3
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error(`Uncaught Exception: ${err.message}`);
  gracefulShutdown('uncaughtException');
});
