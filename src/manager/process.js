import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';

const log = createLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, 'state.json');

// Map: modelPath → { process, port, state, options, metrics, pollerInterval }
const instances = new Map();
let nextPort = config.serverPort;

function stopPolling(instance) {
    if (instance.pollerInterval) {
        clearInterval(instance.pollerInterval);
        instance.pollerInterval = null;
    }
}

async function pollHealthAndMetrics(instance) {
    const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    const baseUrl = `http://${host}:${instance.port}`;

    if (instance.state === 'starting') {
        try {
            const res = await fetch(`${baseUrl}/health`);
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'ok') {
                    log.info(`llama-server healthy on port ${instance.port}: ${path.basename(instance.modelPath)}`);
                    instance.state = 'running';
                    saveState();
                }
            }
        } catch {
            // Still starting up
        }
    } else if (instance.state === 'running') {
        try {
            const res = await fetch(`${baseUrl}/metrics`);
            if (res.ok) {
                instance.metrics = { raw: await res.text() };
            }
        } catch {
            // Metrics endpoint may not be available
        }
    }
}

async function checkExistingServer(port) {
    try {
        const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
        const res = await fetch(`http://${host}:${port}/health`, { timeout: 2000 });
        if (res.ok) {
            const data = await res.json();
            if (data.status === 'ok') return true;
        }
    } catch {
        // No server
    }
    return false;
}

function normalizeModelPath(rawPath) {
    if (path.isAbsolute(rawPath)) return rawPath;
    return path.resolve(config.modelsDir, rawPath);
}

function buildArgs(modelPath, options = {}) {
    const port = options.port;
    const ctxSize = options.ctxSize ?? config.defaultCtxSize;
    const gpuLayers = options.gpuLayers ?? config.defaultGpuLayers;
    const flashAttention = options.flashAttention ?? config.flashAttention;

    const args = [
        '-m', modelPath,
        '--port', port.toString(),
        '-c', ctxSize.toString(),
        '-ngl', gpuLayers.toString(),
    ];

    if (flashAttention) args.push('--flash-attn', 'on');
    if (options.mmprojPath) args.push('--mmproj', options.mmprojPath);
    if (options.embedding) args.push('--embedding');
    if (options.pooling) args.push('--pooling', options.pooling);
    if (options.batchSize) args.push('--batch-size', options.batchSize.toString());
    if (options.mlock) args.push('--mlock');

    return args;
}

function allocatePort() {
    const port = nextPort;
    nextPort++;
    return port;
}

function spawnServer(modelPath, options = {}) {
    const existing = instances.get(modelPath);
    if (existing && existing.state !== 'error') {
        throw new Error(`Server already running with model: ${modelPath}`);
    }

    if (instances.size >= config.maxInstances) {
        throw new Error(`Max instances reached (${config.maxInstances}). Stop a model first.`);
    }

    const port = options.port || allocatePort();
    const args = buildArgs(modelPath, { ...options, port });

    log.info(`Spawning llama-server: ${path.basename(modelPath)} on port ${port}`);

    const instance = {
        modelPath,
        port,
        state: 'starting',
        options,
        metrics: {},
        detached: false,
        process: null,
        pollerInterval: null,
    };

    instance.process = spawn(config.llamaServerPath, args, {
        cwd: process.cwd(),
        detached: false,
        windowsHide: true,
    });

    instance.process.stdout.on('data', (data) => {
        log.info(`[llama:${port}] ${data.toString().trim()}`);
    });

    instance.process.stderr.on('data', (data) => {
        log.info(`[llama:${port}] ${data.toString().trim()}`);
    });

    instance.process.on('error', (err) => {
        log.error(`Failed to start llama-server (${port}): ${err.message}`);
        instance.state = 'error';
        saveState();
    });

    instance.process.on('exit', (code, signal) => {
        log.info(`llama-server exited (${port}): code=${code}, signal=${signal}`);
        instances.delete(modelPath);
        stopPolling(instance);
        saveState();
    });

    stopPolling(instance);
    instance.pollerInterval = setInterval(() => pollHealthAndMetrics(instance), 2000);

    instances.set(modelPath, instance);
    saveState();

    return instance.process.pid;
}

function killInstance(modelPath, options = {}) {
    const { force = false } = options;
    const instance = instances.get(modelPath);
    if (!instance) return true;

    if (!force && config.detachOnShutdown && !instance.detached) {
        log.info(`Detaching from llama-server on port ${instance.port} (DETACH_ON_SHUTDOWN)`);
        instance.detached = true;
        stopPolling(instance);
        saveState();
        return true;
    }

    if (instance.detached) {
        instances.delete(modelPath);
        stopPolling(instance);
        saveState();
        return true;
    }

    log.info(`Killing llama-server PID: ${instance.process.pid} (port ${instance.port})`);
    instance.process.kill('SIGINT');
    instances.delete(modelPath);
    stopPolling(instance);
    saveState();
    return true;
}

function killAll(options = {}) {
    for (const [modelPath] of instances) {
        killInstance(modelPath, options);
    }
}

async function ensureModel(modelPath, options = {}) {
    const absolutePath = normalizeModelPath(modelPath);
    const existing = instances.get(absolutePath);

    if (existing && existing.state === 'running') {
        return { port: existing.port, alreadyRunning: true };
    }

    if (existing && (existing.state === 'starting' || existing.state === 'error')) {
        if (existing.state === 'error') {
            killInstance(absolutePath, { force: true });
        }
        // Fall through to restart
    }

    spawnServer(absolutePath, options);
    return { port: options.port || nextPort - 1, alreadyRunning: false };
}

async function reattachExisting(port, modelPath, options = {}) {
    if (await checkExistingServer(port)) {
        log.info(`Re-attaching to existing llama-server on port ${port}: ${path.basename(modelPath)}`);
        const instance = {
            modelPath,
            port,
            state: 'running',
            options,
            metrics: {},
            detached: true,
            process: { pid: 'unknown', detached: true },
            pollerInterval: null,
        };
        instance.pollerInterval = setInterval(() => pollHealthAndMetrics(instance), 2000);
        instances.set(modelPath, instance);
        return true;
    }
    return false;
}

function getInstance(modelPath) {
    return instances.get(normalizeModelPath(modelPath)) || null;
}

function getAllInstances() {
    const result = [];
    for (const [modelPath, inst] of instances) {
        result.push({
            modelPath,
            port: inst.port,
            pid: inst.process ? inst.process.pid : null,
            state: inst.state,
            detached: inst.detached,
        });
    }
    return result;
}

async function saveState() {
    const state = {};
    for (const [modelPath, inst] of instances) {
        state[modelPath] = {
            port: inst.port,
            options: inst.options,
            detached: inst.detached,
        };
    }
    try {
        await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        log.warn(`Failed to save state: ${err.message}`);
    }
}

async function loadState() {
    try {
        const raw = await fs.readFile(STATE_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

async function restoreState() {
    const state = await loadState();
    let restored = 0;
    for (const [modelPath, entry] of Object.entries(state)) {
        if (entry.detached && await checkExistingServer(entry.port)) {
            await reattachExisting(entry.port, modelPath, entry.options || {});
            restored++;
        }
    }
    if (restored > 0) {
        log.info(`Restored ${restored} detached instance(s) from state`);
    }
}

export {
    ensureModel,
    killInstance,
    killAll,
    getInstance,
    getAllInstances,
    checkExistingServer,
    reattachExisting,
    normalizeModelPath,
    restoreState,
    saveState,
};
