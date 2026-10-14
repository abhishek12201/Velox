import { expect, test } from 'vitest';
import { ErrorResultSchema } from './types.js';
import { veloxCore } from './index.js';

test('core package loads', () => {
  expect(veloxCore).toBe('core');
});

test('tool errors retain normalized code and message fields', () => {
  expect(ErrorResultSchema.parse({
    isError: true,
    code: 'NOT_FOUND',
    message: 'Local offer missing-food was not found',
    retryable: false,
  })).toMatchObject({ code: 'NOT_FOUND', message: 'Local offer missing-food was not found' });
});
