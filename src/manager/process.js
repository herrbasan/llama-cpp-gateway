import { spawn } from 'node:child_process';
import config from './config.js';
import { createLogger } from './nLogger/src/logger.js';

const log = createLogger();

let activeProcess = null;
let currentState = 'idle'; // idle, starting, running, error
let currentMetrics = {};
let currentPort = null;
let pollerInterval = null;
let isDetached = false; // true if we detached on shutdown, don't kill on exit

function stopPolling() {
    if (pollerInterval) {
        clearInterval(pollerInterval);
        pollerInterval = null;
    }
}

async function pollHealthAndMetrics() {
    if (!activeProcess && !isDetached) return stopPolling();

    const baseUrl = `http://127.0.0.1:${currentPort}`;

    if (currentState === 'starting') {
        try {
            const res = await fetch(`${baseUrl}/health`);
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'ok') {
                    log.info('llama-server reported healthy. Transitioning to running.');
                    currentState = 'running';
                }
            }
        } catch (err) {
            // Expected during startup, server not listening yet.
        }
    } else if (currentState === 'running') {
        try {
            const res = await fetch(`${baseUrl}/metrics`);
            if (res.ok) {
                const text = await res.text();
                // Simple parsing or just store raw text if JSON natively isn't exported
                // but usually prometheus metrics are text, we can just pack it as text 
                // or proxy it. Spec says "Forwarded Prometheus metrics".
                currentMetrics = { raw: text };
            }
        } catch (err) {
            log.warn(`Failed to fetch metrics: ${err.message}`);
        }
    }
}

async function checkExistingServer(port = config.serverPort) {
    // Probe the health endpoint to see if a server is already running
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { timeout: 2000 });
        if (res.ok) {
            const data = await res.json();
            if (data.status === 'ok') {
                log.info(`Found existing llama-server on port ${port}`);
                return true;
            }
        }
    } catch (err) {
        // No server running
    }
    return false;
}

function attachToServer(port) {
    // Attach to an existing server process (we don't have the PID but we know it's there)
    log.info(`Attaching to existing llama-server on port ${port}`);
    
    currentPort = port;
    currentState = 'running'; // Assume running since health check passed
    currentMetrics = {};
    activeProcess = { pid: 'unknown', detached: true }; // Placeholder, no actual process handle
    isDetached = true;
    
    // Start poller to monitor it
    stopPolling();
    pollerInterval = setInterval(pollHealthAndMetrics, 2000);
    
    return 'unknown';
}

function spawnLlamaServer(args, port) {
    if (activeProcess) {
        log.warn('Attempted to start server but it is already running. Fail fast.');
        throw new Error('Server already running');
    }

    log.info(`Spawning llama-server from ${config.llamaServerPath} with args: ${args.join(' ')}`);

    currentPort = port;
    currentState = 'starting';
    currentMetrics = {};
    isDetached = false;
    
    activeProcess = spawn(config.llamaServerPath, args, {
        cwd: process.cwd(),
        detached: false, // Ensure Node kills child if Node crashes
        windowsHide: true,
    });

    activeProcess.stdout.on('data', (data) => {
        log.info(`[STDOUT] ${data.toString().trim()}`);
    });

    activeProcess.stderr.on('data', (data) => {
        log.info(`[NATIVE] ${data.toString().trim()}`);
    });

    activeProcess.on('error', (err) => {
        log.error(`Failed to start subprocess: ${err.message}`);
        currentState = 'error';
        activeProcess = null;
        stopPolling();
    });

    activeProcess.on('exit', (code, signal) => {
        log.info(`llama-server exited with code ${code} and signal ${signal}`);
        currentState = 'idle';
        activeProcess = null;
        stopPolling();
    });

    // Start poller loop (every 2 seconds)
    stopPolling();
    pollerInterval = setInterval(pollHealthAndMetrics, 2000);

    return activeProcess.pid;
}

function killLlamaServer(options = {}) {
    const { force = false } = options;
    
    // If detached mode is enabled and not force-kill, just detach
    if (!force && config.detachOnShutdown && !isDetached) {
        log.info('DETACH_ON_SHUTDOWN enabled. Detaching from llama-server without killing.');
        isDetached = true;
        // Stop polling but keep state as running
        stopPolling();
        // Note: We keep activeProcess reference so getStatus() still reports running
        return true;
    }
    
    if (!activeProcess) {
        return true;
    }

    // If we're attached to a detached process (no real handle), just clear state
    if (isDetached && activeProcess.detached) {
        log.info('Clearing detached server state');
        activeProcess = null;
        currentState = 'idle';
        stopPolling();
        return true;
    }

    log.info(`Attempting to kill process PID: ${activeProcess.pid}`);
    
    // Polite kill
    activeProcess.kill('SIGINT');
    activeProcess = null;
    currentState = 'idle';
    isDetached = false;
    stopPolling();
    return true;
}

function getStatus() {
    return {
        state: currentState,
        pid: activeProcess ? activeProcess.pid : null,
        metrics: currentMetrics,
        detached: isDetached
    };
}

export {
    spawnLlamaServer,
    killLlamaServer,
    getStatus,
    checkExistingServer,
    attachToServer
};
