#!/usr/bin/env node
// Precision benchmark for classifier.js.
//
// Usage:
//   node eval/run-eval.js --file export.json [--verbose]
// export.json comes from the bot panel ("Exporter mes cartes classées"). Two-fold cross-validation:
// the bot learns from half of your tagged cards and is scored on the other half.
//
// Wikipedia / Wikidata responses are cached in eval/.cache (see fetch-cache.js) so reruns are fast.

const fs = require('fs');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const fileIdx = args.indexOf('--file');
const exportFile = fileIdx >= 0 ? args[fileIdx + 1] : null;
if (!exportFile) {
  console.error('Usage: node eval/run-eval.js --file export.json [--verbose]');
  process.exit(1);
}

require('./fetch-cache');

const { CardClassifier } = require('../classifier.js');

function loadDataset() {
  const raw = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  const rows = Array.isArray(raw) ? raw : raw.cards;
  // Untagged cards are unlabeled (some of them belong to a theme): they are only used as
  // learning background, never scored.
  return rows
    .filter(r => r.title)
    .map(r => ({
      title: r.title,
      category: r.category || '',
      expected: r.tags && r.tags.length ? r.tags[0] : null,
      acceptable: r.tags || [],
      unlabeled: !(r.tags && r.tags.length)
    }));
}

function toCollectionRow(item, idx) {
  return {
    id: `uc_${idx}`,
    card_id: `c_${idx}`,
    snapshot_title: item.title,
    snapshot_category: item.category || '',
    user_card_tags: item.expected ? [{ tag_id: item.expected, name: item.expected }] : []
  };
}

async function evaluate(classifier, testSet) {
  const perTheme = new Map();
  const bump = (name, field) => {
    if (!perTheme.has(name)) perTheme.set(name, { tp: 0, fp: 0, fn: 0 });
    perTheme.get(name)[field]++;
  };
  const mistakes = [];
  let correct = 0;
  let abstained = 0;

  // Prefetch in batches like the bot does for a full-collection pass.
  if (typeof classifier.prefetch === 'function') {
    await classifier.prefetch(testSet.map(t => t.title), 'fr');
  } else if (typeof classifier.fetchWikipediaBatch === 'function') {
    await classifier.fetchWikipediaBatch(testSet.map(t => t.title), 'fr');
  }

  for (const item of testSet) {
    const res = await classifier.classifyCard({ wikipedia_title: item.title, category: item.category || '' }, true);
    const got = res && res.theme ? res.theme.name : null;
    if (!got && item.expected && res && res.ambiguous) abstained++;
    if (got === item.expected || (got && (item.acceptable || []).includes(got))) {
      correct++;
      if (got) bump(got, 'tp');
    } else {
      if (got) bump(got, 'fp');
      if (item.expected) bump(item.expected, 'fn');
      mistakes.push({ item, got, res });
    }
  }

  return { perTheme, mistakes, correct, abstained, total: testSet.length };
}

function printReport(label, r) {
  const pct = n => (r.total ? ((n / r.total) * 100).toFixed(1) : '0.0');
  let tp = 0, fp = 0, fn = 0;
  for (const s of r.perTheme.values()) { tp += s.tp; fp += s.fp; fn += s.fn; }
  const precision = tp + fp ? (tp / (tp + fp)) * 100 : 0;
  const recall = tp + fn ? (tp / (tp + fn)) * 100 : 0;

  console.log(`\n=== ${label} ===`);
  console.log(`Exactitude : ${r.correct}/${r.total} (${pct(r.correct)} %)`);
  console.log(`Précision des tags posés : ${precision.toFixed(1)} %  |  Rappel : ${recall.toFixed(1)} %`);
  console.log(`Mauvais tags posés : ${fp}  |  Cartes ratées : ${fn}${r.abstained ? ` (dont ${r.abstained} laissées de côté car ambiguës)` : ''}`);
  console.log('\nThème            TP  FP  FN  précision  rappel');
  for (const [name, s] of [...r.perTheme.entries()].sort()) {
    const p = s.tp + s.fp ? ((s.tp / (s.tp + s.fp)) * 100).toFixed(0) : '-';
    const rc = s.tp + s.fn ? ((s.tp / (s.tp + s.fn)) * 100).toFixed(0) : '-';
    console.log(`${name.padEnd(16)} ${String(s.tp).padStart(3)} ${String(s.fp).padStart(3)} ${String(s.fn).padStart(3)}  ${String(p).padStart(8)}%  ${String(rc).padStart(5)}%`);
  }

  console.log('\nErreurs :');
  for (const m of r.mistakes) {
    console.log(`  ✗ ${m.item.title.padEnd(40)} attendu=${String(m.item.expected).padEnd(13)} obtenu=${m.got}${m.res && m.res.ambiguous ? ' (ambigu)' : ''}`);
    if (verbose && m.res && m.res.details) {
      for (const d of m.res.details.slice(0, 3)) {
        console.log(`        ${d.theme.name} ${d.score} : ${d.matches.slice(0, 6).join(' ; ')}`);
      }
    }
  }
}

async function main() {
  const all = loadDataset();
  const background = all.filter(d => d.unlabeled);
  const data = all.filter(d => !d.unlabeled);

  // Two-fold cross-validation: each half is learned from, then the other half is tested.
  const folds = [data.filter((_, i) => i % 2 === 0), data.filter((_, i) => i % 2 === 1)];
  const merged = { perTheme: new Map(), mistakes: [], correct: 0, abstained: 0, total: 0 };
  for (let f = 0; f < 2; f++) {
    const train = folds[f];
    const test = folds[1 - f];
    const classifier = new CardClassifier();
    // Untagged test cards are part of the collection too (they feed document frequencies),
    // but their labels are hidden.
    const collection = [
      ...train.map((t, i) => toCollectionRow(t, `tr${f}_${i}`)),
      ...test.map((t, i) => toCollectionRow({ ...t, expected: null }, `te${f}_${i}`)),
      ...background.map((t, i) => toCollectionRow(t, `bg${f}_${i}`))
    ];
    const tags = [...new Set(train.map(t => t.expected).filter(Boolean))].map(n => ({ id: n, name: n }));
    await classifier.learnFromCollection(collection, tags, true);
    const r = await evaluate(classifier, test);
    merged.correct += r.correct;
    merged.abstained += r.abstained;
    merged.total += r.total;
    merged.mistakes.push(...r.mistakes);
    for (const [k, v] of r.perTheme) {
      const cur = merged.perTheme.get(k) || { tp: 0, fp: 0, fn: 0 };
      merged.perTheme.set(k, { tp: cur.tp + v.tp, fp: cur.fp + v.fp, fn: cur.fn + v.fn });
    }
  }
  printReport(`Collection exportée (${data.length} cartes étiquetées), validation croisée`, merged);
}

main().catch(e => { console.error(e); process.exit(1); });
