#!/usr/bin/env bash
# Installe le parc d'imprimantes AUBM sur Debian : Nginx, MySQL et l'API.
set -euo pipefail

SERVER_NAME="_"
WEB_ROOT="/var/www/aubm-imprimantes"
SITE_NAME="aubm-imprimantes"
ENV_FILE="/etc/aubm-imprimantes.env"
LISTEN_PORT="80"
RESET_DATA=0

usage() {
  cat <<'EOF'
Usage : sudo ./deploy/install-debian.sh [--server-name NOM] [--listen-port PORT] [--web-root CHEMIN] [--reset-data]

Installe Nginx, le serveur MySQL des dépôts Debian, charge le schéma,
démarre l'API et publie le site. La base MySQL déjà présente (GLPI, par
exemple) est conservée : seule la base aubm_imprimantes est ajoutée.

  --server-name NOM    Nom d'hôte Nginx (défaut : _, tout le port choisi)
  --listen-port PORT   Port du site (défaut : 80). Mettre 8080 si le port 80 sert déjà GLPI.
  --web-root CHEMIN    Dossier des fichiers (défaut : /var/www/aubm-imprimantes)
  --reset-data         Recharge le relevé du 4 juin 2025 et vide le journal

Exemple, serveur dont le port 80 est déjà pris par GLPI :
  sudo ./deploy/install-debian.sh --server-name 195.200.200.16 --listen-port 8080
EOF
}

port_holders() {
  ss -H -ltnp "sport = :$1" 2>/dev/null || true
}

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'
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
    --listen-port)
      LISTEN_PORT="${2:-}"
      shift 2
      ;;
    --reset-data)
      RESET_DATA=1
      shift
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

if [[ "$SERVER_NAME" == *" "* || "$WEB_ROOT" == *" "* ]]; then
  echo "Le nom d'hôte et le dossier web ne doivent pas contenir d'espace." >&2
  exit 1
fi

if [[ ! "$LISTEN_PORT" =~ ^[0-9]+$ ]] || [[ "$LISTEN_PORT" -lt 1 || "$LISTEN_PORT" -gt 65535 ]]; then
  echo "Le port d'écoute est invalide." >&2
  exit 1
fi

HOLDERS_80="$(port_holders 80)"
if [[ "$LISTEN_PORT" == "80" && -n "$HOLDERS_80" ]]; then
  OURS_LISTEN=""
  if [[ -f /etc/nginx/sites-available/aubm-imprimantes ]]; then
    OURS_LISTEN="$(grep -E '^[[:space:]]*listen ' /etc/nginx/sites-available/aubm-imprimantes | head -1 || true)"
  fi
  if [[ ! "$OURS_LISTEN" =~ listen[[:space:]]+80(;|[[:space:]]) ]]; then
    echo "Le port 80 est déjà utilisé. GLPI peut rester en place." >&2
    echo "Relancez avec un autre port, par exemple :" >&2
    echo "  sudo $0 --server-name ${SERVER_NAME} --listen-port 8080" >&2
    exit 1
  fi
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
for required in \
  "$ROOT/index.html" \
  "$ROOT/css/styles.css" \
  "$ROOT/js/app.js" \
  "$ROOT/js/pdf.js" \
  "$ROOT/js/logic.js" \
  "$ROOT/server/app.py" \
  "$ROOT/server/schema.sql" \
  "$ROOT/server/seed.json" \
  "$ROOT/deploy/aubm-imprimantes.nginx" \
  "$ROOT/deploy/aubm-imprimantes.service"
do
  if [[ ! -f "$required" ]]; then
    echo "Fichier manquant : $required" >&2
    exit 1
  fi
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y default-mysql-server python3 python3-flask python3-pymysql curl openssl iproute2
# Si Apache occupe déjà le port 80 pour GLPI, le premier démarrage de Nginx peut échouer.
# La configuration posée plus bas n'écoute alors que sur le port demandé.
apt-get install -y nginx || true
if ! command -v nginx >/dev/null 2>&1; then
  echo "Nginx n'a pas pu être installé." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  PASS="Aubm_$(openssl rand -hex 16)"
  umask 027
  cat > "$ENV_FILE" <<EOF
AUBM_DB_HOST=127.0.0.1
AUBM_DB_NAME=aubm_imprimantes
AUBM_DB_USER=aubm
AUBM_DB_PASSWORD=${PASS}
AUBM_BIND=127.0.0.1
AUBM_PORT=8765
EOF
  chown root:www-data "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${AUBM_DB_HOST:?AUBM_DB_HOST manquant dans ${ENV_FILE}}"
: "${AUBM_DB_NAME:?AUBM_DB_NAME manquant dans ${ENV_FILE}}"
: "${AUBM_DB_USER:?AUBM_DB_USER manquant dans ${ENV_FILE}}"
: "${AUBM_DB_PASSWORD:?AUBM_DB_PASSWORD manquant dans ${ENV_FILE}}"
: "${AUBM_PORT:=8765}"

if [[ ! "$AUBM_DB_NAME" =~ ^[A-Za-z0-9_]+$ || ! "$AUBM_DB_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "Le nom de base ou l'utilisateur MySQL est invalide." >&2
  exit 1
fi
if [[ ! "$AUBM_PORT" =~ ^[0-9]+$ ]]; then
  echo "AUBM_PORT est invalide." >&2
  exit 1
fi
if [[ "$LISTEN_PORT" == "$AUBM_PORT" ]]; then
  echo "Le port du site et le port de l'API doivent être différents." >&2
  exit 1
fi

start_mysql() {
  if mysqladmin --protocol=socket ping >/dev/null 2>&1; then
    return 0
  fi
  if [[ -d /run/systemd/system ]]; then
    if systemctl list-unit-files --no-legend 'mariadb.service' 2>/dev/null | grep -q '^mariadb.service'; then
      systemctl enable mariadb
      systemctl restart mariadb
    else
      systemctl enable mysql
      systemctl restart mysql
    fi
    return 0
  fi
  if command -v service >/dev/null 2>&1; then
    service mariadb start >/dev/null 2>&1 || service mysql start >/dev/null 2>&1 || true
  fi
  if mysqladmin --protocol=socket ping >/dev/null 2>&1; then
    return 0
  fi
  install -d -o mysql -g mysql -m 755 /run/mysqld
  mysqld_safe --datadir=/var/lib/mysql --socket=/run/mysqld/mysqld.sock >/var/log/aubm-mysqld.log 2>&1 &
  local _
  for _ in $(seq 1 40); do
    if mysqladmin --protocol=socket ping >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "MySQL n'a pas démarré. Voir /var/log/aubm-mysqld.log." >&2
  return 1
}

start_mysql

mysql --protocol=socket -uroot --default-character-set=utf8mb4 <<SQL
CREATE DATABASE IF NOT EXISTS \`${AUBM_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${AUBM_DB_USER}'@'127.0.0.1' IDENTIFIED BY '${AUBM_DB_PASSWORD}';
ALTER USER '${AUBM_DB_USER}'@'127.0.0.1' IDENTIFIED BY '${AUBM_DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${AUBM_DB_USER}'@'localhost' IDENTIFIED BY '${AUBM_DB_PASSWORD}';
ALTER USER '${AUBM_DB_USER}'@'localhost' IDENTIFIED BY '${AUBM_DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${AUBM_DB_NAME}\`.* TO '${AUBM_DB_USER}'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${AUBM_DB_NAME}\`.* TO '${AUBM_DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

mysql --protocol=socket -uroot --default-character-set=utf8mb4 "$AUBM_DB_NAME" < "$ROOT/server/schema.sql"

python3 -m py_compile "$ROOT/server/app.py"

install -d -o www-data -g www-data -m 755 "$WEB_ROOT" "$WEB_ROOT/css" "$WEB_ROOT/js"
install -o www-data -g www-data -m 644 "$ROOT/index.html" "$WEB_ROOT/index.html"
install -o www-data -g www-data -m 644 "$ROOT/css/styles.css" "$WEB_ROOT/css/styles.css"
install -o www-data -g www-data -m 644 "$ROOT/js/app.js" "$ROOT/js/logic.js" "$ROOT/js/pdf.js" "$WEB_ROOT/js/"

AVAILABLE="/etc/nginx/sites-available/${SITE_NAME}"
ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}"
sed \
  -e "s|__SERVER_NAME__|$(escape_sed "$SERVER_NAME")|g" \
  -e "s|__WEB_ROOT__|$(escape_sed "$WEB_ROOT")|g" \
  -e "s|__API_PORT__|$(escape_sed "$AUBM_PORT")|g" \
  -e "s|__LISTEN_PORT__|$(escape_sed "$LISTEN_PORT")|g" \
  "$ROOT/deploy/aubm-imprimantes.nginx" > "$AVAILABLE"
ln -sfn "$AVAILABLE" "$ENABLED"

if [[ "$LISTEN_PORT" == "80" && "$SERVER_NAME" == "_" && -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "Site Nginx par défaut retiré : le port 80 sert le parc d'imprimantes."
fi

# Apache (GLPI) garde le port 80. Le site d'accueil livré avec Nginx l'occuperait aussi
# et empêcherait Nginx de démarrer. On retire seulement ce site d'accueil.
if [[ "$LISTEN_PORT" != "80" && -e /etc/nginx/sites-enabled/default ]]; then
  HOLDERS_80="$(port_holders 80)"
  if [[ -n "$HOLDERS_80" && ! "$HOLDERS_80" =~ nginx ]]; then
    rm -f /etc/nginx/sites-enabled/default
    echo "Site d'accueil Nginx retiré. Le port 80 reste au service déjà en place."
  fi
fi

nginx -t
if [[ -d /run/systemd/system ]]; then
  systemctl enable nginx
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    systemctl restart nginx
  fi
elif pgrep -x nginx >/dev/null 2>&1; then
  nginx -s reload
else
  nginx
fi

UNIT="/etc/systemd/system/aubm-imprimantes.service"
sed -e "s|__ROOT__|$(escape_sed "$ROOT")|g" "$ROOT/deploy/aubm-imprimantes.service" > "$UNIT"

start_api() {
  if [[ -d /run/systemd/system ]]; then
    systemctl daemon-reload
    systemctl enable aubm-imprimantes
    systemctl restart aubm-imprimantes
    return 0
  fi
  if [[ -f /run/aubm-imprimantes.pid ]]; then
    local old
    old="$(cat /run/aubm-imprimantes.pid 2>/dev/null || true)"
    if [[ -n "${old}" ]]; then
      kill "${old}" 2>/dev/null || true
    fi
  fi
  pkill -f "${ROOT}/server/app.py" 2>/dev/null || true
  sleep 0.4
  touch /var/log/aubm-imprimantes.log
  chown www-data:www-data /var/log/aubm-imprimantes.log
  nohup runuser -u www-data -- bash -c \
    'set -a; . /etc/aubm-imprimantes.env; set +a; cd "$1"; exec /usr/bin/python3 server/app.py' \
    bash "$ROOT" >> /var/log/aubm-imprimantes.log 2>&1 &
  echo $! > /run/aubm-imprimantes.pid
}

start_api

ready=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${AUBM_PORT}/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [[ "$ready" -ne 1 ]]; then
  echo "L'API ne répond pas." >&2
  if [[ -d /run/systemd/system ]]; then
    journalctl -u aubm-imprimantes -n 60 --no-pager || true
  fi
  tail -n 80 /var/log/aubm-imprimantes.log 2>/dev/null || true
  exit 1
fi

if [[ "$RESET_DATA" -eq 1 ]]; then
  curl -fsS -X POST "http://127.0.0.1:${AUBM_PORT}/api/reset" >/dev/null
  echo "Relevé du 4 juin 2025 rechargé. Le journal a été vidé."
fi

if ! curl -fsS "http://127.0.0.1:${LISTEN_PORT}/api/health" >/dev/null; then
  echo "Nginx ne relaie pas /api/ sur le port ${LISTEN_PORT}." >&2
  exit 1
fi

COUNT="$(curl -fsS "http://127.0.0.1:${AUBM_PORT}/api/printers" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["printers"]))')"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  if [[ "$LISTEN_PORT" == "80" ]]; then
    ufw allow 'Nginx HTTP' || true
  else
    ufw allow "${LISTEN_PORT}/tcp" || true
  fi
fi

ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_SHOWN="$SERVER_NAME"
if [[ "$SERVER_NAME" == "_" ]]; then
  HOST_SHOWN="${ADDRESS:-<adresse-ip>}"
fi
if [[ "$LISTEN_PORT" == "80" ]]; then
  URL="http://${HOST_SHOWN}/"
else
  URL="http://${HOST_SHOWN}:${LISTEN_PORT}/"
fi

cat <<EOF

Parc imprimantes installé.
  Fichiers : ${WEB_ROOT}
  Code et API : ${ROOT}
  Base MySQL : ${AUBM_DB_NAME}
  Compte : ${AUBM_DB_USER}@127.0.0.1 (mot de passe dans ${ENV_FILE})
  Service : aubm-imprimantes
  Site Nginx : ${AVAILABLE}
  Imprimantes en base : ${COUNT}
  Adresse : ${URL}

Les fiches, les toners, les kits et les observations sont dans la base ${AUBM_DB_NAME}.
Les autres bases MySQL du serveur, dont celle de GLPI, ne sont pas modifiées.
Une réinstallation conserve la base. Pour revenir au relevé du 4 juin 2025 :
  sudo ${ROOT}/deploy/install-debian.sh --listen-port ${LISTEN_PORT} --reset-data
EOF
