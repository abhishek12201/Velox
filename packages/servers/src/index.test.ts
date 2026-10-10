import { expect, test } from 'vitest';
import { veloxServers } from './index.js';

test('servers package loads', () => {
  expect(veloxServers).toBe('servers');
});
