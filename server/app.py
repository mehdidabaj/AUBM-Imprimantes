#!/usr/bin/env python3
"""API MySQL du parc d'imprimantes AUBM."""

import json
import logging
import os
import re
import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pymysql
from flask import Flask, jsonify, request
from pymysql.err import IntegrityError, MySQLError
from werkzeug.exceptions import HTTPException

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
}

ID_RE = re.compile(r"[A-Za-z0-9_-]{1,40}")
INSTANT_RE = re.compile(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?")
SWATCH_RE = re.compile(r"#[0-9A-Fa-f]{3,8}")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
app = Flask(__name__)
try:
    app.json.ensure_ascii = False
except AttributeError:
    app.config["JSON_AS_ASCII"] = False


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
             releve, observation, ecart, niveaux_le)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            printer["id"], printer["nom"], printer["departement"], printer["emplacement"],
            printer["adresse"], int(printer["couleur"]), printer["fourniture"],
            printer["releve"], printer["observation"], int(printer["ecart"]),
            printer["niveaux_le"],
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
               ecart = %s, niveaux_le = %s
         WHERE id = %s
        """,
        (
            printer["nom"], printer["departement"], printer["emplacement"], printer["adresse"],
            int(printer["couleur"]), printer["fourniture"], printer["releve"],
            printer["observation"], int(printer["ecart"]), printer["niveaux_le"],
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
               releve, observation, ecart, niveaux_le
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


def seed_if_empty(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM imprimantes")
        if cur.fetchone()["n"]:
            return
        insert_seed(cur)


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


@app.get("/api/printers")
def list_printers():
    def read(conn):
        with conn.cursor() as cur:
            return {"printers": load_printers(cur)}

    return jsonify(run(read))


@app.get("/api/journal")
def list_journal():
    def read(conn):
        with conn.cursor() as cur:
            return {"entries": load_journal(cur)}

    return jsonify(run(read))


@app.post("/api/printers")
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


@app.post("/api/reset")
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
    with connection() as conn:
        seed_if_empty(conn)
    host = os.environ.get("AUBM_BIND", "127.0.0.1")
    port = int(os.environ.get("AUBM_PORT", "8765"))
    app.run(host=host, port=port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
