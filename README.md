# 🤖 WikiMasters Bot

Extension de navigateur (et userscript Tampermonkey) pour le jeu de cartes [WikiMasters](https://www.wiki-masters.com) :

- **Ouverture automatique des paquets** dès qu'ils sont disponibles, en les accumulant avant d'ouvrir.
- **Classement automatique des cartes** dans vos thèmes, en posant directement les tags dans le jeu.
- **Défausse rapide** des doublons et des cartes inutiles, avec aperçu avant confirmation.

Tout tourne dans votre navigateur, sur votre session de jeu : aucun serveur, aucun compte tiers, aucune donnée envoyée ailleurs que sur WikiMasters et l'API publique de Wikipédia / Wikidata.

> Projet personnel, non affilié à WikiMasters. Automatiser un jeu peut être contraire à ses conditions d'utilisation : utilisez-le à vos risques.

---

## 📥 Télécharger

**Option 1 : ZIP (le plus simple)**
Sur cette page GitHub : bouton vert **Code** → **Download ZIP**, puis décompressez le dossier.

**Option 2 : Git**
```bash
git clone https://github.com/ZainadosRepo/wikimasters-bot.git
```

## 🔧 Installer

### Extension Chrome / Edge / Brave (recommandé)
1. Ouvrez `chrome://extensions` (ou `edge://extensions`).
2. Activez le **Mode développeur** (en haut à droite).
3. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier téléchargé (celui qui contient `manifest.json`).
4. Allez sur [wiki-masters.com/pulls](https://www.wiki-masters.com/pulls) : la pastille **🤖 WikiMasters Bot** apparaît en bas à gauche.

Pour mettre à jour : remplacez le dossier par la nouvelle version, puis cliquez sur **↻** sur la carte de l'extension dans `chrome://extensions`.

### Userscript (Tampermonkey / Violentmonkey)
1. Installez [Tampermonkey](https://www.tampermonkey.net/) ou [Violentmonkey](https://violentmonkey.github.io/).
2. Créez un nouveau script et collez-y tout le contenu de [`wikimasters-bot.user.js`](wikimasters-bot.user.js).
3. Enregistrez, puis rechargez wiki-masters.com.

## 🎮 Utiliser

Connectez-vous au jeu, allez sur la page **Pulls** et cliquez sur la pastille **🤖 WikiMasters Bot** pour ouvrir le panneau.

### Ouvrir les paquets
- **▶️ Démarrer le Bot** : ouvre les paquets automatiquement. Par défaut, il en accumule un nombre aléatoire (2 à 10) avant de les ouvrir à la suite.
- **⚡ Ouvrir 1 paquet maintenant** / **🔥 Vider tous les paquets maintenant** : ouverture manuelle immédiate.
- Si une vérification anti-robot du site apparaît, le bot se met en pause et émet un bip : validez-la vous-même, il reprend ensuite tout seul.
- **Compte cible** (optionnel) : indiquez votre pseudo et/ou email, séparés par des virgules. Le bot reste inactif dans les onglets connectés à un autre compte. Laissez vide pour agir sur tous les comptes.

### Classer les cartes dans vos thèmes
Le bot ne contient **aucun thème prédéfini** : **chaque tag de votre compte devient un thème**.
1. Dans le jeu, créez vos tags et taguez à la main quelques dizaines de cartes par tag.
2. Dans le panneau : **🧠 Apprendre de mes cartes déjà classées**.
3. Ensuite, chaque carte tirée est classée automatiquement. **📂 Classer toute ma collection existante** classe aussi les cartes déjà possédées.

Comment il décide : pour chaque tag, il repère ce que vos cartes ont en commun sur Wikipédia et Wikidata (métier, sport, nationalité, franchise, catégories…) et qui est rare ailleurs dans votre collection. Une carte déjà taguée garde son tag. **En cas de doute entre deux thèmes, il ne tague pas** et signale la carte « À vérifier » dans le journal. Plus un tag a d'exemples, meilleur est le classement.

L'onglet **🏷️ Mes Thèmes** montre ce qui a été appris et permet de **Tester** un titre de carte.

### Défausser des cartes
**🗑️ Défausser des cartes** ouvre une fenêtre où vous choisissez :
- les raretés concernées ;
- les protections : cartes taguées, favorites, shiny (toujours protégées) ;
- le nombre d'exemplaires à garder par carte (`1` = ne défausser que les doublons).

L'aperçu liste les cartes concernées (`Nom ×3`). Cliquez sur une carte pour l'exclure, puis confirmez. Chaque exemplaire défaussé rapporte 1 Wikibidou. Le bouton d'arrêt fonctionne à tout moment.

---

## 🛠️ Pour les développeurs

Aucune dépendance à installer, seulement [Node.js](https://nodejs.org) 22 ou plus récent.

```bash
npm test        # tests hors-ligne : classement, défausse, userscript à jour
npm run check   # vérification de syntaxe
npm run build   # régénère wikimasters-bot.user.js depuis les sources de l'extension
```

| Fichier | Rôle |
|---|---|
| `content.js` | Panneau, boucle d'ouverture des paquets, classement de la collection, fenêtre de défausse |
| `classifier.js` | Moteur de classement (Wikipédia, Wikidata, apprentissage depuis vos tags) |
| `discard.js` | Plan de défausse et exécution en parallèle avec ralentissement automatique |
| `page-bridge.js` | Accès à la session du jeu dans la page (tags, collection, défausse) |
| `background.js`, `popup/` | Badge ON/OFF et popup de l'extension |
| `wikimasters-bot.user.js` | Userscript **généré** (`npm run build`) : ne pas le modifier à la main |

**Mesurer la précision sur votre collection** : bouton **📤 Exporter mes cartes classées** du panneau, puis :
```bash
node eval/run-eval.js --file wikimasters-collection.json
```
Le bot apprend sur la moitié de vos cartes taguées et est noté sur l'autre moitié. `node eval/inspect-card.js "Titre Wikipédia"` montre ce que le bot voit d'une carte.

**Règles écrites à la main (optionnel)** : un thème peut être déclaré dans `DEFAULT_THEMES` (`classifier.js`) avec des mots-clés et des règles Wikidata :
```js
{
  id: 'tennis', name: 'Tennis', color: '#16a34a', enabled: true,
  strongKeywords: ['joueur de tennis'], keywords: ['tennis'], wikiCategories: ['tennis'], excludeKeywords: [],
  wikidataRules: [
    // any : au moins une propriété contient un des mots ; all : toutes doivent en contenir un
    { label: 'joueur de tennis', humanOnly: true, any: { P106: ['joueur de tennis'], P641: ['tennis'] } }
  ]
}
```
