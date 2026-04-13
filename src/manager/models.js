import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';

const log = createLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VALID_EXTENSIONS = ['.gguf', '.mmproj'];

let tuneResultsCache = null;
let tuneResultsMtime = 0;

async function loadTuneResults() {
    const tunePath = path.resolve(__dirname, '../../scripts/tune-results.json');
    try {
        const stat = await fs.stat(tunePath);
        if (tuneResultsCache && stat.mtimeMs === tuneResultsMtime) {
            return tuneResultsCache;
        }
        const raw = await fs.readFile(tunePath, 'utf-8');
        tuneResultsCache = JSON.parse(raw);
        tuneResultsMtime = stat.mtimeMs;
        return tuneResultsCache;
    } catch {
        return {};
    }
}

function normalizePath(p) {
    return p.replace(/\\/g, '/').replace(/\//g, path.posix.sep);
}

async function extractGgufMetadata(filePath) {
    let fd;
    const metadata = {};
    try {
        fd = await fs.open(filePath, 'r');
        const CHUNK_SIZE = 1024 * 1024 * 2;
        const buf = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, 0);

        if (bytesRead < 24) return metadata;

        const magic = buf.readUInt32LE(0);
        if (magic !== 0x46554747) return metadata;

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
                switch(type) {
                    case 0: case 1: case 7:
                        val = buf[offset]; offset += 1; break;
                    case 2: case 3:
                        offset += 2; break;
                    case 4:
                        val = buf.readUInt32LE(offset); offset += 4; break;
                    case 5:
                        val = buf.readInt32LE(offset); offset += 4; break;
                    case 6:
                        offset += 4; break;
                    case 10:
                        val = Number(buf.readBigUInt64LE(offset)); offset += 8; break;
                    case 11:
                        val = Number(buf.readBigInt64LE(offset)); offset += 8; break;
                    case 12:
                        offset += 8; break;
                    case 8:
                        if (offset + 8 > bytesRead) break;
                        const strLen = Number(buf.readBigUInt64LE(offset)); offset += 8;
                        if (offset + strLen <= bytesRead) {
                            val = buf.toString('utf8', offset, offset + strLen);
                        }
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
                if (key.endsWith('.context_length')) metadata.context_length = parsedValue;
                if (key.endsWith('.block_count')) metadata.block_count = parsedValue;
                if (key === 'general.architecture') metadata.architecture = parsedValue;
                if (key === 'general.name') metadata.model_name = parsedValue;
                if (key === 'general.parameter_count') metadata.parameter_count = parsedValue;
                if (key === 'general.file_type') metadata.file_type = parsedValue;
                if (key === 'general.type') metadata.general_type = parsedValue;
            }
        }
    } catch (err) {
        log.warn(`Failed to parse metadata for ${filePath}: ${err.message}`);
    } finally {
        if (fd) await fd.close();
    }
    return metadata;
}

export async function discoverModels(dir = config.modelsDir) {
    const results = [];
    const tuneResults = await loadTuneResults();

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                const nested = await discoverModels(fullPath);
                results.push(...nested);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (VALID_EXTENSIONS.includes(ext)) {
                    const relativePath = path.relative(config.modelsDir, fullPath);
                    const type = ext === '.mmproj' ? 'vision-projector' : 'llm';
                    
                    const modelObj = {
                        name: entry.name,
                        path: relativePath,
                        fullPath,
                        type
                    };

                    if (type === 'llm') {
                        const meta = await extractGgufMetadata(fullPath);
                        Object.assign(modelObj, meta);

                        // Detect vision support from GGUF metadata
                        if (meta.architecture && meta.architecture.includes('mllm')) {
                            modelObj.vision = true;
                        }

                        // Enrich with tune-results.json data
                        const normalizedRel = normalizePath(relativePath);
                        for (const [tuneKey, tuneData] of Object.entries(tuneResults)) {
                            const normalizedTune = normalizePath(tuneKey);
                            if (normalizedRel === normalizedTune || normalizedRel.endsWith(normalizedTune) || normalizedTune.endsWith(normalizedRel)) {
                                modelObj.benchmark = {
                                    type: tuneData.type,
                                    vramGB: tuneData.vramGB,
                                    testedAt: tuneData.testedAt,
                                };

                                if (tuneData.type === 'vision') {
                                    modelObj.vision = true;
                                    modelObj.benchmark.textTokPerSec = tuneData.textTokPerSec;
                                    modelObj.benchmark.textPromptMs = tuneData.textPromptMs;
                                    modelObj.benchmark.visionAvgMs = tuneData.visionAvgMs;
                                    modelObj.benchmark.visionTokPerSec = tuneData.visionTokPerSec;
                                } else if (tuneData.type === 'embedding') {
                                    modelObj.benchmark.singleThreadMs = tuneData.singleThreadMs;
                                    modelObj.benchmark.bestConcurrency = tuneData.bestConcurrency;
                                    modelObj.benchmark.bestReqPerSec = tuneData.bestReqPerSec;
                                } else if (tuneData.type === 'completion') {
                                    modelObj.benchmark.speed = tuneData.speed;
                                    modelObj.benchmark.promptEvalMs = tuneData.promptEvalMs;
                                    modelObj.benchmark.tokenEvalMs = tuneData.tokenEvalMs;
                                }
                                break;
                            }
                        }
                    }
                    
                    results.push(modelObj);
                }
            }
        }
    } catch (err) {
        log.error(`Failed to scan directory ${dir}: ${err.message}`);
        return [];
    }

    return results;
}
