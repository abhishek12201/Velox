import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';

interface ChaosStore {
  setChaos: (code: string, once?: boolean) => unknown;
  consumeChaos?: () => string | null;
  getChaos?: () => unknown;
}

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  open: number;
  lastActive: number;
  store?: ChaosStore;
  closeServer?: () => Promise<void>;
}

function isLocalHost(value?: string): boolean {
  if (!value) return true;
  const host = value.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

export function createServeApp(createServer: () => { connect: (transport: StreamableHTTPServerTransport) => Promise<void>; close: () => Promise<void>; store?: ChaosStore }, options: { serverName: string; host?: string; port?: number } = { serverName: 'server' }) {
  const app = createMcpExpressApp();
  const sessions = new Map<string, SessionRecord>();
  const host = options.host ?? '127.0.0.1';
  let activeChaosTarget: ChaosStore | undefined;

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    const hostHeader = req.get('host');
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)) {
      res.status(403).json({ error: 'Forbidden: non-local origin' });
      return;
    }
    if (hostHeader && !isLocalHost(hostHeader)) {
      res.status(403).json({ error: 'Forbidden: non-local host' });
      return;
    }
    next();
  });

  const trackResponse = (session: SessionRecord, response: Response) => {
    if (!response.socket || response.destroyed) return;
    session.open += 1;
    response.on('close', () => {
      session.open -= 1;
      session.lastActive = Date.now();
    });
  };

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, server: options.serverName, host });
  });

  app.post('/admin/chaos', (req: Request, res: Response) => {
    const body = req.body as { code?: string; once?: boolean };
    const code = body.code ?? 'SOLD_OUT';
    const once = body.once ?? true;
    if (activeChaosTarget) {
      activeChaosTarget.setChaos(code, once);
    }
    const session = req.headers['mcp-session-id'];
    if (session && sessions.has(String(session))) {
      const record = sessions.get(String(session));
      record?.store?.setChaos(code, once);
    }
    res.status(200).json({ ok: true, code, once, active: Boolean(activeChaosTarget) });
  });

  const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId ? sessions.get(String(sessionId)) : undefined;

    try {
      if (session) {
        trackResponse(session, res);
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const eventStore = new InMemoryEventStore();
        const server = createServer();
        let closePromise: Promise<void> | undefined;
        const closeServer = () => closePromise ??= server.close();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, open: 0, lastActive: Date.now(), store: undefined, closeServer });
          },
        });
        if (server.store) {
          activeChaosTarget = server.store;
        }
        const sessionId = transport.sessionId;
        if (sessionId) {
          const record = sessions.get(sessionId);
          if (record) {
            record.store = server.store;
          }
        }
        await server.connect(transport);
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
          }
          void closeServer().catch((error: unknown) => {
            console.error('MCP server close failed', error);
          });
        };
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }

      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null });
    } catch (error) {
      console.error('MCP request failed', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };

  app.post('/mcp', mcpPostHandler);

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }
    const session = sessions.get(String(sessionId));
    if (!session) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      return;
    }
    trackResponse(session, res);
    await session.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }
    const session = sessions.get(String(sessionId));
    if (!session) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      return;
    }
    await session.transport.close();
    await session.closeServer?.();
    sessions.delete(String(sessionId));
    res.status(200).json({ ok: true });
  });

  const server = app.listen(options.port ?? 0, host, () => {
    // startup handler
  });

  return { app, server, sessions };
}
