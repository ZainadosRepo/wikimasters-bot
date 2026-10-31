// ==UserScript==
// @name         WikiMasters Bot - Auto-Pulls, Classement & Défausse
// @namespace    https://wiki-masters.com/
// @version      1.1.0
// @description  Bot pour WikiMasters : ouverture automatique des packs et classification intelligente de vos cartes selon vos thèmes favoris.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// GENERATED FILE - do not edit. Source: classifier.js, discard.js, page-bridge.js, content.js. Rebuild: node scripts/build-userscript.js

(() => {
const chrome = (() => {
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
})();

// ---- classifier.js ----
// classifier.js - Moteur d'analyse sémantique profonde, API Wikipédia & Apprentissage de Collection
(() => {
  const LEARNED_STORAGE_KEY = 'wm_bot_learned_profiles_v3';

  // Aucun thème n'est livré avec le bot : ils sont créés à partir des tags de votre compte
  // (learnFromCollection) ou passés au constructeur. Format d'un thème : voir le README.
  const DEFAULT_THEMES = [];

  // Apprentissage sur la collection
  const BACKGROUND_GROUP = '__sans_tag__';
  const LEARN_SAMPLE_PER_TAG = 30;
  const LEARN_BACKGROUND_SAMPLE = 90;
  const LEARN_MIN_PURITY = 0.55;
  const LEARN_WD_PROPS = ['P106', 'P641', 'P31', 'P279', 'P102', 'P136', 'P8345', 'P179', 'P1080', 'P361', 'P463', 'P241', 'P452'];
  // Catégories trop génériques pour caractériser un thème, même si elles sont fréquentes dans un tag
  const GENERIC_CATEGORY_RE = /^(naissance|deces|mort|personnalite|page|article|portail|wikip|homonymie|nom de scene|pseudonyme|medaille|champion olympique|championne olympique|laureat|eleve|etudiant|ancien eleve|auteur publie|docteur honoris|membre de l academie|commandeur|officier de la legion|chevalier|grand officier|grand croix|sportif|sportive)/;

  // Échantillon réparti uniformément (déterministe) plutôt que les N premiers éléments
  function evenSample(arr, n) {
    const uniq = [...new Set(arr)];
    if (uniq.length <= n) return uniq;
    const step = uniq.length / n;
    return Array.from({ length: n }, (_, i) => uniq[Math.floor(i * step)]);
  }

  function extractLearnFeatures(info) {
    const feats = new Set();
    for (const c of (info.categories || [])) {
      const cNorm = normalizeText(c);
      if (cNorm.length >= 4 && !GENERIC_CATEGORY_RE.test(cNorm)) feats.add(`cat:${cNorm}`);
    }
    if (info.wd) {
      for (const p of LEARN_WD_PROPS) {
        for (const label of (info.wd.labels[p] || [])) feats.add(`${p}:${label}`);
      }
    }
    return feats;
  }

  // Mots indiquant explicitement un contexte français (thèmes avec requireFrenchContext)
  const FRENCH_CONTEXT_MARKERS = [
    'francais', 'francaise', 'france', 'assemblee nationale', 'senat francais',
    'cinquieme republique', 'quatrieme republique', 'troisieme republique', 'elysee',
    'matignon', 'paris', 'lyon', 'marseille', 'toulouse', 'bordeaux', 'lille', 'nantes',
    'strasbourg', 'rennes', 'grenoble', 'montpellier', 'nice', 'rouen', 'toulon', 'dijon',
    'angers', 'nimes', 'clermont ferrand', 'brest', 'tours', 'limoges', 'amiens', 'metz',
    'perpignan', 'besancon', 'orleans', 'mulhouse', 'caen', 'boulogne', 'nancy', 'argenteuil',
    'saint denis', 'roubaix', 'tourcoing', 'nanterre', 'avignon', 'creteil', 'poitiers',
    'versailles', 'pau', 'la rochelle', 'calais', 'cannes', 'antibes', 'beziers', 'colmar',
    'quimper', 'valence', 'bourges', 'lorient', 'troyes', 'chambery', 'niort', 'ajaccio',
    'bastia', 'guadeloupe', 'martinique', 'guyane', 'la reunion', 'mayotte', 'polynesie',
    'nouvelle caledonie', 'corse', 'bretagne', 'normandie', 'occitanie', 'nouvelle aquitaine',
    'auvergne rhone alpes', 'hauts de france', 'grand est', 'pays de la loire', 'ile de france',
    'provence alpes cote d azur', 'bourgogne franche comte', 'centre val de loire',
    'departement', 'circonscription', 'canton', 'commune francaise', 'outre mer',
    'parti socialiste', 'les republicains', 'rassemblement national', 'front national',
    'france insoumise', 'renaissance', 'en marche', 'ump', 'rpr', 'udf', 'pcf', 'eelv'
  ];

  // Nationalités étrangères qui disqualifient un thème requireFrenchContext si aucun marqueur français n'est présent dans l'intro
  const FOREIGN_POLITICS_MARKERS = [
    'americain', 'americaine', 'etats unis', 'britannique', 'royaume uni', 'anglais', 'anglaise',
    'ecossais', 'allemand', 'allemande', 'allemagne', 'italien', 'italienne', 'italie',
    'espagnol', 'espagnole', 'espagne', 'belge', 'belgique', 'suisse', 'canadien', 'canadienne',
    'canada', 'quebecois', 'quebecoise', 'russe', 'russie', 'sovietique', 'chinois', 'chinoise',
    'japonais', 'japonaise', 'bresilien', 'bresilienne', 'argentin', 'mexicain', 'indien',
    'australien', 'neerlandais', 'autrichien', 'polonais', 'suedois', 'norvegien', 'danois',
    'finlandais', 'grec', 'portugais', 'turc', 'israelien', 'egyptien', 'marocain', 'algerien',
    'tunisien', 'senegalais', 'ivoirien', 'camerounais', 'congolais', 'sud africain', 'ukrainien'
  ];

  // Normalisation des chaînes pour une comparaison textuelle robuste
  function normalizeText(str) {
    if (!str) return '';
    return String(str)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Supprime les accents
      .replace(/['’`]/g, ' ')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Propriétés Wikidata utiles au classement (valeurs = entités dont on récupère le libellé FR)
  const WD_PROPS = [
    'P31',   // nature de l'élément
    'P279',  // sous-classe de
    'P106',  // occupation
    'P27',   // nationalité
    'P17',   // pays
    'P495',  // pays d'origine
    'P641',  // sport
    'P102',  // parti politique
    'P39',   // fonction occupée
    'P241',  // branche militaire
    'P463',  // membre de
    'P607',  // conflit
    'P361',  // partie de
    'P8345', // franchise
    'P179',  // série
    'P1080', // univers de fiction
    'P136',  // genre
    'P452',  // secteur d'activité
    'P1142'  // idéologie
  ];

  // Seuils de décision
  const MINIMUM_SCORE_THRESHOLD = 6;   // Seuil minimal pour éviter les faux positifs sur un mot isolé
  const WD_RULE_WEIGHT = 25;           // Fait Wikidata qui correspond à une règle du thème
  const WD_HUMAN_MISMATCH_FACTOR = 0.5;
  const LEARNED_BOOST_CAP = 12;
  const MIN_MARGIN = 4;                // Écart minimal entre les deux meilleurs thèmes...
  const MIN_MARGIN_RATIO = 0.2;        // ...ou 20 % du meilleur score

  // Une règle correspond si au moins une propriété de `any` contient un des mots attendus
  // et si toutes les propriétés de `all` en contiennent un.
  function matchWikidataRules(theme, wd) {
    for (const rule of (theme.wikidataRules || [])) {
      if (rule.humanOnly && !wd.isHuman) continue;
      if (rule.nonHumanOnly && wd.isHuman) continue;
      const propMatches = (prop, words) => (wd.labels[prop] || []).some(label => words.some(w => hasNormalizedPhrase(label, w)));
      const anyOk = !rule.any || Object.entries(rule.any).some(([p, words]) => propMatches(p, words));
      const allOk = !rule.all || Object.entries(rule.all).every(([p, words]) => propMatches(p, words));
      if (anyOk && allOk) return rule.label;
    }
    return null;
  }

  // Wikimedia limite le débit (HTTP 429) : requêtes en série, espacées, avec réessai.
  const API_MIN_GAP_MS = 120;
  let apiQueue = Promise.resolve();
  let lastApiCallAt = 0;

  function politeFetchJson(url) {
    const run = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = lastApiCallAt + API_MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastApiCallAt = Date.now();
        const res = await fetch(url);
        if (res.ok) return res.json();
        if (res.status !== 429 && res.status < 500) {
          console.warn('[WikiMasters Bot] API Wikimedia HTTP', res.status, url.slice(0, 120));
          return null;
        }
        const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0;
        await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 1500 * (attempt + 1))));
      }
      console.warn('[WikiMasters Bot] API Wikimedia indisponible après réessais', url.slice(0, 120));
      return null;
    };
    const p = apiQueue.then(run, run);
    apiQueue = p.catch(() => {});
    return p;
  }

  function emptyWikiInfo() {
    return { categories: [], extract: '', description: '', firstSentence: '', qid: null, wd: null };
  }

  // Test d'expression exacte aux frontières de mots sur du texte déjà normalisé
  function hasNormalizedPhrase(haystackNorm, needleRaw) {
    if (!haystackNorm || !needleRaw) return false;
    const needle = normalizeText(needleRaw);
    if (!needle) return false;
    const paddedHaystack = ` ${haystackNorm} `;
    return paddedHaystack.includes(` ${needle} `);
  }

  class CardClassifier {
    constructor(customThemes = null) {
      this.themes = customThemes || DEFAULT_THEMES.map(t => ({ ...t }));
      this.wikiInfoCache = new Map(); // cacheKey -> { categories, extract, description, firstSentence, qid, wd }
      this.wdFactsCache = new Map();  // qid -> { qids: {prop: [Q..]}, labels: {prop: [libellé normalisé]}, isHuman }
      this.wdLabelCache = new Map();  // qid -> libellé FR (ou EN)
      this.wdClaimsCache = new Map(); // qid -> {prop: [Q..]} (en attente des libellés)
      this.learnedData = {
        knownCardsById: {},       // card_id -> tagName
        knownCardsByTitle: {},    // normalizedTitle -> tagName
        tagProfiles: {},          // tagName -> { terms: { word: weight }, bigrams: { bg: weight }, wikiCats: { cat: weight }, count: number }
        lastLearnedAt: 0,
        totalTaggedCards: 0
      };
      this.loadLearnedProfiles();
    }

    setThemes(themes) {
      if (!Array.isArray(themes)) return;
      // Pour un thème par défaut, seuls l'activation et la couleur viennent du stockage : les anciennes
      // versions y enregistraient aussi les listes de mots-clés, qui masqueraient sinon les corrections.
      this.themes = themes.map(custom => {
        const def = DEFAULT_THEMES.find(d => d.id === custom.id || normalizeText(d.name) === normalizeText(custom.name));
        if (def) {
          return {
            ...def,
            enabled: typeof custom.enabled === 'boolean' ? custom.enabled : def.enabled,
            color: custom.color || def.color
          };
        }
        return {
          strongKeywords: [],
          keywords: [],
          wikiCategories: [],
          excludeKeywords: [],
          ...custom
        };
      });
    }

    getThemes() {
      return this.themes;
    }

    loadLearnedProfiles() {
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(LEARNED_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              this.learnedData = { ...this.learnedData, ...parsed };
            }
          }
        }
      } catch (_) {}
    }

    saveLearnedProfiles() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(LEARNED_STORAGE_KEY, JSON.stringify(this.learnedData));
        }
      } catch (_) {}
    }

    getLearnedStats() {
      const profiles = this.learnedData.tagProfiles || {};
      const summary = {};
      for (const [tagName, prof] of Object.entries(profiles)) {
        summary[tagName] = {
          cardCount: prof.count || 0,
          topFeatures: Object.entries(prof.features || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f]) => f)
        };
      }
      return {
        totalTaggedCards: this.learnedData.totalTaggedCards || 0,
        knownTitlesCount: Object.keys(this.learnedData.knownCardsByTitle || {}).length,
        lastLearnedAt: this.learnedData.lastLearnedAt || 0,
        profiles: summary
      };
    }

    // =========================================================================
    // Apprentissage Automatique sur la Collection Existante de l'Utilisateur
    // =========================================================================
    async learnFromCollection(collection, userTags = [], fetchWikiForExemplars = true) {
      if (!Array.isArray(collection) || collection.length === 0) return this.getLearnedStats();

      // 1. Table de correspondance tag_id -> nom du tag
      const tagIdToName = new Map();
      const tagColorMap = new Map();
      if (Array.isArray(userTags)) {
        for (const t of userTags) {
          if (t && t.id && t.name) {
            tagIdToName.set(String(t.id), String(t.name).trim());
            if (t.color) tagColorMap.set(String(t.name).trim(), t.color);
          }
        }
      }

      // S'assurer que tout tag personnalisé présent dans la base de l'utilisateur existe aussi dans this.themes
      for (const [, tagName] of tagIdToName.entries()) {
        const exists = this.themes.some(t => normalizeText(t.name) === normalizeText(tagName));
        if (!exists) {
          this.themes.push({
            id: 'custom_' + normalizeText(tagName).replace(/\s+/g, '_'),
            name: tagName,
            color: tagColorMap.get(tagName) || '#10b981',
            enabled: true,
            strongKeywords: [tagName.toLowerCase()],
            keywords: [tagName.toLowerCase()],
            wikiCategories: [tagName.toLowerCase()],
            excludeKeywords: []
          });
        }
      }

      const knownCardsById = {};
      const knownCardsByTitle = {};
      const cardsByTag = new Map(); // tagName -> Array<cardItem>
      let totalTagged = 0;

      for (const uc of collection) {
        const rawTags = uc.user_card_tags || [];
        if (!Array.isArray(rawTags) || rawTags.length === 0) continue;

        const title = uc.snapshot_title || uc.card?.wikipedia_title || uc.card?.name || '';
        const titleNorm = normalizeText(title);

        for (const rt of rawTags) {
          const tid = String(rt.tag_id || rt.id || '');
          const tName = rt.tag_name || rt.name || tagIdToName.get(tid);
          if (!tName) continue;

          // Trouver le nom canonique dans this.themes
          const canonicalTheme = this.themes.find(th => normalizeText(th.name) === normalizeText(tName));
          const finalTagName = canonicalTheme ? canonicalTheme.name : tName;

          if (uc.card_id) knownCardsById[String(uc.card_id)] = finalTagName;
          if (titleNorm) knownCardsByTitle[titleNorm] = finalTagName;

          if (!cardsByTag.has(finalTagName)) cardsByTag.set(finalTagName, []);
          cardsByTag.get(finalTagName).push({ cardId: uc.card_id, title });
          totalTagged++;
        }
      }

      if (!fetchWikiForExemplars) {
        // Pas de requête réseau : on met à jour la mémoire exacte sans écraser les profils déjà appris.
        this.learnedData = {
          ...this.learnedData,
          knownCardsById,
          knownCardsByTitle,
          lastLearnedAt: Date.now(),
          totalTaggedCards: totalTagged
        };
        this.saveLearnedProfiles();
        return this.getLearnedStats();
      }

      // 2. Échantillon de cartes étiquetées (par tag) + cartes sans tag (« fond »). Le fond sert à
      //    mesurer la spécificité : sans lui, une catégorie banale comme « Médaillé olympique français »
      //    paraît typique du premier tag qui la contient.
      const groups = new Map(); // groupe -> { population, sample: [titre] }
      for (const [tagName, items] of cardsByTag) {
        groups.set(tagName, { population: items.length, sample: evenSample(items.map(i => i.title).filter(Boolean), LEARN_SAMPLE_PER_TAG) });
      }
      const untaggedTitles = collection
        .filter(uc => !Array.isArray(uc.user_card_tags) || uc.user_card_tags.length === 0)
        .map(uc => uc.snapshot_title || uc.card?.wikipedia_title || uc.card?.name || '')
        .filter(Boolean);
      groups.set(BACKGROUND_GROUP, { population: untaggedTitles.length, sample: evenSample(untaggedTitles, LEARN_BACKGROUND_SAMPLE) });

      await this.prefetch([...groups.values()].flatMap(g => g.sample), 'fr');

      // 3. Comptage des caractéristiques (catégories, faits Wikidata) par groupe, pondéré par la taille du groupe
      const featCounts = new Map(); // caractéristique -> Map(groupe -> nb de cartes échantillonnées)
      const groupStats = new Map(); // groupe -> { weight, n }
      for (const [g, { population, sample }] of groups) {
        const infos = sample.map(t => this.wikiInfoCache.get(`fr:${t.toLowerCase()}`)).filter(Boolean);
        groupStats.set(g, { weight: infos.length ? population / infos.length : 0, n: infos.length });
        for (const info of infos) {
          for (const f of extractLearnFeatures(info)) {
            if (!featCounts.has(f)) featCounts.set(f, new Map());
            const m = featCounts.get(f);
            m.set(g, (m.get(g) || 0) + 1);
          }
        }
      }

      // 4. Profil appris : caractéristiques fréquentes dans le tag ET rares ailleurs
      const tagProfiles = {};
      for (const [tagName, items] of cardsByTag) {
        const { weight: wTag, n: nSample } = groupStats.get(tagName);
        const features = {};
        if (nSample > 0) {
          for (const [f, byGroup] of featCounts) {
            const nIn = byGroup.get(tagName) || 0;
            if (nIn < 2 || nIn / nSample < 0.15) continue;
            let total = 0;
            for (const [g, n] of byGroup) total += n * groupStats.get(g).weight;
            const purity = (nIn * wTag) / total;
            if (purity < LEARN_MIN_PURITY) continue;
            features[f] = Math.round((2 + 6 * purity) * 10) / 10;
          }
        }
        tagProfiles[tagName] = { count: items.length, features };
      }

      this.learnedData = {
        knownCardsById,
        knownCardsByTitle,
        tagProfiles,
        lastLearnedAt: Date.now(),
        totalTaggedCards: totalTagged
      };

      this.saveLearnedProfiles();
      return this.getLearnedStats();
    }

    // =========================================================================
    // Requêtes API Wikipédia Profondes (Intro + Description + Catégories non-cachées + QID Wikidata)
    // =========================================================================
    async fetchWikipediaInfo(wikiTitle, lang = 'fr') {
      if (!wikiTitle) return emptyWikiInfo();
      const cleanTitle = String(wikiTitle).trim();
      const cacheKey = `${lang}:${cleanTitle.toLowerCase()}`;
      if (!this.wikiInfoCache.has(cacheKey)) {
        await this.fetchWikipediaBatch([cleanTitle], lang);
      }
      const info = this.wikiInfoCache.get(cacheKey);
      if (!info) return emptyWikiInfo();
      if (info.qid && !info.wd) {
        await this.fetchWikidataFacts([info.qid]);
        info.wd = this.wdFactsCache.get(info.qid) || null;
      }
      return info;
    }

    // Rétrocompatibilité avec d'éventuels appels directs à fetchWikipediaCategories
    async fetchWikipediaCategories(wikiTitle, lang = 'fr') {
      const info = await this.fetchWikipediaInfo(wikiTitle, lang);
      return info.categories || [];
    }

    // Wikipédia + Wikidata en lot pour une liste de titres (classement de collection, apprentissage)
    async prefetch(titles, lang = 'fr') {
      await this.fetchWikipediaBatch(titles, lang);
      const infos = (titles || [])
        .map(t => this.wikiInfoCache.get(`${lang}:${String(t || '').trim().toLowerCase()}`))
        .filter(Boolean);
      await this.fetchWikidataFacts(infos.map(i => i.qid).filter(Boolean));
      for (const info of infos) {
        if (info.qid && !info.wd) info.wd = this.wdFactsCache.get(info.qid) || null;
      }
    }

    // Récupération groupée (Batch) jusqu'à 20 titres par requête HTTP pour accélérer x15 le classement de collection
    async fetchWikipediaBatch(titles, lang = 'fr') {
      if (!Array.isArray(titles) || titles.length === 0) return;
      const missing = [...new Set(titles
        .map(t => String(t || '').trim())
        .filter(t => t && !this.wikiInfoCache.has(`${lang}:${t.toLowerCase()}`)))];

      if (missing.length === 0) return;

      const BATCH_SIZE = 18; // MediaWiki exlimit max = 20 pour exintro
      for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const chunk = missing.slice(i, i + BATCH_SIZE);
        try {
          const joined = chunk.map(t => t.replace(/\|/g, ' ')).join('|');
          const baseUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&redirects=1&prop=extracts|categories|description|pageprops&ppprop=wikibase_item&exintro=1&exlimit=20&explaintext=1&clshow=!hidden&cllimit=500&titles=${encodeURIComponent(joined)}&format=json&origin=*`;

          // cllimit est partagé entre toutes les pages du lot : il faut suivre "continue"
          // sinon les dernières pages arrivent sans catégories.
          const pagesById = new Map();
          const redirectMap = new Map(); // toTitleLower -> fromTitleLower
          let cont = null;
          for (let round = 0; round < 6; round++) {
            const contQs = cont ? '&' + Object.entries(cont).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
            const data = await politeFetchJson(baseUrl + contQs);
            if (!data) break;
            const query = data.query;
            if (!query || !query.pages) break;

            for (const n of (query.normalized || [])) {
              redirectMap.set(n.to.toLowerCase(), n.from.toLowerCase());
            }
            for (const r of (query.redirects || [])) {
              const orig = redirectMap.get(r.from.toLowerCase()) || r.from.toLowerCase();
              redirectMap.set(r.to.toLowerCase(), orig);
            }
            for (const [pid, p] of Object.entries(query.pages)) {
              if (Number(pid) < 0) continue;
              const acc = pagesById.get(pid) || { title: p.title, extract: '', description: '', qid: null, categories: [] };
              if (p.extract) acc.extract = p.extract;
              if (p.description) acc.description = p.description;
              if (p.pageprops && p.pageprops.wikibase_item) acc.qid = p.pageprops.wikibase_item;
              for (const c of (p.categories || [])) {
                acc.categories.push(c.title.replace(/^Catégorie:/i, '').replace(/^Category:/i, ''));
              }
              pagesById.set(pid, acc);
            }
            if (!data.continue) break;
            cont = data.continue;
          }

          for (const p of pagesById.values()) {
            const pageTitleLower = (p.title || '').toLowerCase();
            const origTitleLower = redirectMap.get(pageTitleLower) || pageTitleLower;
            const firstSentence = p.extract ? (p.extract.split(/(?<=[.!?])\s+/)[0] || p.extract.substring(0, 300)) : '';
            const info = {
              categories: [...new Set(p.categories)],
              extract: p.extract,
              description: p.description,
              firstSentence,
              qid: p.qid,
              wd: null
            };
            this.wikiInfoCache.set(`${lang}:${pageTitleLower}`, info);
            this.wikiInfoCache.set(`${lang}:${origTitleLower}`, info);
          }
        } catch (e) {
          console.warn('[WikiMasters Bot] Erreur batch Wikipédia:', e);
        }
      }
    }

    // =========================================================================
    // Wikidata : faits structurés (métier, nationalité, sport, parti, conflit...)
    // =========================================================================
    async fetchWikidataFacts(qids) {
      const wanted = [...new Set((qids || []).filter(q => q && !this.wdFactsCache.has(q)))];
      if (wanted.length === 0) return;

      const valueIds = new Set();
      const rawByQid = new Map();
      for (const q of wanted) {
        if (this.wdClaimsCache.has(q)) {
          rawByQid.set(q, this.wdClaimsCache.get(q));
          Object.values(this.wdClaimsCache.get(q)).flat().forEach(id => valueIds.add(id));
        }
      }
      const missing = wanted.filter(q => !this.wdClaimsCache.has(q));
      for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        try {
          const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${chunk.join('|')}&props=claims&format=json&origin=*`;
          const data = await politeFetchJson(url);
          if (!data) continue;
          for (const [qid, ent] of Object.entries(data.entities || {})) {
            const claims = ent.claims || {};
            const byProp = {};
            for (const prop of WD_PROPS) {
              const ids = (claims[prop] || [])
                .filter(c => c.rank !== 'deprecated')
                .map(c => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id)
                .filter(Boolean);
              if (ids.length) {
                byProp[prop] = ids;
                ids.forEach(id => valueIds.add(id));
              }
            }
            rawByQid.set(qid, byProp);
            this.wdClaimsCache.set(qid, byProp);
          }
        } catch (e) {
          console.warn('[WikiMasters Bot] Erreur API Wikidata:', e);
        }
      }

      await this.fetchWikidataLabels([...valueIds]);

      for (const [qid, byProp] of rawByQid) {
        const allIds = Object.values(byProp).flat();
        // Libellés manquants (limite de débit, réseau) : on ne met pas en cache, la prochaine
        // classification de cette carte retentera.
        if (allIds.some(id => !this.wdLabelCache.has(id))) continue;
        const facts = { qids: byProp, labels: {} };
        for (const [prop, ids] of Object.entries(byProp)) {
          facts.labels[prop] = ids.map(id => normalizeText(this.wdLabelCache.get(id))).filter(Boolean);
        }
        facts.isHuman = (byProp.P31 || []).includes('Q5');
        this.wdFactsCache.set(qid, facts);
      }
    }

    async fetchWikidataLabels(ids) {
      const missing = [...new Set((ids || []).filter(id => id && !this.wdLabelCache.has(id)))];
      for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        try {
          const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${chunk.join('|')}&props=labels&languages=fr|en&format=json&origin=*`;
          const data = await politeFetchJson(url);
          if (!data) continue;
          for (const [id, ent] of Object.entries(data.entities || {})) {
            const l = ent.labels || {};
            this.wdLabelCache.set(id, (l.fr && l.fr.value) || (l.en && l.en.value) || '');
          }
        } catch (e) {
          console.warn('[WikiMasters Bot] Erreur labels Wikidata:', e);
        }
      }
    }

    // =========================================================================
    // Classification Multi-Critères (Mémoire Collection + Intro + Catégories + Anti-Faux-Positifs)
    // =========================================================================
    async classifyCard(card, checkWikiApi = true) {
      if (!card) return null;

      const rawTitle = card.wikipedia_title || card.title || card.name || card.snapshot_title || '';
      const titleNorm = normalizeText(rawTitle);
      const cardIdStr = card.card_id ? String(card.card_id) : (card.id ? String(card.id) : '');
      const cardCatRaw = card.category || card.snapshot_category || '';
      const cardCatNorm = normalizeText(cardCatRaw);

      // 1. PRIORITÉ ABSOLUE : Carte déjà classée dans la collection de l'utilisateur !
      const knownThemeName = (cardIdStr && this.learnedData.knownCardsById?.[cardIdStr])
        || (titleNorm && this.learnedData.knownCardsByTitle?.[titleNorm]);

      if (knownThemeName) {
        const matchedTheme = this.themes.find(t => t.enabled && normalizeText(t.name) === normalizeText(knownThemeName));
        if (matchedTheme) {
          return {
            card,
            theme: matchedTheme,
            score: 100,
            confidence: 'certain',
            reason: `Carte déjà classée dans votre collection [${matchedTheme.name}]`,
            details: [{ theme: matchedTheme, score: 100, matches: ['mémoire collection (100%)'] }],
            wikiCategories: []
          };
        }
      }

      // 2. Récupération des données riches Wikipédia (Intro, Description, Catégories non-cachées) + faits Wikidata
      let wikiInfo = emptyWikiInfo();
      if (checkWikiApi && rawTitle) {
        const lang = card.lang || 'fr';
        wikiInfo = await this.fetchWikipediaInfo(rawTitle, lang);
      }
      const wd = wikiInfo.wd || null;

      const wikiCategories = wikiInfo.categories || [];
      const catsNormList = wikiCategories.map(c => normalizeText(c)).filter(Boolean);
      const catsJoinedNorm = catsNormList.join(' | ');
      const wikiDescNorm = normalizeText(wikiInfo.description || '');
      const firstSentenceNorm = normalizeText(wikiInfo.firstSentence || '');
      const fullExtractNorm = normalizeText([
        wikiInfo.extract || '',
        card.description || '',
        card.summary || '',
        card.extract || ''
      ].filter(Boolean).join(' '));

      // Le "coeur" d'identité d'un article Wikipédia est son titre + sa description Wikidata + sa 1ère phrase + ses catégories
      const coreIdentityNorm = `${titleNorm} ${cardCatNorm} ${wikiDescNorm} ${firstSentenceNorm}`;

      const cardFeatures = extractLearnFeatures(wikiInfo);
      const scored = [];

      for (const theme of this.themes) {
        if (!theme.enabled) continue;

        let textScore = 0;
        const matchedKeywords = [];
        let hasCoreMatch = false; // Au moins une correspondance forte (titre, 1ère phrase, catégorie ou mémoire)

        // A. Mots-clés forts (strongKeywords) -> Poids très élevé
        for (const rawKw of (theme.strongKeywords || [])) {
          if (hasNormalizedPhrase(titleNorm, rawKw)) {
            textScore += 10;
            hasCoreMatch = true;
            matchedKeywords.push(`titre fort: "${rawKw}" (+10)`);
          } else if (hasNormalizedPhrase(wikiDescNorm, rawKw) || hasNormalizedPhrase(firstSentenceNorm, rawKw) || hasNormalizedPhrase(cardCatNorm, rawKw)) {
            textScore += 8;
            hasCoreMatch = true;
            matchedKeywords.push(`intro/desc: "${rawKw}" (+8)`);
          } else if (hasNormalizedPhrase(catsJoinedNorm, rawKw)) {
            textScore += 7;
            hasCoreMatch = true;
            matchedKeywords.push(`catégorie forte: "${rawKw}" (+7)`);
          } else if (hasNormalizedPhrase(fullExtractNorm, rawKw)) {
            textScore += 4;
            matchedKeywords.push(`texte fort: "${rawKw}" (+4)`);
          }
        }

        // B. Catégories Wikipédia officielles du thème (wikiCategories)
        if (theme.wikiCategories && catsNormList.length > 0) {
          let catScoreForTheme = 0;
          for (const rawCat of theme.wikiCategories) {
            const targetCatNorm = normalizeText(rawCat);
            if (!targetCatNorm) continue;
            const matchedCat = catsNormList.find(c => c === targetCatNorm || hasNormalizedPhrase(c, targetCatNorm));
            if (matchedCat) {
              catScoreForTheme += 5;
              hasCoreMatch = true;
              matchedKeywords.push(`catégorie wiki: "${rawCat}" (+5)`);
              if (catScoreForTheme >= 15) break; // Plafond pour éviter l'emballement
            }
          }
          textScore += catScoreForTheme;
        }

        // C. Mots-clés secondaires (keywords)
        let secondaryScore = 0;
        for (const rawKw of (theme.keywords || [])) {
          if (hasNormalizedPhrase(titleNorm, rawKw)) {
            secondaryScore += 6;
            hasCoreMatch = true;
            matchedKeywords.push(`titre: "${rawKw}" (+6)`);
          } else if (hasNormalizedPhrase(wikiDescNorm, rawKw) || hasNormalizedPhrase(firstSentenceNorm, rawKw) || hasNormalizedPhrase(cardCatNorm, rawKw)) {
            secondaryScore += 4;
            hasCoreMatch = true;
            matchedKeywords.push(`définition: "${rawKw}" (+4)`);
          } else if (hasNormalizedPhrase(catsJoinedNorm, rawKw)) {
            secondaryScore += 3;
            hasCoreMatch = true;
            matchedKeywords.push(`catégorie: "${rawKw}" (+3)`);
          } else if (hasNormalizedPhrase(fullExtractNorm, rawKw)) {
            secondaryScore += 1.5;
            matchedKeywords.push(`extrait: "${rawKw}" (+1.5)`);
          }
        }
        textScore += Math.min(18, secondaryScore);

        // D. Exclusions et Pénalités Anti-Faux-Positifs (excludeKeywords)
        for (const exKw of (theme.excludeKeywords || [])) {
          if (hasNormalizedPhrase(coreIdentityNorm, exKw) || hasNormalizedPhrase(catsJoinedNorm, exKw)) {
            textScore -= 10;
            matchedKeywords.push(`exclusion: "${exKw}" (-10)`);
          }
        }

        // E. Faits Wikidata : métier, nationalité, sport, parti, franchise...
        const wdMatch = wd ? matchWikidataRules(theme, wd) : null;

        if (theme.requireFrenchContext && !wdMatch) {
          // Vérification stricte du contexte français pour éviter de classer une personnalité étrangère dans un thème « français »
          const hasFrenchMarker = FRENCH_CONTEXT_MARKERS.some(m =>
            hasNormalizedPhrase(coreIdentityNorm, m) || hasNormalizedPhrase(catsJoinedNorm, m)
          );
          const hasForeignMarkerInIntro = FOREIGN_POLITICS_MARKERS.some(m =>
            hasNormalizedPhrase(wikiDescNorm, m) || hasNormalizedPhrase(firstSentenceNorm, m)
          );

          if (!hasFrenchMarker) {
            textScore = 0;
            matchedKeywords.push('annulé: aucun contexte français détecté');
          } else if (hasForeignMarkerInIntro && !hasNormalizedPhrase(firstSentenceNorm, 'francais') && !hasNormalizedPhrase(firstSentenceNorm, 'francaise') && !hasNormalizedPhrase(wikiDescNorm, 'francais') && !hasNormalizedPhrase(wikiDescNorm, 'francaise')) {
            textScore -= 12;
            matchedKeywords.push('pénalité: personnalité politique étrangère (-12)');
          }
        }

        // Si le score ne provient que d'un mot secondaire perdu au fond du 3ème paragraphe sans match dans le titre/intro/catégories, on le plafonne sous le seuil
        if (!hasCoreMatch && textScore < 8) {
          textScore = Math.min(textScore, MINIMUM_SCORE_THRESHOLD - 1);
        }

        // Une personne dont Wikidata connaît les métiers, mais aucun qui corresponde au thème :
        // les mots-clés seuls (homonymes, mentions en passant) ne suffisent plus.
        const humanMismatch = !!(wd && wd.isHuman && !wdMatch && (theme.wikidataRules || []).length > 0);
        if (humanMismatch && textScore > 0) {
          textScore *= WD_HUMAN_MISMATCH_FACTOR;
          matchedKeywords.push(`wikidata: aucun métier/sport du thème (×${WD_HUMAN_MISMATCH_FACTOR})`);
        }

        let score = textScore;
        if (wdMatch) {
          const w = theme.wikidataWeight || WD_RULE_WEIGHT;
          score += w;
          hasCoreMatch = true;
          matchedKeywords.unshift(`wikidata: ${wdMatch} (+${w})`);
        }

        // F. Profil appris depuis les cartes déjà étiquetées par l'utilisateur dans sa collection
        const learnedProfile = this.learnedData.tagProfiles?.[theme.name];
        if (learnedProfile && learnedProfile.features) {
          let learnedBoost = 0;
          for (const f of cardFeatures) {
            const w = learnedProfile.features[f];
            if (w) {
              learnedBoost += w;
              matchedKeywords.push(`appris: "${f}" (+${w})`);
            }
          }
          if (learnedBoost > 0) {
            score += Math.min(LEARNED_BOOST_CAP, learnedBoost) * (humanMismatch ? WD_HUMAN_MISMATCH_FACTOR : 1);
          }
        }

        score = Math.max(0, Math.round(score * 10) / 10);
        if (score > 0) {
          scored.push({ theme, score, matches: matchedKeywords, wdMatched: !!wdMatch });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0] && scored[0].score >= MINIMUM_SCORE_THRESHOLD ? scored[0] : null;
      const runnerUp = scored[1] && scored[1].score >= MINIMUM_SCORE_THRESHOLD ? scored[1] : null;

      // Deux thèmes trop proches : on préfère ne rien poser plutôt qu'un mauvais tag,
      // sauf si seul le premier est confirmé par Wikidata.
      let ambiguous = false;
      if (best && runnerUp) {
        const margin = best.score - runnerUp.score;
        const decidedByWikidata = best.wdMatched && !runnerUp.wdMatched;
        if (!decidedByWikidata && margin < Math.max(MIN_MARGIN, best.score * MIN_MARGIN_RATIO)) {
          ambiguous = true;
        }
      }

      const chosen = best && !ambiguous ? best : null;
      const highestScore = chosen ? chosen.score : 0;
      return {
        card,
        theme: chosen ? chosen.theme : null,
        score: highestScore,
        confidence: chosen
          ? (chosen.wdMatched || highestScore >= 12 ? 'high' : 'medium')
          : 'low',
        ambiguous,
        candidates: ambiguous ? [best.theme, runnerUp.theme] : [],
        details: scored,
        wikiCategories,
        wikiDescription: wikiInfo.description || '',
        wikiFirstSentence: wikiInfo.firstSentence || ''
      };
    }
  }

  // Export pour les différents contextes (Extension, Window, Node)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CardClassifier, DEFAULT_THEMES, normalizeText };
  } else {
    window.WMClassifier = { CardClassifier, DEFAULT_THEMES, normalizeText };
  }
})();

// ---- discard.js ----
// discard.js - Plan et exécution de la défausse de cartes (sans DOM, testable sous Node)
(() => {
  const DISCARD_MAX_CONCURRENCY = 4;   // Requêtes de défausse simultanées (réduit à 1 dès qu'un 429 arrive)
  const DISCARD_GAP_MS = 60;           // Pause par worker entre deux défausses
  const DISCARD_RECOVER_AFTER = 25;    // Défausses réussies sans 429 avant de ré-augmenter le parallélisme

  function buildDiscardPlan(collection, options) {
    const {
      rarities = ['C'],
      protectTagged = true,
      protectStarred = true,
      protectShiny = true,
      keepCount = 0,
      excluded = new Set()
    } = options;
    const groups = new Map();
    let totalCopiesInCollection = 0;
    let totalTaggedCopies = 0;
    let totalStarredCopies = 0;
    let totalShinyCopies = 0;

    for (const uc of collection) {
      const cnt = Math.max(1, Number(uc.count) || 1);
      totalCopiesInCollection += cnt;
      if (Array.isArray(uc.user_card_tags) && uc.user_card_tags.length > 0) totalTaggedCopies += cnt;
      if (uc.starred) totalStarredCopies += cnt;
      if (uc.is_shiny) totalShinyCopies += cnt;

      const key = uc.card_id || uc.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(uc);
    }

    const plan = [];
    const perCard = []; // aperçu groupé : { cardId, name, rarity, units, excluded }

    for (const [cardKey, copies] of groups.entries()) {
      const eligibleCopies = [];
      let protectedCount = 0;

      for (const uc of copies) {
        const isShiny = !!uc.is_shiny;
        const isStarred = !!uc.starred;
        const isTagged = Array.isArray(uc.user_card_tags) && uc.user_card_tags.length > 0;
        const rarity = (uc.snapshot_rarity || (uc.card && uc.card.rarity) || 'C').toUpperCase();
        const matchRarity = rarities.includes(rarity);
        const cnt = Math.max(1, Number(uc.count) || 1);

        if ((protectShiny && isShiny) || (protectStarred && isStarred) || (protectTagged && isTagged) || !matchRarity) {
          protectedCount += cnt;
        } else {
          eligibleCopies.push({
            id: uc.id,
            card_id: uc.card_id,
            name: uc.snapshot_title || (uc.card && uc.card.name) || 'Carte',
            rarity,
            count: cnt
          });
        }
      }

      if (eligibleCopies.length === 0) continue;

      // Les exemplaires protégés comptent dans ceux qu'on garde
      let neededToKeep = Math.max(0, keepCount - protectedCount);
      const units = [];
      for (const el of eligibleCopies) {
        let available = el.count;
        const kept = Math.min(available, neededToKeep);
        available -= kept;
        neededToKeep -= kept;
        for (let i = 0; i < available; i++) {
          units.push({ userCardId: el.id, cardId: el.card_id, cardName: el.name, rarity: el.rarity });
        }
      }
      if (units.length === 0) continue;

      const isExcluded = excluded.has(String(cardKey));
      perCard.push({ cardId: String(cardKey), name: units[0].cardName, rarity: units[0].rarity, units: units.length, excluded: isExcluded });
      if (!isExcluded) plan.push(...units);
    }

    perCard.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
    const distinctCards = new Set(plan.map(p => p.cardId)).size;
    return {
      plan,
      perCard,
      distinctCards,
      totalUnits: plan.length,
      stats: {
        totalRows: collection.length,
        totalCopiesInCollection,
        totalTaggedCopies,
        totalStarredCopies,
        totalShinyCopies
      }
    };
  }

  // Exécute le plan avec plusieurs requêtes en parallèle. Les exemplaires d'une même ligne
  // user_cards passent par un seul worker, à la suite : deux défausses simultanées sur la même
  // ligne pourraient se marcher dessus côté serveur (décrément du compteur).
  async function runDiscardPlan(plan, { sendToBridge, shouldStop, onProgress }) {
    const byRow = new Map();
    for (const item of plan) {
      if (!byRow.has(item.userCardId)) byRow.set(item.userCardId, []);
      byRow.get(item.userCardId).push(item);
    }
    const queue = [...byRow.values()];
    const state = {
      done: 0,
      errors: 0,
      rateLimited: 0,
      lastError: null,
      concurrency: DISCARD_MAX_CONCURRENCY,
      okSinceLimit: 0,
      cooldownUntil: 0
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function discardOne(item) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = state.cooldownUntil - Date.now();
        if (wait > 0) await sleep(wait);
        const res = await sendToBridge('DISCARD_USER_CARD', { userCardId: item.userCardId }, 20000);
        if (res && res.success) {
          if (++state.okSinceLimit >= DISCARD_RECOVER_AFTER && state.concurrency < DISCARD_MAX_CONCURRENCY) {
            state.concurrency++;
            state.okSinceLimit = 0;
          }
          return true;
        }
        if (res && res.status === 429) {
          state.rateLimited++;
          state.concurrency = 1;
          state.okSinceLimit = 0;
          state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + 4000 * (attempt + 1));
          continue;
        }
        state.lastError = res ? (res.error || `HTTP ${res.status}`) : 'pas de réponse du site';
        return false;
      }
      state.lastError = 'limite de requêtes du site (429) persistante';
      return false;
    }

    async function worker(index) {
      while (queue.length > 0 && !shouldStop()) {
        if (index >= state.concurrency) {
          await sleep(400);
          continue;
        }
        const rowItems = queue.shift();
        for (const item of rowItems) {
          if (shouldStop()) break;
          const ok = await discardOne(item);
          if (ok) {
            state.done++;
          } else {
            // Inutile d'insister sur les autres exemplaires de cette ligne : même erreur attendue
            state.errors += 1;
            onProgress(state, item);
            break;
          }
          onProgress(state, item);
          await sleep(DISCARD_GAP_MS);
        }
      }
    }

    await Promise.all(Array.from({ length: DISCARD_MAX_CONCURRENCY }, (_, i) => worker(i)));
    return state;
  }


  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildDiscardPlan, runDiscardPlan };
  } else {
    window.WMDiscard = { buildDiscardPlan, runDiscardPlan };
  }
})();

// ---- page-bridge.js ----
// page-bridge.js - Pont d'accès au contexte d'exécution de la page WikiMasters
(() => {
  if (window.__wmBotBridgeInjected) return;
  window.__wmBotBridgeInjected = true;

  console.log('[WikiMasters Bot] Pont injecté avec succès dans la page.');


  const post = (type, payload = {}) => {
    window.postMessage({ source: 'WM_BOT_BRIDGE', type, payload }, '*');
  };

  function headerVal(h, name) {
    if (!h) return '';
    const target = name.toLowerCase();
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(name) || h.get(target) || '';
      if (Array.isArray(h)) {
        const e = h.find(([k]) => String(k).toLowerCase() === target);
        return e ? String(e[1]) : '';
      }
      if (typeof h === 'object') {
        const k = Object.keys(h).find(x => x.toLowerCase() === target);
        return k ? String(h[k]) : '';
      }
    } catch (_) {}
    return '';
  }

  function decodeJwtSub(jwt) {
    if (!jwt || typeof jwt !== 'string') return null;
    try {
      const parts = jwt.replace(/^Bearer\s+/i, '').trim().split('.');
      if (parts.length < 2) return null;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.sub || payload.user_id || null;
    } catch (_) {
      return null;
    }
  }

  function normalizeRarityCode(raw) {
    if (!raw) return 'C';
    const up = String(raw).trim().toUpperCase();
    if (['C', 'PC', 'R', 'SR', 'UR', 'L'].includes(up)) return up;
    if (up.startsWith('COMMUN') || up === 'COMMON') return 'C';
    if (up.startsWith('PEU COMMUN') || up === 'UNCOMMON' || up === 'UC') return 'PC';
    if (up === 'RARE') return 'R';
    if (up.includes('SUPER')) return 'SR';
    if (up.includes('ULTRA')) return 'UR';
    if (up.startsWith('LEGEND') || up.startsWith('LÉGEND')) return 'L';
    return 'C';
  }

  // -------------------------------------------------------------
  // 1. Capture proactive des en-têtes Supabase en temps réel
  // -------------------------------------------------------------
  let sb = null; // { base, apikey, auth, uid }
  let supabaseClient = null;
  let currentUserId = null;

  function rememberSb(input, initHeaders) {
    try {
      const urlStr = typeof input === 'string'
        ? input
        : (input && typeof input.url === 'string' ? input.url : String(input || ''));
      if (!urlStr) return;

      const u = new URL(urlStr, location.href);
      if (!/\.supabase\.co$/i.test(u.hostname)) return;

      const reqHeaders = (input && input.headers) ? input.headers : null;
      const apikey = headerVal(initHeaders, 'apikey') || headerVal(reqHeaders, 'apikey');
      const auth = headerVal(initHeaders, 'authorization') || headerVal(reqHeaders, 'authorization');

      if (apikey && /^Bearer\s+\S+/i.test(auth)) {
        const uid = decodeJwtSub(auth);
        // Ne remplacer sb que si c'est un vrai token utilisateur (avec sub) ou si sb est vide
        if (uid && uid !== 'anon') {
          sb = { base: u.origin, apikey, auth, uid };
          currentUserId = uid;
        } else if (!sb) {
          sb = { base: u.origin, apikey, auth, uid: currentUserId };
        }
      }
    } catch (_) {}
  }

  // -------------------------------------------------------------
  // 2. Interception Fetch (Paquets + Trafic Supabase)
  // -------------------------------------------------------------
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1];
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    const headers = init?.headers || (input && input.headers);

    try { rememberSb(input, headers); } catch (_) {}

    const isPackOpen = /\/api\/packs\/(open|special|pro-daily|grace)/.test(url);
    const res = await originalFetch(...args);

    if (isPackOpen && res.ok) {
      try {
        const clone = res.clone();
        const data = await clone.json();
        post('PACK_OPENED_INTERCEPT', { data, timestamp: Date.now() });
      } catch (e) {
        console.warn('[WikiMasters Bot] Erreur lecture réponse pack:', e);
      }
    }

    return res;
  };

  // -------------------------------------------------------------
  // 3. Détection React Fiber du client Supabase
  // -------------------------------------------------------------
  function fiberOf(el) {
    if (!el) return null;
    const k = Object.keys(el).find(x => x.startsWith('__reactFiber') || x.startsWith('__reactInternalInstance'));
    return k ? el[k] : null;
  }

  function isClient(v) {
    return v && typeof v === 'object' && typeof v.from === 'function' && v.auth;
  }

  function scanFiberForClient(startEl) {
    for (let f = fiberOf(startEl), i = 0; f && i < 65; f = f.return, i++) {
      const mc = f.updateQueue && f.updateQueue.memoCache;
      if (mc && mc.data) {
        for (const arr of mc.data) {
          if (arr) for (const v of arr) if (isClient(v)) return v;
        }
      }
      let h = f.memoizedState, k = 0;
      while (h && typeof h === 'object' && 'next' in h && k++ < 65) {
        if (isClient(h.memoizedState)) return h.memoizedState;
        if (h.memoizedState && typeof h.memoizedState === 'object' && isClient(h.memoizedState.current)) {
          return h.memoizedState.current;
        }
        h = h.next;
      }
    }
    return null;
  }

  function findSupabaseClient() {
    if (supabaseClient) return supabaseClient;

    // 1. Fallback direct sur window.__wmpFindClient si WikiMasters+ est présent
    if (typeof window.__wmpFindClient === 'function') {
      try {
        const c = window.__wmpFindClient();
        if (isClient(c)) return (supabaseClient = c);
      } catch (_) {}
    }

    // 2. Depuis la carte affichée (animation flip)
    const flip = document.querySelector('main [class*="animate-card-flip"]');
    if (flip) {
      const found = scanFiberForClient(flip);
      if (found) return (supabaseClient = found);
    }

    // 3. Depuis les éléments interactifs de la page (main, header, nav, body)
    const targets = document.querySelectorAll('main *, header *, nav *, button, a, div');
    const step = Math.max(1, Math.floor(targets.length / 250));
    for (let n = 0; n < targets.length; n += step) {
      const found = scanFiberForClient(targets[n]);
      if (found) return (supabaseClient = found);
    }

    return null;
  }

  // -------------------------------------------------------------
  // 4. Décodage avancé des Cookies Supabase SSR chunked & LocalStorage
  // -------------------------------------------------------------
  function b64DecodeUnicode(str) {
    try {
      const norm = str.replace(/-/g, '+').replace(/_/g, '/');
      const pad = norm.length % 4 === 0 ? norm : norm + '='.repeat(4 - (norm.length % 4));
      const bin = atob(pad);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (_) {
      try { return atob(str); } catch (__) { return ''; }
    }
  }

  function extractSessionFromParsedObject(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;

    let token = parsed.access_token || parsed.currentSession?.access_token || parsed.session?.access_token || null;
    let user = parsed.user || parsed.currentSession?.user || parsed.session?.user || null;
    let uid = user?.id || parsed.user_id || parsed.sub || null;

    if (Array.isArray(parsed) && parsed.length >= 1 && typeof parsed[0] === 'string') {
      token = parsed[0];
    }

    if (token && !uid) {
      uid = decodeJwtSub(token);
    }

    if (token && uid) {
      let email = user?.email || null;
      let username = user?.user_metadata?.username || user?.user_metadata?.name || user?.user_metadata?.preferred_username || null;
      if (!email || !username) {
        try {
          const payload = JSON.parse(b64DecodeUnicode(token.split('.')[1]));
          if (!email) email = payload.email || null;
          if (!username) username = payload.user_metadata?.username || payload.user_metadata?.name || null;
        } catch (_) {}
      }
      return { accessToken: token, userId: uid, email, username };
    }
    return null;
  }

  function getStoredSession() {
    // 1. Cookies chunked (@supabase/ssr)
    try {
      if (document.cookie) {
        const cookieEntries = document.cookie.split(';').map(c => c.trim());
        const chunkGroups = {};
        for (const entry of cookieEntries) {
          const eqIdx = entry.indexOf('=');
          if (eqIdx === -1) continue;
          const name = entry.substring(0, eqIdx).trim();
          const val = entry.substring(eqIdx + 1).trim();
          if (name.includes('code-verifier') || name.includes('provider-token')) continue;
          const m = name.match(/^(sb-[a-z0-9_-]+-auth-token)(?:\.(\d+))?$/i);
          if (m) {
            const baseName = m[1];
            const index = m[2] !== undefined ? parseInt(m[2], 10) : 0;
            if (!chunkGroups[baseName]) chunkGroups[baseName] = {};
            chunkGroups[baseName][index] = val;
          }
        }

        for (const baseName of Object.keys(chunkGroups)) {
          const chunkMap = chunkGroups[baseName];
          const sortedIndices = Object.keys(chunkMap).map(Number).sort((a, b) => a - b);
          const combined = sortedIndices.map(i => chunkMap[i]).join('');
          let raw = combined;
          try { raw = decodeURIComponent(combined); } catch (_) {}
          if (raw.startsWith('"') && raw.endsWith('"')) {
            raw = raw.slice(1, -1);
          }
          if (raw.startsWith('base64-')) {
            raw = b64DecodeUnicode(raw.substring(7));
          }
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) {}
          const session = extractSessionFromParsedObject(parsed);
          if (session) return session;
        }
      }
    } catch (_) {}

    // 2. localStorage & sessionStorage
    for (const store of [localStorage, sessionStorage]) {
      try {
        if (!store) continue;
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (!k || k.includes('code-verifier')) continue;
          if ((k.startsWith('sb-') || k.toLowerCase().includes('supabase')) && (k.includes('auth') || k.includes('token') || k.includes('session'))) {
            let raw = store.getItem(k);
            if (!raw) continue;
            if (raw.startsWith('base64-')) raw = b64DecodeUnicode(raw.substring(7));
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (_) {}
            const session = extractSessionFromParsedObject(parsed);
            if (session) return session;
          }
        }
      } catch (_) {}
    }

    // 3. Cache uid auxiliaire (WikiMasters+)
    try {
      const wmpUid = localStorage.getItem('wmp_cache_uid');
      if (wmpUid) return { accessToken: null, userId: wmpUid, email: null, username: null };
    } catch (_) {}

    return null;
  }

  // -------------------------------------------------------------
  // 5. Fournisseur de Backend Universel (Client Supabase + REST)
  // -------------------------------------------------------------
  // URL et clé publique du projet Supabase du site, lues à l'exécution (en-têtes de ses propres
  // requêtes ou client supabase-js) plutôt que copiées dans le code.
  function siteSupabaseProject() {
    if (sb && sb.base && sb.apikey) return { base: sb.base, apikey: sb.apikey };
    const client = findSupabaseClient();
    if (client && client.supabaseUrl && client.supabaseKey) {
      return { base: String(client.supabaseUrl).replace(/\/+$/, ''), apikey: client.supabaseKey };
    }
    return null;
  }

  async function getBackend() {
    // A. Vérifier d'abord la session stockée (cookies / localStorage) pour alimenter sb si besoin
    const stored = getStoredSession();
    const project = siteSupabaseProject();
    if (stored && stored.accessToken && stored.userId) {
      if (!currentUserId) currentUserId = stored.userId;
      if ((!sb || !sb.uid) && project) {
        sb = {
          base: project.base,
          apikey: project.apikey,
          auth: 'Bearer ' + stored.accessToken,
          uid: stored.userId
        };
      }
    }

    // B. Client Supabase React
    const client = findSupabaseClient();
    if (client) {
      let uid = currentUserId || (sb && sb.uid) || (stored && stored.userId) || null;
      if (!uid) {
        try {
          const { data } = await client.auth.getSession();
          const sess = data?.session;
          if (sess?.user?.id) {
            uid = sess.user.id;
            if (sess.access_token && (!sb || !sb.uid) && project) {
              sb = {
                base: project.base,
                apikey: project.apikey,
                auth: 'Bearer ' + sess.access_token,
                uid
              };
            }
          }
        } catch (_) {}
      }
      if (!uid) {
        try {
          const { data } = await client.auth.getUser();
          uid = data?.user?.id || null;
        } catch (_) {}
      }
      if (uid) {
        currentUserId = uid;
        return { type: 'client', client, sb, uid };
      }
    }

    // C. En-têtes sb capturés ou construits depuis la session stockée
    if (sb && sb.uid) {
      currentUserId = sb.uid;
      return { type: 'rest', client: client || null, sb, uid: sb.uid };
    }

    // D. Si on a un uid (ex: wmp_cache_uid) ET le client React
    if (client && stored?.userId) {
      currentUserId = stored.userId;
      return { type: 'client', client, sb, uid: stored.userId };
    }

    return null;
  }

  async function getUserId() {
    if (currentUserId) return currentUserId;
    const be = await getBackend();
    if (be?.uid) return be.uid;
    const stored = getStoredSession();
    return stored?.userId || null;
  }

  // -------------------------------------------------------------
  // 6. Opérations Base de Données Universelles (dbGet, dbInsert) avec Retry
  // -------------------------------------------------------------
  async function retryOp(fn, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fn();
        if (res !== null && res !== undefined) return res;
      } catch (e) {
        lastErr = e;
      }
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, 350 * (i + 1)));
      }
    }
    if (lastErr) console.warn('[WikiMasters Bot] Échec après retries:', lastErr);
    return null;
  }

  async function dbGet(table, select, filter = {}, rangeFrom = null, rangeTo = null) {
    const be = await getBackend();
    if (!be) return null;

    // 1. Essai via le client Supabase React
    if (be.client) {
      try {
        let q = be.client.from(table).select(select);
        if (filter.eq) {
          for (const [col, val] of Object.entries(filter.eq)) {
            q = q.eq(col, val);
          }
        }
        if (filter.in) {
          for (const [col, arr] of Object.entries(filter.in)) {
            if (Array.isArray(arr) && arr.length > 0) q = q.in(col, arr);
          }
        }
        if (filter.order) {
          const col = filter.order.col || filter.order;
          q = q.order(col, { ascending: filter.order.asc !== false });
        }
        if (rangeFrom !== null && rangeTo !== null) {
          q = q.range(rangeFrom, rangeTo);
        }
        const { data, error } = await q;
        if (!error && Array.isArray(data)) return data;
      } catch (_) {}
    }

    // 2. Repli automatique sur l'API REST PostgREST directe
    const activeSb = be.sb || sb;
    if (activeSb && activeSb.auth) {
      const cleanSelect = select.replace(/\s+/g, '');
      let q = `select=${cleanSelect}`;
      if (filter.eq) {
        for (const [col, val] of Object.entries(filter.eq)) {
          q += `&${col}=eq.${encodeURIComponent(val)}`;
        }
      }
      if (filter.in) {
        for (const [col, arr] of Object.entries(filter.in)) {
          if (Array.isArray(arr) && arr.length > 0) {
            q += `&${col}=in.(${arr.map(encodeURIComponent).join(',')})`;
          }
        }
      }
      if (filter.order) {
        const col = filter.order.col || filter.order;
        const dir = filter.order.asc === false ? '.desc' : '.asc';
        q += `&order=${col}${dir}`;
      }

      const headers = {
        'apikey': activeSb.apikey,
        'Authorization': activeSb.auth,
        'Accept': 'application/json'
      };
      if (rangeFrom !== null && rangeTo !== null) {
        headers['Range'] = `${rangeFrom}-${rangeTo}`;
        headers['Range-Unit'] = 'items';
      }

      try {
        const res = await originalFetch(`${activeSb.base}/rest/v1/${table}?${q}`, { headers });
        if (res.ok || res.status === 206) return await res.json();
      } catch (_) {}
    }

    return null;
  }

  async function dbInsert(table, row) {
    const be = await getBackend();
    if (!be) return null;

    if (be.client) {
      try {
        if (table === 'tags') {
          const { data, error } = await be.client.from(table).insert(row).select('*').single();
          if (!error && data) return data;
        } else {
          const { error } = await be.client.from(table).insert(row);
          if (!error) return row;
          if (error && error.code === '23505') return row;
        }
      } catch (_) {}
    }

    const activeSb = be.sb || sb;
    if (activeSb && activeSb.auth) {
      try {
        const res = await originalFetch(`${activeSb.base}/rest/v1/${table}`, {
          method: 'POST',
          headers: {
            'apikey': activeSb.apikey,
            'Authorization': activeSb.auth,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(row)
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          return (Array.isArray(data) && data[0]) ? data[0] : (data || row);
        } else if (res.status === 409) {
          return row;
        }
      } catch (_) {}
    }

    return null;
  }

  // -------------------------------------------------------------
  // 7. Gestion des Tags & Association aux Cartes
  // -------------------------------------------------------------
  let tagsCache = null;
  let tagsCacheUid = null;

  async function fetchUserTags(forceRefresh = false) {
    const uid = await getUserId();
    if (!uid) return [];
    if (!forceRefresh && tagsCache && tagsCacheUid === uid) return tagsCache;
    const res = await dbGet('tags', '*', { eq: { user_id: uid } });
    if (Array.isArray(res)) {
      tagsCache = res;
      tagsCacheUid = uid;
    }
    return tagsCache || [];
  }

  async function getOrCreateTag(name, color = '#10b981') {
    if (!name) return null;
    const uid = await getUserId();
    if (!uid) return null;

    const existing = await fetchUserTags(false);
    const found = (existing || []).find(t => String(t.name).trim().toLowerCase() === name.trim().toLowerCase());
    if (found) return found;

    const created = await dbInsert('tags', {
      user_id: uid,
      name: name.trim(),
      color: color || '#10b981'
    });

    if (created && created.id) {
      if (tagsCache) tagsCache.push(created);
      return created;
    } else {
      const refetched = await fetchUserTags(true);
      return (refetched || []).find(t => String(t.name).trim().toLowerCase() === name.trim().toLowerCase()) || null;
    }
  }

  async function assignTagToUserCard(userCardId, tagId) {
    if (!userCardId || !tagId) return false;

    const existing = await dbGet('user_card_tags', 'user_card_id,tag_id', {
      eq: { user_card_id: userCardId, tag_id: tagId }
    });
    if (Array.isArray(existing) && existing.length > 0) return true;

    const inserted = await dbInsert('user_card_tags', {
      user_card_id: userCardId,
      tag_id: tagId
    });

    if (inserted) {
      try {
        window.dispatchEvent(new CustomEvent('wikimasters:tags-updated', { detail: { userCardId, tagId } }));
      } catch (_) {}
      return true;
    }
    return false;
  }

  // Récupération des exemplaires dans le composant de flip actuel (zéro latence)
  function getRevealedCardCopies() {
    const targets = document.querySelectorAll('main [class*="animate-card-flip"], main [class*="perspective"], main [class*="rotate"]');
    for (const el of targets) {
      for (let f = fiberOf(el), i = 0; f && i < 45; f = f.return, i++) {
        const p = f.memoizedProps;
        if (p && Array.isArray(p.cards) && 'ownedCopies' in p && Array.isArray(p.ownedCopies) && p.ownedCopies.length > 0) {
          return p.ownedCopies;
        }
      }
    }
    return null;
  }

  async function waitForRevealedCardCopies(maxWaitMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const copies = getRevealedCardCopies();
      if (copies && copies.length > 0) return copies;
      await new Promise(r => setTimeout(r, 150));
    }
    return null;
  }

  async function getUserCardInstances(cardIds) {
    const uid = await getUserId();
    if (!uid || !cardIds || cardIds.length === 0) return [];

    // 1. Essai depuis le fiber de révélation
    const inFiber = await waitForRevealedCardCopies(1200);
    if (inFiber && inFiber.length > 0) {
      return inFiber.map(c => ({
        id: c.id,
        card_id: c.card_id,
        is_shiny: !!c.is_shiny,
        user_card_tags: c.user_card_tags || []
      }));
    }

    // 2. Requête en base (tri décroissant par id pour prioriser les copies les plus récentes)
    const rows = await dbGet('user_cards', 'id,card_id,is_shiny', {
      eq: { user_id: uid },
      in: { card_id: cardIds },
      order: { col: 'id', asc: false }
    });
    return Array.isArray(rows) ? rows : [];
  }

  // -------------------------------------------------------------
  // 8. Chargement Multi-Stratégie de Toute la Collection & des Tags
  // -------------------------------------------------------------
  async function fetchFullCollection() {
    const uid = await getUserId();
    const userTags = await fetchUserTags(true);
    const tagIdToObj = new Map();
    for (const t of (userTags || [])) {
      if (t && t.id) tagIdToObj.set(String(t.id), t);
    }

    const out = [];
    const CHUNK = 1000;
    let joinSupported = true;

    if (uid) {
      console.log('[WikiMasters Bot] Chargement de toute la collection pour user:', uid);

      for (let from = 0; from < 100000; ) {
        let rows = null;

        if (joinSupported) {
          rows = await retryOp(() => dbGet(
            'user_cards',
            'id,card_id,count,is_shiny,starred,snapshot_title,snapshot_rarity,snapshot_category,user_card_tags(tag_id)',
            { eq: { user_id: uid }, order: { col: 'id', asc: true } },
            from,
            from + CHUNK - 1
          ), 2);
        }

        // Si le join user_card_tags échoue, repli sans join
        if (!Array.isArray(rows)) {
          joinSupported = false;
          rows = await retryOp(() => dbGet(
            'user_cards',
            'id,card_id,count,is_shiny,starred,snapshot_title,snapshot_rarity,snapshot_category',
            { eq: { user_id: uid }, order: { col: 'id', asc: true } },
            from,
            from + CHUNK - 1
          ), 3);
        }

        if (!Array.isArray(rows) || rows.length === 0) break;

        for (const r of rows) {
          const rarity = normalizeRarityCode(r.snapshot_rarity || r.card?.rarity || 'C');
          const rawCardTags = Array.isArray(r.user_card_tags) ? r.user_card_tags : [];
          const enrichedTags = rawCardTags.map(rt => {
            const tid = String(rt.tag_id || rt.id || '');
            const tagObj = tagIdToObj.get(tid);
            return {
              tag_id: rt.tag_id || rt.id,
              name: tagObj?.name || rt.name || null,
              color: tagObj?.color || rt.color || null
            };
          });

          out.push({
            id: r.id,
            card_id: r.card_id,
            count: Math.max(1, Number(r.count) || 1),
            is_shiny: !!r.is_shiny,
            starred: !!r.starred,
            snapshot_title: r.snapshot_title || '',
            snapshot_rarity: rarity,
            snapshot_category: r.snapshot_category || '',
            card: {
              id: r.card_id,
              name: r.snapshot_title || '',
              wikipedia_title: r.snapshot_title || '',
              rarity,
              category: r.snapshot_category || ''
            },
            user_card_tags: enrichedTags
          });
        }

        if (rows.length < CHUNK) break;
        from += rows.length;
      }

      // Si le join n'était pas supporté, charger tous les user_card_tags avec pagination complète
      if (!joinSupported && out.length > 0) {
        const tagMap = new Map();
        for (let tFrom = 0; tFrom < 100000; ) {
          const tagRows = await dbGet('user_card_tags', 'user_card_id,tag_id', {}, tFrom, tFrom + CHUNK - 1);
          if (!Array.isArray(tagRows) || tagRows.length === 0) break;
          for (const tr of tagRows) {
            const ucid = tr.user_card_id;
            if (!tagMap.has(ucid)) tagMap.set(ucid, []);
            const tagObj = tagIdToObj.get(String(tr.tag_id));
            tagMap.get(ucid).push({
              tag_id: tr.tag_id,
              name: tagObj?.name || null,
              color: tagObj?.color || null
            });
          }
          if (tagRows.length < CHUNK) break;
          tFrom += tagRows.length;
        }
        for (const item of out) {
          if (!item.user_card_tags || item.user_card_tags.length === 0) {
            item.user_card_tags = tagMap.get(item.id) || [];
          }
        }
      }
    }

    // Repli Stratégie B : Cache WikiMasters+ (window.__wmpData) si la requête directe a renvoyé 0 carte
    if (out.length === 0 && window.__wmpData && typeof window.__wmpData.list === 'function') {
      try {
        console.log('[WikiMasters Bot] Repli sur le cache __wmpData.list()...');
        const wmpRows = await window.__wmpData.list();
        if (Array.isArray(wmpRows) && wmpRows.length > 0) {
          for (const r of wmpRows) {
            const rarity = normalizeRarityCode(r.snapshot_rarity || r.rarity || 'C');
            out.push({
              id: r.id,
              card_id: r.card_id,
              count: Math.max(1, Number(r.count) || 1),
              is_shiny: !!r.is_shiny,
              starred: !!r.starred,
              snapshot_title: r.snapshot_title || r.title || '',
              snapshot_rarity: rarity,
              snapshot_category: r.snapshot_category || r.category || '',
              card: {
                id: r.card_id,
                name: r.snapshot_title || r.title || '',
                wikipedia_title: r.snapshot_title || r.title || '',
                rarity,
                category: r.snapshot_category || r.category || ''
              },
              user_card_tags: Array.isArray(r.user_card_tags) ? r.user_card_tags : []
            });
          }
        }
      } catch (e) {
        console.warn('[WikiMasters Bot] Échec repli __wmpData:', e);
      }
    }

    console.log(`[WikiMasters Bot] Collection chargée : ${out.length} entrées (${userTags.length} tags).`);
    return { collection: out, tags: userTags };
  }

  // -------------------------------------------------------------
  // 9. Informations du Compte
  // -------------------------------------------------------------
  async function getAccountInfo() {
    const uid = await getUserId();
    let username = null;
    let email = null;

    const stored = getStoredSession();
    if (stored) {
      if (stored.username) username = stored.username;
      if (stored.email) email = stored.email;
    }

    if (uid && !username) {
      const profiles = await dbGet('profiles', '*', { eq: { id: uid } });
      if (Array.isArray(profiles) && profiles.length > 0 && profiles[0]) {
        username = profiles[0].username || profiles[0].pseudo || profiles[0].name || null;
      }
    }

    if (!username) {
      const profileLinks = document.querySelectorAll('a[href*="/profil"], a[href*="/profile"], a[href*="/u/"], a[href*="/user"], header, nav, aside');
      for (const el of profileLinks) {
        const t = (el.innerText || el.textContent || '').trim();
        const m = t.match(/@([a-zA-Z0-9_-]{2,30})/);
        if (m) {
          username = m[1];
          break;
        }
      }
    }

    return { userId: uid, username, email };
  }

  // -------------------------------------------------------------
  // 10. Traitement des Messages venant du Content Script
  // -------------------------------------------------------------
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'WM_BOT_CONTENT') return;

    const { action, payload, reqId } = event.data;

    try {
      switch (action) {
        case 'PING': {
          const account = await getAccountInfo();
          const be = await getBackend();
          post('PONG', { ready: true, hasClient: !!be, account, reqId });
          break;
        }

        case 'GET_ACCOUNT_INFO': {
          const account = await getAccountInfo();
          post('ACCOUNT_INFO_RESULT', { account, reqId });
          break;
        }

        case 'GET_USER_TAGS': {
          const tags = await fetchUserTags(true);
          post('USER_TAGS_RESULT', { tags, reqId });
          break;
        }

        case 'TAG_CARD': {
          const { userCardId, tagName, tagColor } = payload;
          const tag = await getOrCreateTag(tagName, tagColor);
          let success = false;
          if (tag) {
            success = await assignTagToUserCard(userCardId, tag.id);
          }
          post('TAG_CARD_RESULT', { success, userCardId, tag, reqId });
          break;
        }

        case 'RESOLVE_AND_TAG_CARDS': {
          const { cardClassifications } = payload;
          const results = [];

          const ids = cardClassifications.map(c => c.cardId);
          const instances = await getUserCardInstances(ids);
          const usedInstanceIds = new Set();

          for (const item of cardClassifications) {
            const matchingCopies = instances.filter(i => i.card_id === item.cardId && !usedInstanceIds.has(i.id));
            const copy = matchingCopies.find(i => !!i.is_shiny === !!item.isShiny) || matchingCopies[matchingCopies.length - 1] || matchingCopies[0];

            if (copy && item.themeName) {
              usedInstanceIds.add(copy.id);
              const tag = await getOrCreateTag(item.themeName, item.themeColor);
              if (tag) {
                const ok = await assignTagToUserCard(copy.id, tag.id);
                results.push({ cardId: item.cardId, userCardId: copy.id, tagName: item.themeName, success: ok });
              } else {
                results.push({ cardId: item.cardId, userCardId: copy.id, tagName: item.themeName, success: false });
              }
            }
          }

          post('RESOLVE_AND_TAG_RESULTS', { results, reqId });
          break;
        }

        case 'GET_COLLECTION_CARDS': {
          const { collection, tags } = await fetchFullCollection();
          post('COLLECTION_CARDS_RESULT', { collection, tags, reqId });
          break;
        }

        case 'DISCARD_USER_CARD': {
          const { userCardId } = payload;
          try {
            const res = await originalFetch(`/api/user-cards/${encodeURIComponent(userCardId)}/discard`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include'
            });
            const data = await res.json().catch(() => ({}));
            post('DISCARD_USER_CARD_RESULT', {
              success: res.ok,
              status: res.status,
              error: data.error || (res.status === 429 ? 'Rate limit (429)' : null),
              userCardId,
              reqId
            });
          } catch (err) {
            post('DISCARD_USER_CARD_RESULT', { success: false, error: err.message, userCardId, reqId });
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[WikiMasters Bot Bridge] Erreur:', action, err);
      post('ACTION_ERROR', { action, error: err.message, reqId });
    }
  });

  post('BRIDGE_READY');
})();

// ---- content.js ----
// content.js - Interface flottante et moteur d'automatisation pour WikiMasters
(() => {
  if (window.__wmBotInjected) return;
  window.__wmBotInjected = true;

  console.log('[WikiMasters Bot] Content script initialisé.');

  // -------------------------------------------------------------
  // 1. Injection du pont de page (page-bridge.js)
  // -------------------------------------------------------------
  function injectBridge() {
    // Version userscript : le pont est déjà inclus et partage ce contexte
    if (window.__wmBotBridgeInjected) return;
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('page-bridge.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.error('[WikiMasters Bot] Erreur injection pont:', e);
    }
  }
  injectBridge();

  // -------------------------------------------------------------
  // 2. Moteur de thèmes et classifier local
  // -------------------------------------------------------------
  let classifier = null;
  if (window.WMClassifier) {
    classifier = new window.WMClassifier.CardClassifier();
  }

  // -------------------------------------------------------------
  // 3. Configuration et État
  // -------------------------------------------------------------
  const DEFAULT_SETTINGS = {
    botEnabled: false,
    targetAccount: '',                // Compte(s) cible(s) : "pseudo, email" (vide = tous les comptes)
    enforceTargetAccount: true,       // Actif uniquement sur le compte cible
    autoOpenPacks: true,
    stackPacksMode: true,             // Accumulation aléatoire avant ouverture
    minStack: 2,                      // Min paquets à stacker
    maxStack: 10,                     // Max paquets à stacker (jusqu'à 10 !)
    fastSkipReveal: true,
    humanBehavior: true,              // Randomisation et délais naturels
    attentionPauseOnRare: true,       // Pause d'admiration sur carte rare
    autoClassify: true,
    createMissingTags: true,
    soundAlerts: true,
    useWikiApi: true,
    stats: {
      packsOpened: 0,
      cardsSeen: 0,
      cardsTagged: 0,
      rarities: { C: 0, PC: 0, R: 0, SR: 0, UR: 0, L: 0, shiny: 0 }
    }
  };

  let settings = { ...DEFAULT_SETTINGS };
  let customThemes = null;
  let activityLogs = [];
  let isOpening = false;
  let isOpeningSessionActive = false; // VRAI lors de la session de vidage des paquets
  let sessionFloor = 0;               // Seuil d'arrêt (0 pour tout vider, ou 1)
  let packSessionCount = 0;
  let isTakingHumanPause = false;
  let currentDetectedAccount = null;
  let currentDetectedEmail = null;
  let isWrongAccount = false;
  let isVerificationActive = false;
  let verificationAlertInterval = null;
  let currentStackGoal = 4;

  // Charger depuis le stockage local
  chrome.storage.local.get(['settings', 'customThemes'], (res) => {
    if (res.settings) settings = { ...DEFAULT_SETTINGS, ...res.settings };
    if (res.customThemes) customThemes = res.customThemes;
    currentStackGoal = pickNextStackTarget(settings.minStack, settings.maxStack);
    initClassifier();
    renderUI();
  });

  // Bouton ON/OFF de la popup : elle écrit settings.botEnabled dans le stockage
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = area === 'local' && changes.settings && changes.settings.newValue;
    if (!next || typeof next.botEnabled !== 'boolean' || next.botEnabled === settings.botEnabled) return;
    settings.botEnabled = next.botEnabled;
    updateStatusBadge();
    logActivity(settings.botEnabled ? '🚀 Bot démarré depuis la popup.' : '⏸️ Bot mis en pause depuis la popup.', settings.botEnabled ? 'success' : 'warn');
    if (settings.botEnabled) botStep();
  });

  function initClassifier() {
    if (!classifier && window.WMClassifier) {
      classifier = new window.WMClassifier.CardClassifier(customThemes);
    } else if (classifier && customThemes) {
      classifier.setThemes(customThemes);
    }
  }

  function saveSettings() {
    chrome.storage.local.set({ settings, customThemes });
    chrome.runtime.sendMessage({ type: 'STATUS_CHANGED', enabled: settings.botEnabled });
  }

  function rnd(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // Sélection d'un palier d'accumulation naturel, varié et humain (de 2 à 10)
  function pickNextStackTarget(min = 2, max = 10) {
    const minVal = Math.max(2, Math.min(min, max));
    const maxVal = Math.min(10, Math.max(min, max));
    const roll = Math.random();
    let low = minVal, high = maxVal;
    if (roll < 0.25) {
      // 25% : session rapide (2 à 4)
      low = minVal;
      high = Math.min(maxVal, 4);
    } else if (roll < 0.65) {
      // 40% : session moyenne (5 à 7)
      low = Math.max(minVal, 5);
      high = Math.min(maxVal, 7);
    } else {
      // 35% : grosse session (8 à 10)
      low = Math.max(minVal, 8);
      high = maxVal;
    }
    if (low > high) { low = minVal; high = maxVal; }
    return rnd(low, high);
  }

  // Clic avec dispersion aléatoire simulant une souris humaine
  function humanClick(btn) {
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const x = rect.left + rect.width * (0.25 + Math.random() * 0.5);
    const y = rect.top + rect.height * (0.25 + Math.random() * 0.5);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new MouseEvent('mousedown', opts));
    setTimeout(() => {
      btn.dispatchEvent(new PointerEvent('pointerup', opts));
      btn.dispatchEvent(new MouseEvent('mouseup', opts));
      btn.click();
    }, rnd(35, 75));
  }

  // -------------------------------------------------------------
  // 4. Communication avec le pont (page-bridge.js)
  // -------------------------------------------------------------
  let reqCounter = 0;
  const pendingRequests = new Map();

  function sendToBridge(action, payload = {}, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const reqId = ++reqCounter;
      pendingRequests.set(reqId, resolve);
      window.postMessage({ source: 'WM_BOT_CONTENT', action, payload, reqId }, '*');

      setTimeout(() => {
        if (pendingRequests.has(reqId)) {
          pendingRequests.delete(reqId);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  let hasAutoLearnedThisSession = false;

  async function syncCollectionLearning(silent = false) {
    if (!classifier || typeof classifier.learnFromCollection !== 'function') return null;
    const learnBtn = document.getElementById('wm-btn-learn-collection');
    if (learnBtn) {
      learnBtn.disabled = true;
      learnBtn.textContent = '⏳ Apprentissage de vos cartes classées...';
    }
    if (!silent) {
      logActivity('🧠 Analyse de vos cartes déjà classées pour comprendre vos thèmes...', 'info');
    }

    try {
      const res = await sendToBridge('GET_COLLECTION_CARDS', {}, 60000);
      const collection = (res && res.collection) || [];
      const tags = (res && res.tags) || [];

      if (collection.length > 0) {
        const stats = await classifier.learnFromCollection(collection, tags, !silent);
        updateLearnedBadge();
        updateThemesTab();
        if (!silent) {
          logActivity(`🧠 Apprentissage terminé : ${stats.totalTaggedCards} cartes classées mémorisées (${stats.knownTitlesCount} titres uniques) !`, 'success');
        }
        return stats;
      } else if (!silent) {
        logActivity('⚠️ Collection non accessible pour le moment (vérifiez la connexion).', 'warn');
      }
    } catch (e) {
      console.warn('[WikiMasters Bot] Erreur apprentissage:', e);
    } finally {
      if (learnBtn) {
        learnBtn.disabled = false;
        learnBtn.textContent = '🧠 Apprendre de mes cartes déjà classées';
      }
    }
    return null;
  }

  function updateLearnedBadge() {
    if (!classifier || typeof classifier.getLearnedStats !== 'function') return;
    const stats = classifier.getLearnedStats();
    const el = document.getElementById('wm-learned-status');
    if (el) {
      if (stats.totalTaggedCards > 0) {
        const themeSummary = Object.entries(stats.profiles || {})
          .map(([name, p]) => `${name}: ${p.cardCount}`)
          .join(' · ');
        el.innerHTML = `🧠 <b>Mémoire active :</b> ${stats.totalTaggedCards} cartes classées apprises (${stats.knownTitlesCount} titres)<div style="font-size:10px;color:#9ca3af;margin-top:2px;">${themeSummary || ''}</div>`;
      } else {
        el.innerHTML = `🧠 <b>Mémoire :</b> Cliquez sur « Apprendre de mes cartes » ou « Classer » pour analyser vos tags existants.`;
      }
    }
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'WM_BOT_BRIDGE') return;

    const { type, payload } = e.data;

    if (type === 'BRIDGE_READY') {
      logActivity('Pont de session WikiMasters connecté', 'info');
      // Demande des infos de compte
      sendToBridge('PING');
    }

    if (type === 'PONG' || type === 'ACCOUNT_INFO_RESULT') {
      if (payload && payload.account) {
        currentDetectedEmail = payload.account.email || null;
        const u = payload.account.username || null;
        currentDetectedAccount = u || currentDetectedEmail || null;

        checkAccountMatch();
        updateStatusBadge();
        updateLearnedBadge();

        if (!hasAutoLearnedThisSession && !isWrongAccount && payload.account.userId) {
          hasAutoLearnedThisSession = true;
          setTimeout(() => syncCollectionLearning(true), 1500);
        }
      }
    }

    if (type === 'PACK_OPENED_INTERCEPT') {
      onPackOpenedIntercept(payload.data);
    }

    if (payload && payload.reqId && pendingRequests.has(payload.reqId)) {
      const resolver = pendingRequests.get(payload.reqId);
      pendingRequests.delete(payload.reqId);
      resolver(payload);
    }
  });

  // -------------------------------------------------------------
  // 5. Détection Anti-Bot & Sons
  // -------------------------------------------------------------
  let audioCtx = null;

  function playAlertBeep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 820;
      osc.type = 'triangle';
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.4);
    } catch (_) {}
  }

  function playJingle(rarity) {
    if (!settings.soundAlerts) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const freqs = {
        L: [523.25, 659.25, 783.99, 1046.50, 1318.51],
        UR: [440, 554.37, 659.25, 880],
        SR: [392, 493.88, 587.33]
      }[rarity];

      if (!freqs) return;

      freqs.forEach((f, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = f;
        osc.type = rarity === 'L' ? 'triangle' : 'sine';

        const startTime = audioCtx.currentTime + (idx * 0.12);
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.15, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.35);

        osc.connect(gain).connect(audioCtx.destination);
        osc.start(startTime);
        osc.stop(startTime + 0.4);
      });
    } catch (_) {}
  }

  // Détection d'un challenge Cloudflare Turnstile ou pop-up de vérification
  function checkVerificationOrCloudflare() {
    const cfIframe = document.querySelector('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], [id*="turnstile"], .cf-turnstile');
    const bodyText = document.body ? document.body.innerText : '';
    const hasVerificationText = /vérification.*robot|veuillez patienter|êtes-vous un humain|cloudflare challenge|validation de sécurité/i.test(bodyText) && !location.pathname.startsWith('/login');

    const isDetected = !!cfIframe || (hasVerificationText && document.querySelector('[role="dialog"], .fixed, .modal'));

    if (isDetected && !isVerificationActive) {
      isVerificationActive = true;
      logActivity('⚠️ VÉRIFICATION / CLOUDFLARE DÉTECTÉE ! Le bot se met en pause.', 'warn');
      updateStatusBadge();
      playAlertBeep();

      if (!verificationAlertInterval) {
        verificationAlertInterval = setInterval(() => {
          if (isVerificationActive) playAlertBeep();
        }, 12000);
      }
    } else if (!isDetected && isVerificationActive) {
      isVerificationActive = false;
      logActivity('✅ Vérification validée ! Reprise automatique du bot.', 'success');
      if (verificationAlertInterval) {
        clearInterval(verificationAlertInterval);
        verificationAlertInterval = null;
      }
      updateStatusBadge();
      if (settings.botEnabled) {
        setTimeout(botStep, 1500);
      }
    }

    return isVerificationActive;
  }

  // Vérification que nous sommes bien sur le compte cible (pseudo et/ou email, séparés par des virgules)
  function checkAccountMatch() {
    if (!settings.enforceTargetAccount || !settings.targetAccount) {
      isWrongAccount = false;
      return true;
    }

    const targets = getTargetAliases();

    const detected = (currentDetectedAccount || '').trim().toLowerCase().replace(/^@/, '');
    const detectedMail = (currentDetectedEmail || '').trim().toLowerCase();

    // 1. Vérification avec le compte détecté ou email
    if (detected) {
      const match = targets.some(t => detected === t || detected.includes(t) || t.includes(detected));
      if (match) {
        isWrongAccount = false;
        return true;
      }
    }

    if (detectedMail) {
      const matchMail = targets.some(t => detectedMail === t || detectedMail.includes(t) || t.includes(detectedMail));
      if (matchMail) {
        isWrongAccount = false;
        return true;
      }
    }

    // 2. Recherche textuelle dans tout le document HTML (DOM global)
    try {
      const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
      for (const t of targets) {
        if (t && t.length >= 3 && bodyText.includes(t)) {
          isWrongAccount = false;
          return true;
        }
      }
    } catch (_) {}

    // 3. Si un compte différent est formellement identifié et ne correspond à aucune cible
    if (detected && targets.length > 0) {
      isWrongAccount = true;
      return false;
    }

    // En attente ou indéterminé : ne pas bloquer arbitrairement
    isWrongAccount = false;
    return true;
  }

  function getTargetAliases() {
    return (settings.targetAccount || '')
      .toLowerCase()
      .split(/[,;|]+/)
      .map(s => s.trim().replace(/^@/, ''))
      .filter(Boolean);
  }

  function targetLabel() {
    return (settings.targetAccount || '').split(/[,;|]+/)[0].trim().replace(/^@/, '') || 'tous comptes';
  }

  // Détection du nombre de paquets prêts
  function getAvailablePacksCount() {
    const openBtn = [...document.querySelectorAll('main button')].find(
      b => b.textContent.includes('Ouvrir') && !b.disabled
    );
    if (!openBtn) return 0;

    const mainText = document.querySelector('main')?.innerText || '';
    const matchRatio = mainText.match(/(\d+)\s*\/\s*(?:10|\d+)/);
    if (matchRatio) return parseInt(matchRatio[1], 10);

    const matchCount = mainText.match(/(\d+)\s*(?:paquet|pack)/i);
    if (matchCount) return parseInt(matchCount[1], 10);

    return 1;
  }

  // -------------------------------------------------------------
  // 6. Gestion du tirage d'un pack et de sa classification
  // -------------------------------------------------------------
  async function onPackOpenedIntercept(packData) {
    if (!packData) return;
    if (isWrongAccount) return;

    isOpening = true;
    packSessionCount++;
    updateStatusBadge();

    // Le content script est la seule source des stats : elles sont persistées par saveSettings()
    settings.stats.packsOpened++;

    const cards = Array.isArray(packData.cards) ? packData.cards : (Array.isArray(packData) ? packData : []);
    logActivity(`📦 Paquet ouvert ! (${cards.length} cartes)`, 'success');

    let hasSpecialRare = false;

    if (cards.length > 0) {
      settings.stats.cardsSeen += cards.length;
      const classifyJobs = [];

      for (const card of cards) {
        const rarity = (card.rarity || 'C').toUpperCase();
        if (settings.stats.rarities[rarity] !== undefined) {
          settings.stats.rarities[rarity]++;
        }
        if (card.is_shiny) settings.stats.rarities.shiny++;

        if (rarity === 'UR' || rarity === 'L' || rarity === 'SR') {
          hasSpecialRare = true;
          if (rarity === 'UR' || rarity === 'L') playJingle(rarity);
        }

        if (settings.autoClassify && classifier) {
          classifyJobs.push((async () => {
            const res = await classifier.classifyCard(card, settings.useWikiApi);
            if (res && res.theme) {
              return {
                cardId: card.id,
                cardName: card.wikipedia_title || card.name || card.title,
                rarity: card.rarity,
                isShiny: card.is_shiny,
                themeName: res.theme.name,
                themeColor: res.theme.color,
                score: res.score
              };
            }
            return {
              cardId: card.id,
              cardName: card.wikipedia_title || card.name || card.title,
              rarity: card.rarity,
              isShiny: card.is_shiny,
              themeName: null,
              ambiguousBetween: res && res.ambiguous ? res.candidates.map(t => t.name) : null
            };
          })());
        }
      }

      if (classifyJobs.length > 0) {
        const classifiedCards = await Promise.all(classifyJobs);
        const toTag = classifiedCards.filter(c => c.themeName);

        if (toTag.length > 0) {
          logActivity(`🏷️ Attribution de ${toTag.length} thèmes...`, 'info');
          const bridgeRes = await sendToBridge('RESOLVE_AND_TAG_CARDS', {
            cardClassifications: toTag
          });

          if (bridgeRes && bridgeRes.results) {
            const taggedOk = bridgeRes.results.filter(r => r.success).length;
            settings.stats.cardsTagged += taggedOk;
            logActivity(`✅ ${taggedOk} cartes étiquetées dans le compte !`, 'success');
          }
        }

        classifiedCards.forEach(c => {
          const themeBadge = c.themeName
            ? `<span style="background:${c.themeColor};color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;">${escapeHtml(c.themeName)}</span>`
            : c.ambiguousBetween
              ? `<span style="color:#fbbf24;font-size:10px;">(À vérifier : ${escapeHtml(c.ambiguousBetween.join(' ou '))})</span>`
              : `<span style="color:#9ca3af;font-size:10px;">(Sans thème)</span>`;
          const rarityBadge = `<span style="font-weight:bold;color:${getRarityColor(c.rarity)}">[${escapeHtml(c.rarity)}]</span>`;
          logActivity(`${rarityBadge} ${escapeHtml(c.cardName)} ➔ ${themeBadge}`, 'card');
        });
      }

    }

    saveSettings();
    updateStatsTab();
    advanceRevealFlow(hasSpecialRare);
  }

  // Les titres Wikipédia finissent dans du innerHTML (journal, aperçus)
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function getRarityColor(r) {
    const colors = { L: '#ffe144', UR: '#fa9931', SR: '#ed6fa3', R: '#c6a7f2', PC: '#b1cff2', C: '#b8f2d5' };
    return colors[r] || '#fff';
  }

  // Défilement à travers les cartes du booster
  function advanceRevealFlow(hasSpecialRare) {
    let attempts = 0;
    let stepDelay = settings.humanBehavior ? rnd(650, 1350) : 180;

    const stepInterval = setInterval(() => {
      attempts++;
      const flip = document.querySelector('main [class*="animate-card-flip"]');

      if (!flip) {
        clearInterval(stepInterval);
        isOpening = false;
        updateStatusBadge();

        if (settings.botEnabled && !isWrongAccount) {
          let nextWait = settings.humanBehavior ? rnd(2800, 5200) : 1000;

          if (settings.humanBehavior && packSessionCount % rnd(4, 6) === 0) {
            isTakingHumanPause = true;
            const pauseSeconds = rnd(8, 15);
            logActivity(`☕ Pause naturelle (${pauseSeconds}s) simulation humaine...`, 'info');
            updateStatusBadge();
            setTimeout(() => {
              isTakingHumanPause = false;
              updateStatusBadge();
              setTimeout(botStep, 1000);
            }, pauseSeconds * 1000);
            return;
          }

          setTimeout(botStep, nextWait);
        }
        return;
      }

      const col = flip.closest('.flex.flex-col') || flip.parentElement.parentElement;
      const roundBtns = col ? [...col.querySelectorAll('button')].filter(b => /\bw-12\b/.test(b.className)) : [];
      const nextBtn = roundBtns[roundBtns.length - 1];
      const finishBtn = col ? [...col.querySelectorAll('button')].find(b => /\bpx-8\b/.test(b.className) && !b.disabled) : null;

      if (hasSpecialRare && settings.attentionPauseOnRare && attempts === 1) {
        clearInterval(stepInterval);
        const admireTime = rnd(3000, 5500);
        logActivity(`👀 Pause tirage rare (${(admireTime/1000).toFixed(1)}s)...`, 'info');
        setTimeout(() => {
          advanceRevealFlow(false);
        }, admireTime);
        return;
      }

      if (finishBtn) {
        humanClick(finishBtn);
      } else if (nextBtn && !nextBtn.disabled) {
        humanClick(nextBtn);
      }

      if (attempts > 35) {
        clearInterval(stepInterval);
        isOpening = false;
        updateStatusBadge();
      }
    }, stepDelay);
  }

  // -------------------------------------------------------------
  // 7. Boucle d'automatisation (Bot Loop)
  // -------------------------------------------------------------
  function botStep() {
    if (!settings.botEnabled) return;
    if (!location.pathname.startsWith('/pulls')) return;
    if (isOpening || isTakingHumanPause) return;

    // 1. Anti-bot / vérification en cours
    if (checkVerificationOrCloudflare()) return;

    // 2. Vérification que l'onglet correspond au bon compte
    if (!checkAccountMatch()) {
      updateStatusBadge();
      return;
    }

    const availablePacks = getAvailablePacksCount();

    // 3. Gestion du Stacking et des Sessions d'ouverture humaines
    if (settings.stackPacksMode) {
      if (isOpeningSessionActive) {
        // En session active : est-on descendu jusqu'au palier final (0 ou 1) ?
        if (availablePacks <= sessionFloor || availablePacks === 0) {
          isOpeningSessionActive = false;
          currentStackGoal = pickNextStackTarget(settings.minStack, settings.maxStack);
          logActivity(`🎉 Session terminée ! Tous les paquets ont été ouverts (${availablePacks} restant). Prochaine session à ${currentStackGoal} paquets.`, 'success');
          updateStatusBadge();
          detectCountdown(false);
          return;
        }
        // Sinon, la session continue : on ouvre le booster suivant ci-dessous
      } else {
        // En phase d'accumulation :
        // Si le quota cible est atteint ou si on est proche du plafond (>= 9 paquets)
        if (availablePacks >= currentStackGoal || availablePacks >= 9) {
          isOpeningSessionActive = true;
          // 80% du temps on vide complètement jusqu'à 0, 20% on laisse 1 paquet
          sessionFloor = (availablePacks >= 3 && Math.random() < 0.20) ? 1 : 0;
          logActivity(`🔥 Objectif atteint (${availablePacks}/${currentStackGoal} paquets) ! Lancement de la session d'ouverture (descente jusqu'à ${sessionFloor})...`, 'info');
          updateStatusBadge();
        } else {
          // On continue d'accumuler les paquets
          const countdownEl = document.getElementById('wm-bot-timer-display');
          if (countdownEl) {
            countdownEl.textContent = `📦 Stacking : ${availablePacks}/${currentStackGoal} paquets (ouvrira à ${currentStackGoal})`;
            countdownEl.style.color = '#fbbf24';
          }
          detectCountdown(true);
          updateStatusBadge();
          return;
        }
      }
    }

    // 4. Déclenchement de l'ouverture
    const openBtn = [...document.querySelectorAll('main button')].find(
      b => b.textContent.trim() === 'Ouvrir' && !b.disabled
    );

    if (openBtn) {
      const remainingInfo = isOpeningSessionActive ? ` (Session : reste ${availablePacks} ➔ ${sessionFloor})` : '';
      logActivity(`⚡ Ouverture d'un booster...${remainingInfo}`, 'info');
      isOpening = true;
      updateStatusBadge();
      setTimeout(() => {
        humanClick(openBtn);
      }, settings.humanBehavior ? rnd(250, 650) : 50);
      return;
    } else {
      if (isOpeningSessionActive) {
        isOpeningSessionActive = false;
        currentStackGoal = pickNextStackTarget(settings.minStack, settings.maxStack);
        logActivity(`🎉 Fin de session (plus de paquets). Prochain palier : ${currentStackGoal} paquets.`, 'success');
        updateStatusBadge();
      }
    }

    detectCountdown(false);
  }

  function detectCountdown(isStacking = false) {
    const pageText = document.querySelector('main')?.innerText || '';
    const timerMatch = pageText.match(/(\d{1,2})\s*:\s*(\d{2})/);
    const countdownEl = document.getElementById('wm-bot-timer-display');
    if (countdownEl && timerMatch && !isStacking) {
      countdownEl.textContent = `Prochain pack dans ${timerMatch[1]}:${timerMatch[2]}`;
      countdownEl.style.color = '#34d399';
    }
  }

  setInterval(() => {
    if (settings.botEnabled && location.pathname.startsWith('/pulls')) {
      botStep();
    }
  }, 3500);

  // -------------------------------------------------------------
  // 8. "Classer toute ma collection existante" (Avec apprentissage préalable + Batch Wiki)
  // -------------------------------------------------------------
  let isClassifyingCollection = false;
  let stopClassifyRequested = false;

  async function classifyFullCollection() {
    if (!classifier) {
      alert('Le classifieur n\'est pas initialisé.');
      return;
    }

    const btn = document.getElementById('wm-btn-classify-collection');

    if (isClassifyingCollection) {
      stopClassifyRequested = true;
      if (btn) btn.textContent = '⏹️ Arrêt du classement en cours...';
      return;
    }

    isClassifyingCollection = true;
    stopClassifyRequested = false;

    if (btn) {
      btn.textContent = '⏳ Chargement de la collection...';
    }

    logActivity('🔍 Récupération de toute votre collection et de vos tags...', 'info');

    const res = await sendToBridge('GET_COLLECTION_CARDS', {}, 60000);
    const userCards = (res && res.collection) || [];
    const userTags = (res && res.tags) || [];

    if (!userCards || userCards.length === 0) {
      logActivity('⚠️ Aucune carte trouvée ou session non détectée. Essayez de rafraîchir la page.', 'warn');
      isClassifyingCollection = false;
      if (btn) { btn.disabled = false; btn.textContent = '📂 Classer toute ma collection existante'; }
      return;
    }

    // Étape 1 : Apprentissage intelligent sur les cartes déjà étiquetées par l'utilisateur
    if (typeof classifier.learnFromCollection === 'function') {
      if (btn) btn.textContent = '🧠 Apprentissage de vos cartes classées...';
      logActivity('🧠 Analyse de vos cartes déjà classées pour affiner les profils thématiques...', 'info');
      const learnedStats = await classifier.learnFromCollection(userCards, userTags, settings.useWikiApi);
      updateLearnedBadge();
      logActivity(`🧠 Mémoire mise à jour : ${learnedStats.totalTaggedCards} cartes classées analysées.`, 'success');
    }

    const unclassified = userCards.filter(uc => !uc.user_card_tags || uc.user_card_tags.length === 0);
    if (unclassified.length === 0) {
      logActivity(`🎉 Vos ${userCards.length} cartes possèdent déjà toutes une étiquette !`, 'success');
      isClassifyingCollection = false;
      if (btn) { btn.disabled = false; btn.textContent = '📂 Classer toute ma collection existante'; }
      return;
    }

    logActivity(`🎯 ${unclassified.length} cartes sans étiquette à analyser (par lots Wikipédia)...`, 'info');

    let taggedCount = 0;
    const ambiguousCards = [];
    const batchSize = 50; // Wikidata accepte 50 entités par requête

    for (let i = 0; i < unclassified.length; i += batchSize) {
      if (stopClassifyRequested) {
        logActivity(`🛑 Classement interrompu (${taggedCount} cartes étiquetées).`, 'warn');
        break;
      }

      const batch = unclassified.slice(i, i + batchSize);

      if (btn) {
        btn.textContent = `⏹️ Stop (${Math.min(i + batch.length, unclassified.length)}/${unclassified.length} · ${taggedCount} classées)`;
      }

      // Pré-chargement groupé Wikipédia (intro, catégories) + Wikidata (métier, sport, nationalité...)
      if (settings.useWikiApi && typeof classifier.prefetch === 'function') {
        const titles = batch
          .map(uc => uc.snapshot_title || uc.card?.wikipedia_title || uc.card?.name || '')
          .filter(Boolean);
        await classifier.prefetch(titles, 'fr');
      }

      const jobs = batch.map(async (uc) => {
        const cardData = {
          ...(uc.card || {}),
          id: uc.card_id,
          card_id: uc.card_id,
          name: uc.snapshot_title || uc.card?.name,
          wikipedia_title: uc.snapshot_title || uc.card?.wikipedia_title,
          category: uc.snapshot_category || uc.card?.category,
          rarity: uc.snapshot_rarity || uc.card?.rarity
        };
        const classResult = await classifier.classifyCard(cardData, settings.useWikiApi);
        if (classResult && classResult.theme) {
          return {
            userCardId: uc.id,
            cardId: uc.card_id,
            cardName: cardData.name || cardData.wikipedia_title || 'Carte',
            themeName: classResult.theme.name,
            themeColor: classResult.theme.color,
            score: classResult.score
          };
        }
        if (classResult && classResult.ambiguous) {
          ambiguousCards.push(`${cardData.name || cardData.wikipedia_title} (${classResult.candidates.map(t => t.name).join(' ou ')})`);
        }
        return null;
      });

      const batchResults = (await Promise.all(jobs)).filter(Boolean);

      for (const item of batchResults) {
        if (stopClassifyRequested) break;
        const tagRes = await sendToBridge('TAG_CARD', {
          userCardId: item.userCardId,
          tagName: item.themeName,
          tagColor: item.themeColor
        });
        if (tagRes && tagRes.success) {
          taggedCount++;
          logActivity(`🏷️ Classée : "${escapeHtml(item.cardName)}" ➔ [${escapeHtml(item.themeName)}] (score ${item.score})`, 'success');
        }
      }
    }

    logActivity(`✅ Classement terminé ! ${taggedCount} nouvelles cartes étiquetées dans le jeu !`, 'success');
    if (ambiguousCards.length > 0) {
      logActivity(`🤔 ${ambiguousCards.length} carte(s) laissée(s) sans tag car ambiguës, à classer à la main : ${escapeHtml(ambiguousCards.slice(0, 15).join(' · '))}${ambiguousCards.length > 15 ? ' …' : ''}`, 'warn');
    }
    settings.stats.cardsTagged += taggedCount;
    saveSettings();
    updateStatsTab();

    isClassifyingCollection = false;
    stopClassifyRequested = false;

    if (btn) {
      btn.disabled = false;
      btn.textContent = '📂 Classer toute ma collection existante';
    }
  }

  // Export des cartes (titre, catégorie, tags) au format lu par eval/run-eval.js --file
  async function exportCollectionForEval() {
    logActivity('📤 Export de la collection en cours...', 'info');
    const res = await sendToBridge('GET_COLLECTION_CARDS', {}, 60000);
    const collection = (res && res.collection) || [];
    if (collection.length === 0) {
      logActivity('⚠️ Collection introuvable, export annulé.', 'warn');
      return;
    }
    const seen = new Set();
    const cards = [];
    for (const uc of collection) {
      const title = uc.snapshot_title || uc.card?.wikipedia_title || '';
      if (!title || seen.has(title)) continue;
      seen.add(title);
      cards.push({
        title,
        category: uc.snapshot_category || '',
        tags: (uc.user_card_tags || []).map(t => t.name).filter(Boolean)
      });
    }
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), cards }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wikimasters-collection.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    logActivity(`📤 ${cards.length} cartes exportées (dont ${cards.filter(c => c.tags.length).length} étiquetées).`, 'success');
  }

  // -------------------------------------------------------------
  // 8.5. Défausse de Cartes (Sélection personnalisée)
  // -------------------------------------------------------------
  const DISCARD_PREFS_KEY = 'wm_bot_discard_prefs_v1';
  const { buildDiscardPlan, runDiscardPlan } = window.WMDiscard;

  function loadDiscardPrefs() {
    try {
      return JSON.parse(localStorage.getItem(DISCARD_PREFS_KEY) || 'null');
    } catch (e) {
      console.warn('[WikiMasters Bot] Préférences de défausse illisibles:', e);
      return null;
    }
  }

  function saveDiscardPrefs(prefs) {
    try {
      localStorage.setItem(DISCARD_PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      console.warn('[WikiMasters Bot] Préférences de défausse non sauvegardées:', e);
    }
  }

  let discardModalRunning = false;
  let discardModalStop = false;

  async function openDiscardModal() {
    const existing = document.getElementById('wm-discard-modal');
    if (existing) existing.remove();

    const prefs = loadDiscardPrefs() || { rarities: ['C'], protectTagged: true, protectStarred: true, keepCount: 0 };
    const rarityBox = (value, label, color) => `
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" class="wm-disc-rar" value="${value}" ${prefs.rarities.includes(value) ? 'checked' : ''}>
                <span style="color:${color};font-weight:700;">[${value}] ${label}</span>
              </label>`;

    const overlay = document.createElement('div');
    overlay.id = 'wm-discard-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);font-family:system-ui,-apple-system,sans-serif;color:#f3f4f6;user-select:none;';

    overlay.innerHTML = `
      <div style="width:510px;max-width:94vw;max-height:92vh;background:#111413;border:1px solid rgba(255,255,255,0.14);border-radius:18px;padding:20px;box-shadow:0 30px 70px rgba(0,0,0,0.9);display:flex;flex-direction:column;gap:14px;box-sizing:border-box;overflow:hidden;">
        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:22px;">🗑️</span>
            <div>
              <b style="font-size:15px;color:#f87171;letter-spacing:0.3px;">Défausse sélective de cartes</b>
              <div style="font-size:11px;color:#9ca3af;margin-top:2px;">Chaque exemplaire défaussé rapporte <b style="color:#fbbf24;">+1 Wikibidou (🪙 W)</b></div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button id="wm-discard-btn-reload" title="Recharger la collection" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#e5e7eb;font-size:11px;font-weight:600;cursor:pointer;padding:5px 10px;border-radius:6px;">🔄 Recharger</button>
            <button id="wm-discard-btn-close" style="background:none;border:none;color:#9ca3af;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px;">✕</button>
          </div>
        </div>

        <!-- Body Scrollable -->
        <div style="display:flex;flex-direction:column;gap:12px;overflow-y:auto;max-height:62vh;padding-right:4px;">
          <!-- Section Raretés -->
          <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;">
            <div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px;">Raretés à défausser</div>
            <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;font-size:11px;">
              ${rarityBox('C', 'Commune', '#b8f2d5')}
              ${rarityBox('PC', 'Peu Commune', '#b1cff2')}
              ${rarityBox('R', 'Rare', '#c6a7f2')}
              ${rarityBox('SR', 'Super Rare', '#ed6fa3')}
              ${rarityBox('UR', 'Ultra Rare', '#fa9931')}
              ${rarityBox('L', 'Légendaire', '#ffe144')}
            </div>
          </div>

          <!-- Section Protections -->
          <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;font-size:11px;">
            <div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px;">Sécurité & Protections</div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="wm-disc-protect-tags" ${prefs.protectTagged ? 'checked' : ''}>
                <span>🏷️ <b>Ne jamais défausser les cartes étiquetées</b> (Sans étiquette uniquement)</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="wm-disc-protect-fav" ${prefs.protectStarred ? 'checked' : ''}>
                <span>⭐ <b>Ne jamais défausser les cartes favorites</b></span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;opacity:0.9;">
                <input type="checkbox" id="wm-disc-protect-shiny" checked disabled>
                <span>✨ <b>Ne jamais défausser les cartes Shiny</b> (Protection active)</span>
              </label>
            </div>
          </div>

          <!-- Section Conservation -->
          <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;font-size:11px;">
            <div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px;">Mode de conservation</div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              📦 <b>Exemplaires à garder par carte :</b>
              <input type="number" id="wm-disc-keep" min="0" max="99" value="${Number(prefs.keepCount) || 0}" style="width:52px;background:#0a0d0c;border:1px solid rgba(255,255,255,0.15);color:#f3f4f6;border-radius:6px;padding:3px 6px;font-size:12px;">
              <span style="color:#9ca3af;">(0 = tout défausser, 1 = doublons seulement)</span>
            </label>
          </div>

          <!-- Section Résumé en direct -->
          <div id="wm-disc-summary-box" style="background:#0a0d0c;border:1px solid rgba(52,211,153,0.25);border-radius:10px;padding:12px;font-size:12px;">
            <div id="wm-disc-col-stats" style="font-size:10px;color:#9ca3af;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06);">⏳ Connexion à la base de données WikiMasters...</div>
            <div id="wm-disc-summary-text" style="color:#e5e7eb;font-weight:600;">Chargement de votre collection...</div>
            <div id="wm-disc-gain-text" style="color:#fbbf24;font-size:11px;margin-top:2px;font-weight:700;"></div>
            <div id="wm-disc-preview-list" style="margin-top:8px;max-height:160px;overflow-y:auto;font-size:10px;color:#9ca3af;line-height:1.6;"></div>
          </div>

          <!-- Section Progression (pendant défausse) -->
          <div id="wm-disc-prog-box" style="display:none;background:#080a09;border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:12px;">
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:6px;">
              <span id="wm-disc-prog-status" style="color:#f87171;font-weight:600;">Défausse en cours...</span>
              <span id="wm-disc-prog-counter" style="color:#fbbf24;font-weight:700;">0 / 0</span>
            </div>
            <div style="background:rgba(255,255,255,0.08);border-radius:999px;height:8px;overflow:hidden;">
              <div id="wm-disc-prog-bar" style="background:#ef4444;height:100%;width:0%;transition:width 0.2s;"></div>
            </div>
            <div id="wm-disc-prog-detail" style="font-size:10px;color:#9ca3af;margin-top:6px;"></div>
          </div>
        </div>

        <!-- Footer Actions -->
        <div style="display:flex;gap:10px;justify-content:flex-end;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;">
          <button id="wm-disc-btn-cancel" style="padding:9px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#d1d5db;font-weight:600;font-size:12px;cursor:pointer;">
            Annuler
          </button>
          <button id="wm-disc-btn-confirm" disabled style="padding:9px 18px;border-radius:8px;border:none;background:#ef4444;color:#fff;font-weight:700;font-size:12px;cursor:pointer;opacity:0.6;transition:all 0.2s;">
            ⏳ Analyse en cours...
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const closeBtn = document.getElementById('wm-discard-btn-close');
    const reloadBtn = document.getElementById('wm-discard-btn-reload');
    const cancelBtn = document.getElementById('wm-disc-btn-cancel');
    const confirmBtn = document.getElementById('wm-disc-btn-confirm');
    const colStatsEl = document.getElementById('wm-disc-col-stats');
    const summaryText = document.getElementById('wm-disc-summary-text');
    const gainText = document.getElementById('wm-disc-gain-text');
    const previewList = document.getElementById('wm-disc-preview-list');
    const progBox = document.getElementById('wm-disc-prog-box');
    const progStatus = document.getElementById('wm-disc-prog-status');
    const progCounter = document.getElementById('wm-disc-prog-counter');
    const progBar = document.getElementById('wm-disc-prog-bar');
    const progDetail = document.getElementById('wm-disc-prog-detail');

    let collection = [];
    let currentPlan = [];
    const excluded = new Set(); // card_id exclus à la main depuis l'aperçu

    const getOptions = () => {
      const rarities = [...overlay.querySelectorAll('.wm-disc-rar:checked')].map(el => el.value);
      const protectTagged = document.getElementById('wm-disc-protect-tags').checked;
      const protectStarred = document.getElementById('wm-disc-protect-fav').checked;
      const keepCount = Math.max(0, Math.min(99, parseInt(document.getElementById('wm-disc-keep').value, 10) || 0));
      return { rarities, protectTagged, protectStarred, protectShiny: true, keepCount, excluded };
    };

    const updatePreview = () => {
      if (discardModalRunning) return;
      if (!collection || collection.length === 0) {
        colStatsEl.innerHTML = '⚠️ Aucune carte récupérée depuis la session actuelle.';
        summaryText.innerHTML = '⚠️ Collection introuvable. Cliquez sur <b>« 🔄 Recharger »</b> en haut à droite ou vérifiez que vous êtes bien connecté.';
        gainText.textContent = '';
        previewList.textContent = '';
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        confirmBtn.textContent = 'Rien à défausser';
        return;
      }

      const opts = getOptions();
      saveDiscardPrefs({ rarities: opts.rarities, protectTagged: opts.protectTagged, protectStarred: opts.protectStarred, keepCount: opts.keepCount });
      const { plan, perCard, distinctCards, totalUnits, stats } = buildDiscardPlan(collection, opts);
      currentPlan = plan;

      colStatsEl.innerHTML = `📚 Collection chargée : <b style="color:#e5e7eb;">${stats.totalCopiesInCollection} exemplaires</b> (${stats.totalRows} entrées) · 🏷️ ${stats.totalTaggedCopies} étiquetés · ⭐ ${stats.totalStarredCopies} favoris · ✨ ${stats.totalShinyCopies} shiny`;

      if (perCard.length > 0) {
        const excludedCount = perCard.filter(p => p.excluded).length;
        previewList.innerHTML = `<b>Cartes ciblées</b> (cliquez une carte pour l'exclure ou la remettre${excludedCount ? ` · ${excludedCount} exclue${excludedCount > 1 ? 's' : ''}` : ''}) :<br>`
          + perCard.map(p => `<div class="wm-disc-row" data-card-id="${escapeHtml(p.cardId)}" style="cursor:pointer;${p.excluded ? 'text-decoration:line-through;opacity:0.45;' : ''}">• <span style="color:${getRarityColor(p.rarity)}">[${escapeHtml(p.rarity)}]</span> ${escapeHtml(p.name)}${p.units > 1 ? ` <b style="color:#e5e7eb;">×${p.units}</b>` : ''}</div>`).join('');
      } else {
        previewList.textContent = 'Toutes les cartes de ces raretés sont actuellement protégées par vos filtres (étiquette, favori, shiny ou exemplaires gardés).';
      }

      if (totalUnits === 0) {
        summaryText.innerHTML = '<span style="color:#fbbf24;">Aucune carte ne correspond aux critères sélectionnés.</span>';
        gainText.textContent = '';
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        confirmBtn.textContent = 'Rien à défausser';
      } else {
        summaryText.innerHTML = `🎯 <b>${totalUnits} exemplaire${totalUnits > 1 ? 's' : ''}</b> ciblé${totalUnits > 1 ? 's' : ''} sur <b>${distinctCards} carte${distinctCards > 1 ? 's' : ''}</b>`;
        gainText.innerHTML = `🪙 Gain total : <b>+${totalUnits} Wikibidou${totalUnits > 1 ? 's' : ''}</b>`;
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '1';
        confirmBtn.style.background = '#ef4444';
        confirmBtn.textContent = `🔥 Confirmer la défausse de ${totalUnits} exemplaire${totalUnits > 1 ? 's' : ''} (+${totalUnits} W)`;
      }
    };

    previewList.addEventListener('click', (e) => {
      if (discardModalRunning) return;
      const row = e.target.closest('.wm-disc-row');
      if (!row) return;
      const id = row.dataset.cardId;
      if (excluded.has(id)) excluded.delete(id); else excluded.add(id);
      updatePreview();
    });

    const loadCollectionIntoModal = async () => {
      if (discardModalRunning) return;
      reloadBtn.disabled = true;
      reloadBtn.textContent = '⏳...';
      colStatsEl.textContent = '⏳ Chargement complet de votre collection en cours...';
      summaryText.textContent = 'Veuillez patienter quelques secondes...';
      confirmBtn.disabled = true;
      confirmBtn.textContent = '⏳ Analyse en cours...';

      try {
        const res = await sendToBridge('GET_COLLECTION_CARDS', {}, 60000);
        collection = (res && res.collection) || [];
        const tags = (res && res.tags) || [];
        if (collection.length > 0 && classifier && typeof classifier.learnFromCollection === 'function') {
          classifier.learnFromCollection(collection, tags, false)
            .then(() => updateLearnedBadge())
            .catch(err => console.warn('[WikiMasters Bot] Mise à jour de la mémoire échouée:', err));
        }
        updatePreview();
      } catch (e) {
        summaryText.textContent = '❌ Erreur lors du chargement de la collection.';
        console.error(e);
      } finally {
        reloadBtn.disabled = false;
        reloadBtn.textContent = '🔄 Recharger';
      }
    };

    overlay.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', updatePreview);
      if (inp.type === 'number') inp.addEventListener('input', updatePreview);
    });
    reloadBtn.onclick = loadCollectionIntoModal;

    closeBtn.onclick = () => {
      if (discardModalRunning) {
        discardModalStop = true;
        closeBtn.textContent = 'Arrêt...';
        closeBtn.disabled = true;
      } else {
        overlay.remove();
      }
    };

    cancelBtn.onclick = () => {
      if (discardModalRunning) {
        discardModalStop = true;
        cancelBtn.textContent = 'Arrêt...';
        cancelBtn.disabled = true;
      } else {
        overlay.remove();
      }
    };

    await loadCollectionIntoModal();

    confirmBtn.onclick = async () => {
      if (discardModalRunning) {
        discardModalStop = true;
        confirmBtn.textContent = 'Arrêt en cours...';
        confirmBtn.disabled = true;
        return;
      }

      if (!currentPlan || currentPlan.length === 0) return;

      const total = currentPlan.length;
      discardModalRunning = true;
      discardModalStop = false;

      overlay.querySelectorAll('input').forEach(inp => inp.disabled = true);
      reloadBtn.disabled = true;
      confirmBtn.style.background = '#d97706';
      confirmBtn.textContent = '⏹️ Arrêter la défausse';
      progBox.style.display = 'block';

      logActivity(`🗑️ Début de la défausse sélective de ${total} exemplaire(s)...`, 'info');

      const startedAt = Date.now();
      const state = await runDiscardPlan(currentPlan, {
        sendToBridge,
        shouldStop: () => discardModalStop,
        onProgress: (st, item) => {
          const processed = st.done + st.errors;
          const pct = Math.round((processed / total) * 100);
          progBar.style.width = `${pct}%`;
          progCounter.textContent = `${st.done} / ${total}`;
          const elapsedSec = (Date.now() - startedAt) / 1000;
          const rate = processed / Math.max(1, elapsedSec);
          const etaSec = rate > 0 ? Math.round((total - processed) / rate) : 0;
          progStatus.textContent = `Défausse · "${item.cardName}"`;
          progDetail.textContent = `${rate.toFixed(1)} cartes/s · ${st.concurrency} en parallèle · reste ~${etaSec >= 60 ? Math.floor(etaSec / 60) + ' min ' : ''}${etaSec % 60}s`
            + (st.rateLimited ? ` · ${st.rateLimited} ralentissement(s) (429)` : '')
            + (st.errors ? ` · ${st.errors} échec(s) : ${st.lastError}` : '');
        }
      });

      discardModalRunning = false;
      const done = state.done;
      progBar.style.width = `${Math.round((done / total) * 100)}%`;
      progCounter.textContent = `${done} / ${total}`;
      const errorSuffix = state.errors ? ` · ${state.errors} échec(s), dernier : ${state.lastError}` : '';

      if (discardModalStop) {
        progStatus.textContent = `Arrêté après ${done} défausse(s) (+${done} W).`;
        logActivity(`🛑 Défausse arrêtée par l'utilisateur : ${done} exemplaire(s) défaussé(s) (+${done} W).${escapeHtml(errorSuffix)}`, 'warn');
      } else {
        progStatus.textContent = `Terminé : ${done} exemplaire(s) défaussé(s) (+${done} W).`;
        logActivity(`✅ Défausse sélective terminée : ${done} exemplaire(s) (+${done} Wikibidous) en ${Math.round((Date.now() - startedAt) / 1000)}s.${escapeHtml(errorSuffix)}`, state.errors ? 'warn' : 'success');
      }

      try {
        window.dispatchEvent(new CustomEvent('wikimasters:balance-updated'));
        window.dispatchEvent(new CustomEvent('wikimasters:collection-updated'));
      } catch (e) {
        console.warn('[WikiMasters Bot] Rafraîchissement du site non déclenché:', e);
      }

      confirmBtn.remove();
      cancelBtn.textContent = 'Fermer';
      cancelBtn.style.background = '#10b981';
      cancelBtn.style.color = '#062b1e';
      cancelBtn.onclick = () => overlay.remove();
      closeBtn.disabled = false;
      closeBtn.onclick = () => overlay.remove();
    };
  }
  // -------------------------------------------------------------
  // 9. Logs d'activité
  // -------------------------------------------------------------
  function logActivity(text, type = 'info') {
    const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    activityLogs.unshift({ time, text, type });
    if (activityLogs.length > 80) activityLogs.pop();
    updateLogsView();
  }

  function updateLogsView() {
    const container = document.getElementById('wm-bot-logs-list');
    if (!container) return;

    container.innerHTML = activityLogs.map(log => {
      let color = '#9ca3af';
      if (log.type === 'success') color = '#34d399';
      if (log.type === 'warn') color = '#fbbf24';
      if (log.type === 'card') color = '#e5e7eb';
      return `<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);color:${color};font-size:11px;">
        <span style="color:#6b7280;margin-right:6px;">[${log.time}]</span>${log.text}
      </div>`;
    }).join('');
  }

  // -------------------------------------------------------------
  // 10. Interface Flottante (UI Dashboard)
  // -------------------------------------------------------------
  function renderUI() {
    if (document.getElementById('wm-bot-root')) return;

    const host = document.createElement('div');
    host.id = 'wm-bot-root';
    host.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:2147483640;font-family:system-ui,-apple-system,sans-serif;';

    host.innerHTML = `
      <style>
        #wm-bot-pill {
          background: #111413;
          border: 1px solid rgba(52, 211, 153, 0.4);
          color: #f3f4f6;
          border-radius: 999px;
          padding: 8px 16px;
          display: flex;
          align-items: center;
          gap: 10px;
          cursor: pointer;
          box-shadow: 0 10px 25px rgba(0,0,0,0.6);
          transition: all 0.2s;
          user-select: none;
        }
        #wm-bot-pill:hover {
          border-color: #34d399;
          transform: translateY(-2px);
          box-shadow: 0 12px 30px rgba(52, 211, 153, 0.25);
        }
        #wm-bot-panel {
          display: none;
          position: absolute;
          bottom: 50px;
          left: 0;
          width: 390px;
          max-height: 590px;
          background: #0f1211;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 16px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.85);
          backdrop-filter: blur(12px);
          flex-direction: column;
          overflow: hidden;
          color: #e5e7eb;
        }
        #wm-bot-panel.open { display: flex; }
        .wm-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: #161a18;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .wm-title { font-weight: 800; font-size: 14px; display: flex; align-items: center; gap: 8px; }
        .wm-title span { color: #34d399; }
        .wm-account-tag {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 6px;
          background: rgba(255,255,255,0.06);
          color: #34d399;
          font-weight: 700;
        }
        .wm-tabs {
          display: flex;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: #121514;
        }
        .wm-tab-btn {
          flex: 1;
          padding: 9px;
          font-size: 12px;
          font-weight: 600;
          text-align: center;
          cursor: pointer;
          background: transparent;
          border: none;
          color: #9ca3af;
          transition: all 0.15s;
        }
        .wm-tab-btn.active {
          color: #34d399;
          border-bottom: 2px solid #34d399;
          background: rgba(52, 211, 153, 0.05);
        }
        .wm-body { padding: 14px; overflow-y: auto; flex: 1; }
        .wm-btn-main {
          width: 100%;
          padding: 10px;
          border-radius: 10px;
          font-weight: 700;
          font-size: 13px;
          border: none;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .wm-btn-start { background: #10b981; color: #062b1e; }
        .wm-btn-start:hover { background: #34d399; }
        .wm-btn-stop { background: #ef4444; color: #fff; }
        .wm-btn-action {
          width: 100%;
          padding: 8px;
          border-radius: 8px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          color: #e5e7eb;
          font-weight: 600;
          font-size: 12px;
          cursor: pointer;
          margin-top: 8px;
          transition: background 0.15s;
        }
        .wm-btn-action:hover { background: rgba(255,255,255,0.12); }
        .wm-checkbox-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 5px 0;
          font-size: 12px;
          cursor: pointer;
        }
        .wm-checkbox-row input { cursor: pointer; accent-color: #10b981; }
        .wm-stat-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
          margin-bottom: 12px;
        }
        .wm-stat-box {
          background: rgba(255,255,255,0.04);
          border-radius: 8px;
          padding: 8px 10px;
          border: 1px solid rgba(255,255,255,0.06);
        }
        .wm-stat-label { font-size: 10px; color: #9ca3af; text-transform: uppercase; font-weight: 600; }
        .wm-stat-val { font-size: 16px; font-weight: 800; color: #fff; margin-top: 2px; }
      </style>

      <div id="wm-bot-pill">
        <span style="font-size:16px;">🤖</span>
        <span style="font-weight:700;font-size:12px;">WikiMasters Bot</span>
        <span id="wm-pill-status" style="font-size:10px;padding:2px 8px;border-radius:99px;background:#374151;color:#d1d5db;font-weight:700;">OFF</span>
      </div>

      <div id="wm-bot-panel">
        <div class="wm-header">
          <div class="wm-title">
            <span>WikiMasters</span> AutoBot
            <span id="wm-account-badge" class="wm-account-tag">@${escapeHtml(targetLabel())}</span>
          </div>
          <button id="wm-btn-close" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;">✕</button>
        </div>

        <div class="wm-tabs">
          <button class="wm-tab-btn active" data-tab="control">🎮 Contrôle</button>
          <button class="wm-tab-btn" data-tab="themes">🏷️ Mes Thèmes</button>
          <button class="wm-tab-btn" data-tab="stats">📊 Historique</button>
        </div>

        <div class="wm-body">
          <!-- ONGLET CONTRÔLE -->
          <div id="wm-tab-control">
            <button id="wm-btn-toggle" class="wm-btn-main wm-btn-start">
              ▶️ Démarrer le Bot (Auto-Pulls)
            </button>

            <div id="wm-bot-timer-display" style="text-align:center;font-size:11px;color:#34d399;margin-top:8px;font-weight:600;">
              En attente d'activation...
            </div>

            <button id="wm-btn-open-one" class="wm-btn-action">
              ⚡ Ouvrir 1 paquet maintenant
            </button>

            <button id="wm-btn-drain-all" class="wm-btn-action" style="border-color:rgba(245,158,11,0.5);color:#fbbf24;">
              🔥 Vider tous les paquets maintenant (Lancer session ➔ 0)
            </button>

            <button id="wm-btn-classify-collection" class="wm-btn-action" style="border-color:rgba(52,211,153,0.4);color:#34d399;">
              📂 Classer toute ma collection existante
            </button>

            <button id="wm-btn-learn-collection" class="wm-btn-action" style="border-color:rgba(167,139,250,0.5);color:#c4b5fd;">
              🧠 Apprendre de mes cartes déjà classées
            </button>

            <button id="wm-btn-discard-collection" class="wm-btn-action" style="border-color:rgba(248,113,113,0.5);color:#f87171;">
              🗑️ Défausser des cartes (Sélection)...
            </button>

            <button id="wm-btn-export-collection" class="wm-btn-action" style="border-color:rgba(148,163,184,0.4);color:#cbd5e1;" title="Titres + tags uniquement, pour mesurer la précision avec eval/run-eval.js --file">
              📤 Exporter mes cartes classées (test de précision)
            </button>

            <div id="wm-learned-status" style="margin-top:8px;padding:7px 10px;border-radius:8px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.25);font-size:11px;color:#ddd6fe;">
              🧠 <b>Mémoire :</b> Synchronisation automatique avec votre collection...
            </div>

            <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:10px;">
              <div style="font-size:11px;color:#9ca3af;font-weight:700;margin-bottom:6px;text-transform:uppercase;">Options d'automatisation & Sécurité</div>

              <label class="wm-checkbox-row">
                <input type="checkbox" id="wm-opt-human" ${settings.humanBehavior ? 'checked' : ''}>
                <span>👤 Comportement humain (délais & clics randomisés)</span>
              </label>

              <label class="wm-checkbox-row">
                <input type="checkbox" id="wm-opt-stack" ${settings.stackPacksMode ? 'checked' : ''}>
                <span>📦 Accumuler avant d'ouvrir (Session humaine)</span>
              </label>

              <div style="margin: 2px 0 8px 24px; padding: 6px 10px; background: rgba(255,255,255,0.03); border-radius: 8px; font-size: 11px; border: 1px solid rgba(255,255,255,0.06);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
                  <span style="color:#9ca3af;">Plage aléatoire :</span>
                  <span style="color:#e5e7eb; font-weight:600;">2 à 10 paquets</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span style="color:#9ca3af;">Prochain palier :</span>
                  <span id="wm-stack-goal-badge" style="color:#fbbf24; font-weight:700;">${currentStackGoal} paquets</span>
                  <button id="wm-btn-reroll-stack" type="button" style="padding:2px 8px; font-size:10px; font-weight:600; border-radius:4px; border:none; background:rgba(255,255,255,0.1); color:#fff; cursor:pointer;">🎲 Relancer</button>
                </div>
              </div>

              <label class="wm-checkbox-row">
                <input type="checkbox" id="wm-opt-account" ${settings.enforceTargetAccount ? 'checked' : ''}>
                <span>🔒 Actif UNIQUEMENT sur le compte cible</span>
              </label>

              <div style="display:flex;align-items:center;gap:6px;margin:4px 0 6px 24px;">
                <span style="font-size:11px;color:#9ca3af;">Compte cible :</span>
                <input type="text" id="wm-input-target-account" value="${escapeHtml(settings.targetAccount)}" placeholder="pseudo, email..." style="background:#1a201d;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:3px 8px;font-size:11px;color:#34d399;font-weight:700;flex:1;">
              </div>

              <div style="margin: 4px 0 10px 24px; padding: 8px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                  <span style="font-size:10px; color:#9ca3af;">Compte détecté :</span>
                  <span id="wm-detected-account-text" style="font-size:11px; font-weight:700; color:#34d399;">@${escapeHtml(currentDetectedAccount || targetLabel())}</span>
                </div>
                <div style="display:flex; gap:6px;">
                  <button id="wm-btn-force-account" type="button" style="flex:1; padding:5px 8px; font-size:10px; font-weight:700; background:#059669; color:#fff; border:none; border-radius:6px; cursor:pointer;">
                    🎯 Valider cette fenêtre (${escapeHtml(targetLabel())})
                  </button>
                  <button id="wm-btn-rescan-account" type="button" style="padding:5px 8px; font-size:10px; font-weight:600; background:rgba(255,255,255,0.1); color:#e5e7eb; border:none; border-radius:6px; cursor:pointer;">
                    🔄 Re-scanner
                  </button>
                </div>
              </div>

              <label class="wm-checkbox-row">
                <input type="checkbox" id="wm-opt-admire" ${settings.attentionPauseOnRare ? 'checked' : ''}>
                <span>👀 Pause d'attention sur carte rare (UR / Légendaire)</span>
              </label>

              <label class="wm-checkbox-row">
                <input type="checkbox" id="wm-opt-auto-classify" ${settings.autoClassify ? 'checked' : ''}>
                <span>🏷️ Classer automatiquement selon mes thèmes</span>
              </label>

              <label class="wm-checkbox-row">
                <input type="checkbox" id="wm-opt-wiki-api" ${settings.useWikiApi ? 'checked' : ''}>
                <span>🌐 Précision maximale via l'API Wikipédia</span>
              </label>

              <label class="wm-checkbox-row">
                <input type="checkbox" id="wm-opt-sound" ${settings.soundAlerts ? 'checked' : ''}>
                <span>🔔 Jingle sonore sur carte rare / vérification</span>
              </label>
            </div>
          </div>

          <!-- ONGLET THÈMES -->
          <div id="wm-tab-themes" style="display:none;">
            <div style="font-size:11px;color:#9ca3af;margin-bottom:10px;">
              Vos 8 thèmes configurés correspondent exactement à vos tags en jeu.
            </div>

            <div id="wm-themes-list" style="display:flex;flex-direction:column;gap:6px;max-height:240px;overflow-y:auto;padding-right:4px;"></div>

            <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,0.08);padding-top:10px;">
              <div style="font-size:11px;font-weight:700;margin-bottom:6px;color:#e5e7eb;">Tester la détection d'une carte :</div>
              <div style="display:flex;gap:6px;">
                <input id="wm-test-input" type="text" placeholder="Ex: Tadej Pogačar, Martin Fourcade..." style="flex:1;background:#1e2421;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:6px 8px;font-size:12px;color:#fff;">
                <button id="wm-btn-test-theme" class="wm-btn-action" style="margin-top:0;width:auto;padding:6px 12px;">Tester</button>
              </div>
              <div id="wm-test-result" style="font-size:11px;margin-top:6px;color:#34d399;font-weight:600;"></div>
            </div>
          </div>

          <!-- ONGLET STATS -->
          <div id="wm-tab-stats" style="display:none;">
            <div class="wm-stat-grid">
              <div class="wm-stat-box">
                <div class="wm-stat-label">Packs ouverts</div>
                <div id="wm-stat-packs" class="wm-stat-val">${settings.stats.packsOpened}</div>
              </div>
              <div class="wm-stat-box">
                <div class="wm-stat-label">Cartes classées</div>
                <div id="wm-stat-tagged" class="wm-stat-val" style="color:#34d399;">${settings.stats.cardsTagged}</div>
              </div>
              <div class="wm-stat-box">
                <div class="wm-stat-label">Total Cartes</div>
                <div id="wm-stat-cards" class="wm-stat-val">${settings.stats.cardsSeen}</div>
              </div>
              <div class="wm-stat-box">
                <div class="wm-stat-label">Légendaires (L)</div>
                <div id="wm-stat-legendary" class="wm-stat-val" style="color:#ffe144;">${settings.stats.rarities.L}</div>
              </div>
            </div>

            <div style="font-size:11px;color:#9ca3af;font-weight:700;margin:10px 0 6px;text-transform:uppercase;">Derniers tirages & classements</div>
            <div id="wm-bot-logs-list" style="background:#090b0a;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:8px;max-height:160px;overflow-y:auto;font-family:monospace;"></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(host);

    const pill = document.getElementById('wm-bot-pill');
    const panel = document.getElementById('wm-bot-panel');
    const btnClose = document.getElementById('wm-btn-close');
    const btnToggle = document.getElementById('wm-btn-toggle');
    const btnOpenOne = document.getElementById('wm-btn-open-one');
    const btnClassifyCol = document.getElementById('wm-btn-classify-collection');
    const btnDiscardCol = document.getElementById('wm-btn-discard-collection');
    const inputTarget = document.getElementById('wm-input-target-account');

    pill.onclick = () => panel.classList.toggle('open');
    btnClose.onclick = () => panel.classList.remove('open');

    if (inputTarget) {
      inputTarget.onchange = () => {
        settings.targetAccount = inputTarget.value.trim();
        saveSettings();
        checkAccountMatch();
        updateStatusBadge();
      };
    }

    const btnForceAcc = document.getElementById('wm-btn-force-account');
    const btnRescanAcc = document.getElementById('wm-btn-rescan-account');

    if (btnForceAcc) {
      btnForceAcc.onclick = () => {
        currentDetectedAccount = targetLabel();
        isWrongAccount = false;
        checkAccountMatch();
        updateStatusBadge();
        logActivity(`🎯 Fenêtre validée comme ${escapeHtml(targetLabel())} ! Le bot est débloqué.`, 'success');
      };
    }

    if (btnRescanAcc) {
      btnRescanAcc.onclick = () => {
        sendToBridge('PING');
        checkAccountMatch();
        updateStatusBadge();
        logActivity(`🔍 Re-scan compte : ${currentDetectedAccount || 'En cours...'}`, 'info');
      };
    }

    document.querySelectorAll('.wm-tab-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.wm-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.getElementById('wm-tab-control').style.display = tab === 'control' ? 'block' : 'none';
        document.getElementById('wm-tab-themes').style.display = tab === 'themes' ? 'block' : 'none';
        document.getElementById('wm-tab-stats').style.display = tab === 'stats' ? 'block' : 'none';
        if (tab === 'themes') updateThemesTab();
        if (tab === 'stats') updateStatsTab();
      };
    });

    btnToggle.onclick = () => {
      settings.botEnabled = !settings.botEnabled;
      saveSettings();
      updateStatusBadge();
      if (settings.botEnabled) {
        logActivity('🚀 Bot démarré avec simulation humaine !', 'success');
        botStep();
      } else {
        logActivity('⏸️ Bot mis en pause.', 'warn');
      }
    };

    btnOpenOne.onclick = () => {
      const openBtn = [...document.querySelectorAll('main button')].find(
        b => b.textContent.trim() === 'Ouvrir' && !b.disabled
      );
      if (openBtn) {
        humanClick(openBtn);
      } else {
        logActivity('⚠️ Aucun pack disponible à ouvrir.', 'warn');
      }
    };

    btnClassifyCol.onclick = classifyFullCollection;
    const btnLearnCol = document.getElementById('wm-btn-learn-collection');
    if (btnLearnCol) btnLearnCol.onclick = () => syncCollectionLearning(false);
    if (btnDiscardCol) btnDiscardCol.onclick = openDiscardModal;
    const btnExportCol = document.getElementById('wm-btn-export-collection');
    if (btnExportCol) btnExportCol.onclick = exportCollectionForEval;

    const btnDrainAll = document.getElementById('wm-btn-drain-all');
    if (btnDrainAll) {
      btnDrainAll.onclick = () => {
        const count = getAvailablePacksCount();
        if (count === 0) {
          logActivity('⚠️ Aucun paquet disponible à vider.', 'warn');
          return;
        }
        isOpeningSessionActive = true;
        sessionFloor = 0;
        settings.botEnabled = true;
        saveSettings();
        logActivity(`🔥 Session forcée : vidage de tous les paquets (${count} restants jusqu'à 0)...`, 'info');
        updateStatusBadge();
        botStep();
      };
    }

    const btnRerollStack = document.getElementById('wm-btn-reroll-stack');
    if (btnRerollStack) {
      btnRerollStack.onclick = () => {
        currentStackGoal = pickNextStackTarget(settings.minStack, settings.maxStack);
        const goalBadge = document.getElementById('wm-stack-goal-badge');
        if (goalBadge) goalBadge.textContent = `${currentStackGoal} paquets`;
        logActivity(`🎲 Nouveau palier aléatoire choisi : ${currentStackGoal} paquets.`, 'info');
        updateStatusBadge();
      };
    }

    const bindCheck = (id, prop) => {
      const el = document.getElementById(id);
      if (el) el.onchange = (e) => {
        settings[prop] = e.target.checked;
        saveSettings();
        if (prop === 'enforceTargetAccount') {
          checkAccountMatch();
          updateStatusBadge();
        }
      };
    };
    bindCheck('wm-opt-human', 'humanBehavior');
    bindCheck('wm-opt-stack', 'stackPacksMode');
    bindCheck('wm-opt-account', 'enforceTargetAccount');
    bindCheck('wm-opt-admire', 'attentionPauseOnRare');
    bindCheck('wm-opt-auto-classify', 'autoClassify');
    bindCheck('wm-opt-wiki-api', 'useWikiApi');
    bindCheck('wm-opt-sound', 'soundAlerts');

    const testInput = document.getElementById('wm-test-input');
    const testBtn = document.getElementById('wm-btn-test-theme');
    const testResult = document.getElementById('wm-test-result');
    if (testBtn) {
      testBtn.onclick = async () => {
        const val = testInput.value.trim();
        if (!val || !classifier) return;
        testResult.textContent = '⏳ Analyse approfondie Wikipédia + Mémoire en cours...';
        const res = await classifier.classifyCard({ wikipedia_title: val, title: val, description: '' }, true);
        if (res && res.theme) {
          const topMatches = (res.details && res.details[0]?.matches || []).slice(0, 4).join(', ');
          testResult.innerHTML = `Résultat : <span style="background:${res.theme.color};color:#fff;padding:2px 6px;border-radius:4px;">${res.theme.name}</span> (Score: ${res.score})<div style="font-size:10px;color:#9ca3af;margin-top:3px;font-weight:400;">Indices : ${topMatches || 'correspondance sémantique'}</div>`;
        } else if (res && res.ambiguous) {
          const [a, b] = res.candidates;
          testResult.innerHTML = `<span style="color:#fbbf24;">Ambigu entre <b>${escapeHtml(a.name)}</b> et <b>${escapeHtml(b.name)}</b> : aucun tag ne serait posé.</span>`;
        } else {
          testResult.innerHTML = `<span style="color:#ef4444;">Aucun thème correspondant trouvé (Score sous le seuil de confiance).</span>`;
        }
      };
    }

    updateStatusBadge();
    updateLearnedBadge();
    updateLogsView();
  }

  function updateStatusBadge() {
    const pillStatus = document.getElementById('wm-pill-status');
    const btnToggle = document.getElementById('wm-btn-toggle');
    const accDisplay = document.getElementById('wm-account-badge');
    const detDisplay = document.getElementById('wm-detected-account-text');

    if (accDisplay) {
      if (isWrongAccount && settings.enforceTargetAccount) {
        accDisplay.textContent = currentDetectedAccount ? `@${currentDetectedAccount}` : `Pas ${targetLabel()}`;
        accDisplay.style.color = '#ef4444';
        accDisplay.style.background = 'rgba(239, 68, 68, 0.15)';
      } else {
        accDisplay.textContent = currentDetectedAccount ? `@${currentDetectedAccount}` : `@${targetLabel()}`;
        accDisplay.style.color = '#34d399';
        accDisplay.style.background = 'rgba(52, 211, 153, 0.15)';
      }
    }

    if (detDisplay) {
      detDisplay.textContent = currentDetectedAccount ? `@${currentDetectedAccount}` : 'Recherche...';
      detDisplay.style.color = (isWrongAccount && settings.enforceTargetAccount) ? '#ef4444' : '#34d399';
    }

    if (!pillStatus || !btnToggle) return;

    if (isWrongAccount && settings.enforceTargetAccount) {
      pillStatus.textContent = 'DORMANTE 😴';
      pillStatus.style.background = '#4b5563';
      pillStatus.style.color = '#9ca3af';
      btnToggle.textContent = `🛑 Dormant (Pas ${targetLabel()})`;
      btnToggle.className = 'wm-btn-main wm-btn-stop';
      return;
    }

    if (isVerificationActive) {
      pillStatus.textContent = 'VÉRIFICATION ⚠️';
      pillStatus.style.background = '#f59e0b';
      pillStatus.style.color = '#000';
      btnToggle.textContent = '⚠️ Vérification requise';
      btnToggle.className = 'wm-btn-main wm-btn-stop';
      return;
    }

    if (settings.botEnabled) {
      if (isTakingHumanPause) {
        pillStatus.textContent = 'PAUSE ☕';
        pillStatus.style.background = '#8b5cf6';
      } else if (isOpening) {
        pillStatus.textContent = 'OUVERTURE ⚡';
        pillStatus.style.background = '#3b82f6';
      } else if (settings.stackPacksMode) {
        if (isOpeningSessionActive) {
          pillStatus.textContent = `SESSION 🔥 (${getAvailablePacksCount()} ➔ ${sessionFloor})`;
          pillStatus.style.background = '#7c3aed';
        } else {
          pillStatus.textContent = `STACKING 📦 (${getAvailablePacksCount()}/${currentStackGoal})`;
          pillStatus.style.background = '#d97706';
        }
      } else {
        pillStatus.textContent = 'ACTIF 🟢';
        pillStatus.style.background = '#059669';
      }
      pillStatus.style.color = '#fff';

      const goalBadge = document.getElementById('wm-stack-goal-badge');
      if (goalBadge) goalBadge.textContent = `${currentStackGoal} paquets`;

      btnToggle.textContent = '⏸️ Mettre le Bot en Pause';
      btnToggle.className = 'wm-btn-main wm-btn-stop';
    } else {
      pillStatus.textContent = 'PAUSE ⏸️';
      pillStatus.style.background = '#4b5563';
      pillStatus.style.color = '#e5e7eb';

      btnToggle.textContent = '▶️ Démarrer le Bot (Auto-Pulls)';
      btnToggle.className = 'wm-btn-main wm-btn-start';
    }
  }

  function updateThemesTab() {
    const container = document.getElementById('wm-themes-list');
    if (!container || !classifier) return;

    const themes = classifier.getThemes();
    const learnedStats = typeof classifier.getLearnedStats === 'function' ? classifier.getLearnedStats() : { profiles: {} };
    if (themes.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:#9ca3af;padding:8px;">Aucun thème pour le moment. Taguez des cartes dans le jeu, puis cliquez sur « 🧠 Apprendre de mes cartes déjà classées » : chaque tag deviendra un thème.</div>';
      return;
    }
    container.innerHTML = themes.map(t => {
      const kwCount = (t.strongKeywords?.length || 0) + (t.keywords?.length || 0);
      const learnedCount = learnedStats.profiles?.[t.name]?.cardCount || 0;
      const learnedPill = learnedCount > 0
        ? `<span style="font-size:9px;background:rgba(167,139,250,0.2);color:#c4b5fd;padding:1px 6px;border-radius:99px;font-weight:700;">🧠 ${learnedCount} apprises</span>`
        : '';
      return `
      <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="width:12px;height:12px;border-radius:50%;background:${t.color};display:inline-block;box-shadow:0 0 4px ${t.color};"></span>
          <span style="font-size:12px;font-weight:700;color:#f3f4f6;">${escapeHtml(t.name)}</span>
          <span style="font-size:10px;color:#9ca3af;">(${kwCount} règles)</span>
          ${learnedPill}
        </div>
        <input type="checkbox" ${t.enabled ? 'checked' : ''} style="accent-color:#10b981;cursor:pointer;" data-theme-id="${t.id}">
      </div>
    `;
    }).join('');

    container.querySelectorAll('input[type="checkbox"]').forEach(box => {
      box.onchange = (e) => {
        const id = box.dataset.themeId;
        const target = themes.find(t => t.id === id);
        if (target) {
          target.enabled = e.target.checked;
          // Les thèmes par défaut sont stockés sans leurs règles : elles viennent toujours du code
          const defaultIds = new Set((window.WMClassifier?.DEFAULT_THEMES || []).map(d => d.id));
          customThemes = themes.map(t => defaultIds.has(t.id) ? { id: t.id, name: t.name, color: t.color, enabled: t.enabled } : t);
          saveSettings();
        }
      };
    });
  }

  function updateStatsTab() {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setVal('wm-stat-packs', settings.stats.packsOpened);
    setVal('wm-stat-tagged', settings.stats.cardsTagged);
    setVal('wm-stat-cards', settings.stats.cardsSeen);
    setVal('wm-stat-legendary', settings.stats.rarities.L);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderUI);
  } else {
    renderUI();
  }
})();
})();
