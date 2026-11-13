# Audit du parc imprimantes

Revue du 13 novembre 2026 (heure de Casablanca), sur le code publié et les quatre lots qui suivent. L'architecture retenue est décrite dans [l'ADR 0001](adr/0001-architecture.md).

## Périmètre

Pages statiques, règles d'état et exports, API Flask, schéma MySQL, lecture SNMP, Nginx et le script d'installation Debian.

## Ce qui tenait déjà

- Les requêtes SQL passent par des paramètres, y compris les identifiants et les textes saisis.
- Les mots de passe sont des empreintes. L'API ne renvoie jamais `mot_de_passe`. Un compte absent est vérifié contre une empreinte factice, pour ne pas répondre plus vite.
- Le cookie de session est HttpOnly et SameSite Lax. Les mutations avec corps doivent être du JSON. Le corps est limité à 512 Kio.
- Huit échecs de connexion pour le même couple adresse et identifiant, dans une fenêtre de dix minutes, répondent 429.
- `snmpwalk` est lancé sans shell. La communauté ne peut pas commencer par `-`. Les adresses non routables, la boucle locale, le lien local et la multidiffusion sont refusées.
- Le premier administrateur ne se supprime pas. Le dernier administrateur actif ne peut pas être retiré ni rétrogradé. Un compte ne peut pas se désactiver lui-même.
- Les couleurs de cartouche acceptées sont des codes hexadécimaux. Le texte affiché passe par `esc`.
- Nginx envoie les en-têtes de cadre, de type et la politique de contenu. systemd interdit les nouveaux privilèges et protège le système de fichiers.

## Écarts et lots

### Lot 1 — sécurité et bugs critiques

- `X-Real-IP` était lu quel que soit l'expéditeur. Seul un pair sur la boucle locale, donc Nginx, peut encore annoncer l'adresse du poste.
- Les nouvelles empreintes sont figées en scrypt. Les empreintes déjà en base restent vérifiables.
- L'API n'exige plus `AUBM_ADMIN_PASSWORD` quand un compte existe. L'installation affiche le mot de passe du premier administrateur une fois, puis retire la ligne du fichier d'environnement. Une réinstallation ne génère pas un mot de passe qu'elle n'appliquerait pas. Si le décompte des comptes échoue, le script s'arrête.
- Un identifiant déjà pris n'est plus annoncé comme une imprimante en double.

### Lot 2 — tests manquants

`tests/logic.test.mjs` importait `js/data.js` et `server/seed.json`, retirés avec le relevé du 4 juin 2025. Il est réécrit sur un parc d'exemple : seuils, filtres, colonnes d'export, CSV, noms SNMP, date de Casablanca et titre PDF en encre foncée.

### Lot 3 — dette à fort impact

Ouvrir, enregistrer ou relever une fiche chargeait tout le parc pour n'en garder qu'une ligne. `load_one` lit l'imprimante demandée, puis ses toners et ses kits. Le découpage de `js/app.js` n'est pas fait : le fichier est long, mais le couper sans outil de construction changerait le chargement des pages pour un gain incertain.

### Lot 4 — documentation et déploiement

Cet audit, l'ADR, la [checklist de déploiement](DEPLOIEMENT.md) et le README décrivent le même comportement que le script. `scripts/test.sh` enchaîne les tests du navigateur et de l'API.

## Résiduel, assumé

- En HTTP, le cookie ne porte pas Secure. Le poser quand même empêcherait la connexion. Après HTTPS : `AUBM_COOKIE_SECURE=1` dans `/etc/aubm-imprimantes.env`, puis relancer le service.
- Le cookie n'est pas limité au port 8080. Le navigateur l'envoie aussi à GLPI sur le même hôte. GLPI ne le lit pas comme session de son côté, mais il circule.
- La communauté SNMP v2c voyage en clair sur le réseau local. C'est le protocole des copieurs.
- L'API utilise le serveur intégré de Flask, un processus, bac à sable systemd. Un serveur WSGI n'est pas imposé ici : le répertoire de travail doit rester celui des imports de `server/`.
- Le compteur des échecs de connexion est en mémoire. Un redémarrage le remet à zéro.
- `style-src` autorise les styles en ligne, parce que les jauges écrivent leur couleur dans un attribut `style`. Les scripts restent limités à l'origine.
