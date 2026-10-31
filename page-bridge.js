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
