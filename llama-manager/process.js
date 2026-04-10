import { spawn } from 'node:child_process';
import config from './config.js';
import { createLogger } from './nLogger/src/logger.js';

const log = createLogger();

let activeProcess = null;
let currentState = 'idle'; // idle, starting, running, error
let currentMetrics = {};
let currentPort = null;
let pollerInterval = null;

function stopPolling() {
    if (pollerInterval) {
        clearInterval(pollerInterval);
        pollerInterval = null;
    }
}

async function pollHealthAndMetrics() {
    if (!activeProcess) return stopPolling();

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

function spawnLlamaServer(args, port) {
    if (activeProcess) {
        log.warn('Attempted to start server but it is already running. Fail fast.');
        throw new Error('Server already running');
    }

    log.info(`Spawning llama-server from ${config.llamaServerPath} with args: ${args.join(' ')}`);

    currentPort = port;
    currentState = 'starting';
    currentMetrics = {};
    
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

function killLlamaServer() {
    if (!activeProcess) {
        return true;
    }

    log.info(`Attempting to kill process PID: ${activeProcess.pid}`);
    
    // Polite kill
    activeProcess.kill('SIGINT');
    activeProcess = null;
    currentState = 'idle';
    stopPolling();
    return true;
}

function getStatus() {
    return {
        state: currentState,
        pid: activeProcess ? activeProcess.pid : null,
        metrics: currentMetrics
    };
}

export {
    spawnLlamaServer,
    killLlamaServer,
    getStatus
};
