#!/usr/bin/env node
// Prints what the classifier sees for one or more Wikipedia titles (Wikidata facts, categories, scores).
// Usage: node eval/inspect-card.js "Titre 1" "Titre 2" [--facts-only]
require('./fetch-cache');
const { CardClassifier } = require('../classifier.js');

const args = process.argv.slice(2);
const factsOnly = args.includes('--facts-only');
const titles = args.filter(a => !a.startsWith('--'));

(async () => {
  const c = new CardClassifier();
  await c.prefetch(titles, 'fr');
  for (const t of titles) {
    const info = await c.fetchWikipediaInfo(t, 'fr');
    console.log(`\n### ${t}  (${info.qid || 'pas de QID'})`);
    console.log('  description :', info.description);
    if (info.wd) {
      for (const [p, labels] of Object.entries(info.wd.labels)) console.log(`  ${p.padEnd(6)} ${labels.join(' | ')}`);
    }
    if (factsOnly) continue;
    console.log('  catégories :', info.categories.join(' | '));
    const res = await c.classifyCard({ wikipedia_title: t }, true);
    console.log(`  => ${res.theme ? res.theme.name : 'aucun'} (score ${res.score}${res.ambiguous ? ', ambigu' : ''})`);
    for (const d of res.details.slice(0, 3)) console.log(`     ${d.theme.name} ${d.score} : ${d.matches.join(' ; ')}`);
  }
})();
