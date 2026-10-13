import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentApp } from './api.js';

async function connectAgent() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await createAgentApp();
    } catch (error) {
      lastError = error;
      if (attempt < 29) await delay(500);
    }
  }
  throw new Error('Could not connect to all MCP servers after 15 seconds', { cause: lastError });
}

export async function startAgent(): Promise<{ close: () => Promise<void> }> {
  const agent = await connectAgent();
  const port = Number(process.env.VELOX_PORT_AGENT ?? 7100);
  const host = process.env.VELOX_AGENT_HOST ?? '127.0.0.1';
  const server = agent.app.listen(port, host);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
  } catch (error) {
    await agent.close();
    throw error;
  }
  agent.startScheduler();
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`agent listening on http://${host}:${actualPort}`);
  return {
    async close() {
      agent.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await agent.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAgent().then((agent) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      agent.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('Agent shutdown failed', error);
          process.exitCode = 1;
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch((error: unknown) => {
    console.error('Agent startup failed', error);
    process.exitCode = 1;
  });
}
