#!/usr/bin/env python3
"""API MySQL du parc d'imprimantes AUBM."""

import json
import logging
import os
import re
import secrets
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pymysql
from flask import Flask, jsonify, request, session
from pymysql.err import IntegrityError, MySQLError
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

from snmp_levels import (
    COMMUNITY_RE,
    SnmpError,
    apply_reading,
    interpret,
    query_supplies,
    valid_ipv4,
)

ROOT = Path(__file__).resolve().parent
SEED_PATH = ROOT / "seed.json"

STANDARD = (
    ("noir", "Noir", "#2b3038"),
    ("cyan", "Cyan", "#0b7c8c"),
    ("magenta", "Magenta", "#b5336b"),
    ("jaune", "Jaune", "#c89208"),
)

JOURNAL_TYPES = {
    "mise-a-jour": "Mise à jour de la fiche",
    "creation": "Ajout au parc",
    "toner-noir": "Remplacement toner noir",
    "toner-cyan": "Remplacement toner cyan",
    "toner-magenta": "Remplacement toner magenta",
    "toner-jaune": "Remplacement toner jaune",
    "kit": "Remplacement de kit",
    "photoconducteur": "Remplacement de l'unité photoconductrice",
    "autre": "Autre intervention",
    "suppression": "Retrait du parc",
    "releve-snmp": "Relevé des niveaux",
}

ID_RE = re.compile(r"[A-Za-z0-9_-]{1,40}")
USER_RE = re.compile(r"[a-z0-9][a-z0-9._-]{2,79}")
ROLES = {"admin", "consultation"}
INSTANT_RE = re.compile(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?")
SWATCH_RE = re.compile(r"#[0-9A-Fa-f]{3,8}")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
app = Flask(__name__)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)
try:
    app.json.ensure_ascii = False
except AttributeError:
    app.config["JSON_AS_ASCII"] = False


def configure_session():
    secret = os.environ.get("AUBM_SECRET", "")
    if secret:
        app.secret_key = secret


configure_session()


class ApiError(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def connect():
    return pymysql.connect(
        host=os.environ.get("AUBM_DB_HOST", "127.0.0.1"),
        user=os.environ.get("AUBM_DB_USER", "aubm"),
        password=os.environ.get("AUBM_DB_PASSWORD", ""),
        database=os.environ.get("AUBM_DB_NAME", "aubm_imprimantes"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
        connect_timeout=5,
    )


@contextmanager
def connection():
    try:
        conn = connect()
    except MySQLError as exc:
        app.logger.exception("connexion MySQL")
        raise ApiError("La base MySQL est indisponible.", 503) from exc
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def run(fn):
    try:
        with connection() as conn:
            return fn(conn)
    except ApiError:
        raise
    except IntegrityError as exc:
        raise ApiError("Cette imprimante existe déjà.", 409) from exc
    except MySQLError as exc:
        app.logger.exception("requête MySQL")
        raise ApiError("La base MySQL a refusé l'opération.", 500) from exc


def clean_text(value, limit, required=False, field="Champ"):
    text = "" if value is None else str(value).strip()
    if required and not text:
        raise ApiError(f"{field} est obligatoire.", 400)
    if len(text) > limit:
        raise ApiError(f"{field} est trop long.", 400)
    return text


def percent(value, required=False):
    if value is None or value == "":
        if required:
            raise ApiError("Pourcentage manquant.", 400)
        return None
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError) as exc:
        raise ApiError("Pourcentage invalide.", 400) from exc
    if number < 0 or number > 100:
        raise ApiError("Un pourcentage doit rester entre 0 et 100.", 400)
    return number


def clean_community(value):
    community = clean_text(value, 64) or "public"
    if not COMMUNITY_RE.fullmatch(community):
        raise ApiError("Communauté SNMP invalide.", 400)
    return community


def clean_instant(value):
    if value is None or value == "":
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    text = str(value).strip()
    if INSTANT_RE.fullmatch(text):
        return text
    raise ApiError("Date de relevé invalide.", 400)


def normalize(raw, forced_id=None):
    if not isinstance(raw, dict):
        raise ApiError("Fiche invalide.", 400)
    printer_id = forced_id if forced_id is not None else raw.get("id")
    if not printer_id:
        printer_id = f"imp-{secrets.token_hex(4)}"
    printer_id = clean_text(printer_id, 40, True, "Identifiant")
    if not ID_RE.fullmatch(printer_id):
        raise ApiError("Identifiant invalide.", 400)

    adresse = clean_text(raw.get("adresse"), 80) or "Localhost"
    printer = {
        "id": printer_id,
        "nom": clean_text(raw.get("nom"), 160, True, "Le nom"),
        "departement": clean_text(raw.get("departement"), 80, True, "Le département"),
        "emplacement": clean_text(raw.get("emplacement"), 160, True, "L'emplacement"),
        "adresse": adresse,
        "couleur": raw.get("couleur") in (True, 1, "1", "on"),
        "fourniture": clean_text(raw.get("fourniture"), 80),
        "releve": clean_text(raw.get("releve"), 4000),
        "observation": clean_text(raw.get("observation"), 2000) or "RAS",
        "ecart": bool(raw.get("ecart")),
        "niveaux_le": clean_instant(raw.get("niveauxLe")),
        "snmp_communaute": clean_community(raw.get("snmpCommunaute")),
    }

    extra = raw.get("extra") or []
    if not isinstance(extra, list) or len(extra) > 20:
        raise ApiError("Liste de toners invalide.", 400)
    toners = []
    seen = set()
    for index, (key, label, swatch) in enumerate(STANDARD):
        value = percent(raw.get(key))
        if value is None:
            continue
        seen.add(key)
        toners.append({
            "cle": key,
            "libelle": label,
            "pourcentage": value,
            "swatch": swatch,
            "extra": 0,
            "ordre": index,
        })
    for index, item in enumerate(extra):
        if not isinstance(item, dict):
            raise ApiError("Toner invalide.", 400)
        key = clean_text(item.get("key"), 40, True, "Le toner")
        if not ID_RE.fullmatch(key) or key in seen:
            raise ApiError("Canal de toner invalide.", 400)
        seen.add(key)
        swatch = clean_text(item.get("swatch"), 20) or "#2b3038"
        if not SWATCH_RE.fullmatch(swatch):
            swatch = "#2b3038"
        toners.append({
            "cle": key,
            "libelle": clean_text(item.get("label"), 80, True, "Le toner"),
            "pourcentage": percent(item.get("value"), required=True),
            "swatch": swatch,
            "extra": 1,
            "ordre": 10 + index,
        })

    kits_raw = raw.get("kits") or []
    if not isinstance(kits_raw, list) or len(kits_raw) > 30:
        raise ApiError("Liste de kits invalide.", 400)
    kits = []
    for index, kit in enumerate(kits_raw):
        if not isinstance(kit, dict):
            raise ApiError("Kit invalide.", 400)
        label = clean_text(kit.get("label"), 160, True, "Le kit")
        kits.append({
            "libelle": label,
            "pourcentage": percent(kit.get("level")),
            "ordre": index,
        })
    printer["toners"] = toners
    printer["kits"] = kits
    return printer


def journal_from_client(raw, printer):
    raw = raw or {}
    if not isinstance(raw, dict):
        raise ApiError("Journal invalide.", 400)
    kind = clean_text(raw.get("type"), 40, True, "Le type")
    if kind not in JOURNAL_TYPES or kind == "suppression":
        raise ApiError("Type d'intervention invalide.", 400)
    detail = clean_text(raw.get("detail"), 2000) or "Intervention enregistrée."
    return {
        "imprimante_id": printer["id"],
        "imprimante_nom": printer["nom"],
        "type": kind,
        "type_label": JOURNAL_TYPES[kind],
        "detail": detail,
    }


def insert_printer(cur, printer):
    cur.execute(
        """
        INSERT INTO imprimantes
            (id, nom, departement, emplacement, adresse, couleur, fourniture,
             releve, observation, ecart, snmp_communaute, niveaux_le)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            printer["id"], printer["nom"], printer["departement"], printer["emplacement"],
            printer["adresse"], int(printer["couleur"]), printer["fourniture"],
            printer["releve"], printer["observation"], int(printer["ecart"]),
            printer.get("snmp_communaute") or "public", printer["niveaux_le"],
        ),
    )
    insert_children(cur, printer)


def update_printer(cur, printer):
    cur.execute("SELECT id FROM imprimantes WHERE id = %s FOR UPDATE", (printer["id"],))
    if not cur.fetchone():
        raise ApiError("Imprimante introuvable.", 404)
    cur.execute(
        """
        UPDATE imprimantes
           SET nom = %s, departement = %s, emplacement = %s, adresse = %s,
               couleur = %s, fourniture = %s, releve = %s, observation = %s,
               ecart = %s, snmp_communaute = %s, niveaux_le = %s
         WHERE id = %s
        """,
        (
            printer["nom"], printer["departement"], printer["emplacement"], printer["adresse"],
            int(printer["couleur"]), printer["fourniture"], printer["releve"],
            printer["observation"], int(printer["ecart"]),
            printer.get("snmp_communaute") or "public", printer["niveaux_le"],
            printer["id"],
        ),
    )
    cur.execute("DELETE FROM toners WHERE imprimante_id = %s", (printer["id"],))
    cur.execute("DELETE FROM kits WHERE imprimante_id = %s", (printer["id"],))
    insert_children(cur, printer)


def insert_children(cur, printer):
    for toner in printer["toners"]:
        cur.execute(
            """
            INSERT INTO toners
                (imprimante_id, cle, libelle, pourcentage, swatch, extra, ordre)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                printer["id"], toner["cle"], toner["libelle"], toner["pourcentage"],
                toner["swatch"], toner["extra"], toner["ordre"],
            ),
        )
    for kit in printer["kits"]:
        cur.execute(
            """
            INSERT INTO kits (imprimante_id, libelle, pourcentage, ordre)
            VALUES (%s, %s, %s, %s)
            """,
            (printer["id"], kit["libelle"], kit["pourcentage"], kit["ordre"]),
        )


def insert_journal(cur, entry):
    cur.execute(
        """
        INSERT INTO journal (imprimante_id, imprimante_nom, type, type_label, detail, created_at)
        VALUES (%s, %s, %s, %s, %s, UTC_TIMESTAMP(3))
        """,
        (
            entry["imprimante_id"], entry["imprimante_nom"], entry["type"],
            entry["type_label"], entry["detail"],
        ),
    )
    return cur.lastrowid


def to_iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return str(value)


def load_printers(cur):
    cur.execute(
        """
        SELECT id, nom, departement, emplacement, adresse, couleur, fourniture,
               releve, observation, ecart, snmp_communaute, niveaux_le
          FROM imprimantes
         ORDER BY nom, emplacement, id
        """
    )
    rows = cur.fetchall()
    cur.execute(
        """
        SELECT imprimante_id, cle, libelle, pourcentage, swatch, extra, ordre
          FROM toners
         ORDER BY imprimante_id, ordre, id
        """
    )
    toners = {}
    for row in cur.fetchall():
        toners.setdefault(row["imprimante_id"], []).append(row)
    cur.execute(
        """
        SELECT imprimante_id, libelle, pourcentage, ordre
          FROM kits
         ORDER BY imprimante_id, ordre, id
        """
    )
    kits = {}
    for row in cur.fetchall():
        kits.setdefault(row["imprimante_id"], []).append(row)
    return [assemble(row, toners.get(row["id"], []), kits.get(row["id"], [])) for row in rows]


def load_one(cur, printer_id):
    for printer in load_printers(cur):
        if printer["id"] == printer_id:
            return printer
    raise ApiError("Imprimante introuvable.", 404)


def assemble(row, toners, kits):
    printer = {
        "id": row["id"],
        "nom": row["nom"],
        "departement": row["departement"],
        "emplacement": row["emplacement"],
        "adresse": row["adresse"],
        "couleur": bool(row["couleur"]),
        "fourniture": row["fourniture"] or "",
        "releve": row["releve"] or "",
        "observation": row["observation"] or "",
        "niveauxLe": row["niveaux_le"],
        "snmpCommunaute": row.get("snmp_communaute") or "public",
        "kits": [{"label": kit["libelle"], "level": kit["pourcentage"]} for kit in kits],
    }
    if row["ecart"]:
        printer["ecart"] = True
    by_key = {toner["cle"]: toner["pourcentage"] for toner in toners if not toner["extra"]}
    for key, _label, _swatch in STANDARD:
        printer[key] = by_key.get(key)
    extra_rows = [toner for toner in toners if toner["extra"]]
    printer["extra"] = [
        {
            "key": toner["cle"],
            "label": toner["libelle"],
            "value": toner["pourcentage"],
            "swatch": toner["swatch"] or "#2b3038",
        }
        for toner in extra_rows
    ] or None
    return printer


def load_journal(cur, limit=500):
    cur.execute(
        """
        SELECT id, imprimante_id, imprimante_nom, type, type_label, detail, created_at
          FROM journal
         ORDER BY id DESC
         LIMIT %s
        """,
        (int(limit),),
    )
    return [journal_entry(row) for row in cur.fetchall()]


def load_journal_one(cur, entry_id):
    cur.execute(
        """
        SELECT id, imprimante_id, imprimante_nom, type, type_label, detail, created_at
          FROM journal
         WHERE id = %s
        """,
        (entry_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ApiError("Entrée de journal introuvable.", 500)
    return journal_entry(row)


def journal_entry(row):
    return {
        "id": row["id"],
        "at": to_iso(row["created_at"]),
        "printerId": row["imprimante_id"],
        "printerNom": row["imprimante_nom"],
        "type": row["type"],
        "typeLabel": row["type_label"],
        "detail": row["detail"],
    }


def load_seed():
    try:
        data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ApiError("Le relevé initial est illisible.", 500) from exc
    if not isinstance(data, list) or not data:
        raise ApiError("Le relevé initial est vide.", 500)
    return data


def insert_seed(cur):
    for raw in load_seed():
        insert_printer(cur, normalize(raw))


def sync_places(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT departement, emplacement FROM imprimantes")
        for pair in cur.fetchall():
            departement = (pair["departement"] or "").strip()
            emplacement = (pair["emplacement"] or "").strip()
            if not departement:
                continue
            cur.execute("INSERT IGNORE INTO departements (nom) VALUES (%s)", (departement,))
            cur.execute("SELECT id FROM departements WHERE nom = %s", (departement,))
            departement_id = cur.fetchone()["id"]
            if emplacement:
                cur.execute(
                    "INSERT IGNORE INTO emplacements (departement_id, nom) VALUES (%s, %s)",
                    (departement_id, emplacement),
                )


def load_places(cur):
    cur.execute("SELECT id, nom FROM departements ORDER BY nom")
    departements = []
    for departement in cur.fetchall():
        cur.execute(
            "SELECT id, nom FROM emplacements WHERE departement_id = %s ORDER BY nom",
            (departement["id"],),
        )
        departements.append({
            "id": departement["id"],
            "nom": departement["nom"],
            "emplacements": [{"id": row["id"], "nom": row["nom"]} for row in cur.fetchall()],
        })
    return departements


def seed_if_empty(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM imprimantes")
        if cur.fetchone()["n"]:
            return
        insert_seed(cur)


def public_user(row):
    return {
        "id": row["id"],
        "identifiant": row["identifiant"],
        "nom": row["nom"],
        "role": row["role"],
        "actif": bool(row["actif"]),
    }


def session_user(conn):
    user_id = session.get("user_id")
    if not user_id:
        return None
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, identifiant, nom, role, actif FROM utilisateurs WHERE id = %s",
            (user_id,),
        )
        row = cur.fetchone()
    if not row or not row["actif"]:
        session.clear()
        return None
    return row


def require_user():
    def read(conn):
        return session_user(conn)

    user = run(read)
    if not user:
        raise ApiError("Connexion requise.", 401)
    return user


def require_admin():
    user = require_user()
    if user["role"] != "admin":
        raise ApiError("Cette action est réservée aux administrateurs.", 403)
    return user


def guarded(admin=False):
    def decorator(fn):
        def wrapped(*args, **kwargs):
            if admin:
                require_admin()
            else:
                require_user()
            return fn(*args, **kwargs)

        wrapped.__name__ = fn.__name__
        return wrapped

    return decorator


def clean_role(value):
    role = clean_text(value, 20, True, "Le profil")
    if role not in ROLES:
        raise ApiError("Profil invalide.", 400)
    return role


def clean_login(value):
    identifiant = clean_text(value, 80, True, "L'identifiant").lower()
    if not USER_RE.fullmatch(identifiant):
        raise ApiError("L'identifiant doit contenir au moins 3 lettres ou chiffres.", 400)
    return identifiant


def clean_password(value, required=False):
    password = "" if value is None else str(value)
    if not password:
        if required:
            raise ApiError("Le mot de passe est obligatoire.", 400)
        return ""
    if len(password) < 8 or len(password) > 200:
        raise ApiError("Le mot de passe doit contenir au moins 8 caractères.", 400)
    return password


def ensure_admin(conn):
    username = clean_login(os.environ.get("AUBM_ADMIN_USER", "admin"))
    password = os.environ.get("AUBM_ADMIN_PASSWORD", "")
    if len(password) < 8:
        raise ApiError("AUBM_ADMIN_PASSWORD est absent.", 500)
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM utilisateurs")
        if cur.fetchone()["n"]:
            return
        cur.execute(
            """
            INSERT INTO utilisateurs (identifiant, nom, mot_de_passe, role, actif)
            VALUES (%s, %s, %s, 'admin', 1)
            """,
            (username, "Administrateur", generate_password_hash(password)),
        )


def payload():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Requête invalide.", 400)
    return data


@app.after_request
def no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/health")
def health():
    def check(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT 1 AS ok")
            cur.fetchone()
        return {"ok": True, "database": "mysql"}

    return jsonify(run(check))


@app.post("/api/login")
def login():
    body = payload()
    identifiant = clean_login(body.get("identifiant"))
    password = "" if body.get("motDePasse") is None else str(body.get("motDePasse"))

    def read(conn):
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, identifiant, nom, role, actif, mot_de_passe
                  FROM utilisateurs
                 WHERE identifiant = %s
                """,
                (identifiant,),
            )
            return cur.fetchone()

    row = run(read)
    if not row or not row["actif"] or not check_password_hash(row["mot_de_passe"], password):
        raise ApiError("Identifiant ou mot de passe incorrect.", 401)
    session.clear()
    session["user_id"] = row["id"]
    session.permanent = True
    return jsonify(public_user(row))


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def me():
    return jsonify(public_user(require_user()))


@app.get("/api/users")
@guarded(admin=True)
def list_users():
    def read(conn):
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, identifiant, nom, role, actif
                  FROM utilisateurs
                 ORDER BY nom, identifiant
                """
            )
            return {"users": [public_user(row) for row in cur.fetchall()]}

    return jsonify(run(read))


@app.post("/api/users")
@guarded(admin=True)
def create_user():
    body = payload()
    identifiant = clean_login(body.get("identifiant"))
    nom = clean_text(body.get("nom"), 160, True, "Le nom")
    role = clean_role(body.get("role"))
    password = clean_password(body.get("motDePasse"), required=True)

    def write(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM utilisateurs WHERE identifiant = %s", (identifiant,))
            if cur.fetchone():
                raise ApiError("Cet identifiant est déjà utilisé.", 409)
            cur.execute(
                """
                INSERT INTO utilisateurs (identifiant, nom, mot_de_passe, role, actif)
                VALUES (%s, %s, %s, %s, 1)
                """,
                (identifiant, nom, generate_password_hash(password), role),
            )
            cur.execute(
                "SELECT id, identifiant, nom, role, actif FROM utilisateurs WHERE id = %s",
                (cur.lastrowid,),
            )
            return {"user": public_user(cur.fetchone())}

    return jsonify(run(write)), 201


@app.put("/api/users/<int:user_id>")
@guarded(admin=True)
def update_user(user_id):
    body = payload()
    nom = clean_text(body.get("nom"), 160, True, "Le nom")
    role = clean_role(body.get("role"))
    actif = body.get("actif") in (True, 1, "1", "on")
    password = clean_password(body.get("motDePasse"), required=False)
    if session.get("user_id") == user_id and not actif:
        raise ApiError("Vous ne pouvez pas désactiver votre propre compte.", 400)

    def write(conn):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, role, actif FROM utilisateurs WHERE id = %s FOR UPDATE",
                (user_id,),
            )
            current = cur.fetchone()
            if not current:
                raise ApiError("Compte introuvable.", 404)
            loses_admin = current["role"] == "admin" and current["actif"] and not (role == "admin" and actif)
            if loses_admin:
                cur.execute(
                    """
                    SELECT COUNT(*) AS n
                      FROM utilisateurs
                     WHERE role = 'admin' AND actif = 1 AND id <> %s
                    """,
                    (user_id,),
                )
                if cur.fetchone()["n"] == 0:
                    raise ApiError("Le dernier administrateur actif doit rester en place.", 400)
            if password:
                cur.execute(
                    """
                    UPDATE utilisateurs
                       SET nom = %s, role = %s, actif = %s, mot_de_passe = %s
                     WHERE id = %s
                    """,
                    (nom, role, int(actif), generate_password_hash(password), user_id),
                )
            else:
                cur.execute(
                    "UPDATE utilisateurs SET nom = %s, role = %s, actif = %s WHERE id = %s",
                    (nom, role, int(actif), user_id),
                )
            cur.execute(
                "SELECT id, identifiant, nom, role, actif FROM utilisateurs WHERE id = %s",
                (user_id,),
            )
            return {"user": public_user(cur.fetchone())}

    return jsonify(run(write))


@app.get("/api/printers")
@guarded()
def list_printers():
    def read(conn):
        with conn.cursor() as cur:
            return {"printers": load_printers(cur)}

    return jsonify(run(read))


@app.get("/api/journal")
@guarded()
def list_journal():
    def read(conn):
        with conn.cursor() as cur:
            return {"entries": load_journal(cur)}

    return jsonify(run(read))


@app.post("/api/printers")
@guarded(admin=True)
def create_printer():
    body = payload()
    printer = normalize(body.get("printer") or {})
    entry = journal_from_client(body.get("journal"), printer)
    if entry["type"] == "mise-a-jour":
        entry["type"] = "creation"
        entry["type_label"] = JOURNAL_TYPES["creation"]

    def write(conn):
        with conn.cursor() as cur:
            insert_printer(cur, printer)
            entry_id = insert_journal(cur, entry)
            return {"printer": load_one(cur, printer["id"]), "entry": load_journal_one(cur, entry_id)}

    return jsonify(run(write)), 201


@app.put("/api/printers/<printer_id>")
@guarded(admin=True)
def update_printer_route(printer_id):
    body = payload()
    printer = normalize(body.get("printer") or {}, forced_id=printer_id)
    entry = journal_from_client(body.get("journal"), printer)

    def write(conn):
        with conn.cursor() as cur:
            update_printer(cur, printer)
            entry_id = insert_journal(cur, entry)
            return {"printer": load_one(cur, printer["id"]), "entry": load_journal_one(cur, entry_id)}

    return jsonify(run(write))


@app.delete("/api/printers/<printer_id>")
@guarded(admin=True)
def delete_printer(printer_id):
    printer_id = clean_text(printer_id, 40, True, "Identifiant")
    if not ID_RE.fullmatch(printer_id):
        raise ApiError("Identifiant invalide.", 400)

    def write(conn):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, nom, emplacement FROM imprimantes WHERE id = %s FOR UPDATE",
                (printer_id,),
            )
            row = cur.fetchone()
            if not row:
                raise ApiError("Imprimante introuvable.", 404)
            entry = {
                "imprimante_id": row["id"],
                "imprimante_nom": row["nom"],
                "type": "suppression",
                "type_label": JOURNAL_TYPES["suppression"],
                "detail": row["emplacement"],
            }
            cur.execute("DELETE FROM imprimantes WHERE id = %s", (printer_id,))
            entry_id = insert_journal(cur, entry)
            return {"entry": load_journal_one(cur, entry_id)}

    return jsonify(run(write))


@app.get("/api/places")
@guarded()
def list_places():
    def read(conn):
        with conn.cursor() as cur:
            return {"departements": load_places(cur)}

    return jsonify(run(read))


@app.post("/api/departements")
@guarded(admin=True)
def create_departement():
    nom = clean_text(payload().get("nom"), 80, True, "Le département")

    def write(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM departements WHERE nom = %s", (nom,))
            if cur.fetchone():
                raise ApiError("Ce département existe déjà.", 409)
            cur.execute("INSERT INTO departements (nom) VALUES (%s)", (nom,))
            return {"departements": load_places(cur)}

    return jsonify(run(write)), 201


@app.put("/api/departements/<int:departement_id>")
@guarded(admin=True)
def update_departement(departement_id):
    nom = clean_text(payload().get("nom"), 80, True, "Le département")

    def write(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT id, nom FROM departements WHERE id = %s FOR UPDATE", (departement_id,))
            current = cur.fetchone()
            if not current:
                raise ApiError("Département introuvable.", 404)
            cur.execute("SELECT id FROM departements WHERE nom = %s AND id <> %s", (nom, departement_id))
            if cur.fetchone():
                raise ApiError("Ce département existe déjà.", 409)
            cur.execute("UPDATE departements SET nom = %s WHERE id = %s", (nom, departement_id))
            if current["nom"] != nom:
                cur.execute(
                    "UPDATE imprimantes SET departement = %s WHERE departement = %s",
                    (nom, current["nom"]),
                )
            return {"departements": load_places(cur)}

    return jsonify(run(write))


@app.delete("/api/departements/<int:departement_id>")
@guarded(admin=True)
def delete_departement(departement_id):
    def write(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT nom FROM departements WHERE id = %s FOR UPDATE", (departement_id,))
            current = cur.fetchone()
            if not current:
                raise ApiError("Département introuvable.", 404)
            cur.execute("SELECT COUNT(*) AS n FROM imprimantes WHERE departement = %s", (current["nom"],))
            if cur.fetchone()["n"]:
                raise ApiError("Ce département est encore utilisé par une imprimante.", 409)
            cur.execute("DELETE FROM departements WHERE id = %s", (departement_id,))
            return {"departements": load_places(cur)}

    return jsonify(run(write))


@app.post("/api/emplacements")
@guarded(admin=True)
def create_emplacement():
    body = payload()
    nom = clean_text(body.get("nom"), 160, True, "L'emplacement")
    try:
        departement_id = int(body.get("departementId"))
    except (TypeError, ValueError):
        raise ApiError("Le département est obligatoire.", 400) from None

    def write(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM departements WHERE id = %s", (departement_id,))
            if not cur.fetchone():
                raise ApiError("Département introuvable.", 404)
            cur.execute(
                "SELECT id FROM emplacements WHERE departement_id = %s AND nom = %s",
                (departement_id, nom),
            )
            if cur.fetchone():
                raise ApiError("Cet emplacement existe déjà pour ce département.", 409)
            cur.execute(
                "INSERT INTO emplacements (departement_id, nom) VALUES (%s, %s)",
                (departement_id, nom),
            )
            return {"departements": load_places(cur)}

    return jsonify(run(write)), 201


@app.put("/api/emplacements/<int:emplacement_id>")
@guarded(admin=True)
def update_emplacement(emplacement_id):
    nom = clean_text(payload().get("nom"), 160, True, "L'emplacement")

    def write(conn):
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT emplacements.id, emplacements.nom, departements.nom AS departement
                  FROM emplacements
                  JOIN departements ON departements.id = emplacements.departement_id
                 WHERE emplacements.id = %s
                 FOR UPDATE
                """,
                (emplacement_id,),
            )
            current = cur.fetchone()
            if not current:
                raise ApiError("Emplacement introuvable.", 404)
            cur.execute(
                """
                SELECT id FROM emplacements
                 WHERE departement_id = (SELECT departement_id FROM emplacements WHERE id = %s)
                   AND nom = %s AND id <> %s
                """,
                (emplacement_id, nom, emplacement_id),
            )
            if cur.fetchone():
                raise ApiError("Cet emplacement existe déjà pour ce département.", 409)
            cur.execute("UPDATE emplacements SET nom = %s WHERE id = %s", (nom, emplacement_id))
            if current["nom"] != nom:
                cur.execute(
                    """
                    UPDATE imprimantes
                       SET emplacement = %s
                     WHERE departement = %s AND emplacement = %s
                    """,
                    (nom, current["departement"], current["nom"]),
                )
            return {"departements": load_places(cur)}

    return jsonify(run(write))


@app.delete("/api/emplacements/<int:emplacement_id>")
@guarded(admin=True)
def delete_emplacement(emplacement_id):
    def write(conn):
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT emplacements.nom, departements.nom AS departement
                  FROM emplacements
                  JOIN departements ON departements.id = emplacements.departement_id
                 WHERE emplacements.id = %s
                 FOR UPDATE
                """,
                (emplacement_id,),
            )
            current = cur.fetchone()
            if not current:
                raise ApiError("Emplacement introuvable.", 404)
            cur.execute(
                """
                SELECT COUNT(*) AS n FROM imprimantes
                 WHERE departement = %s AND emplacement = %s
                """,
                (current["departement"], current["nom"]),
            )
            if cur.fetchone()["n"]:
                raise ApiError("Cet emplacement est encore utilisé par une imprimante.", 409)
            cur.execute("DELETE FROM emplacements WHERE id = %s", (emplacement_id,))
            return {"departements": load_places(cur)}

    return jsonify(run(write))


@app.post("/api/printers/<printer_id>/relever")
@guarded(admin=True)
def relever_printer(printer_id):
    printer_id = clean_text(printer_id, 40, True, "Identifiant")
    if not ID_RE.fullmatch(printer_id):
        raise ApiError("Identifiant invalide.", 400)
    body = payload()

    def write(conn):
        with conn.cursor() as cur:
            current = load_one(cur, printer_id)
            address = clean_text(body.get("adresse"), 80) or current["adresse"]
            if not valid_ipv4(address):
                raise ApiError("Indiquez une adresse IPv4 pour lire les niveaux.", 400)
            community = clean_community(body.get("communaute") or current.get("snmpCommunaute"))
            try:
                supplies = query_supplies(address, community)
            except SnmpError as exc:
                raise ApiError(str(exc), 502) from exc
            fixed = [
                item for item in (current.get("extra") or [])
                if not str(item.get("key") or "").startswith("ton-")
            ]
            plotter = bool(fixed) and all(current.get(key) is None for key in ("noir", "cyan", "magenta", "jaune"))
            reading = interpret(supplies, plotter=plotter)
            if not reading["channels"] and not reading["extras"] and not reading["kits"]:
                raise ApiError("Les niveaux lus ne sont pas chiffrés.", 502)
            apply_reading(current, reading)
            for item in current.get("extra") or []:
                if not item.get("key"):
                    item["key"] = f"ton-{secrets.token_hex(4)}"
            current["adresse"] = address
            current["snmpCommunaute"] = community
            current["niveauxLe"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            stored = normalize(current, forced_id=printer_id)
            update_printer(cur, stored)
            parts = []
            if reading["channels"] or reading["extras"]:
                parts.append(f"{len(reading['channels']) + len(reading['extras'])} toner(s)")
            if reading["kits"]:
                parts.append(f"{len(reading['kits'])} kit(s)")
            entry = {
                "imprimante_id": printer_id,
                "imprimante_nom": current["nom"],
                "type": "releve-snmp",
                "type_label": JOURNAL_TYPES["releve-snmp"],
                "detail": f"{address} · {', '.join(parts)}",
            }
            entry_id = insert_journal(cur, entry)
            return {
                "printer": load_one(cur, printer_id),
                "entry": load_journal_one(cur, entry_id),
                "message": "Niveaux lus sur l'imprimante.",
            }

    return jsonify(run(write))


@app.post("/api/reset")
@guarded(admin=True)
def reset():
    def write(conn):
        with conn.cursor() as cur:
            cur.execute("DELETE FROM journal")
            cur.execute("DELETE FROM imprimantes")
            insert_seed(cur)
            return {"printers": load_printers(cur), "entries": []}

    return jsonify(run(write))


@app.errorhandler(ApiError)
def handle_api(err):
    return jsonify(error=str(err)), err.status


@app.errorhandler(Exception)
def handle_unexpected(err):
    if isinstance(err, HTTPException):
        return err
    app.logger.exception("erreur API")
    return jsonify(error="Erreur interne du serveur."), 500


def main():
    if not os.environ.get("AUBM_DB_PASSWORD"):
        raise SystemExit("AUBM_DB_PASSWORD est absent.")
    if not os.environ.get("AUBM_SECRET"):
        raise SystemExit("AUBM_SECRET est absent.")
    if not os.environ.get("AUBM_ADMIN_PASSWORD"):
        raise SystemExit("AUBM_ADMIN_PASSWORD est absent.")
    configure_session()
    try:
        with connection() as conn:
            seed_if_empty(conn)
            sync_places(conn)
            ensure_admin(conn)
    except ApiError as exc:
        raise SystemExit(str(exc)) from exc
    host = os.environ.get("AUBM_BIND", "127.0.0.1")
    port = int(os.environ.get("AUBM_PORT", "8765"))
    app.run(host=host, port=port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
