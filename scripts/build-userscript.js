#!/usr/bin/env node
// Builds wikimasters-bot.user.js (Tampermonkey / Violentmonkey) from the extension sources,
// so the userscript can never drift from the extension again.
// Usage: node scripts/build-userscript.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'wikimasters-bot.user.js');
const SOURCES = ['classifier.js', 'discard.js', 'page-bridge.js', 'content.js'];

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

// content.js only needs these chrome.* calls; in a userscript the storage lives in localStorage.
const CHROME_SHIM = `const chrome = (() => {
  const KEY = 'wm_bot_userscript_storage';
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch (e) {
      console.warn('[WikiMasters Bot] Stockage userscript illisible, réinitialisé:', e);
      return {};
    }
  };
  return {
    storage: {
      local: {
        get(keys, cb) {
          const all = load();
          const out = {};
          for (const k of [].concat(keys)) if (k in all) out[k] = all[k];
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set(obj) {
          localStorage.setItem(KEY, JSON.stringify({ ...load(), ...obj }));
          return Promise.resolve();
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: { getURL: f => f, sendMessage() {} }
  };
})();`;

function buildUserscript() {
  const manifest = JSON.parse(read('manifest.json'));
  const header = `// ==UserScript==
// @name         WikiMasters Bot - Auto-Pulls, Classement & Défausse
// @namespace    https://wiki-masters.com/
// @version      ${manifest.version}
// @description  ${manifest.description}
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// GENERATED FILE - do not edit. Source: ${SOURCES.join(', ')}. Rebuild: node scripts/build-userscript.js
`;
  const body = SOURCES.map(f => `// ---- ${f} ----\n${read(f).trimEnd()}`).join('\n\n');
  return `${header}\n(() => {\n${CHROME_SHIM}\n\n${body}\n})();\n`;
}

if (require.main === module) {
  fs.writeFileSync(OUT, buildUserscript());
  console.log(`Wrote ${path.relative(ROOT, OUT)}`);
}

module.exports = { buildUserscript, OUT };
