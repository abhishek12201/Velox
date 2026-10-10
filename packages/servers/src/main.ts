import { createAirServer } from './air/server.js';
import { createServeApp } from './kit/serve.js';

const name = process.argv[2] ?? 'air';
const port = Number(process.env.PORT ?? 7101);

if (name === 'air') {
  const { server } = createServeApp(() => createAirServer().server, { serverName: 'air', port });
  server.on('listening', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`air server listening on ${actualPort}`);
  });
} else {
  console.error(`unsupported server: ${name}`);
  process.exit(1);
}
