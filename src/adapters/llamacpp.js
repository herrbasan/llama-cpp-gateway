/**
 * llama.cpp Adapter - Protocol handler for llama.cpp server via the Manager.
 * 
 * Reads model config from modelConfig.localInference and forwards it as
 * X-Model-* headers to the Manager (port 4080). The Manager handles
 * model lifecycle — loading, swapping, health checks. The request body
 * is proxied raw with zero transformation.
 */

import { request as httpRequest } from '../utils/http.js';

function buildModelHeaders(modelConfig) {
    const li = modelConfig.localInference;
    if (!li || !li.enabled) return {};

    const headers = {
        'X-Model-Path': li.modelPath,
    };

    if (li.contextSize !== undefined) headers['X-Model-CtxSize'] = String(li.contextSize);
    if (li.gpuLayers !== undefined) headers['X-Model-GpuLayers'] = String(li.gpuLayers);
    if (li.flashAttention !== undefined) headers['X-Model-FlashAttention'] = String(li.flashAttention);
    if (li.mmproj !== undefined) headers['X-Model-Mmproj'] = li.mmproj;
    if (li.embedding !== undefined) headers['X-Model-Embedding'] = String(li.embedding);
    if (li.pooling !== undefined) headers['X-Model-Pooling'] = li.pooling;
    if (li.batchSize !== undefined) headers['X-Model-BatchSize'] = String(li.batchSize);
    if (li.mlock !== undefined) headers['X-Model-Mlock'] = String(li.mlock);

    return headers;
}

export function createLlamaCppAdapter() {
    return {
        name: 'llamacpp',

        /**
         * Chat completion.
         */
        async chatComplete(modelConfig, request) {
            
            const { endpoint, maxTokens: configMaxTokens, extraBody } = modelConfig;
            const modelHeaders = buildModelHeaders(modelConfig);

            const payload = {
                model: 'local',
                messages: request.messages || [],
                stream: false
            };

            if (configMaxTokens !== undefined) {
                payload.max_tokens = configMaxTokens;
            } else if (request.maxTokens) {
                payload.max_tokens = request.maxTokens;
            }

            if (typeof request.temperature === 'number') payload.temperature = request.temperature;
            if (typeof request.top_p === 'number') payload.top_p = request.top_p;
            if (typeof request.frequency_penalty === 'number') payload.frequency_penalty = request.frequency_penalty;
            if (typeof request.presence_penalty === 'number') payload.presence_penalty = request.presence_penalty;
            if (request.stop) payload.stop = request.stop;

            if (extraBody) {
                Object.assign(payload, extraBody);
            }

            if (request.extra_body) {
                Object.assign(payload, request.extra_body);
            }

            logger.debug(`[llamacpp] Payload: ${JSON.stringify(payload).substring(0, 500)}`);

            const res = await httpRequest(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    ...modelHeaders,
                },
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`llama.cpp Error: ${data.error.message || JSON.stringify(data.error)}`);
            }

            return { ...data, provider: 'llamacpp' };
        },

        /**
         * Streaming chat completion.
         */
        async *streamComplete(modelConfig, request) {
            
            const { endpoint, maxTokens: configMaxTokens, extraBody, hardTokenCap } = modelConfig;
            const modelHeaders = buildModelHeaders(modelConfig);

            const payload = {
                model: 'local',
                messages: request.messages || [],
                stream: true
            };

            if (configMaxTokens !== undefined) {
                payload.max_tokens = configMaxTokens;
            } else if (request.maxTokens) {
                payload.max_tokens = request.maxTokens;
            }

            if (typeof request.temperature === 'number') payload.temperature = request.temperature;
            if (typeof request.top_p === 'number') payload.top_p = request.top_p;
            if (typeof request.frequency_penalty === 'number') payload.frequency_penalty = request.frequency_penalty;
            if (typeof request.presence_penalty === 'number') payload.presence_penalty = request.presence_penalty;
            if (request.stop) payload.stop = request.stop;

            if (extraBody) {
                Object.assign(payload, extraBody);
            }

            if (request.extra_body) {
                Object.assign(payload, request.extra_body);
            }

            const res = await httpRequest(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    ...modelHeaders,
                },
                signal: request.signal,
                body: JSON.stringify(payload)
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            let generatedTokens = 0;
            const tokenCap = hardTokenCap || configMaxTokens;
            
            let inThinkingMode = false;
            let thinkingBuffer = '';
            let sentReasoning = false;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue;

                        if (trimmed.startsWith('data: ')) {
                            const data = trimmed.slice(6);
                            if (data === '[DONE]') return;
                            try {
                                const parsed = JSON.parse(data);
                                parsed.provider = 'llamacpp';
                                
                                const delta = parsed.choices?.[0]?.delta;
                                if (delta?.content !== undefined) {
                                    let content = delta.content || '';
                                    
                                    if (content.includes('<think>')) {
                                        const thinkIndex = content.indexOf('<think>');
                                        if (thinkIndex > 0) {
                                            delta.content = content.substring(0, thinkIndex);
                                        } else {
                                            delta.content = null;
                                        }
                                        content = content.substring(thinkIndex + 7);
                                        inThinkingMode = true;
                                    }
                                    
                                    if (inThinkingMode && content.includes('</think>')) {
                                        const endIndex = content.indexOf('</think>');
                                        thinkingBuffer += content.substring(0, endIndex);
                                        content = content.substring(endIndex + 8);
                                        inThinkingMode = false;
                                        
                                        if (thinkingBuffer && !sentReasoning) {
                                            yield {
                                                provider: 'llamacpp',
                                                choices: [{
                                                    index: 0,
                                                    delta: {
                                                        reasoning_content: thinkingBuffer,
                                                        content: content || null
                                                    }
                                                }]
                                            };
                                            sentReasoning = true;
                                            continue;
                                        }
                                    }
                                    
                                    if (inThinkingMode) {
                                        thinkingBuffer += content;
                                        delta.content = null;
                                    } else if (content) {
                                        delta.content = content;
                                    }
                                    
                                    if (delta.content === null || delta.content === '') {
                                        delete delta.content;
                                    }
                                }
                                
                                if (tokenCap) {
                                    const content = parsed.choices?.[0]?.delta?.content || '';
                                    const reasoning = parsed.choices?.[0]?.delta?.reasoning_content || '';
                                    const estimatedTokens = Math.ceil((content.length + reasoning.length) / 4);
                                    generatedTokens += estimatedTokens;
                                    
                                    if (generatedTokens >= tokenCap) {
                                        parsed.choices = parsed.choices || [];
                                        if (parsed.choices[0]) {
                                            parsed.choices[0].finish_reason = 'length';
                                            parsed.choices[0].delta = {};
                                        }
                                        yield parsed;
                                        return;
                                    }
                                }
                                
                                yield parsed;
                            } catch (e) {
                                // Skip broken JSON
                            }
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }
        },

        /**
         * Create embeddings.
         */
        async createEmbedding(modelConfig, request) {
            const { endpoint } = modelConfig;
            const modelHeaders = buildModelHeaders(modelConfig);

            const payload = {
                input: Array.isArray(request.input) ? request.input : [request.input],
                model: 'local'
            };

            const res = await httpRequest(`${endpoint}/v1/embeddings`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    ...modelHeaders,
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.error) {
                throw new Error(`llama.cpp Embedding Error: ${data.error.message || JSON.stringify(data.error)}`);
            }

            return data;
        },

        /**
         * Generate image - not supported by llama.cpp.
         */
        async generateImage(modelConfig, request) {
            throw new Error('[LlamaCppAdapter] Image generation not supported by llama.cpp');
        },

        /**
         * Synthesize speech - not supported by llama.cpp.
         */
        async synthesizeSpeech(modelConfig, request) {
            throw new Error('[LlamaCppAdapter] TTS not supported by llama.cpp');
        },

        /**
         * Generate video - not supported by llama.cpp.
         */
        async generateVideo(modelConfig, request) {
            throw new Error('[LlamaCppAdapter] Video generation not supported by llama.cpp');
        },

        /**
         * List available models.
         */
        async listModels(modelConfig) {
            const { endpoint, capabilities } = modelConfig;
            const contextWindow = capabilities?.contextWindow || 4096;
            const hasVision = capabilities?.vision === true;

            try {
                const res = await httpRequest(`${endpoint}/v1/models`);
                const data = await res.json();

                if (data.data && Array.isArray(data.data)) {
                    return data.data.map(m => ({
                        id: m.id,
                        object: 'model',
                        owned_by: m.owned_by || 'llamacpp',
                        capabilities: {
                            chat: true,
                            embeddings: false,
                            structuredOutput: true,
                            streaming: true,
                            vision: hasVision,
                            context_window: contextWindow
                        }
                    }));
                }
            } catch (e) {
                // Manager /v1/models may not be implemented
            }

            return [{
                id: modelConfig.localInference?.modelPath || 'unknown',
                object: 'model',
                owned_by: 'llamacpp',
                capabilities: {
                    chat: true,
                    embeddings: false,
                    structuredOutput: true,
                    streaming: true,
                    vision: hasVision,
                    context_window: contextWindow
                }
            }];
        }
    };
}
