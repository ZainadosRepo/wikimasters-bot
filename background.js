// background.js - Service Worker pour WikiMasters Bot
importScripts('update-check.js');

const UPDATE_ALARM = 'update-check';

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    botEnabled: false,
    autoOpenPacks: true,
    fastSkipReveal: true,
    autoClassify: true,
    createMissingTags: true,
    soundAlerts: true,
    checkIntervalSec: 15,
    stats: {
      packsOpened: 0,
      cardsSeen: 0,
      cardsTagged: 0,
      rarities: { C: 0, PC: 0, R: 0, SR: 0, UR: 0, L: 0, shiny: 0 }
    }
  };

  const stored = await chrome.storage.local.get(['settings', 'stats']);
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: defaults });
  }

  await updateBadge(stored.settings ? stored.settings.botEnabled : false);
  scheduleUpdateCheck();
});

chrome.runtime.onStartup.addListener(scheduleUpdateCheck);

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
});

// Une extension décompressée ne se met pas à jour seule : on vérifie au démarrage puis chaque jour
function scheduleUpdateCheck() {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 24 * 60 });
  checkForUpdate();
}

async function checkForUpdate() {
  try {
    const response = await fetch(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { tag_name: tag, html_url: url } = await response.json();
    const version = newerVersion(chrome.runtime.getManifest().version, tag);
    await chrome.storage.local.set({ update: version ? { version, url } : null });
  } catch (e) {
    // Hors ligne ou GitHub indisponible : la dernière réponse connue reste affichée
    console.warn('[WikiMasters Bot] Vérification de mise à jour impossible :', e);
  }
  const { settings = {} } = await chrome.storage.local.get('settings');
  await updateBadge(settings.botEnabled || false);
}

// Mise à jour du badge de l'icône dans la barre d'outils ; « ↑ » signale une nouvelle version
async function updateBadge(enabled) {
  const { update } = await chrome.storage.local.get('update');
  // Comparée à la version installée : une réponse gardée d'avant la mise à jour ne compte plus
  const available = update && newerVersion(chrome.runtime.getManifest().version, update.version);
  const arrow = available ? '↑' : '';
  await chrome.action.setTitle({
    title: available ? `WikiMasters Bot - version ${available} disponible` : 'WikiMasters Bot'
  });
  if (enabled) {
    await chrome.action.setBadgeText({ text: `ON${arrow}` });
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' }); // Vert émeraude
  } else {
    await chrome.action.setBadgeText({ text: `OFF${arrow}` });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' }); // Gris
  }
}

// Écoute des messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STATUS_CHANGED') {
    updateBadge(message.enabled);
    sendResponse({ ok: true });
    return true;
  }

});
