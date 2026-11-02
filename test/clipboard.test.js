import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyNotice, watchCopies } from '../src/ui/clipboard.js';
import { setLanguage } from '../src/i18n/index.js';

// These tests check the Turkish interface text.
setLanguage('tr');

test('copy notice counts characters and lines', () => {
  assert.equal(copyNotice({ chars: 42, lines: 1 }), '✓ 42 karakter kopyalandı');
  assert.equal(copyNotice({ chars: 1234, lines: 3 }), '✓ 1.234 karakter kopyalandı · 3 satır');
  assert.equal(typeof watchCopies(() => {}, { platform: 'linux' }), 'function'); // no-op off Windows
});
