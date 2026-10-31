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
