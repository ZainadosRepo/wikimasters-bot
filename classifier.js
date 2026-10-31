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
