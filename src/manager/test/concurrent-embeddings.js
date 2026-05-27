import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf-8'));
const managerHost = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
const managerPort = cfg.port;

const modelPath = process.env.TEST_MODEL_PATH;
const concurrency = parseInt(process.env.CONCURRENCY || '12', 10);
const waves = parseInt(process.env.WAVES || '3', 10);
const requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10);
const payloadMode = (process.env.PAYLOAD_MODE || 'small').toLowerCase();
const inputShape = (process.env.INPUT_SHAPE || 'string').toLowerCase();
const staggerMs = parseInt(process.env.STAGGER_MS || '0', 10);
const ctxSize = parseInt(process.env.CTX_SIZE || '32000', 10);
const targetChars = parseInt(process.env.TARGET_CHARS || '6000', 10);

if (!modelPath) {
  console.error('Missing TEST_MODEL_PATH environment variable.');
  console.error('Example:');
  console.error('  $env:TEST_MODEL_PATH="SomeFolder/SomeModel.gguf"; npm run test:embed:concurrency');
  process.exit(1);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTextForMode(waveNumber, requestNumber) {
  const base = `wave-${waveNumber}-req-${requestNumber}`;
  if (payloadMode === 'maintenance') {
    const sizes = [1.0, 0.75, 0.5];
    const desired = Math.max(800, Math.floor(targetChars * sizes[requestNumber % sizes.length]));
    const seed = `${base} maintenance replay chunk with app history, search context, and retry metadata.`;
    let out = seed;
    while (out.length < desired) {
      out += ` ${seed}`;
    }
    return out.slice(0, desired);
  }

  if (payloadMode === 'chatlike') {
    const samples = [
      `${base} quick semantic lookup for a short sentence`,
      `${base} summarize this paragraph: the user reopened the app, retried queued messages, and the embedding index refreshed while background sync started`,
      `${base} retrieve context for this multi-part note: project handover says concurrent embedding requests can crash newer llama-server builds on windows with access violations and repeated restarts`,
    ];
    return samples[requestNumber % samples.length];
  }

  return `${base} quick embedding probe text`;
}

function buildInputPayload(waveNumber, requestNumber) {
  const text = buildTextForMode(waveNumber, requestNumber);

  if (inputShape === 'array') {
    return [text, `${text} extra context`, `${text} retrieval candidate`];
  }

  if (inputShape === 'mixed') {
    if (requestNumber % 2 === 0) {
      return text;
    }
    return [text, `${text} extra context`, `${text} retrieval candidate`];
  }

  return text;
}

function requestJson(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: managerHost,
        port: managerPort,
        path: route,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = raw;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            // Keep raw body when response is not JSON.
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );

    req.setTimeout(requestTimeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${requestTimeoutMs}ms`));
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function managerIsReachable() {
  try {
    const res = await requestJson('GET', '/status');
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

async function waitForManager(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await managerIsReachable()) return true;
    await delay(500);
  }
  return false;
}

async function runWave(waveNumber, waveSize) {
  const startedAt = Date.now();
  const requests = [];

  for (let i = 0; i < waveSize; i++) {
    const payloadInput = buildInputPayload(waveNumber, i);
    requests.push(
      requestJson(
        'POST',
        '/v1/embeddings',
        {
          input: payloadInput,
          model: 'gateway-embedding-test',
        },
        {
          'x-model-path': modelPath,
          'x-model-ctxsize': String(ctxSize),
          'x-model-embedding': 'true',
          'x-model-pooling': 'mean',
        }
      )
    );

    if (staggerMs > 0) {
      await delay(staggerMs);
    }
  }

  const settled = await Promise.allSettled(requests);
  const ok = [];
  const failed = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value.status === 200) {
        ok.push(result.value);
      } else {
        failed.push({ type: 'http', detail: result.value });
      }
      continue;
    }

    failed.push({
      type: 'transport',
      detail: result.reason?.message || String(result.reason),
    });
  }

  return {
    waveNumber,
    durationMs: Date.now() - startedAt,
    okCount: ok.length,
    failCount: failed.length,
    failures: failed,
  };
}

async function warmupEmbedding() {
  console.log('Running warm-up request to ensure model is loaded before concurrency waves...');
  const res = await requestJson(
    'POST',
    '/v1/embeddings',
    {
      input: buildInputPayload(0, 0),
      model: 'gateway-embedding-test',
    },
    {
      'x-model-path': modelPath,
      'x-model-ctxsize': String(ctxSize),
      'x-model-embedding': 'true',
      'x-model-pooling': 'mean',
    }
  );

  if (res.status !== 200) {
    throw new Error(`Warm-up request failed with status ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const status = await requestJson('GET', '/status');
  const running = (status.body?.instances || []).some((i) => i.state === 'running');
  if (!running) {
    throw new Error('Warm-up completed but gateway does not report a running instance.');
  }
}

async function main() {
  let manager;
  let managerStartedByTest = false;
  const managerLogs = [];

  try {
    if (!(await managerIsReachable())) {
      console.log('Manager not running. Starting local gateway process...');
      manager = spawn('node', ['src/manager/server.js'], {
        cwd: projectRoot,
        env: process.env,
        detached: false,
      });

      managerStartedByTest = true;

      manager.stdout.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line) {
          managerLogs.push(line);
          console.log(`[manager] ${line}`);
        }
      });

      manager.stderr.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line) {
          managerLogs.push(line);
          console.error(`[manager:err] ${line}`);
        }
      });

      const ready = await waitForManager(30000);
      if (!ready) {
        throw new Error('Gateway failed to start within 30 seconds.');
      }
    }

    console.log('=== Concurrent Embedding Repro Test ===');
    console.log(`Target model path: ${modelPath}`);
    console.log(`Gateway endpoint: http://${managerHost}:${managerPort}/v1/embeddings`);
    console.log(`Waves: ${waves}, concurrency per wave: ${concurrency}`);
    console.log(`Context window (ctx): ${ctxSize}`);
    console.log(`Payload mode: ${payloadMode}, input shape: ${inputShape}, stagger: ${staggerMs}ms`);
      if (payloadMode === 'maintenance') {
        console.log(`Maintenance target chars: ${targetChars}`);
      }

    await warmupEmbedding();
    await delay(500);

    const results = [];
    for (let wave = 1; wave <= waves; wave++) {
      console.log(`\nRunning wave ${wave}/${waves} ...`);
      const waveResult = await runWave(wave, concurrency);
      results.push(waveResult);

      console.log(
        `Wave ${wave}: ok=${waveResult.okCount}, failed=${waveResult.failCount}, duration=${waveResult.durationMs}ms`
      );

      const status = await requestJson('GET', '/status');
      const instances = status.body?.instances || [];
      const runningCount = instances.filter((i) => i.state === 'running').length;
      const startingCount = instances.filter((i) => i.state === 'starting').length;
      console.log(`Gateway status after wave ${wave}: running=${runningCount}, starting=${startingCount}`);

      // Keep pressure high but still allow status/log inspection between waves.
      await delay(500);
    }

    const totalOk = results.reduce((sum, r) => sum + r.okCount, 0);
    const totalFail = results.reduce((sum, r) => sum + r.failCount, 0);
    const failureSamples = results.flatMap((r) => r.failures).slice(0, 5);

    const crashSignature = managerLogs.some(
      (line) =>
        line.includes('code=3221225477') ||
        line.includes('code=3221226505') ||
        line.toLowerCase().includes('access violation')
    );

    console.log('\n=== Summary ===');
    console.log(`Total requests: ${waves * concurrency}`);
    console.log(`Successful: ${totalOk}`);
    console.log(`Failed: ${totalFail}`);
    if (failureSamples.length > 0) {
      console.log('Failure samples:');
      for (const sample of failureSamples) {
        console.log(JSON.stringify(sample));
      }
    }

    if (crashSignature || totalFail > 0) {
      console.error('Reproduction signal detected: non-zero failures or access violation signature in logs.');
      process.exitCode = 2;
      return;
    }

    console.log('No crash signal detected in this run.');
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (managerStartedByTest && manager) {
      manager.kill('SIGINT');
    }
  }
}

main();