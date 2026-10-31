// background.js - Service Worker pour WikiMasters Bot
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
});

// Mise à jour du badge de l'icône dans la barre d'outils
async function updateBadge(enabled) {
  if (enabled) {
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' }); // Vert émeraude
  } else {
    await chrome.action.setBadgeText({ text: 'OFF' });
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
