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
