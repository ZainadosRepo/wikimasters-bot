// Offline regression tests: Wikipedia/Wikidata data is injected into the caches, network is forbidden.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CardClassifier, DEFAULT_THEMES, normalizeText } = require('../classifier.js');

globalThis.fetch = async (url) => { throw new Error(`network call in offline test: ${url}`); };

// Neutral sample themes exercising each rule mechanism (no theme ships with the bot)
const theme = (id, name, extra) => ({ id, name, enabled: true, strongKeywords: [], keywords: [], wikiCategories: [], excludeKeywords: [], ...extra });
const SAMPLE_THEMES = [
  theme('tennis', 'Tennis', {
    keywords: ['tennis'],
    wikidataRules: [{ label: 'sport tennis', any: { P641: ['tennis'], P106: ['joueur de tennis'] } }]
  }),
  theme('chanson_fr', 'Chanson FR', {
    requireFrenchContext: true,
    wikidataRules: [{ label: 'chanteur français', humanOnly: true, any: { P106: ['chanteur'] }, all: { P27: ['france'] } }]
  }),
  theme('armement', 'Armement', {
    wikidataRules: [{ label: 'arme', nonHumanOnly: true, any: { P31: ['arme'], P279: ['arme', 'char'] } }]
  })
];

function withInfo(classifier, title, { description = '', firstSentence = '', categories = [], wd = null } = {}) {
  classifier.wikiInfoCache.set(`fr:${title.toLowerCase()}`, {
    categories,
    extract: firstSentence,
    description,
    firstSentence,
    qid: null,
    wd: wd && {
      isHuman: !!wd.isHuman,
      qids: {},
      labels: Object.fromEntries(Object.entries(wd).filter(([k]) => k !== 'isHuman').map(([p, ls]) => [p, ls.map(normalizeText)]))
    }
  });
}

test('no theme ships with the bot', () => {
  assert.equal(DEFAULT_THEMES.length, 0);
  assert.equal(new CardClassifier().getThemes().length, 0);
});

test('a Wikidata rule decides the theme', async () => {
  const c = new CardClassifier(SAMPLE_THEMES);
  withInfo(c, 'Jane Doe', { description: 'joueuse norvégienne', wd: { isHuman: true, P106: ['joueur de tennis'], P27: ['Norvège'] } });
  assert.equal((await c.classifyCard({ wikipedia_title: 'Jane Doe' })).theme.name, 'Tennis');
});

test('a namesake keyword in the title is not enough when Wikidata knows the person does something else', async () => {
  const c = new CardClassifier(SAMPLE_THEMES);
  withInfo(c, 'Tennis Martin', { description: 'chanteur d\'opéra espagnol', wd: { isHuman: true, P106: ['artiste lyrique'], P27: ['Espagne'] } });
  assert.equal((await c.classifyCard({ wikipedia_title: 'Tennis Martin' })).theme, null);
});

test('`all` constraints: nationality is required', async () => {
  const c = new CardClassifier(SAMPLE_THEMES);
  withInfo(c, 'Hans', { description: 'chanteur allemand', wd: { isHuman: true, P106: ['chanteur ou chanteuse'], P27: ['Allemagne'] } });
  withInfo(c, 'Jean', { description: 'chanteur français', wd: { isHuman: true, P106: ['chanteur ou chanteuse'], P27: ['France'] } });
  assert.equal((await c.classifyCard({ wikipedia_title: 'Hans' })).theme, null);
  assert.equal((await c.classifyCard({ wikipedia_title: 'Jean' })).theme.name, 'Chanson FR');
});

test('nonHumanOnly rules ignore people', async () => {
  const c = new CardClassifier(SAMPLE_THEMES);
  withInfo(c, 'Char X', { wd: { P31: ['modèle de véhicule de combat'], P279: ['char lourd'] } });
  withInfo(c, 'Armurier Y', { wd: { isHuman: true, P31: ['être humain'], P279: ['arme'] } });
  assert.equal((await c.classifyCard({ wikipedia_title: 'Char X' })).theme.name, 'Armement');
  assert.equal((await c.classifyCard({ wikipedia_title: 'Armurier Y' })).theme, null);
});

test('two close themes => no tag, flagged as ambiguous', async () => {
  const c = new CardClassifier([
    theme('a', 'Alpha', { keywords: ['alpha'] }),
    theme('b', 'Beta', { keywords: ['beta'] })
  ]);
  withInfo(c, 'Alpha Beta', {});
  const res = await c.classifyCard({ wikipedia_title: 'Alpha Beta' });
  assert.equal(res.theme, null);
  assert.equal(res.ambiguous, true);
  assert.deepEqual(res.candidates.map(t => t.name).sort(), ['Alpha', 'Beta']);
});

function collectionBuilder(c) {
  const collection = [];
  const add = (title, tag, info) => {
    withInfo(c, title, info);
    collection.push({ id: title, card_id: title, snapshot_title: title, user_card_tags: tag ? [{ tag_id: tag, name: tag }] : [] });
  };
  return { collection, add };
}

test('themes are created from the account tags and learned from scratch', async () => {
  const c = new CardClassifier();
  const { collection, add } = collectionBuilder(c);
  for (let i = 0; i < 5; i++) {
    add(`Pilote ${i}`, 'Rallye', { description: 'pilote automobile', categories: ['Pilote de rallye'], wd: { isHuman: true, P106: ['pilote de rallye'], P641: ['rallye automobile'] } });
  }
  for (let i = 0; i < 8; i++) {
    add(`Peintre ${i}`, null, { description: 'peintre', categories: ['Peintre français'], wd: { isHuman: true, P106: ['peintre'] } });
  }
  await c.learnFromCollection(collection, [{ id: 'Rallye', name: 'Rallye' }], true);

  assert.deepEqual(c.getThemes().map(t => t.name), ['Rallye']);
  withInfo(c, 'Nouveau pilote', { description: 'pilote automobile', categories: ['Pilote de rallye'], wd: { isHuman: true, P106: ['pilote de rallye'], P641: ['rallye automobile'] } });
  withInfo(c, 'Nouveau peintre', { description: 'peintre', categories: ['Peintre français'], wd: { isHuman: true, P106: ['peintre'] } });
  assert.equal((await c.classifyCard({ wikipedia_title: 'Nouveau pilote' })).theme.name, 'Rallye');
  assert.equal((await c.classifyCard({ wikipedia_title: 'Nouveau peintre' })).theme, null);
});

test('learning: generic traits shared with untagged cards are not learned', async () => {
  const c = new CardClassifier();
  const { collection, add } = collectionBuilder(c);
  for (let i = 0; i < 4; i++) {
    add(`Joueuse ${i}`, 'Tennis', { description: 'joueuse américaine', categories: ['Nom de scène', 'Joueuse américaine'], wd: { isHuman: true, P106: ['joueur de tennis'], P27: ['États-Unis'] } });
  }
  for (let i = 0; i < 6; i++) {
    add(`Chanteuse ${i}`, null, { description: 'chanteuse américaine', categories: ['Nom de scène', 'Chanteuse américaine'], wd: { isHuman: true, P106: ['chanteur ou chanteuse'], P27: ['États-Unis'] } });
  }
  await c.learnFromCollection(collection, [{ id: 'Tennis', name: 'Tennis' }], true);

  const features = Object.keys(c.learnedData.tagProfiles.Tennis.features);
  assert.ok(!features.includes('cat:nom de scene'), 'generic category must not be learned');
  assert.ok(features.includes('P106:joueur de tennis'), `learned: ${features.join(', ')}`);

  withInfo(c, 'Nouvelle chanteuse', { description: 'chanteuse américaine', categories: ['Nom de scène', 'Chanteuse américaine'], wd: { isHuman: true, P106: ['chanteur ou chanteuse'], P27: ['États-Unis'] } });
  assert.equal((await c.classifyCard({ wikipedia_title: 'Nouvelle chanteuse' })).theme, null);
});

test('silent learning (no network) keeps previously learned profiles', async () => {
  const c = new CardClassifier();
  c.learnedData.tagProfiles = { Rallye: { count: 3, features: { 'P641:rallye automobile': 5 } } };
  await c.learnFromCollection([{ id: 1, card_id: 1, snapshot_title: 'Sébastien', user_card_tags: [{ tag_id: 'r', name: 'Rallye' }] }], [], false);
  assert.deepEqual(c.learnedData.tagProfiles.Rallye.features, { 'P641:rallye automobile': 5 });
  assert.equal(c.learnedData.knownCardsByTitle.sebastien, 'Rallye');
});
