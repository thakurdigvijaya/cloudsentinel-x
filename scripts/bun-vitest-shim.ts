// Lets the Vitest-style tests run under Bun's test runner in environments where
// the npm registry is unavailable. On a normal machine use `npm test` (real Vitest).
import { mock } from 'bun:test';
import * as bunTest from 'bun:test';

mock.module('vitest', () => bunTest);
