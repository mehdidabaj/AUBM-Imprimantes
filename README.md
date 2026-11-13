# AUBM — Parc imprimantes

Application web pour suivre le parc d'imprimantes : identité, adresse, niveaux de toner, kits et observations. Les fiches sont enregistrées dans MySQL et partagées par tous les postes.

## Déployer sur Debian

Sur le serveur, en root ou avec `sudo` :

```bash
sudo apt update
sudo apt install -y git
sudo git clone https://github.com/mehdidabaj/AUBM-Imprimantes.git /opt/aubm-imprimantes
cd /opt/aubm-imprimantes
sudo ./deploy/install-debian.sh
```

Le script installe Nginx, le serveur MySQL des dépôts Debian (paquet `default-mysql-server`), charge le schéma et démarre l'API (`aubm-imprimantes`, port local 8765). Nginx publie le site et relaie `/api/`. Le parc démarre vide.

Avec le nom d'hôte par défaut, le port 80 du serveur affiche le parc. Pour un nom précis :

```bash
sudo ./deploy/install-debian.sh --server-name imprimantes.exemple.ma
```

Le nom doit pointer vers le serveur. Ouvrez ensuite `http://imprimantes.exemple.ma/`.

## Serveur qui héberge déjà GLPI

GLPI garde le port 80 et sa base MySQL. Le parc écoute sur le port 8080 et utilise une base séparée, `aubm_imprimantes`. Sur `195.200.200.16` :

```bash
sudo apt update
sudo apt install -y git
sudo git clone https://github.com/mehdidabaj/AUBM-Imprimantes.git /opt/aubm-imprimantes
cd /opt/aubm-imprimantes
sudo ./deploy/install-debian.sh --server-name 195.200.200.16 --listen-port 8080
```

Ouvrez ensuite [http://195.200.200.16:8080/](http://195.200.200.16:8080/). GLPI reste sur [http://195.200.200.16/](http://195.200.200.16/).

Si le dépôt est déjà cloné :

```bash
cd /opt/aubm-imprimantes
sudo git checkout main
sudo git pull
sudo ./deploy/install-debian.sh --server-name 195.200.200.16 --listen-port 8080
```

Contrôle : `curl -s http://127.0.0.1:8080/api/health` doit répondre `"ok": true`. Gardez `--listen-port 8080` à chaque relance, afin de laisser le port 80 à GLPI. Pour effacer le parc, le journal, les départements et les emplacements, tout en gardant les comptes :

```bash
cd /opt/aubm-imprimantes
sudo git checkout main
sudo git pull
sudo ./deploy/install-debian.sh --server-name 195.200.200.16 --listen-port 8080 --vider
```

Le mot de passe du compte MySQL `aubm` est créé dans `/etc/aubm-imprimantes.env` (lecture root et www-data). Une réinstallation le réutilise et conserve les fiches déjà saisies.

## Comptes et accès

Deux profils :

- **Administrateur** : parc, interventions, départements et page Utilisateurs.
- **Consultation** : tableau, inventaire, alertes, fiches et journal en lecture, plus les exports CSV et PDF. L'ajout, la modification et la suppression du parc restent fermés.

À la première installation, le script crée le compte `admin` (ou la valeur de `AUBM_ADMIN_USER`) et affiche son mot de passe une seule fois. Il le retire ensuite de `/etc/aubm-imprimantes.env`. La base ne garde que l'empreinte scrypt. Une réinstallation ne le réaffiche pas. La page Utilisateurs permet d'ajouter un compte, de changer son profil, de le désactiver, de poser un nouveau mot de passe ou de supprimer un compte ajouté. Le premier administrateur ne peut pas être supprimé. Le dernier administrateur actif reste en place.

L'audit, les choix d'architecture et la checklist de mise à jour sont dans `docs/AUDIT.md`, `docs/adr/0001-architecture.md` et `docs/DEPLOIEMENT.md`. Les tests se lancent avec `./scripts/test.sh`.

L'adresse `/api/health` reste publique pour le contrôle d'installation. Le reste de l'API exige une session. Les modifications exigent le profil administrateur.

Pour mettre à jour après un changement, relancez le script avec les mêmes options. Sur un serveur sans GLPI :

```bash
cd /opt/aubm-imprimantes
sudo git checkout main
sudo git pull
sudo ./deploy/install-debian.sh --server-name imprimantes.exemple.ma
```

Sur `195.200.200.16`, où GLPI occupe le port 80, gardez le port 8080 :

```bash
cd /opt/aubm-imprimantes
sudo git checkout main
sudo git pull
sudo ./deploy/install-debian.sh --server-name 195.200.200.16 --listen-port 8080
```

Si le pare-feu `ufw` est déjà actif, le script ouvre le profil « Nginx HTTP ». L'API n'écoute que sur `127.0.0.1`.

HTTPS, une fois le nom d'hôte en place :

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d imprimantes.exemple.ma
```

Contrôle rapide :

```bash
curl -s http://127.0.0.1/api/health
systemctl status aubm-imprimantes
```

Sur un serveur sans systemd, le script démarre MySQL et l'API directement. Le journal de l'API est alors `/var/log/aubm-imprimantes.log`.

## Ce que l'on peut faire

Tout compte connecté peut :

- Voir les machines à traiter (observation autre que RAS, ou consommable à 10 % ou moins) et celles à surveiller (jusqu'à 30 %, ou toner non renseigné).
- Filtrer le parc par département, état, couleur, réseau ou antenne.
- Exporter le parc en CSV ou en PDF. Dans l'inventaire, les machines cochées forment l'export. Sans coche, l'export reprend la liste filtrée.

L'administrateur peut en plus :

- Ajouter une imprimante : nom, département, emplacement, case couleur, et case adresse IP. Sans adresse, la machine est en poste local. Avec une adresse IPv4, la lecture SNMP remplit le nom exact de chaque cartouche, son niveau, et les kits. Chaque cartouche se saisit aussi à la main : marque, nom et pourcentage. Les kits aussi.
- Indiquer chaque toner et son pourcentage. Laisser vide un canal qui ne concerne pas la machine. Ajouter d'autres toners, avec un nom et un pourcentage. Le traceur HP T930 reste suivi sur ses six encres.
- Ajouter les kits lorsqu'ils existent, avec un pourcentage ou la mention OK si le niveau n'est pas chiffré.
- Noter l'observation finale (RAS ou le remplacement à prévoir).
- Enregistrer une intervention (remplacement de toner, de kit, de photoconducteur).
- Créer les comptes, choisir leur profil et supprimer un compte ajouté. Le premier administrateur ne se supprime pas.
- Gérer les départements et les emplacements qui leur sont liés. La fiche propose ensuite ces emplacements selon le département choisi.
- Lire les niveaux des cartouches et des kits sur une imprimante joignable par adresse IPv4. Le bouton « Lire les cartouches et les kits » interroge la machine en SNMP (communauté `public` par défaut, modifiable sur la fiche). « Lire les IP » parcourt les machines qui ont une adresse. Une adresse `Localhost` n'est pas interrogée.
