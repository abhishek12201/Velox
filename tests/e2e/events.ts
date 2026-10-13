import { expect } from 'vitest';

export type E2eEvent = Record<string, unknown>;

export function assertNoStepLimit(events: E2eEvent[]): void {
  expect(events.filter((event) =>
    event.type === 'error' && typeof event.message === 'string' && /step limit/i.test(event.message),
  )).toEqual([]);
}

export function eventsFrom(body: string): E2eEvent[] {
  const events = body.split('\n\n').flatMap((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    if (!data) return [];
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SSE event');
    return [value as E2eEvent];
  });
  assertNoStepLimit(events);
  return events;
}
