import fs from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';

const log = createLogger();

/**
 * Valid model file extensions
 */
const VALID_EXTENSIONS = ['.gguf', '.mmproj'];

/**
 * A tiny, zero-dependency, fail-fast GGUF header parser.
 * It reads up to the first 2MB of a file trying to extract key metadata.
 * @param {string} filePath 
 * @returns {Promise<Object>}
 */
async function extractGgufMetadata(filePath) {
    let fd;
    const metadata = {};
    try {
        fd = await fs.open(filePath, 'r');
        
        // 2MB is generally more than enough to capture the KV metadata headers
        const CHUNK_SIZE = 1024 * 1024 * 2; 
        const buf = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, 0);

        if (bytesRead < 24) return metadata;

        const magic = buf.readUInt32LE(0);
        if (magic !== 0x46554747) return metadata; // 0x46554747 == 'GGUF'

        // Skip version (4 bytes), skip tensor_count (8 bytes)
        const kvCount = Number(buf.readBigUInt64LE(16));
        let offset = 24;

        for (let i = 0; i < kvCount; i++) {
            if (offset + 8 > bytesRead) break; // Out of buffer bounds
            
            const keyLen = Number(buf.readBigUInt64LE(offset));
            offset += 8;

            if (offset + keyLen > bytesRead) break;
            const key = buf.toString('utf8', offset, offset + keyLen);
            offset += keyLen;

            if (offset + 4 > bytesRead) break;
            const valType = buf.readUInt32LE(offset);
            offset += 4;

            // Advance offset recursively based on GGUF Value Types
            function parseValue(type) {
                if (offset > bytesRead) return null;
                let val = null;
                switch(type) {
                    case 0: // UINT8
                    case 1: // INT8
                    case 7: // BOOL
                        val = buf[offset]; offset += 1; break;
                    case 2: // UINT16
                    case 3: // INT16
                        offset += 2; break; // Skip
                    case 4: // UINT32
                        val = buf.readUInt32LE(offset); offset += 4; break;
                    case 5: // INT32
                        val = buf.readInt32LE(offset); offset += 4; break;
                    case 6: // FLOAT32
                        offset += 4; break; // Skip
                    case 10: // UINT64
                        val = Number(buf.readBigUInt64LE(offset)); offset += 8; break;
                    case 11: // INT64
                        val = Number(buf.readBigInt64LE(offset)); offset += 8; break;
                    case 12: // FLOAT64
                        offset += 8; break; // Skip
                    case 8: // STRING
                        if (offset + 8 > bytesRead) break;
                        const strLen = Number(buf.readBigUInt64LE(offset)); offset += 8;
                        if (offset + strLen <= bytesRead) {
                            val = buf.toString('utf8', offset, offset + strLen);
                        }
                        offset += strLen; break;
                    case 9: // ARRAY
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
            }
        }
    } catch (err) {
        log.warn(`Failed to parse metadata for ${filePath}: ${err.message}`);
    } finally {
        if (fd) await fd.close();
    }
    return metadata;
}

/**
 * Recursively scans a directory for files matching the allowed extensions.
 * @param {string} dir 
 * @returns {Promise<Array<{name: string, path: string, type: string, context_length?: number}>>}
 */
export async function discoverModels(dir = config.modelsDir) {
    const results = [];
    
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
                    // We return relative paths from the base modelsDir
                    const relativePath = path.relative(config.modelsDir, fullPath);
                    // Determine type for clarity
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
                    }
                    
                    results.push(modelObj);
                }
            }
        }
    } catch (err) {
        log.error(`Failed to scan directory ${dir}: ${err.message}`);
        // Design Failures Away: Return empty array rather than totally crashing the manager.
        // It's a truth state: there are 0 models we can read right now.
        return [];
    }

    return results;
}
