import { expect, test } from 'vitest';
import { veloxAgent } from './index.js';

test('agent package loads', () => {
  expect(veloxAgent).toBe('agent');
});
