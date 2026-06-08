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

// ── Chunker ─────────────────────────────────────────────
// For embedding inputs that exceed the per-request chunk size
// (configured by embeddingChunkSizeChars), split the string into
// non-overlapping windows, embed each, and mean-pool the result.
// The cloud is the spec; it accepts up to ~500k chars and returns
// one 2560-dim vector. We do the same on the local gateway.
//
// This is the Phase 3 chunker from
// docs/embedding-pipeline-refactor-plan.md. The "character-aligned
// chunks with overlap" approach was chosen over token-aligned chunks
// to avoid a tokenizer dependency. Mean-pooling is robust to
// mid-word boundaries for the Qwen3 Embedding model (it was trained
// with similar pooling strategies).

const CHUNKER_DEFAULT_SIZE = 5000;
const CHUNKER_DEFAULT_OVERLAP = 200;

function getChunkerConfig() {
  const size = Number(config.embeddingChunkSizeChars);
  const overlap = Number(config.embeddingChunkOverlapChars);
  return {
    size: Number.isFinite(size) && size >= 1000 ? Math.floor(size) : CHUNKER_DEFAULT_SIZE,
    overlap: Number.isFinite(overlap) && overlap >= 0 ? Math.floor(overlap) : CHUNKER_DEFAULT_OVERLAP,
  };
}

function chunkString(s, size, overlap) {
  if (typeof s !== 'string' || s.length <= size) return [s];
  const step = Math.max(1, size - overlap);
  const out = [];
  for (let start = 0; start < s.length; start += step) {
    const end = Math.min(s.length, start + size);
    out.push(s.slice(start, end));
    if (end === s.length) break;
  }
  return out;
}

function meanPoolVectors(vectors) {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new Error('meanPoolVectors: empty input');
  }
  // Find first valid vector to determine dim.
  let dim = null;
  for (const v of vectors) {
    if (Array.isArray(v) && typeof v.length === 'number') { dim = v.length; break; }
  }
  if (dim == null) {
    throw new Error('meanPoolVectors: no valid vector to determine dim');
  }
  const acc = new Float64Array(dim);
  let used = 0;
  for (let vi = 0; vi < vectors.length; vi++) {
    const v = vectors[vi];
    if (!Array.isArray(v)) {
      throw new Error(`meanPoolVectors: input[${vi}] is not an array (got ${typeof v})`);
    }
    if (v.length !== dim) {
      throw new Error(`meanPoolVectors: input[${vi}] has dim ${v.length}, expected ${dim}`);
    }
    for (let i = 0; i < dim; i++) acc[i] += v[i];
    used++;
  }
  if (used === 0) {
    throw new Error('meanPoolVectors: no vectors to pool');
  }
  for (let i = 0; i < dim; i++) acc[i] /= used;
  return Array.from(acc);
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (maxBytes > 0 && total > maxBytes) {
        aborted = true;
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (aborted) return;
      reject(err);
    });
  });
}

async function postEmbeddingToInstance(instance, bodyText, trace) {
  // Send a single embedding POST directly to the llama-server instance
  // (not through the manager). Returns the parsed JSON response.
  const targetUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${instance.port}/v1/embeddings`;
  const r = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyText,
  });
  const text = await r.text();
  if (!r.ok) {
    if (trace) {
      log.warn(`EmbedTrace ${trace.requestId} chunk sub-request failed`, {
        requestId: trace.requestId,
        targetPort: instance.port,
        status: r.status,
        bodyFirst200: text.slice(0, 200),
      });
    }
    throw Object.assign(new Error(`Chunk sub-request returned ${r.status}: ${text.slice(0, 200)}`), {
      status: r.status,
      body: text,
    });
  }
  return JSON.parse(text);
}

function buildOpenAIEmbeddingResponse(vectors, model) {
  return {
    object: 'list',
    data: vectors.map((embedding, i) => ({
      object: 'embedding',
      index: i,
      embedding,
    })),
    model: model || 'local-gguf',
    usage: {
      // OpenAI returns prompt_tokens / total_tokens; we don't track
      // tokens here. The LLM Gateway doesn't read these fields.
      prompt_tokens: 0,
      total_tokens: 0,
    },
  };
}

// Extract the "input" field from a JSON body. Returns the parsed
// object or null if the body isn't a valid embeddings request.
function parseEmbeddingInput(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const input = j?.input ?? j?.content;
    if (input == null) return { input: null, isArray: false, isString: false };
    return {
      input,
      isArray: Array.isArray(input),
      isString: typeof input === 'string',
    };
  } catch {
    return { input: null, isArray: false, isString: false };
  }
}

// Decide which strings in an embedding request need chunking.
// Returns a list of { index, chunks } entries — only for entries
// where chunking is required. Entries not in the result are passed
// through as-is. The 'index' is the position in the input array (or
// 0 for a single string).
function planChunking(input, isArray, chunkCfg) {
  const result = [];
  const size = chunkCfg.size;
  if (isArray) {
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      if (typeof item === 'string' && item.length > size) {
        result.push({ index: i, chunks: chunkString(item, size, chunkCfg.overlap) });
      }
    }
  } else if (typeof input === 'string' && input.length > size) {
    result.push({ index: 0, chunks: chunkString(input, size, chunkCfg.overlap) });
  }
  return result;
}

// Entry point for embedding requests. Buffers the request body,
// runs the chunker if any string exceeds the chunk size, and
// returns the OpenAI-spec response. For non-chunked inputs this is
// functionally identical to proxyToInstance but goes through the
// buffer-read path.
async function dispatchEmbedding(req, res, instance, modelConfig, trace) {
  const maxBytes = getEmbeddingMaxRequestBytes();
  let bodyBuffer;
  try {
    bodyBuffer = await readRequestBody(req, maxBytes);
  } catch (err) {
    if (trace) {
      log.error(`EmbedTrace ${trace.requestId} body read failed`, {
        requestId: trace.requestId,
        error: err.message,
      });
    }
    if (trace?.modelPath) recordEmbeddingFailure(trace.modelPath, err.message, trace);
    return sendJson(res, 413, {
      error: 'Embedding body read failed',
      details: err.message,
    });
  }

  if (trace) {
    const bodyText = bodyBuffer.toString('utf-8');
    const summary = summarizeEmbeddingInput(bodyText);
    log.info(`EmbedTrace ${trace.requestId} body-shape`, {
      requestId: trace.requestId,
      stage: 'request-end',
      tracedBytes: bodyBuffer.length,
      truncated: false,
      summary,
    });
  }

  let result;
  try {
    result = await runChunkerOnBufferedBody(bodyBuffer, instance, modelConfig.modelName, trace);
  } catch (err) {
    if (trace) {
      log.error(`EmbedTrace ${trace.requestId} chunker failed`, {
        requestId: trace.requestId,
        targetPort: instance.port,
        durationMs: 0,
        error: err.message,
        stack: err.stack,
      });
    }
    if (trace?.modelPath) recordEmbeddingFailure(trace.modelPath, err.message, trace);
    // If the upstream returned a structured error, surface its body
    // to the client so the LLM Gateway can route to the cloud.
    if (err.status) {
      return sendJson(res, err.status, {
        error: 'Embedding backend error',
        details: err.message,
      });
    }
    return sendJson(res, 502, {
      error: 'Bad Gateway',
      details: err.message,
    });
  }

  if (result.errorResponse) {
    return sendJson(res, result.errorResponse.status, result.errorResponse.body);
  }

  if (trace?.modelPath) resetEmbeddingFailures(trace.modelPath);

  if (trace) {
    log.info(`EmbedTrace ${trace.requestId} chunker end`, {
      requestId: trace.requestId,
      targetPort: instance.port,
      statusCode: 200,
    });
  }

  sendJson(res, 200, result.response);
}

// Run the chunker for an embedding request whose body has been
// buffered. Returns the OpenAI-spec response body. The returned
// response mirrors the shape the LLM Gateway expects: one
// `data[i].embedding` for each input string, in order. For chunked
// inputs, the entry's `embedding` is the mean of its chunks' embeddings.
async function runChunkerOnBufferedBody(bodyBuffer, instance, modelName, trace) {
  const bodyText = bodyBuffer.toString('utf-8');
  const parsed = parseEmbeddingInput(bodyText);
  if (parsed.input == null) {
    // Body isn't a valid embeddings request — return an error.
    return {
      errorResponse: { status: 400, body: { error: 'Bad Request', details: 'Could not parse embedding input.' } },
    };
  }

  const chunkCfg = getChunkerConfig();
  const plan = planChunking(parsed.input, parsed.isArray, chunkCfg);

  // Build a JSON-serialisable input array for our sub-requests,
  // expanding any chunked entries into the planned chunks.
  const flatInputs = []; // array of strings we will POST
  const outIndex = [];   // outIndex[i] = original-index of flatInputs[i]
  const chunkCount = []; // chunkCount[origIdx] = number of chunks (1 for non-chunked)

  const items = parsed.isArray ? parsed.input : [parsed.input];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item === 'string') {
      const chunked = plan.find((p) => p.index === i);
      if (chunked) {
        for (const c of chunked.chunks) {
          flatInputs.push(c);
          outIndex.push(i);
        }
        chunkCount[i] = chunked.chunks.length;
      } else {
        flatInputs.push(item);
        outIndex.push(i);
        chunkCount[i] = 1;
      }
    } else {
      // Non-string items (numbers, arrays) — pass through as a JSON
      // string. They won't trigger chunking.
      const asStr = Array.isArray(item) ? item.join(' ') : JSON.stringify(item);
      flatInputs.push(asStr);
      outIndex.push(i);
      chunkCount[i] = 1;
    }
  }

  if (trace) {
    log.info(`EmbedTrace ${trace.requestId} chunker plan`, {
      requestId: trace.requestId,
      modelPath: trace.modelPath,
      chunkSize: chunkCfg.size,
      chunkOverlap: chunkCfg.overlap,
      inputCount: items.length,
      flatCount: flatInputs.length,
      chunkedEntries: plan.length,
    });
  }

  // If nothing actually needs chunking, fall through to a single
  // sub-request that mirrors the original body — preserves the
  // response shape exactly.
  if (plan.length === 0) {
    const r = await postEmbeddingToInstance(instance, bodyText, trace);
    // postEmbeddingToInstance returns the parsed JSON; we want the
    // body as-is, so return it.
    return { response: r };
  }

  // Issue one sub-request per flat input. We serialise through the
  // embeddingGates map in the calling site (runInference is wrapped
  // in runWithEmbeddingGate) so concurrent calls don't fan out
  // unbounded. Promise.all is fine because the gate limits to
  // `embeddingMaxConcurrency` in flight at any time.
  const subBodies = flatInputs.map((s) => JSON.stringify({ model: modelName || 'local-gguf', input: s }));
  const subResponses = await Promise.all(
    subBodies.map((b, i) => postEmbeddingToInstance(instance, b, trace).catch((err) => {
      if (trace) {
        log.error(`EmbedTrace ${trace.requestId} chunk sub ${i} failed`, {
          requestId: trace.requestId,
          index: i,
          error: err.message,
          bodyFirst200: err.body?.slice(0, 200),
        });
      }
      return { error: err.message, body: err.body, status: err.status };
    })),
  );

  // Mean-pool chunks back into per-original-input vectors.
  const vectors = new Array(items.length);
  for (let origIdx = 0; origIdx < items.length; origIdx++) vectors[origIdx] = null;
  for (let flatIdx = 0; flatIdx < subResponses.length; flatIdx++) {
    const origIdx = outIndex[flatIdx];
    const sub = subResponses[flatIdx];
    if (sub && sub.error) {
      throw new Error(`Chunk sub ${flatIdx} failed: ${sub.error} (body first 200: ${(sub.body || '').slice(0, 200)})`);
    }
    const v = sub?.data?.[0]?.embedding;
    if (!Array.isArray(v)) {
      throw new Error(`Sub-response missing embedding vector at flat index ${flatIdx} (keys: ${Object.keys(sub || {}).join(',')})`);
    }
    if (chunkCount[origIdx] === 1) {
      vectors[origIdx] = v;
    } else {
      if (!Array.isArray(vectors[origIdx])) vectors[origIdx] = [];
      vectors[origIdx].push(v);
    }
  }
  for (let i = 0; i < vectors.length; i++) {
    // Only mean-pool if vectors[i] is an array whose first element
    // is itself an array (i.e., a list of chunk vectors). For
    // non-chunked inputs, vectors[i] is a single flat 2560-float
    // array — don't mean-pool that.
    if (
      Array.isArray(vectors[i]) &&
      vectors[i].length > 1 &&
      Array.isArray(vectors[i][0])
    ) {
      vectors[i] = meanPoolVectors(vectors[i]);
    }
  }

  return {
    response: buildOpenAIEmbeddingResponse(vectors, modelName),
  };
}

function proxyBufferedBody(bodyBuffer, contentType, instance, trace) {
  // Variant of proxyToInstance that sends a pre-buffered body to the
  // llama-server instance. Used by the chunker when it has already
  // read the request body and needs to dispatch a re-shaped payload
  // (e.g., a single chunk from a longer input).
  return new Promise((resolve, reject) => {
    const targetUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${instance.port}/v1/embeddings`;
    const startedAt = Date.now();
    const r = fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'application/json' },
      body: bodyBuffer,
    });
    r.then(async (res) => {
      const text = await res.text();
      if (!res.ok) {
        if (trace) {
          log.warn(`EmbedTrace ${trace.requestId} buffered sub-request failed`, {
            requestId: trace.requestId,
            targetPort: instance.port,
            status: res.status,
            bodyFirst200: text.slice(0, 200),
          });
        }
        reject(Object.assign(new Error(`Buffered sub-request returned ${res.status}`), {
          status: res.status,
          body: text,
        }));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error(`Failed to parse buffered response as JSON: ${e.message}`));
      }
    }).catch((err) => {
      if (trace) {
        log.error(`EmbedTrace ${trace.requestId} buffered sub-request error`, {
          requestId: trace.requestId,
          targetPort: instance.port,
          durationMs: Date.now() - startedAt,
          error: err.message,
        });
      }
      reject(err);
    });
  });
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

    const dispatch = (inst) => {
      if (embeddingsRoute) {
        return dispatchEmbedding(req, res, inst, modelConfig, trace ? { ...trace, modelPath: finalModelPath } : null);
      }
      return proxyToInstance(req, res, inst, trace ? { ...trace, modelPath: finalModelPath } : null);
    };

    const existing = getInstance(finalModelPath);
    if (existing && existing.state === 'running') {
      return dispatch(existing);
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
        return dispatch(inst);
      }

      const runningInstance = getInstance(finalModelPath);
      return dispatch(runningInstance);
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
