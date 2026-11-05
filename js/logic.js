export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function readableSupplyName(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const parts = text.replace(/:/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length < 4 || !parts.every((part) => /^[0-9A-Fa-f]{2}$/.test(part))) return text;
  const bytes = parts.map((part) => Number.parseInt(part, 16));
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
  if (bytes.length < 2) return text;
  const raw = Uint8Array.from(bytes);
  let decoded = "";
  const utf16 = raw.length >= 4 && raw.length % 2 === 0 && (raw[0] === 0 || raw[1] === 0);
  if (utf16) {
    const encoding = raw[0] === 0 ? "utf-16be" : "utf-16le";
    decoded = new TextDecoder(encoding).decode(raw);
  } else {
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      decoded = new TextDecoder("iso-8859-1").decode(raw);
    }
  }
  decoded = decoded.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  const letters = decoded.match(/[A-Za-zÀ-ÿ]/g);
  if (!decoded || !letters || letters.length < 2) return text;
  return decoded;
}

export function isLocal(printer) {
  return !printer.adresse || /^(localhost|local)$/i.test(String(printer.adresse).trim());
}

export function isAntenne(printer) {
  return /^A\./i.test(printer.departement || "") || /^Antenne/i.test(printer.emplacement || "");
}

const STANDARD = [
  ["noir", "Noir", "#2b3038"],
  ["cyan", "Cyan", "#0b7c8c"],
  ["magenta", "Magenta", "#b5336b"],
  ["jaune", "Jaune", "#c89208"],
];

export function tonerLevels(printer) {
  if (Array.isArray(printer.cartouches) && printer.cartouches.length) {
    return printer.cartouches
      .filter((item) => item.value !== null && item.value !== undefined && item.value !== "")
      .map((item) => ({
        key: item.key || item.type,
        label: readableSupplyName(item.nom || item.type || item.label || "Cartouche"),
        value: Number(item.value),
        swatch: item.swatch || "#2b3038",
      }));
  }
  const standard = STANDARD
    .filter(([key]) => printer[key] !== null && printer[key] !== undefined && printer[key] !== "")
    .map(([key, label, swatch]) => ({ key, label, value: Number(printer[key]), swatch }));
  const extra = Array.isArray(printer.extra)
    ? printer.extra.map((item) => ({
      key: item.key,
      label: readableSupplyName(item.type || item.label),
      value: Number(item.value),
      swatch: item.swatch || "#2b3038",
    }))
    : [];
  return [...standard, ...extra];
}

export function kitLevels(printer) {
  return (printer.kits || []).filter((kit) => kit.level !== null && kit.level !== undefined && kit.level !== "");
}

export function observationOuverte(printer) {
  const text = (printer.observation || "").trim();
  return text.length > 0 && text.toUpperCase() !== "RAS";
}

export function minLevel(printer) {
  const values = [
    ...tonerLevels(printer).map((item) => item.value),
    ...kitLevels(printer).map((kit) => Number(kit.level)),
  ].filter((value) => !Number.isNaN(value));
  if (!values.length) return null;
  return Math.min(...values);
}

/** critique ≤ 10 % ou observation ouverte ; attention ≤ 30 %. */
export function statut(printer) {
  const levels = tonerLevels(printer);
  const lowest = minLevel(printer);
  if (observationOuverte(printer) || (lowest !== null && lowest <= 10)) return "critique";
  if (!levels.length || (lowest !== null && lowest <= 30)) return "attention";
  return "ok";
}

export function statutLabel(code) {
  if (code === "critique") return "À traiter";
  if (code === "attention") return "À surveiller";
  return "RAS";
}

export function motifs(printer) {
  const items = [];
  if (!tonerLevels(printer).length) items.push("Niveaux non renseignés");
  if (observationOuverte(printer)) items.push(printer.observation.trim());
  for (const level of tonerLevels(printer)) {
    if (level.value <= 30) items.push(`${level.label} ${level.value} %`);
  }
  for (const kit of kitLevels(printer)) {
    if (Number(kit.level) <= 30) items.push(`${kit.label} ${kit.level} %`);
  }
  return items;
}

export function fabricant(printer) {
  const name = printer.nom || "";
  const table = [
    ["HP", "HP"],
    ["Canon", "Canon"],
    ["Konica", "Konica"],
    ["Kyocera", "Kyocera"],
    ["Sharp", "Sharp"],
    ["NRG", "NRG"],
    ["Ricoh", "Ricoh"],
    ["RICOH", "Ricoh"],
    ["Océ", "Océ"],
    ["Oce", "Océ"],
  ];
  for (const [needle, label] of table) {
    if (name.toLowerCase().includes(needle.toLowerCase())) return label;
  }
  return "Autre";
}

export function filtrer(printers, filters) {
  const query = (filters.q || "").trim().toLowerCase();
  return printers.filter((printer) => {
    if (query) {
      const blob = [
        printer.nom,
        printer.departement,
        printer.emplacement,
        printer.adresse,
        printer.observation,
        printer.fourniture,
        fabricant(printer),
      ].join(" ").toLowerCase();
      if (!blob.includes(query)) return false;
    }
    if (filters.dept && printer.departement !== filters.dept) return false;
    if (filters.statut && statut(printer) !== filters.statut) return false;
    if (filters.couleur === "oui" && !printer.couleur) return false;
    if (filters.couleur === "non" && printer.couleur) return false;
    if (filters.lien === "reseau" && isLocal(printer)) return false;
    if (filters.lien === "local" && !isLocal(printer)) return false;
    if (filters.lieu === "antenne" && !isAntenne(printer)) return false;
    if (filters.lieu === "siege" && isAntenne(printer)) return false;
    if (filters.marque && fabricant(printer) !== filters.marque) return false;
    return true;
  });
}

const RANK = { critique: 0, attention: 1, ok: 2 };

export function trier(list, sort) {
  const direction = sort.dir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    let left;
    let right;
    if (sort.key === "statut") {
      left = RANK[statut(a)];
      right = RANK[statut(b)];
    } else if (sort.key === "niveau") {
      left = minLevel(a) ?? 101;
      right = minLevel(b) ?? 101;
    } else {
      left = String(a[sort.key] || "").toLocaleLowerCase("fr");
      right = String(b[sort.key] || "").toLocaleLowerCase("fr");
    }
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    return a.nom.localeCompare(b.nom, "fr");
  });
}

export function parDepartement(printers) {
  const map = new Map();
  for (const printer of printers) {
    const key = printer.departement || "—";
    if (!map.has(key)) map.set(key, { dept: key, total: 0, alertes: 0 });
    const row = map.get(key);
    row.total += 1;
    if (statut(printer) !== "ok") row.alertes += 1;
  }
  return [...map.values()].sort((a, b) => b.alertes - a.alertes || b.total - a.total || a.dept.localeCompare(b.dept, "fr"));
}

export function resume(printers) {
  const counts = { total: printers.length, critique: 0, attention: 0, ok: 0, couleur: 0, local: 0, antenne: 0 };
  for (const printer of printers) {
    counts[statut(printer)] += 1;
    if (printer.couleur) counts.couleur += 1;
    if (isLocal(printer)) counts.local += 1;
    if (isAntenne(printer)) counts.antenne += 1;
  }
  return counts;
}

export function toCsv(printers) {
  const headers = [
    "Nom", "Département", "Emplacement", "Adresse", "Couleur",
    "Noir", "Cyan", "Magenta", "Jaune", "Autres toners", "Fourniture", "Kits",
    "Observation", "État",
  ];
  const lines = [headers.join(";")];
  for (const printer of printers) {
    const extras = printer.cartouches?.length
      ? printer.cartouches
        .filter((item) => !["noir", "cyan", "magenta", "jaune"].includes(item.key))
        .map((item) => `${[item.marque, item.type].filter(Boolean).join(" ")}:${item.value}%`)
        .join(" | ")
      : (printer.extra?.length
        ? printer.extra.map((item) => `${item.label}:${item.value}%`).join(" | ")
        : "");
    const kits = (printer.kits || [])
      .map((kit) => (kit.level === null || kit.level === undefined ? `${kit.label}:OK` : `${kit.label}:${kit.level}%`))
      .join(" | ");
    const cells = [
      printer.nom,
      printer.departement,
      printer.emplacement,
      printer.adresse,
      printer.couleur ? "OUI" : "NON",
      printer.noir ?? "",
      printer.cyan ?? "",
      printer.magenta ?? "",
      printer.jaune ?? "",
      extras,
      printer.fourniture || "",
      kits,
      printer.observation || "",
      statutLabel(statut(printer)),
    ].map(csvCell);
    lines.push(cells.join(";"));
  }
  return `\uFEFF${lines.join("\n")}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[;"\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function formatDate(iso, withTime = false) {
  if (!iso) return "—";
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return date.toLocaleString("fr-FR", {
    timeZone: "Africa/Casablanca",
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}
