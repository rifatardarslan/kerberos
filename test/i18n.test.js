import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage, localized, replyLanguage, setLanguage, setReplyLanguage, systemLanguage, t, tn } from '../src/i18n/index.js';
import { TR } from '../src/i18n/tr.js';

test('systemLanguage reads env first, then the locale', () => {
  assert.equal(systemLanguage({ LANG: 'tr_TR.UTF-8' }, 'en-US'), 'tr');
  assert.equal(systemLanguage({}, 'de-DE'), 'de');
  assert.equal(systemLanguage({ LANG: 'C' }, 'tr-TR'), 'en');
});

test('t() is English by default, Turkish when set, and falls back to English', () => {
  setLanguage('en');
  assert.equal(t('Plan ready'), 'Plan ready');
  assert.equal(t('{name} finished', { name: 'Codex' }), 'Codex finished');
  setLanguage('tr');
  assert.equal(getLanguage(), 'tr');
  assert.equal(t('Plan ready'), 'Plan hazır');
  assert.equal(t('{name} finished', { name: 'Codex' }), 'Codex bitti');
  assert.equal(t('no translation for this'), 'no translation for this');
  assert.equal(tn(3, '{n} file', '{n} files'), '3 dosya');
  setLanguage('xx');
  assert.equal(getLanguage(), 'en');
  assert.equal(tn(1, '{n} file', '{n} files'), '1 file');
});

test('localized tables translate on read, also nested', () => {
  const table = localized({ a: 'Plan ready', nested: { b: 'Files' }, list: ['Files'] });
  setLanguage('en');
  assert.equal(table.nested.b, 'Files');
  setLanguage('tr');
  assert.equal(table.a, 'Plan hazır');
  assert.equal(table.nested.b, 'Dosyalar');
  assert.equal(table.list[0], 'Dosyalar');
  setLanguage('en');
});

test('replyLanguage names the language for the prompts', () => {
  setReplyLanguage('tr');
  assert.equal(replyLanguage(), 'Turkish');
  setReplyLanguage('de');
  assert.equal(replyLanguage(), 'German');
  setReplyLanguage('auto');
});

test('every Turkish entry keeps the placeholders of its English text', () => {
  for (const [en, tr] of Object.entries(TR)) {
    const want = (en.match(/\{\w+\}/g) || []).sort().join();
    const got = (tr.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(got, want, en);
  }
});
