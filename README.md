# AUBM — Parc imprimantes

Application web pour suivre le parc d'imprimantes à partir du relevé du **4 juin 2025** : identité, adresse, niveaux de toner, kits et observations.

## Lancer

Depuis la racine du dépôt :

```bash
python3 -m http.server 4173
```

Puis ouvrir [http://127.0.0.1:4173](http://127.0.0.1:4173).

Les modifications (niveaux, ajouts, interventions) restent dans le navigateur (`localStorage`). Le bouton de restauration du journal remet le relevé d'origine.

## Déployer sur Debian

Le site est statique. Nginx le sert sur le port 80. Sur le serveur, en root ou avec `sudo` :

```bash
sudo apt update
sudo apt install -y git
sudo git clone -b cursor/gestion-imprimantes-e995 https://github.com/mehdidabaj/AUBM-Imprimantes.git /opt/aubm-imprimantes
cd /opt/aubm-imprimantes
sudo ./deploy/install-debian.sh
```

Une fois cette branche fusionnée dans `main`, le clone peut se faire sans `-b`.

Le script installe Nginx, copie les fichiers dans `/var/www/aubm-imprimantes` et active le site. Avec le nom d'hôte par défaut, le port 80 du serveur affiche le parc. Pour un nom précis :

```bash
sudo ./deploy/install-debian.sh --server-name imprimantes.exemple.ma
```

Le nom doit pointer vers le serveur. Ouvrez ensuite `http://imprimantes.exemple.ma/`.

Pour mettre à jour après un changement :

```bash
cd /opt/aubm-imprimantes
sudo git pull
sudo ./deploy/install-debian.sh --server-name imprimantes.exemple.ma
```

Si le pare-feu `ufw` est déjà actif, le script ouvre le profil « Nginx HTTP ». Les données saisies dans l'application ne sont pas sur le serveur : chaque navigateur garde son propre suivi.

HTTPS, une fois le nom d'hôte en place :

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d imprimantes.exemple.ma
```

## Ce que l'on peut faire

- Voir les machines à traiter (observation autre que RAS, ou consommable à 10 % ou moins) et celles à surveiller (jusqu'à 30 %).
- Filtrer le parc par département, état, couleur, réseau ou antenne.
- Ouvrir une fiche, corriger les niveaux et enregistrer un remplacement.
- Exporter le parc en CSV (la liste filtrée, si un filtre est actif sur l'inventaire).

Le traceur HP T930 est suivi sur ses six encres (noir photo, gris, noir mat, cyan, magenta, jaune). Pour le bureau Régisseur, le texte du relevé et les colonnes de pourcentages du tableau ne coïncident pas : la fiche le signale et retient les pourcentages des colonnes.
