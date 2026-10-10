import { expect, test } from 'vitest';
import { appTitle } from './index.js';

test('web app title is set', () => {
  expect(appTitle).toBe('Velox Console');
});
