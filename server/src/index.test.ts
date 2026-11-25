import { expect, test } from 'vitest';
import { VERSION } from './index.js';
test('skeleton builds', () => { expect(VERSION).toBe('0.0.0'); });
