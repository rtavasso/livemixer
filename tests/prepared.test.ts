import { describe, expect, it } from 'vitest';
import { preparedCollection } from '../src/library/prepared';
describe('prepared collection routes', () => {
  it('keeps fixtures as the default and resolves a local collection', () => {
    expect(preparedCollection('')).toBeUndefined();
    expect(preparedCollection('?collection=love-supreme-sun')).toBe('/scenes/love-supreme-sun/');
  });
  it('rejects traversal and remote URLs before loading', () => {
    for (const value of ['../secret', 'https://example.org', '%2e%2e%2fsecret', '']) {
      expect(() => preparedCollection('?collection=' + value)).toThrow('Invalid local collection ID');
    }
  });
});
