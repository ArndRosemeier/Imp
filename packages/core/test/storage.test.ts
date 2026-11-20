import { describe, expect, it } from 'vitest';
import { assertValidKey, MemoryKeyValueStore } from '../src/index.js';
import { describeKeyValueStoreContract } from '../src/testing.js';

describeKeyValueStoreContract('MemoryKeyValueStore', () => new MemoryKeyValueStore());

describe('assertValidKey', () => {
  it.each(['a', 'settings/coordinator.model', 'activity/2026-01-01T00-00-00.000Z_id-1'])(
    'accepts %s',
    (key) => {
      expect(() => {
        assertValidKey(key);
      }).not.toThrow();
    },
  );

  it.each(['', '/a', 'a/', 'a//b', 'a b', 'a/ü'])('rejects "%s"', (key) => {
    expect(() => {
      assertValidKey(key);
    }).toThrow(TypeError);
  });
});
