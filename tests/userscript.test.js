const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { buildUserscript, OUT, LATEST_USERSCRIPT } = require('../scripts/build-userscript.js');

test('wikimasters-bot.user.js is up to date with the extension sources', () => {
  const onDisk = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(onDisk === buildUserscript(), 'run: node scripts/build-userscript.js');
});

test('generated userscript is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(buildUserscript()));
});

test('userscript managers update from the latest release', () => {
  const header = buildUserscript().split('// ==/UserScript==')[0];
  assert.match(LATEST_USERSCRIPT, /\/releases\/latest\/download\/wikimasters-bot\.user\.js$/);
  assert.ok(header.includes(`// @updateURL    ${LATEST_USERSCRIPT}`));
  assert.ok(header.includes(`// @downloadURL  ${LATEST_USERSCRIPT}`));
});
