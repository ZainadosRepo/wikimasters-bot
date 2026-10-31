const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { buildUserscript, OUT } = require('../scripts/build-userscript.js');

test('wikimasters-bot.user.js is up to date with the extension sources', () => {
  const onDisk = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(onDisk === buildUserscript(), 'run: node scripts/build-userscript.js');
});

test('generated userscript is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(buildUserscript()));
});
