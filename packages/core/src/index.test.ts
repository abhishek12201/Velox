import { expect, test } from 'vitest';
import { veloxCore } from './index.js';

test('core package loads', () => {
  expect(veloxCore).toBe('core');
});
