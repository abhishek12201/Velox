import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { expect, test } from 'vitest';
import { createAirServer } from './air/server.js';
import { createLocalServer } from './local/server.js';
import { createServeApp } from './kit/serve.js';
import { createStayServer } from './stay/server.js';
import { createVaultServer } from './vault/server.js';

const execFile = promisify(execFileCallback);

async function checkServer(
  serverName: string,
  createServer: (options: { dbPath: string }) => { connect: (transport: any) => Promise<void>; close: () => Promise<void> },
): Promise<string> {
  const instance = createServer({ dbPath: ':memory:' });
  const { server } = createServeApp(() => instance, { serverName, port: 0 });
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
  const servers: Array<[string, (options: { dbPath: string }) => { connect: (transport: any) => Promise<void>; close: () => Promise<void> }]> = [
    ['air', createAirServer],
    ['stay', createStayServer],
    ['local', createLocalServer],
    ['vault', createVaultServer],
  ];
  for (const [name, createServer] of servers) {
    const output = await checkServer(name, createServer);
    expect(output).toContain('Protocol: 2025-11-25 (strict)');
    expect(output).toContain('| PASS');
    expect(output).not.toContain('| FAIL');
  }
});
