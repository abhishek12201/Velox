import { expect, test } from 'vitest';
import { veloxCheck } from './index.js';

test('veloxcheck package loads', () => {
  expect(veloxCheck).toBe('veloxcheck');
});
