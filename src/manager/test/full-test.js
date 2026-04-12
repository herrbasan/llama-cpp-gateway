import { spawn } from 'node:child_process';
import http from 'node:http';

const MANAGER_PORT = 4080;
const LLAMA_PORT = 4081;
// Use Qwen3.5-35B-A3B model for testing
const TEST_MODEL = 'HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q3_K_M.gguf';

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runFullTest() {
  console.log('='.repeat(60));
  console.log('LLAMA-CPP-GATEWAY FULL TEST');
  console.log('='.repeat(60));
  
  // Check if manager is already running
  let manager;
  let managerStartedByTest = false;
  
  try {
    await request(MANAGER_PORT, 'GET', '/status');
    console.log('✓ Manager already running on port', MANAGER_PORT);
  } catch {
    console.log('→ Starting Llama Manager server...');
    manager = spawn('node', ['server.js'], { 
      cwd: process.cwd(),
      detached: false,
      env: { ...process.env, MANAGER_PORT: String(MANAGER_PORT), LLAMA_SERVER_PORT: String(LLAMA_PORT) }
    });
    
    manager.stdout.on('data', d => console.log('[MANAGER]', d.toString().trim()));
    manager.stderr.on('data', d => console.error('[MANAGER ERR]', d.toString().trim()));
    
    managerStartedByTest = true;
    await delay(2000);
    console.log('✓ Manager started');
  }

  try {
    // Step 0: List profiles
    console.log('\n--- STEP 0: Available Model Profiles ---');
    const profilesRes = await request(MANAGER_PORT, 'GET', '/profiles');
    if (profilesRes.body.data) {
      console.log(`Found ${profilesRes.body.data.length} model profiles:`);
      profilesRes.body.data.forEach(p => {
        console.log(`  • ${p.name}: ctx=${p.defaults.ctxSize}, VRAM~${p.vramEstimateGB}GB, tags=[${p.tags.join(', ')}]`);
      });
    }

    // Step 1: List models
    console.log('\n--- STEP 1: List Available Models ---');
    console.log('VRAM Budget Goal: ~23GB (24GB total - 1GB spare)');
    console.log('Target: Fit 1 embedding model + 1 inference model');
    const modelsRes = await request(MANAGER_PORT, 'GET', '/models');
    console.log(`Status: ${modelsRes.status}`);
    if (modelsRes.body.data) {
      console.log(`Found ${modelsRes.body.data.length} models:`);
      modelsRes.body.data.forEach((m, i) => {
        const size = m.parameter_count ? `(${(m.parameter_count / 1e9).toFixed(1)}B params)` : '';
        const arch = m.architecture ? `[${m.architecture}]` : '[unknown]';
        const ctx = m.context_length ? `${m.context_length} ctx` : '';
        console.log(`  ${i + 1}. ${arch} ${m.name} ${size} ${ctx}`);
      });
    }

    // Step 2: Check status (should be idle)
    console.log('\n--- STEP 2: Check Initial Status ---');
    const initialStatus = await request(MANAGER_PORT, 'GET', '/status');
    console.log('Initial status:', initialStatus.body);

    // Step 3: Start the model
    console.log('\n--- STEP 3: Start Model ---');
    console.log(`Starting model: ${TEST_MODEL.split('/').pop()}`);
    const startTime = Date.now();
    console.log('Note: Calling start WITHOUT parameters - letting profile system optimize');
    const startRes = await request(MANAGER_PORT, 'POST', '/start', { 
      modelPath: TEST_MODEL
      // No ctxSize, gpuLayers, or flashAttention - using profile defaults!
    });
    console.log('Start response:', startRes.body);
    
    // Verify GPU offload
    const hasCuda = startRes.body.args.includes('-ngl');
    const gpuLayers = hasCuda ? startRes.body.args[startRes.body.args.indexOf('-ngl') + 1] : '0';
    const flashAttn = startRes.body.args.includes('--flash-attn');
    console.log(`\nHardware Config:`);
    console.log(`  GPU Layers: ${gpuLayers} (99 = all layers on GPU)`);
    console.log(`  Flash Attention: ${flashAttn ? 'Enabled' : 'Disabled'}`);
    console.log(`  Context Size: ${startRes.body.args[startRes.body.args.indexOf('-c') + 1]}`);
    
    if (startRes.status !== 200) {
      throw new Error(`Failed to start model: ${startRes.body.error || 'Unknown error'}`);
    }

    // Wait for model to load
    console.log('Waiting for model to load (this may take 10-30 seconds)...');
    let isRunning = false;
    for (let i = 0; i < 60 && !isRunning; i++) {
      await delay(1000);
      const status = await request(MANAGER_PORT, 'GET', '/status');
      process.stdout.write(`\r  Status: ${status.body.state} (${i + 1}s)`);
      if (status.body.state === 'running') {
        isRunning = true;
        const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✓ Model loaded in ${loadTime}s`);
      }
    }
    
    if (!isRunning) {
      throw new Error('Model failed to reach running state');
    }

    // Step 4: Run generation request
    console.log('\n--- STEP 4: Generation Request ---');
    const prompt = "Explain quantum computing in simple terms:";
    console.log(`Prompt: "${prompt}"`);
    
    const genStartTime = Date.now();
    const genRes = await request(LLAMA_PORT, 'POST', '/completion', {
      prompt: prompt,
      n_predict: 100,
      temperature: 0.7,
      stream: false
    });
    const genEndTime = Date.now();
    
    if (genRes.status !== 200) {
      throw new Error(`Generation failed: ${genRes.body}`);
    }
    
    const result = genRes.body;
    const generationTime = (genEndTime - genStartTime) / 1000;
    const tokensGenerated = result.tokens_predicted || 0;
    const tokensPrompt = result.tokens_evaluated || 0;
    const tokensPerSecond = tokensGenerated / generationTime;
    
    console.log('\n--- GENERATION RESULTS ---');
    console.log(`Generated text: ${result.content?.substring(0, 200)}...`);
    console.log(`\nMetrics:`);
    console.log(`  Prompt tokens:    ${tokensPrompt}`);
    console.log(`  Generated tokens: ${tokensGenerated}`);
    console.log(`  Generation time:  ${generationTime.toFixed(2)}s`);
    console.log(`  Tokens/second:    ${tokensPerSecond.toFixed(2)} tok/s`);
    
    if (result.timings) {
      console.log(`  Prompt eval:      ${result.timings.prompt_per_token_ms?.toFixed(3)} ms/tok`);
      console.log(`  Predicted eval:   ${result.timings.predicted_per_token_ms?.toFixed(3)} ms/tok`);
    }

    // Step 5: Check final status
    console.log('\n--- STEP 5: Final Status ---');
    const finalStatus = await request(MANAGER_PORT, 'GET', '/status');
    console.log('Status:', finalStatus.body);

    // Step 6: Stop the service
    console.log('\n--- STEP 6: Stop Service ---');
    const stopRes = await request(MANAGER_PORT, 'POST', '/stop');
    console.log('Stop response:', stopRes.body);
    
    await delay(2000);
    const afterStopStatus = await request(MANAGER_PORT, 'GET', '/status');
    console.log('Status after stop:', afterStopStatus.body);

    console.log('\n' + '='.repeat(60));
    console.log('TEST COMPLETED SUCCESSFULLY');
    console.log('='.repeat(60));
    console.log(`Final Performance: ${tokensPerSecond.toFixed(2)} tokens/second`);

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    console.error(err);
    
    // Try to stop any running server
    try {
      await request(MANAGER_PORT, 'POST', '/stop');
    } catch {}
  } finally {
    if (managerStartedByTest && manager) {
      console.log('\n→ Shutting down manager...');
      manager.kill('SIGINT');
    }
  }
}

runFullTest();
