// popup.js - Contrôle rapide du bot depuis la popup d'extension
document.addEventListener('DOMContentLoaded', async () => {
  const badge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const btnToggle = document.getElementById('btn-toggle');
  const statPacks = document.getElementById('stat-packs');
  const statTagged = document.getElementById('stat-tagged');

  // Charger les données stockées
  const { settings = {} } = await chrome.storage.local.get('settings');
  let isEnabled = settings.botEnabled || false;

  function updateView() {
    if (isEnabled) {
      badge.textContent = 'ON';
      badge.className = 'badge on';
      statusText.textContent = 'Actif (En cours)';
      statusText.style.color = '#34d399';
      btnToggle.textContent = '⏸️ Mettre en Pause';
      btnToggle.className = 'btn btn-danger';
    } else {
      badge.textContent = 'OFF';
      badge.className = 'badge off';
      statusText.textContent = 'En pause';
      statusText.style.color = '#9ca3af';
      btnToggle.textContent = '▶️ Activer le Bot';
      btnToggle.className = 'btn btn-primary';
    }

    if (settings.stats) {
      statPacks.textContent = settings.stats.packsOpened || 0;
      statTagged.textContent = settings.stats.cardsTagged || 0;
    }
  }

  updateView();

  // Bascule Actif / Pause
  btnToggle.addEventListener('click', async () => {
    isEnabled = !isEnabled;
    // Relire juste avant d'écrire : l'onglet du jeu a pu mettre à jour les stats depuis l'ouverture
    const { settings: latest = {} } = await chrome.storage.local.get('settings');
    Object.assign(settings, latest, { botEnabled: isEnabled });
    // L'onglet WikiMasters réagit via chrome.storage.onChanged
    await chrome.storage.local.set({ settings });

    chrome.runtime.sendMessage({ type: 'STATUS_CHANGED', enabled: isEnabled });

    updateView();
  });
});
