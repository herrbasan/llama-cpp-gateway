import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// ── Config ─────────────────────────────────────────────
const configFile = path.resolve(projectRoot, 'config.json');
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));

const MODELS_DIR = cfg.modelsDir;
const LLAMA_SERVER = path.resolve(projectRoot, cfg.llamaServerPath);
const SERVER_PORT = cfg.serverPort + 1; // Use a different port to avoid conflict with manager
const SERVER_HOST = cfg.host === '0.0.0.0' ? '127.0.0.1' : (cfg.host || '127.0.0.1');
const TEST_PROMPT = `Write a comprehensive technical analysis of modern GPU computing architectures and their programming models. Cover the following topics in depth:

1. **CUDA Ecosystem**: Discuss NVIDIA's CUDA platform, including its programming model, memory hierarchy, and optimization techniques. Cover shared memory, constant memory, texture memory, and how they impact performance. Discuss warp-level programming, cooperative groups, and tensor cores.

2. **Vulkan Compute**: Analyze the Vulkan API for compute workloads. Discuss its explicit synchronization model, pipeline barriers, descriptor sets, and how it compares to CUDA in terms of control and complexity. Cover SPIR-V shader compilation and cross-vendor implications.

3. **SYCL and Open Standards**: Examine Intel's SYCL programming model built on OpenCL. Discuss single-source C++ programming, device selectors, and how SYCL aims to provide portability across GPU vendors. Cover the DPC++ implementation and ecosystem maturity.

4. **Performance Comparison**: Provide a detailed comparison of these platforms across multiple dimensions: raw compute throughput, memory bandwidth utilization, latency characteristics, programming complexity, and ecosystem support. Include specific benchmarks where relevant.

5. **Use Case Analysis**: For each platform, identify specific workloads where it excels: deep learning training, inference, scientific simulation, video encoding, ray tracing, and general-purpose computation.

6. **Future Directions**: Discuss emerging trends including unified memory, chiplet architectures, and how these might affect the programming models going forward.

Provide specific examples and code snippets where appropriate to illustrate key concepts.`;
const TEST_TOKENS = 1000;

// ── Results Storage ─────────────────────────────────────
const RESULTS_FILE = path.join(__dirname, 'tune-results.json');

function loadResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveResults(results) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
}

// ── Helpers ─────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const EMBEDDING_ARCHS = ['bert', 'nomic-bert', 'jina-bert', 'qwen2', 'gemma', 'clip', 'bge'];
const VISION_ARCHS = ['qwen2vl', 'minicpm', 'llava', 'qwen2-vl', 'phi3-v', 'mllama'];

function isEmbeddingModel(arch, name) {
  if (!arch) return name.toLowerCase().includes('embed');
  return EMBEDDING_ARCHS.some(a => arch.toLowerCase().includes(a)) &&
    (name.toLowerCase().includes('embed') || name.toLowerCase().includes('bge'));
}

function isVisionModel(arch, name, dir) {
  // Check for mmproj file first - most reliable indicator
  try {
    const entries = fs.readdirSync(dir);
    if (entries.some(f => f.toLowerCase().includes('mmproj') && f.endsWith('.gguf'))) return true;
  } catch {}
  // Fallback: known vision-only architectures
  if (VISION_ARCHS.some(a => (arch || '').toLowerCase().includes(a))) return true;
  if (name.toLowerCase().includes('vl') || name.toLowerCase().includes('vision')) return true;
  return false;
}

function findMmproj(dir, modelPath) {
  try {
    const entries = fs.readdirSync(dir);
    const mmproj = entries.find(f => f.toLowerCase().includes('mmproj') && f.endsWith('.gguf'));
    if (mmproj) return path.join(dir, mmproj);
  } catch {}
  return null;
}

// ── Vision Test Image ───────────────────────────────────
const TEST_IMAGE_PATH = path.join(__dirname, 'test_image.jpg');
let TEST_IMAGE_BASE64 = null;

async function loadTestImage() {
  if (TEST_IMAGE_BASE64) return TEST_IMAGE_BASE64;
  try {
    const data = await fs.promises.readFile(TEST_IMAGE_PATH);
    TEST_IMAGE_BASE64 = data.toString('base64');
    return TEST_IMAGE_BASE64;
  } catch (err) {
    console.error(`\nTest image not found: ${TEST_IMAGE_PATH}`);
    console.error('Place an image at scripts/test_image.jpg for vision testing.');
    process.exit(1);
  }
}

function question(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function log(msg) {
  console.log(`\n${msg}`);
}

function logStep(msg) {
  console.log(`\n━━━ ${msg} ━━━`);
}

// ── GGUF Header Parser ──────────────────────────────────
async function readGgufMetadata(filePath) {
  let fd;
  const meta = { contextLength: null, architecture: null, embeddingLength: null };
  try {
    fd = await fs.promises.open(filePath, 'r');
    const CHUNK_SIZE = 1024 * 1024 * 2;
    const buf = Buffer.alloc(CHUNK_SIZE);
    const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, 0);
    if (bytesRead < 24) return meta;

    const magic = buf.readUInt32LE(0);
    if (magic !== 0x46554747) return meta;

    const kvCount = Number(buf.readBigUInt64LE(16));
    let offset = 24;

    for (let i = 0; i < kvCount; i++) {
      if (offset + 8 > bytesRead) break;
      const keyLen = Number(buf.readBigUInt64LE(offset));
      offset += 8;
      if (offset + keyLen > bytesRead) break;
      const key = buf.toString('utf8', offset, offset + keyLen);
      offset += keyLen;
      if (offset + 4 > bytesRead) break;
      const valType = buf.readUInt32LE(offset);
      offset += 4;

      function parseValue(type) {
        if (offset > bytesRead) return null;
        let val = null;
        switch (type) {
          case 0: case 1: case 7: val = buf[offset]; offset += 1; break;
          case 2: case 3: offset += 2; break;
          case 4: val = buf.readUInt32LE(offset); offset += 4; break;
          case 5: val = buf.readInt32LE(offset); offset += 4; break;
          case 6: offset += 4; break;
          case 10: val = Number(buf.readBigUInt64LE(offset)); offset += 8; break;
          case 11: val = Number(buf.readBigInt64LE(offset)); offset += 8; break;
          case 12: offset += 8; break;
          case 8:
            if (offset + 8 > bytesRead) break;
            const strLen = Number(buf.readBigUInt64LE(offset)); offset += 8;
            if (offset + strLen <= bytesRead) val = buf.toString('utf8', offset, offset + strLen);
            offset += strLen; break;
          case 9:
            if (offset + 12 > bytesRead) break;
            const arrType = buf.readUInt32LE(offset); offset += 4;
            const arrLen = Number(buf.readBigUInt64LE(offset)); offset += 8;
            for (let j = 0; j < arrLen; j++) parseValue(arrType);
            break;
        }
        return val;
      }

      const parsedValue = parseValue(valType);
      if (parsedValue !== null) {
        if (key.endsWith('.context_length')) meta.contextLength = parsedValue;
        if (key === 'general.architecture') meta.architecture = parsedValue;
        if (key.endsWith('.embedding_length')) meta.embeddingLength = parsedValue;
      }
    }
  } catch {
    // Ignore parse errors
  } finally {
    if (fd) await fd.close();
  }
  return meta;
}
async function findModels(dir) {
  const models = [];
  if (!fs.existsSync(dir)) {
    console.error(`Models directory not found: ${dir}`);
    console.error('Set MODELS_DIR env var to your models folder.');
    process.exit(1);
  }

  function scan(currentPath, relativePath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      if (entry.isDirectory()) {
        scan(fullPath, relPath);
      } else if (entry.name.endsWith('.gguf') && !entry.name.includes('mmproj')) {
        models.push({ name: entry.name, path: relPath, fullPath, dir: currentPath });
      }
    }
  }

  scan(dir, '');

  // Read context length for each model
  console.log('Reading model metadata...');
  for (const m of models) {
    const meta = await readGgufMetadata(m.fullPath);
    m.contextLength = meta.contextLength;
    m.architecture = meta.architecture;
    m.embeddingLength = meta.embeddingLength;
    m.isEmbedding = isEmbeddingModel(meta.architecture, m.name);
    m.isVision = isVisionModel(meta.architecture, m.name, m.dir);
    m.mmprojPath = findMmproj(m.dir, m.fullPath);
  }

  return models;
}

// ── Server Control ──────────────────────────────────────
function startServer(modelPath, ctxSize, gpuLayers, mmprojPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath,
      '--port', String(SERVER_PORT),
      '-c', String(ctxSize),
      '-ngl', String(gpuLayers),
      '--flash-attn', 'on',
    ];
    if (mmprojPath) args.push('--mmproj', mmprojPath);

    log(`Spawning: ${LLAMA_SERVER}`);
    log(`Args: ${args.join(' ')}\n`);

    const proc = spawn(LLAMA_SERVER, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let output = '';
    let resolved = false;

    function onData(text) {
      process.stdout.write(text);
      output += text;
      if (!resolved && (output.includes('HTTP server listening') || output.includes('starting the main loop'))) {
        resolved = true;
        resolve({ proc, kill: () => proc.kill('SIGINT'), output });
      }
    }

    proc.stderr.on('data', data => onData(data.toString()));
    proc.stdout.on('data', data => onData(data.toString()));

    proc.on('error', err => reject(err));
    proc.on('exit', code => {
      if (!resolved) {
        reject(new Error(`llama-server exited with code ${code}`));
      }
    });

    // Timeout after 120s (large models take time)
    setTimeout(() => {
      if (!resolved) reject(new Error('Server startup timed out (120s)'));
    }, 120000);
  });
}

async function waitForHealth(maxRetries = 60) {
  for (let i = 0; i < maxRetries; i++) {
    process.stdout.write('.');
    try {
      const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/health`, { timeout: 2000 });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok') {
          console.log(' OK');
          return true;
        }
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(' FAILED');
  return false;
}

async function runCompletion() {
  const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: TEST_PROMPT,
      n_predict: TEST_TOKENS,
      temperature: 0.1,
      stream: false,
    }),
  });

  const data = await res.json();

  return {
    content: data.content || '',
    tokensPredicted: data.tokens_predicted || 0,
    timings: data.timings || {},
  };
}

async function runEmbedding(iterations = 100) {
  const testText = 'The quick brown fox jumps over the lazy dog. This is a test sentence for measuring embedding model performance and vector generation speed.';
  const times = [];

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: testText }),
    });
    const data = await res.json();
    times.push(Date.now() - start);
    if (i === 0) var dimensions = data.embedding?.length || 0;
  }

  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);

  return { dimensions, avgMs, minMs, maxMs, iterations };
}

async function runEmbeddingConcurrency(concurrency, iterations = 50) {
  const testText = 'The quick brown fox jumps over the lazy dog. This is a test sentence for measuring embedding model performance and vector generation speed.';
  const allTimes = [];
  let dimensions = 0;

  async function worker() {
    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
    const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: testText }),
      });
      const data = await res.json();
      allTimes.push(Date.now() - start);
      if (dimensions === 0) dimensions = data.embedding?.length || 0;
    }
  }

  const wallStart = Date.now();
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const wallEnd = Date.now();
  const wallTimeMs = wallEnd - wallStart;

  const totalRequests = allTimes.length;
  const avgMs = allTimes.reduce((a, b) => a + b, 0) / allTimes.length;
  const minMs = Math.min(...allTimes);
  const maxMs = Math.max(...allTimes);
  const sorted = [...allTimes].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const reqPerSec = (totalRequests / wallTimeMs * 1000).toFixed(0);

  return { dimensions, concurrency, totalRequests, wallTimeMs, avgMs, minMs, maxMs, p50, p95, p99, reqPerSec };
}

async function runVisionTest(mmprojPath, iterations = 2) {
  const imageBase64 = await loadTestImage();
  const prompt = 'Describe this image in detail.';
  const times = [];
  let tokenCount = 0;

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    const body = {
      prompt,
      image_data: [{ data: imageBase64, id: 0 }],
      n_predict: 50,
      temperature: 0.1,
      stream: false,
    };
    if (mmprojPath) body.mmproj = mmprojPath;

  const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    times.push(Date.now() - start);
    tokenCount += data.tokens_predicted || 0;
  }

  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);
  const sorted = [...times].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  return { avgMs, minMs, maxMs, p50, p95, iterations, totalTokens: tokenCount };
}

// ── Main ────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     LLaMA Model Tuner                    ║');
  console.log('╚══════════════════════════════════════════╝');

  // Check binary
  if (!fs.existsSync(LLAMA_SERVER)) {
    console.error(`\nllama-server.exe not found at: ${LLAMA_SERVER}`);
    console.error('Run build script first: .\\build\\build-universal.ps1');
    process.exit(1);
  }

  // Find models
  logStep('Scanning for models');
  const models = await findModels(MODELS_DIR);
  if (models.length === 0) {
    console.error('No .gguf files found.');
    process.exit(1);
  }

  const results = loadResults();

  console.log(`Found ${models.length} model(s):\n`);
  models.forEach((m, i) => {
    const prev = results[m.path];
    const typeBadge = m.isVision ? ' [V]' : m.isEmbedding ? ' [E]' : '';
    const ctxBadge = m.contextLength ? ` (max ctx: ${m.contextLength.toLocaleString()})` : '';
    let prevBadge = '';
    if (prev) {
      if (prev.type === 'embedding') prevBadge = ` [prev: ${prev.avgMs}ms avg]`;
      else if (prev.type === 'vision') prevBadge = ` [prev: ${prev.avgMs}ms avg]`;
      else prevBadge = ` [prev: ${prev.speed} tok/s]`;
    }
    const debugInfo = m.architecture ? ` [arch: ${m.architecture}]` : '';
    const mmprojInfo = m.mmprojPath ? ` [mmproj: ${path.basename(m.mmprojPath)}]` : '';
    console.log(`  ${i + 1}. ${m.path}${typeBadge}${ctxBadge}${debugInfo}${mmprojInfo}${prevBadge}`);
  });

  // Select model
  const selection = await question(`\nSelect model (1-${models.length}): `);
  const idx = parseInt(selection, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= models.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  const model = models[idx];
  log(`Selected: ${model.path}`);

  // Context size
  const defaultCtx = model.contextLength || 8192;
  const ctxInput = await question(`\nMax context size (default ${defaultCtx.toLocaleString()}, max ${model.contextLength ? model.contextLength.toLocaleString() : 'unknown'}): `);
  const ctxSize = parseInt(ctxInput, 10) || defaultCtx;
  log(`Context size: ${ctxSize.toLocaleString()}`);

  // GPU layers
  const gpuInput = await question(`\nGPU layers (default 99 = all): `);
  const gpuLayers = parseInt(gpuInput, 10) ?? 99;
  log(`GPU layers: ${gpuLayers}`);

  // Start server
  logStep('Starting llama-server');
  let server;
  try {
    server = await startServer(model.fullPath, ctxSize, gpuLayers, model.mmprojPath);
  } catch (err) {
    console.error(`\nFailed to start server: ${err.message}`);
    process.exit(1);
  }

  // Wait for health
  log('Waiting for server to be ready...');
  const healthy = await waitForHealth();
  if (!healthy) {
    console.error('Server failed to become healthy.');
    server.kill();
    process.exit(1);
  }
  log('Server is ready.');

  // Run test
  if (model.isEmbedding) {
    logStep('Running embedding test (single-threaded)');
    console.log(`Test text: "The quick brown fox..."`);
    console.log(`Iterations: 100\n`);

    let embedResult;
    try {
      embedResult = await runEmbedding(100);
    } catch (err) {
      console.error(`\nEmbedding test failed: ${err.message}`);
      server.kill();
      process.exit(1);
    }

    // Parse VRAM from server output (sum all CUDA buffers)
    const vramMatches = server.output.matchAll(/CUDA\d+\s+model buffer size\s+=\s+([\d.]+)\s+MiB/g);
    let totalVramMiB = 0;
    for (const m of vramMatches) totalVramMiB += parseFloat(m[1]);
    const vramGB = totalVramMiB > 0 ? (totalVramMiB / 1024).toFixed(1) : 'N/A';

    // Report single-threaded
    logStep('Single-threaded Results');

    console.log(`
  Embedding dimensions: ${embedResult.dimensions}
  Avg time:            ${embedResult.avgMs.toFixed(1)} ms
  Min time:            ${embedResult.minMs} ms
  Max time:            ${embedResult.maxMs} ms
  VRAM used:           ${vramGB} GB
  `);

    // Concurrency test
    const concTest = await question(`\nTest concurrency? (y/n, default n): `);
    if (concTest.trim().toLowerCase() === 'y') {
      logStep('Concurrency test');
      console.log('Testing 1, 2, 4, 8, 16 parallel requests (50 iterations each)...\n');

      const levels = [1, 2, 4, 8, 16, 32, 64, 128];
      const concResults = [];

      for (const level of levels) {
        process.stdout.write(`  Concurrency ${level}... `);
        try {
          const r = await runEmbeddingConcurrency(level, 50);
          concResults.push(r);
          console.log(`${r.avgMs.toFixed(1)} ms avg`);
        } catch (err) {
          console.log(`FAILED: ${err.message}`);
        }
      }

      // Show comparison table
      logStep('Concurrency Comparison');
      console.log(`
  ┌─────────────┬────────────────────┬────────────────────┬──────────────────────┐
  │ Concurrency │ Avg (ms) │ P50 (ms) │ P95 (ms) │ P99 (ms) │ Min (ms) │ Req/s      │
  ├─────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼────────────┤`);

      for (const r of concResults) {
        const pad = (v, w) => String(v).padStart(w);
        console.log(`  │ ${pad(r.concurrency, 11)} │ ${pad(r.avgMs.toFixed(1), 8)} │ ${pad(r.p50, 8)} │ ${pad(r.p95, 8)} │ ${pad(r.p99, 8)} │ ${pad(r.minMs, 8)} │ ${pad(r.reqPerSec, 10)} │`);
      }
      console.log(`  └─────────────┴────────────────────┴────────────────────┴──────────────────────┘`);

      // Find best concurrency (highest throughput)
      const best = concResults.reduce((a, b) => parseInt(a.reqPerSec) > parseInt(b.reqPerSec) ? a : b);
      console.log(`\n  Best concurrency: ${best.concurrency} (${best.reqPerSec} req/s, ${best.avgMs.toFixed(1)} ms avg)`);

      // Save best concurrency result
      results[model.path] = {
        modelPath: model.path,
        ctxSize,
        gpuLayers,
        type: 'embedding',
        dimensions: embedResult.dimensions,
        singleThreadMs: embedResult.avgMs.toFixed(1),
        bestConcurrency: best.concurrency,
        bestReqPerSec: best.reqPerSec,
        concurrencyResults: concResults.map(r => ({
          concurrency: r.concurrency,
          avgMs: r.avgMs.toFixed(1),
          p50: r.p50,
          p95: r.p95,
          p99: r.p99,
          reqPerSec: r.reqPerSec,
        })),
        vramGB,
        testedAt: new Date().toISOString(),
      };
    } else {
      results[model.path] = {
        modelPath: model.path,
        ctxSize,
        gpuLayers,
        type: 'embedding',
        dimensions: embedResult.dimensions,
        avgMs: embedResult.avgMs.toFixed(1),
        minMs: embedResult.minMs,
        maxMs: embedResult.maxMs,
        vramGB,
        testedAt: new Date().toISOString(),
      };
    }

    // Stop server
    logStep('Stopping server');
    server.kill();
    await new Promise(r => setTimeout(r, 1000));

    // Suggested config
    logStep('Suggested config for llm_gateway');
    console.log(`
  "localInference": {
    "enabled": true,
    "modelPath": "${model.path}",
    "contextLength": ${ctxSize},
    "gpuLayers": ${gpuLayers},
    "flashAttention": true,
    "port": 4081
  }`);

    log(`Results saved to scripts/tune-results.json`);
  } else if (model.isVision) {
    // Vision models: run both completion and vision tests

    // First: normal completion test
    logStep('Running completion test (text-only)');
    console.log(`Prompt: "${TEST_PROMPT}"`);
    console.log(`Target: ${TEST_TOKENS} tokens\n`);

    let completionResult;
    try {
      completionResult = await runCompletion();
    } catch (err) {
      console.error(`\nCompletion failed: ${err.message}`);
      server.kill();
      process.exit(1);
    }

    // Second: vision test
    logStep('Running vision test');
    console.log(`Test: image + "Describe this image in detail."`);
    console.log(`Iterations: 2\n`);

    let visionResult;
    try {
      visionResult = await runVisionTest(model.mmprojPath, 2);
    } catch (err) {
      console.error(`\nVision test failed: ${err.message}`);
      server.kill();
      process.exit(1);
    }

    // Stop server
    logStep('Stopping server');
    server.kill();
    await new Promise(r => setTimeout(r, 1000));

    // Parse VRAM from server output (sum all CUDA buffers)
    const vramMatches = server.output.matchAll(/CUDA\d+\s+model buffer size\s+=\s+([\d.]+)\s+MiB/g);
    let totalVramMiB = 0;
    for (const m of vramMatches) totalVramMiB += parseFloat(m[1]);
    const vramGB = totalVramMiB > 0 ? (totalVramMiB / 1024).toFixed(1) : 'N/A';

    // Report
    logStep('Results — Text Generation');

    const tokPerSec = completionResult.timings.predicted_per_second || 0;
    console.log(`
  Tokens generated:  ${completionResult.tokensPredicted}
  Speed:             ${tokPerSec.toFixed(1)} tok/s
  Prompt eval:       ${completionResult.timings.prompt_ms?.toFixed(0) || '?'} ms
  Token eval:        ${completionResult.timings.predicted_ms?.toFixed(0) || '?'} ms
  `);

    logStep('Results — Vision');

    const visionTokPerSec = visionResult.totalTokens > 0 ? ((visionResult.totalTokens / visionResult.iterations) / (visionResult.avgMs / 1000)).toFixed(1) : 'N/A';
    const avgPerToken = visionResult.totalTokens > 0 ? (visionResult.avgMs / (visionResult.totalTokens / visionResult.iterations)).toFixed(1) : 'N/A';

    console.log(`
  Total tokens:        ${visionResult.totalTokens}
  Speed:               ${visionTokPerSec} tok/s
  Avg time/iteration:  ${visionResult.avgMs.toFixed(1)} ms
  Avg time/token:      ${avgPerToken} ms
  P50:                 ${visionResult.p50} ms
  P95:                 ${visionResult.p95} ms
  `);

    console.log(`\n  VRAM used: ${vramGB} GB`);

    // Suggested config
    logStep('Suggested config for llm_gateway');
    console.log(`
  "localInference": {
    "enabled": true,
    "modelPath": "${model.path}",
    "contextLength": ${ctxSize},
    "gpuLayers": ${gpuLayers},
    "flashAttention": true,
    "port": 4081
  }`);

    results[model.path] = {
      modelPath: model.path,
      ctxSize,
      gpuLayers,
      type: 'vision',
      // Completion results
      textTokPerSec: tokPerSec.toFixed(1),
      textPromptMs: completionResult.timings.prompt_ms?.toFixed(0) || null,
      textTokenMs: completionResult.timings.predicted_ms?.toFixed(0) || null,
      // Vision results
      visionAvgMs: visionResult.avgMs.toFixed(1),
      visionTokPerSec,
      visionP50: visionResult.p50,
      visionP95: visionResult.p95,
      vramGB,
      testedAt: new Date().toISOString(),
    };

    log(`Results saved to scripts/tune-results.json`);
  } else {
    logStep('Running completion test');
    console.log(`Prompt: "${TEST_PROMPT}"`);
    console.log(`Target: ${TEST_TOKENS} tokens\n`);

    let result;
    try {
      result = await runCompletion();
    } catch (err) {
      console.error(`\nCompletion failed: ${err.message}`);
      server.kill();
      process.exit(1);
    }

    // Stop server
    logStep('Stopping server');
    server.kill();
    await new Promise(r => setTimeout(r, 1000));

    // Parse VRAM from server output (sum all CUDA buffers)
    const vramMatches = server.output.matchAll(/CUDA\d+\s+model buffer size\s+=\s+([\d.]+)\s+MiB/g);
    let totalVramMiB = 0;
    for (const m of vramMatches) totalVramMiB += parseFloat(m[1]);
    const vramGB = totalVramMiB > 0 ? (totalVramMiB / 1024).toFixed(1) : 'N/A';

    // Report
    logStep('Results');

    const tokPerSec = result.timings.predicted_per_second || 0;

    console.log(`
  Tokens generated:  ${result.tokensPredicted}
  Speed:             ${tokPerSec.toFixed(1)} tok/s
  VRAM used:         ${vramGB} GB
  Prompt eval:       ${result.timings.prompt_ms?.toFixed(0) || '?'} ms
  Token eval:        ${result.timings.predicted_ms?.toFixed(0) || '?'} ms
  `);

    // Suggested config
    logStep('Suggested config for llm_gateway');
    console.log(`
  "localInference": {
    "enabled": true,
    "modelPath": "${model.path}",
    "contextLength": ${ctxSize},
    "gpuLayers": ${gpuLayers},
    "flashAttention": true,
    "port": 4081
  }`);

    // Save results
    results[model.path] = {
      modelPath: model.path,
      ctxSize,
      gpuLayers,
      type: 'completion',
      speed: tokPerSec.toFixed(1),
      vramGB,
      promptEvalMs: result.timings.prompt_ms?.toFixed(0) || null,
      tokenEvalMs: result.timings.predicted_ms?.toFixed(0) || null,
      tokensGenerated: result.tokensPredicted,
      testedAt: new Date().toISOString(),
    };
  }
  saveResults(results);
  log(`Results saved to scripts/tune-results.json`);

  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
