import { useCallback, useEffect, useReducer, useState } from 'react';
import type { SseEvent } from '@velox/core';
import { agentReducer, initialAgentState } from './reducer.js';

const knownEventTypes = new Set(['say', 'call', 'result', 'card', 'chip', 'recovery', 'nudge', 'clock', 'error', 'done']);
const reconnectLimitMs = 15_000;

function agentBaseUrl(): string {
  const override = new URLSearchParams(window.location.search).get('agent');
  const configured = import.meta.env.VITE_AGENT_URL;
  return (override || configured || 'http://127.0.0.1:7100').replace(/\/+$/, '');
}

function decodeFrame(frame: string): SseEvent | undefined {
  const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
  if (!data) return undefined;
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !knownEventTypes.has(String((value as { type?: unknown }).type))) {
    throw new Error('The agent sent an unsupported event.');
  }
  return value as SseEvent;
}

async function consumeSse(
  response: Response,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.ok || !response.body) {
    const body: unknown = await response.json().catch(() => ({}));
    const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `Agent request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const event = decodeFrame(buffer.slice(0, boundary));
        if (event) onEvent(event);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The agent could not complete the request.';
}

export function useAgent() {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [state, dispatch] = useReducer(agentReducer, initialAgentState);

  useEffect(() => {
    const controller = new AbortController();
    let retryMs = 500;
    const baseUrl = agentBaseUrl();
    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`${baseUrl}/api/events?session_id=${encodeURIComponent(sessionId)}`, {
            signal: controller.signal,
            headers: { Accept: 'text/event-stream' },
          });
          if (!response.ok || !response.body) throw new Error(`Events stream failed with HTTP ${response.status}`);
          dispatch({ type: 'connection', value: 'connected' });
          retryMs = 500;
          await consumeSse(response, (event) => dispatch({ type: 'event', event }), controller.signal);
          if (!controller.signal.aborted) throw new Error('Events stream closed.');
        } catch {
          if (controller.signal.aborted) return;
          dispatch({ type: 'connection', value: 'reconnecting' });
          await retryDelay(retryMs, controller.signal);
          retryMs = Math.min(retryMs * 2, reconnectLimitMs);
        }
      }
    };
    void connect();
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${agentBaseUrl()}/api/clock`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Clock request failed with HTTP ${response.status}`);
        return response.json();
      })
      .then((value: { now?: unknown }) => {
        if (typeof value.now === 'string') dispatch({ type: 'event', event: { type: 'clock', now: value.now } });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) dispatch({ type: 'error', message: errorText(error) });
      });
    return () => controller.abort();
  }, []);

  const postStream = useCallback(async (path: string, body: Record<string, unknown>) => {
    const controller = new AbortController();
    dispatch({ type: 'loading', value: true });
    dispatch({ type: 'error' });
    try {
      const response = await fetch(`${agentBaseUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ ...body, session_id: sessionId }),
        signal: controller.signal,
      });
      await consumeSse(response, (event) => dispatch({ type: 'event', event }), controller.signal);
      dispatch({ type: 'loading', value: false });
    } catch (error) {
      dispatch({ type: 'loading', value: false });
      dispatch({ type: 'error', message: errorText(error) });
    }
  }, [sessionId]);

  const sendText = useCallback((text: string) => {
    if (!text.trim()) return Promise.resolve();
    dispatch({ type: 'user', text: text.trim() });
    return postStream('/api/chat', { text: text.trim() });
  }, [postStream]);

  const confirmPlan = useCallback((planId: string, acceptSwap = false) =>
    postStream(acceptSwap ? '/api/accept' : '/api/confirm', { plan_id: planId }),
  [postStream]);

  const postJson = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    dispatch({ type: 'error' });
    try {
      const response = await fetch(`${agentBaseUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const value: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
          ? (value as { error: string }).error
          : `Request failed with HTTP ${response.status}`;
        throw new Error(message);
      }
      return value as Record<string, unknown>;
    } catch (error) {
      dispatch({ type: 'error', message: errorText(error) });
      return undefined;
    }
  }, []);

  const newSession = useCallback(() => {
    setSessionId(crypto.randomUUID());
    dispatch({ type: 'reset' });
  }, []);

  return { sessionId, state, dispatch, sendText, confirmPlan, postJson, newSession };
}
