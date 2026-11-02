// update-check.js - Compare la version installée à la dernière release GitHub.
// Partagé par le service worker, la popup et les tests (Node).

// Lu par le service worker une fois par jour : l'API GitHub autorise ces appels sans jeton
// ni permission d'hôte (CORS ouvert), dans la limite de 60 par heure et par adresse IP.
const LATEST_RELEASE_API = 'https://api.github.com/repos/ZainadosRepo/wikimasters-bot/releases/latest';

/** Version de `latestTag` ("v1.2.0") si elle est plus récente que `current` ("1.1.0"), sinon null. */
function newerVersion(current, latestTag) {
  const parse = v => String(v).trim().replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10));
  const latest = parse(latestTag);
  const installed = parse(current);
  if (latest.some(Number.isNaN) || installed.some(Number.isNaN)) return null;
  for (let i = 0; i < Math.max(latest.length, installed.length); i++) {
    const a = latest[i] || 0;
    const b = installed[i] || 0;
    if (a !== b) return a > b ? latest.join('.') : null;
  }
  return null;
}

if (typeof module !== 'undefined') module.exports = { newerVersion, LATEST_RELEASE_API };
