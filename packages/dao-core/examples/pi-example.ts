/**
 * PI Coding Agent Example
 *
 * Demonstrates how to use the PiCodingAgent with the common agent interface.
 */

import { PiCodingAgent } from '@whonb/dao-core';

async function main() {

  console.log(`PI Agent initialized with session ssss `);
  const abort = new AbortController();

  // 1. Create PI Agent instance
  await using agent = new PiCodingAgent({
    instructions: 'You are a helpful coding assistant. You have access to file read, bash, edit, and write tools.',
    thinkingLevel: 'low', // "off", "low", "medium", "high"
    debug: false,
  });

  // Initialize the agent
  await agent.initialize();

  console.log(`PI Agent initialized with session: ${agent.getSessionId()}`);

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\nCanceling...');
    abort.abort();
    process.exitCode = 0;
  });

  console.log('--- PI Coding Agent Started ---\n');

  // 2. Send a prompt (returns array of events, not streaming)
  const events = await agent.ask(
    'List files in the current directory',
    abort.signal,
  );

  // 3. Process events
  for (const event of events) {
    switch (event.type) {
      case 'content':
        process.stdout.write(event.value);
        break;

      case 'tool_call_request':
        console.log(`\n[Tool Call: ${event.value.name}]`);
        break;

      case 'tool_call_response':
        console.log(`[Tool Result: ${event.value.name} - ${event.value.success ? 'OK' : 'Failed'}]`);
        break;

      case 'error':
        console.error('\nError:', event.value);
        break;
    }
  }

  console.log('\n\n--- Done ---');

  // Keep alive for a bit to allow async disposal
  await sleep(5000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await main();
