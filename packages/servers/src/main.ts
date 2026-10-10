import { createAirServer } from './air/server.js';
import { createLocalServer } from './local/server.js';
import { createStayServer } from './stay/server.js';
import { createServeApp } from './kit/serve.js';

const name = process.argv[2] ?? 'air';
const defaults = { air: 7101, stay: 7102, local: 7103 };
const defaultPort = defaults[name as keyof typeof defaults];

const createServer = name === 'air'
  ? () => createAirServer({ basePort: port })
  : name === 'stay'
    ? () => createStayServer({ basePort: port })
    : name === 'local'
      ? () => createLocalServer({ basePort: port })
      : undefined;

if (!createServer) {
  console.error(`unsupported server: ${name}`);
  process.exit(1);
}

const port = Number(process.env[`${name.toUpperCase()}_PORT`] ?? (name === 'air' ? process.env.PORT : undefined) ?? defaultPort);
const { server } = createServeApp(() => createServer().server, { serverName: name, port });
server.on('listening', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`${name} server listening on ${actualPort}`);
});
