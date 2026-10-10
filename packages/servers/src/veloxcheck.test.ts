import { execFile as execFileCallback } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { start } from './main.js';

const execFile = promisify(execFileCallback);

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Port probe did not bind to a TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function checkServer(serverName: string): Promise<string> {
  const { server } = start(serverName, { port: await freePort(), dbPath: ':memory:' });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('error', reject);
    server.once('listening', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error(`${serverName} test server did not bind to a TCP port`);
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const { stdout } = await execFile('node_modules/.bin/tsx', [
      'packages/veloxcheck/src/cli.ts',
      url,
      '--strict',
    ], { cwd: process.cwd() });
    return stdout;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('veloxcheck strict mode passes on all four in-process servers', async () => {
  for (const name of ['air', 'stay', 'local', 'vault']) {
    const output = await checkServer(name);
    expect(output).toContain('Protocol: 2025-11-25 (strict)');
    expect(output).toContain('| PASS');
    expect(output).not.toContain('| FAIL');
  }
});
