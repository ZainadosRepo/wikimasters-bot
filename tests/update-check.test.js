const test = require('node:test');
const assert = require('node:assert/strict');
const { newerVersion } = require('../update-check.js');

test('a newer release is reported with its plain version', () => {
  assert.equal(newerVersion('1.1.0', 'v1.2.0'), '1.2.0');
  assert.equal(newerVersion('1.1.9', 'v1.10.0'), '1.10.0', 'numeric, not alphabetical');
  assert.equal(newerVersion('1.1', '2.0.0'), '2.0.0');
});

test('the same or an older release is not an update', () => {
  assert.equal(newerVersion('1.2.0', 'v1.2.0'), null);
  assert.equal(newerVersion('1.2.0', 'v1.2'), null);
  assert.equal(newerVersion('1.2.0', 'v1.1.5'), null);
});

test('unreadable versions never claim an update', () => {
  assert.equal(newerVersion('1.1.0', 'nightly'), null);
  assert.equal(newerVersion('1.1.0', undefined), null);
  assert.equal(newerVersion('dev', 'v1.2.0'), null);
});
