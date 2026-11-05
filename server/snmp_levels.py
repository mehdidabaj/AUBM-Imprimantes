"""Lecture des toners et des kits via la MIB imprimante (SNMP v2c)."""

import re
import shutil
import subprocess

SUPPLY_PREFIX = ".1.3.6.1.2.1.43.11.1.1."
TONER_TYPES = {3, 5, 6, 7, 12, 13, 21}
KIT_TYPES = {4, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 22}
COLORS = (
    ("noir", ("noir", "black", "schwarz", "nero"), "#2b3038"),
    ("cyan", ("cyan",), "#0b7c8c"),
    ("magenta", ("magenta",), "#b5336b"),
    ("jaune", ("jaune", "yellow", "gelb", "giallo"), "#c89208"),
)
IPV4_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
COMMUNITY_RE = re.compile(r"[A-Za-z0-9_.:@+-]{1,64}")


class SnmpError(Exception):
    pass


def valid_ipv4(value):
    if not value or not IPV4_RE.fullmatch(value):
        return False
    return all(0 <= int(part) <= 255 for part in value.split("."))


def logical_lines(text):
    """Réunit les lignes de continuation d'un Hex-STRING trop long."""
    logical = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        stripped = line.strip()
        continued = line[:1].isspace() or (
            logical and not stripped.startswith(".") and not stripped.startswith("1.3.6.1")
        )
        if continued and logical:
            logical[-1] = f"{logical[-1]} {stripped}"
            continue
        logical.append(stripped)
    return logical


def parse_walk(text):
    rows = {}
    marker = SUPPLY_PREFIX.lstrip(".")
    for line in logical_lines(text):
        position = line.find(marker)
        if position < 0:
            continue
        rest = line[position + len(marker):]
        oid, _, raw = rest.partition(" ")
        column, _, index = oid.partition(".")
        if not column.isdigit() or not index:
            continue
        rows.setdefault(index, {})[int(column)] = decode_value(raw)
    supplies = []
    for index, columns in rows.items():
        kind = columns.get(5)
        if isinstance(kind, str) and kind.isdigit():
            kind = int(kind)
        supplies.append({
            "index": index,
            "type": kind if isinstance(kind, int) else None,
            "description": str(columns.get(6) or "").strip(),
            "maximum": columns.get(8) if isinstance(columns.get(8), int) else None,
            "level": columns.get(9) if isinstance(columns.get(9), int) else None,
        })
    return supplies


def decode_value(raw):
    text = raw.strip()
    text = re.sub(r"^(INTEGER|STRING|Gauge32|Counter32|Unsigned32|Opaque):\s*", "", text)
    if text.startswith("Hex-STRING:"):
        return readable_supply_name(text.split(":", 1)[1]) or ""
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    text = unescape_snmp(unquote(text))
    if looks_like_hex_dump(text):
        return readable_supply_name(text)
    return tidy_name(text)


def unquote(text):
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return text[1:-1]
    return text


def unescape_snmp(text):
    def replace(match):
        token = match.group(1)
        if token == "n":
            return "\n"
        if token == "r":
            return "\r"
        if token == "t":
            return "\t"
        if token in {'"', "\\"}:
            return token
        if re.fullmatch(r"[0-7]{1,3}", token):
            return chr(int(token, 8))
        return token

    return re.sub(r"\\([nrt\"\\]|[0-7]{1,3})", replace, text)


def looks_like_hex_dump(text):
    parts = text.replace(":", " ").split()
    return len(parts) >= 4 and all(re.fullmatch(r"[0-9A-Fa-f]{2}", part) for part in parts)


def readable_supply_name(value):
    """Nom lisible : une chaîne déjà claire, ou un dump hexadécimal SNMP."""
    text = tidy_name("" if value is None else str(value))
    if not looks_like_hex_dump(text):
        return text
    decoded = decode_hex(text)
    letters = re.findall(r"[A-Za-zÀ-ÿ]", decoded)
    if len(letters) < 2:
        return text
    return decoded


def decode_hex(hex_part):
    pieces = re.findall(r"[0-9A-Fa-f]{2}", hex_part)
    if not pieces:
        return ""
    try:
        data = bytes(int(piece, 16) for piece in pieces)
    except ValueError:
        return ""
    return tidy_name(text_from_bytes(data))


def text_from_bytes(data):
    data = data.rstrip(b"\x00")
    if not data:
        return ""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", "replace")
    if _utf16(data):
        encoding = "utf-16-be" if data[0] == 0 else "utf-16-le"
        payload = data[:len(data) - (len(data) % 2)]
        return payload.decode(encoding, "replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    for encoding in ("cp932", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", "replace")


def _utf16(data):
    if len(data) < 4 or len(data) % 2:
        if len(data) < 4:
            return False
    odd = data[1::2].count(0)
    even = data[0::2].count(0)
    return max(odd, even) >= max(2, len(data) // 4)


def tidy_name(text):
    text = text.replace("\x00", "")
    text = text.replace("\u0000", "")
    text = text.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    return re.sub(r"\s+", " ", text).strip()


def percentage(level, maximum):
    if not isinstance(level, int) or level < 0:
        return None
    if isinstance(maximum, int) and maximum > 0:
        return max(0, min(100, round(level * 100 / maximum)))
    if level <= 100:
        return level
    return None


def _contains(text, word):
    return re.search(rf"(^|[^a-z]){re.escape(word)}([^a-z]|$)", text) is not None


def classify(description):
    text = description.casefold()
    for key, words, swatch in COLORS:
        if any(_contains(text, word) for word in words):
            return key, swatch
    return None, "#5b4636"


def looks_like_kit(label):
    text = label.casefold()
    words = ("kit", "fuser", "fusion", "tambour", "drum", "opc", "transfert", "transfer", "courroie", "waste", "develop")
    return any(word in text for word in words)


def named_supplies(supplies):
    """Noms et niveaux tels que l'imprimante les expose, sans les regrouper."""
    cartouches = []
    kits = []
    for item in supplies:
        kind = item.get("type")
        percent = percentage(item.get("level"), item.get("maximum"))
        label = readable_supply_name(item.get("description") or "") or "Consommable"
        if percent is None:
            continue
        if kind in KIT_TYPES or (kind in (None, 1, 2) and looks_like_kit(label)):
            kits.append({"label": label[:160], "level": percent})
            continue
        if kind not in TONER_TYPES and kind not in (None, 1, 2):
            continue
        _color, swatch = classify(label)
        cartouches.append({
            "marque": "",
            "nom": label[:160],
            "type": label[:160],
            "value": percent,
            "swatch": swatch,
        })
    return {"cartouches": cartouches, "kits": kits}


def interpret(supplies, plotter=False):
    channels = {}
    extras = []
    kits = []
    for item in supplies:
        kind = item.get("type")
        percent = percentage(item.get("level"), item.get("maximum"))
        label = readable_supply_name(item.get("description") or "") or "Consommable"
        if percent is None:
            continue
        if kind in KIT_TYPES or (kind in (None, 1, 2) and looks_like_kit(label)):
            kits.append({"label": label[:160], "value": percent})
            continue
        if kind not in TONER_TYPES and kind not in (None, 1, 2):
            continue
        color, swatch = classify(label)
        if color and not plotter and color not in channels:
            channels[color] = percent
            continue
        extras.append({"label": label[:80], "value": percent, "swatch": swatch})
    return {"channels": channels, "extras": extras, "kits": kits}


def apply_reading(printer, reading):
    for key, value in reading["channels"].items():
        printer[key] = value
    extras = [dict(item) for item in (printer.get("extra") or [])]
    for item in reading["extras"]:
        found = next((row for row in extras if str(row.get("label", "")).casefold() == item["label"].casefold()), None)
        if found:
            found["value"] = item["value"]
            continue
        extras.append(item)
    printer["extra"] = extras or None
    kits = [dict(item) for item in (printer.get("kits") or [])]
    for item in reading["kits"]:
        found = next((row for row in kits if str(row.get("label", "")).casefold() == item["label"].casefold()), None)
        if found:
            found["level"] = item["value"]
            continue
        kits.append({"label": item["label"], "level": item["value"]})
    printer["kits"] = kits
    return printer


def query_supplies(host, community):
    if shutil.which("snmpwalk") is None:
        raise SnmpError("Le relevé SNMP n'est pas disponible sur le serveur.")
    try:
        completed = subprocess.run(
            [
                "snmpwalk", "-v2c", "-c", community, "-Oqn", "-t", "2", "-r", "0",
                host, "1.3.6.1.2.1.43.11.1.1",
            ],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SnmpError("L'imprimante ne répond pas au relevé SNMP.") from exc
    if completed.returncode != 0 and not completed.stdout.strip():
        raise SnmpError("L'imprimante ne répond pas au relevé SNMP. Vérifiez l'adresse IP et la communauté.")
    supplies = parse_walk(completed.stdout)
    if not supplies:
        raise SnmpError("Aucun consommable n'a été lu sur cette imprimante.")
    return supplies
