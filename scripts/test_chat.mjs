import fetch from 'node-fetch';
import { spawn } from 'child_process';

const PORT = 10000; // Same as in server.js
const BASE_URL = `http://localhost:${PORT}`;

async function main() {
  let serverProcess;

  try {
    console.log('Starting server...');
    // Use node to run server.js. The user is expected to have a .env file with the necessary secrets.
    serverProcess = spawn('node', ['server.js'], { stdio: 'pipe' });

    serverProcess.stdout.on('data', (data) => {
        console.log(`[SERVER STDOUT]: ${data}`);
    });

    serverProcess.stderr.on('data', (data) => {
        console.error(`[SERVER STDERR]: ${data}`);
    });

    // Wait for the server to start
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds for the server to start

    console.log('Server starting... Running tests...');

    // 1. Start a new chat to get a thread_id
    console.log('\n--- 1. Starting a new chat ---');
    const startRes = await fetch(`${BASE_URL}/start-chat`);
    if (!startRes.ok) {
        throw new Error(`Failed to start chat: ${startRes.status} ${startRes.statusText}`);
    }
    const startData = await startRes.json();
    if (!startData.ok || !startData.thread_id) {
      throw new Error(`Failed to start chat: ${JSON.stringify(startData)}`);
    }
    const { thread_id } = startData;
    console.log(`✓ Got thread_id: ${thread_id}`);


    // 2. Ask the first question
    console.log('\n--- 2. Sending first message (/assistant/ask) ---');
    const askRes = await fetch(`${BASE_URL}/assistant/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id,
        message: 'Hello, what is the return policy?',
      }),
    });
    if (!askRes.ok) {
        const errorText = await askRes.text();
        throw new Error(`Failed to ask question: ${askRes.status} ${askRes.statusText} - ${errorText}`);
    }
    const askData = await askRes.json();
    if (!askData.ok || !askData.answer) {
        console.error(`Failed to ask question: ${JSON.stringify(askData, null, 2)}`);
        throw new Error(`Failed to ask question: ${JSON.stringify(askData)}`);
    }
    console.log('✓ Got response:');
    console.log(askData.answer);


    // 3. Send a follow-up question
    console.log('\n--- 3. Sending follow-up message (/send) ---');
    const sendRes = await fetch(`${BASE_URL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            thread_id,
            message: 'Thanks! What about shipping?',
        }),
    });
    if (!sendRes.ok) {
        const errorText = await sendRes.text();
        throw new Error(`Failed to send message: ${sendRes.status} ${sendRes.statusText} - ${errorText}`);
    }
    const sendData = await sendRes.json();
    if (!sendData.ok || !sendData.answer) {
        console.error(`Failed to send message: ${JSON.stringify(sendData, null, 2)}`);
        throw new Error(`Failed to send message: ${JSON.stringify(sendData)}`);
    }
    console.log('✓ Got response:');
    console.log(sendData.answer);

    console.log('\n✅ All tests passed!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  } finally {
    if (serverProcess) {
      console.log('\nStopping server...');
      serverProcess.kill();
    }
  }
}

main();
