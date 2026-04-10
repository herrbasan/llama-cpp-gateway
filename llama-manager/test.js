import { spawn } from 'node:child_process';
import http from 'node:http';

const SERVER_PORT = process.env.MANAGER_PORT || 8085;
const TEST_MODEL = 'HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
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

async function runTests() {
  console.log('--- Phase 4: Local Testing ---');
  
  console.log('Spawning Llama Manager server...');
  const server = spawn('node', ['server.js'], { 
      cwd: process.cwd(), 
      detached: false,
      env: { ...process.env, MANAGER_PORT: SERVER_PORT, LLAMA_SERVER_PORT: 8086 }
  });
  server.stdout.on('data', d => console.log('MANAGER STDOUT:', d.toString().trim()));
  server.stderr.on('data', d => console.error('MANAGER STDERR:', d.toString().trim()));
  
  // Wait a second for it to bind
  await delay(1500);

  try {
    console.log('[4.1] Boot Test: Starting server directly with test model...');
    const startRes = await request('POST', '/start', { 
        modelPath: TEST_MODEL,
        ctxSize: 512,
        gpuLayers: 99
    });
    console.log('Start Res:', startRes.body);

    console.log('Waiting for model to load and bind (15s)...');
    await delay(15000);

    console.log('[4.2] Status Test: Checking telemetry and state...');
    const statusRes = await request('GET', '/status');
    console.log('Status Res:', JSON.stringify(statusRes.body, null, 2).substring(0, 300) + '... (truncated)');
    if (statusRes.body.state !== 'running') {
        console.error('SERVER FAILED TO REACH RUNNING STATE!');
    } else {
        console.log('Server is properly tracking RUNNING state.');
    }

    console.log('[4.3] Kill Test: Sending /stop signal...');
    const stopRes = await request('POST', '/stop');
    console.log('Stop Res:', stopRes.body);

    console.log('Waiting 3s for cleanup...');
    await delay(3000);

    const finalStatus = await request('GET', '/status');
    console.log('Final Status (should be idle):', finalStatus.body);

    console.log('Testing complete. Tearing down Llama Manager.');
  } catch (err) {
    console.error('Test execution failed:', err);
  } finally {
    server.kill('SIGINT');
  }
}

runTests();
