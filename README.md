# AUBM — Parc imprimantes

Application web pour suivre le parc d'imprimantes à partir du relevé du **4 juin 2025** : identité, adresse, niveaux de toner, kits et observations. Les fiches sont enregistrées dans MySQL et partagées par tous les postes.

## Déployer sur Debian

Sur le serveur, en root ou avec `sudo` :

```bash
sudo apt update
sudo apt install -y git
sudo git clone -b cursor/gestion-imprimantes-e995 https://github.com/mehdidabaj/AUBM-Imprimantes.git /opt/aubm-imprimantes
cd /opt/aubm-imprimantes
sudo ./deploy/install-debian.sh
```

Une fois cette branche fusionnée dans `main`, le clone peut se faire sans `-b`.

Le script installe Nginx, le serveur MySQL des dépôts Debian (paquet `default-mysql-server`), charge le schéma, importe le relevé si la base est vide, et démarre l'API (`aubm-imprimantes`, port local 8765). Nginx publie le site sur le port 80 et relaie `/api/`.

Avec le nom d'hôte par défaut, le port 80 du serveur affiche le parc. Pour un nom précis :

```bash
sudo ./deploy/install-debian.sh --server-name imprimantes.exemple.ma
```

Le nom doit pointer vers le serveur. Ouvrez ensuite `http://imprimantes.exemple.ma/`.

Le mot de passe du compte `aubm` est créé dans `/etc/aubm-imprimantes.env` (lecture root et www-data). Une réinstallation le réutilise et conserve les fiches déjà saisies.

Pour mettre à jour après un changement :

```bash
cd /opt/aubm-imprimantes
sudo git pull
sudo ./deploy/install-debian.sh --server-name imprimantes.exemple.ma
```

Pour revenir au relevé du 4 juin 2025 et vider le journal :

```bash
sudo ./deploy/install-debian.sh --reset-data
```

Le même bouton existe dans le journal de l'application.

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

- Ajouter une imprimante : nom, département, emplacement, adresse, couleur, marque des cartouches.
- Indiquer chaque toner et son pourcentage. Laisser vide un canal qui ne concerne pas la machine. Le traceur HP T930 reste suivi sur ses six encres.
- Ajouter les kits lorsqu'ils existent, avec un pourcentage ou la mention OK si le niveau n'est pas chiffré.
- Noter l'observation finale (RAS ou le remplacement à prévoir).
- Enregistrer une intervention (remplacement de toner, de kit, de photoconducteur).
- Voir les machines à traiter (observation autre que RAS, ou consommable à 10 % ou moins) et celles à surveiller (jusqu'à 30 %, ou toner non renseigné).
- Filtrer le parc par département, état, couleur, réseau ou antenne.
- Exporter le parc en CSV (la liste filtrée, si un filtre est actif sur l'inventaire).

Pour le bureau Régisseur, le texte du relevé et les colonnes de pourcentages du tableau ne coïncident pas : la fiche le signale et retient les pourcentages des colonnes.
