import { describe, expect, test } from 'vitest';
import { configFromEnv, parsePublicUrl } from './context.js';

describe('public URL', () => {
  test('unset or empty means localhost on the port (an env file written before the tunnel exists)', () => {
    expect(parsePublicUrl(undefined, 8787)).toBe('http://localhost:8787');
    expect(parsePublicUrl('', 8787)).toBe('http://localhost:8787');
    expect(parsePublicUrl('  ', 9000)).toBe('http://localhost:9000');
    expect(configFromEnv({ AGENT_DRIVE_PUBLIC_URL: '', AGENT_DRIVE_PORT: '8787' }).publicUrl).toBe('http://localhost:8787');
  });
  test('a tunnel address is kept, without a trailing slash', () => {
    expect(parsePublicUrl('https://drive.example.com/', 8787)).toBe('https://drive.example.com');
  });
  test('anything else is refused with a message that names the setting', () => {
    expect(() => parsePublicUrl('drive.example.com', 8787)).toThrow(/AGENT_DRIVE_PUBLIC_URL/);
    expect(() => parsePublicUrl('ftp://drive.example.com', 8787)).toThrow(/AGENT_DRIVE_PUBLIC_URL/);
  });
});
