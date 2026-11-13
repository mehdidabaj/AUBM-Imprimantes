# ADR 0001 — Pages statiques, API Flask et MySQL

Statut : accepté

## Contexte

Le parc d'imprimantes de l'Agence Urbaine de Beni Mellal est consulté depuis plusieurs postes du réseau. GLPI occupe déjà le port 80 du serveur Debian `195.200.200.16`. L'application doit enregistrer les fiches, les niveaux et les comptes, produire un CSV et un PDF, et interroger les imprimantes en SNMP, sans étape de compilation sur le serveur.

## Décision

- Le navigateur charge `index.html`, `js/app.js`, `js/logic.js`, `js/pdf.js` et `css/styles.css`. Il n'y a pas de bundler.
- Nginx sert ces fichiers et relaie `/api/` vers Flask, qui n'écoute que sur `127.0.0.1:8765`.
- MySQL garde les fiches dans la base `aubm_imprimantes`, séparée de GLPI.
- Deux profils : administrateur et consultation. La session est un cookie HttpOnly, SameSite Lax, valable 12 heures.
- Les mots de passe sont des empreintes scrypt (Werkzeug). La base ne contient pas le secret en clair.
- La lecture des consommables lance `snmpwalk` avec une liste d'arguments, sans shell.
- Le site est publié sur le port 8080 lorsque GLPI garde le port 80.

## Conséquences

- Une mise à jour est un `git pull` suivi de `deploy/install-debian.sh`. Aucune construction n'est requise.
- Le cookie de session n'est pas limité au port. Sur le même hôte, le navigateur l'envoie aussi à GLPI. Le nom du cookie ne change pas ce comportement.
- Tant que le site est en HTTP, le cookie ne peut pas porter l'attribut Secure. Il le porte dès que `AUBM_COOKIE_SECURE=1` et que Nginx sert le site en HTTPS.
- SNMP v2c transporte la communauté en clair. C'est le protocole des imprimantes du parc, pas un choix de stockage.
- L'API tourne avec le serveur de développement de Flask, dans le bac à sable systemd. Le remplacer par un serveur WSGI reste possible, mais le répertoire de travail doit rester `server/` à cause des imports locaux.
