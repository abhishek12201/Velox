import { pathToFileURL } from 'node:url';
import { createAirServer } from './air/server.js';
import { createLocalServer } from './local/server.js';
import { createStayServer } from './stay/server.js';
import { createVaultServer } from './vault/server.js';
import { createServeApp } from './kit/serve.js';

type ServerName = 'air' | 'stay' | 'local' | 'vault';

const defaultPorts: Record<ServerName, number> = {
  air: 7101,
  stay: 7102,
  local: 7103,
  vault: 7104,
};

const portEnvironmentVariables: Record<ServerName, string> = {
  air: 'VELOX_PORT_AIR',
  stay: 'VELOX_PORT_STAY',
  local: 'VELOX_PORT_LOCAL',
  vault: 'VELOX_PORT_VAULT',
};

function isServerName(name: string): name is ServerName {
  return name === 'air' || name === 'stay' || name === 'local' || name === 'vault';
}

export function start(name: string, options: { port?: number; dbPath?: string } = {}) {
  if (!isServerName(name)) {
    throw new Error(`unsupported server: ${name}`);
  }

  const port = options.port ?? Number(process.env[portEnvironmentVariables[name]] ?? defaultPorts[name]);
  const createServer = () => {
    const serverOptions = { basePort: port, dbPath: options.dbPath };
    switch (name) {
      case 'air': return createAirServer(serverOptions);
      case 'stay': return createStayServer(serverOptions);
      case 'local': return createLocalServer(serverOptions);
      case 'vault': return createVaultServer(serverOptions);
    }
  };

  const { server } = createServeApp(createServer, { serverName: name, port });
  server.on('listening', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`${name} server listening on http://127.0.0.1:${actualPort}/mcp`);
  });
  return { server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    start(process.argv[2] ?? 'air');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
