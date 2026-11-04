#!/usr/bin/env bash
# Installe le parc d'imprimantes AUBM sur un serveur Debian, derrière Nginx.
set -euo pipefail

SERVER_NAME="_"
WEB_ROOT="/var/www/aubm-imprimantes"
SITE_NAME="aubm-imprimantes"

usage() {
  cat <<'EOF'
Usage : sudo ./deploy/install-debian.sh [--server-name NOM] [--web-root CHEMIN]

Installe Nginx si besoin, copie l'application et active le site.

  --server-name NOM   Nom d'hôte Nginx (défaut : _, tout le port 80)
  --web-root CHEMIN   Dossier des fichiers (défaut : /var/www/aubm-imprimantes)

Exemple :
  sudo ./deploy/install-debian.sh --server-name imprimantes.exemple.ma
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-name)
      SERVER_NAME="${2:-}"
      shift 2
      ;;
    --web-root)
      WEB_ROOT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Option inconnue : $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Lancez le script avec sudo." >&2
  exit 1
fi

if [[ -z "$SERVER_NAME" || -z "$WEB_ROOT" ]]; then
  echo "Le nom d'hôte et le dossier web ne peuvent pas être vides." >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "Impossible de lire /etc/os-release." >&2
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in
  debian:*|*:debian*|*:debian\ *) ;;
  *)
    echo "Ce script cible Debian (détecté : ${PRETTY_NAME:-inconnu})." >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for required in "$ROOT/index.html" "$ROOT/css/styles.css" "$ROOT/js/app.js" "$ROOT/deploy/aubm-imprimantes.nginx"; do
  if [[ ! -f "$required" ]]; then
    echo "Fichier manquant : $required" >&2
    exit 1
  fi
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y nginx

install -d -o www-data -g www-data -m 755 "$WEB_ROOT" "$WEB_ROOT/css" "$WEB_ROOT/js"
install -o www-data -g www-data -m 644 "$ROOT/index.html" "$WEB_ROOT/index.html"
install -o www-data -g www-data -m 644 "$ROOT/css/styles.css" "$WEB_ROOT/css/styles.css"
install -o www-data -g www-data -m 644 "$ROOT"/js/*.js "$WEB_ROOT/js/"

AVAILABLE="/etc/nginx/sites-available/${SITE_NAME}"
ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}"
sed "s/__SERVER_NAME__/${SERVER_NAME//\//\\/}/g" "$ROOT/deploy/aubm-imprimantes.nginx" > "$AVAILABLE"
ln -sfn "$AVAILABLE" "$ENABLED"

if [[ "$SERVER_NAME" == "_" && -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "Site Nginx par défaut retiré : le port 80 sert le parc d'imprimantes."
fi

nginx -t
if [[ -d /run/systemd/system ]]; then
  systemctl enable nginx
  systemctl restart nginx
elif pgrep -x nginx >/dev/null 2>&1; then
  nginx -s reload
else
  nginx
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx HTTP' || true
fi

ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ "$SERVER_NAME" == "_" ]]; then
  URL="http://${ADDRESS:-<adresse-ip>}/"
else
  URL="http://${SERVER_NAME}/"
fi

cat <<EOF

Parc imprimantes installé.
  Fichiers : ${WEB_ROOT}
  Site Nginx : ${AVAILABLE}
  Adresse : ${URL}

Les niveaux saisis par les agents restent dans leur navigateur.
Pour publier une nouvelle version : git pull, puis relancez ce script.
EOF
