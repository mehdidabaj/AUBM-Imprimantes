# Checklist de déploiement

À faire sur le Debian qui héberge déjà GLPI, après fusion des lots d'audit dans `main`. GLPI reste sur le port 80. Le parc reste sur le port 8080.

## Avant

- [ ] Le dépôt local est `/opt/aubm-imprimantes` et suit `main`.
- [ ] Une copie du fichier `/etc/aubm-imprimantes.env` est mise de côté. Il contient le mot de passe MySQL du compte `aubm` et `AUBM_SECRET`. Il ne doit plus contenir `AUBM_ADMIN_PASSWORD` après cette installation.
- [ ] Le mot de passe du premier administrateur est déjà noté, ou un autre administrateur peut encore se connecter. L'installation ne le réaffiche pas si le compte existe.

## Mise à jour

```bash
cd /opt/aubm-imprimantes
sudo git checkout main
sudo git pull
sudo ./deploy/install-debian.sh --server-name 195.200.200.16 --listen-port 8080
```

Garder `--listen-port 8080` à chaque relance.

## Après

- [ ] `curl -s http://127.0.0.1:8080/api/health` contient `"ok": true`.
- [ ] `systemctl status aubm-imprimantes` est actif. Sans systemd, le journal est `/var/log/aubm-imprimantes.log`.
- [ ] `grep AUBM_ADMIN_PASSWORD /etc/aubm-imprimantes.env` ne renvoie rien. Le mot de passe MySQL, lui, est toujours dans ce fichier.
- [ ] La page de connexion affiche le logo. Un administrateur ouvre le parc, une fiche, puis exporte le PDF : le titre est « État des consommables des imprimantes de l'AUBM en date jj/mm/aaaa », sans heure.
- [ ] GLPI répond toujours sur le port 80.
- [ ] Recharger le navigateur pour prendre les nouveaux fichiers.

## HTTPS, plus tard

Quand un nom d'hôte pointe vers le serveur :

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d imprimantes.exemple.ma
```

Ajouter ensuite `AUBM_COOKIE_SECURE=1` dans `/etc/aubm-imprimantes.env` et relancer `aubm-imprimantes`. Sans HTTPS, ne pas poser cette variable : le navigateur refuserait le cookie et la connexion échouerait.

## Tests, avant de pousser une modification

```bash
./scripts/test.sh
```

Le script lance `node tests/logic.test.mjs`, puis les tests Python dans `server/`. Il faut Python 3 avec Flask, PyMySQL et Werkzeug.
