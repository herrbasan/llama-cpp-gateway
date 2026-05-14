// ============================================
// Embedding Benchmark - Tokenization optimization
// ============================================

const LLAMACPP_URL = 'http://127.0.0.1:4081/embedding';
const TOKENIZE_URL = 'http://127.0.0.1:4081/tokenize';
const HEADERS = { 'Content-Type': 'application/json' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateText(len) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789.,!? ';
    const words = [];
    for (let i = 0; i < len; i++) {
        const wordLen = 3 + Math.floor(Math.random() * 8);
        let word = '';
        for (let j = 0; j < wordLen; j++) word += chars[Math.floor(Math.random() * chars.length)];
        words.push(word);
    }
    return words.join(' ');
}

async function tokenizeTexts(texts) {
    const res = await fetch(TOKENIZE_URL, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ content: texts, tokens: true })
    });
    const data = await res.json();
    return data.tokens;
}

async function embedTexts(tokenBatches) {
    const res = await fetch(LLAMACPP_URL, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ content: tokenBatches })
    });
    return res.json();
}

async function benchmarkRaw(texts) {
    const start = Date.now();
    const res = await fetch(LLAMACPP_URL, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ content: texts })
    });
    const ms = Date.now() - start;
    if (!res.ok) throw new Error(await res.text());
    return ms;
}

async function benchmarkPretokenized(texts) {
    const start = Date.now();
    const tokens = await tokenizeTexts(texts);
    const embedMs = Date.now() - start;
    
    const embedStart = Date.now();
    await embedTexts(tokens);
    const totalMs = Date.now() - start;
    const embedOnlyMs = Date.now() - embedStart;
    
    return { totalMs, tokenizeMs: embedMs, embedMs: embedOnlyMs };
}

async function testBatch(label, count, textLen) {
    console.log(`\n  ${count}×${textLen}c:`);
    const texts = [];
    for (let i = 0; i < count; i++) texts.push(generateText(textLen));
    
    // Raw text
    try {
        const rawMs = await benchmarkRaw(texts);
        console.log(`    Raw:           ${(rawMs/1000).toFixed(1)}s total`);
    } catch (err) {
        console.log(`    Raw:           FAILED - ${err.message.slice(0, 50)}`);
    }
    await sleep(200);
    
    // Pre-tokenized
    try {
        const { totalMs, tokenizeMs, embedMs } = await benchmarkPretokenized(texts);
        console.log(`    Pre-tokenized: ${(totalMs/1000).toFixed(1)}s total (tokenize: ${tokenizeMs}ms, embed: ${embedMs}ms)`);
    } catch (err) {
        console.log(`    Pre-tokenized: FAILED - ${err.message.slice(0, 50)}`);
    }
}

async function main() {
    console.log('=== Embedding Benchmark: Raw vs Pre-tokenized ===\n');
    
    console.log('Test 1: 10 texts × 500 chars');
    await testBatch('t1', 10, 500);
    
    console.log('\nTest 2: 50 texts × 500 chars');
    await testBatch('t2', 50, 500);
    
    console.log('\nTest 3: 100 texts × 500 chars');
    await testBatch('t3', 100, 500);
    
    console.log('\nTest 4: Small texts (50 texts × 50 chars)');
    await testBatch('t4', 50, 50);
    
    console.log('\n=== Done ===');
}

main().catch(e => { console.error('Benchmark failed:', e.message); process.exit(1); });