import assert from "node:assert/strict";
import {
  EXPORT_HEADERS,
  esc,
  exportCells,
  filtrer,
  formatDateCourt,
  minLevel,
  readableSupplyName,
  resume,
  safeSwatch,
  statut,
  statutLabel,
  toCsv,
  tonerLevels,
  trier,
} from "../js/logic.js";
import { buildPdf } from "../js/pdf.js";

const machine = (overrides = {}) => ({
  nom: "HP LaserJet",
  departement: "Urbanisme",
  emplacement: "Bureau 2",
  adresse: "10.1.1.20",
  observation: "RAS",
  couleur: false,
  kits: [],
  noir: 80,
  cyan: null,
  magenta: null,
  jaune: null,
  ...overrides,
});

assert.equal(statut(machine()), "ok");
assert.equal(statut(machine({ noir: 25 })), "attention", "toner à 25 %");
assert.equal(statut(machine({ noir: 10 })), "critique", "seuil de 10 %");
assert.equal(statut(machine({ observation: "photoconducteur à remplacer" })), "critique");
assert.equal(statut(machine({ noir: null, observation: "RAS" })), "attention", "aucun niveau");
assert.equal(statut(machine({ extra: [{ key: "gris", label: "Gris", value: 8, swatch: "#888" }] })), "critique");

assert.equal(minLevel(machine({ noir: 40, kits: [{ label: "Kit", level: 12 }] })), 12);
assert.equal(tonerLevels(machine({ noir: 40, cyan: null })).length, 1);

const parc = [
  machine({ nom: "HP M552", departement: "A. KH", adresse: "localhost", couleur: true }),
  machine({ nom: "Canon", departement: "Urbanisme" }),
  machine({ nom: "Kyocera", departement: "A. KH", adresse: "10.0.0.4", noir: 5, observation: "RAS" }),
];
assert.equal(filtrer(parc, { q: "m552" }).length, 1);
assert.equal(filtrer(parc, { dept: "A. KH" }).length, 2);
assert.equal(filtrer(parc, { lien: "local" }).length, 1);
assert.equal(filtrer(parc, { statut: "critique" }).length, 1);
assert.equal(filtrer(parc, { couleur: "oui" }).length, 1);
assert.equal(filtrer(parc, { lieu: "antenne" }).length, 2);

const counts = resume(parc);
assert.equal(counts.total, 3);
assert.equal(counts.critique + counts.attention + counts.ok, 3);

const ordered = trier(parc, { key: "statut", dir: "asc" });
assert.equal(statut(ordered[0]), "critique");

assert.deepEqual(EXPORT_HEADERS, [
  "imprimante",
  "Departement-Emplacement",
  "Adresse",
  "Toners",
  "Kits",
  "Observations",
  "Etat",
]);

const cells = exportCells(machine({
  kits: [{ label: "Tambour", level: "" }, { label: "Fusion", level: 40 }],
}));
assert.equal(cells[0], "HP LaserJet");
assert.equal(cells[1], "Urbanisme - Bureau 2");
assert.equal(cells[3], "Noir 80 %");
assert.equal(cells[4], "Tambour OK, Fusion 40 %");
assert.equal(cells[6], "RAS");
assert.equal(exportCells(machine({ noir: null, kits: [] }))[3], "—");
assert.equal(statutLabel("critique"), "À traiter");

const csv = toCsv([machine({ observation: 'dire "RAS"; puis vérifier' })]);
assert.equal(csv.charCodeAt(0), 0xfeff);
assert.ok(csv.includes('"dire ""RAS""; puis vérifier"'));
assert.ok(csv.startsWith("\uFEFFimprimante;Departement-Emplacement;"));

assert.equal(safeSwatch("#0b7c8c"), "#0b7c8c");
assert.equal(safeSwatch("#abc"), "#abc");
assert.equal(safeSwatch("red"), "#5b4636");
assert.equal(safeSwatch("javascript:alert(1)"), "#5b4636");
assert.equal(esc(`<img alt="x" src='y'>&`), "&lt;img alt=&quot;x&quot; src=&#39;y&#39;&gt;&amp;");

assert.equal(readableSupplyName("4E 6F 69 72"), "Noir");
assert.equal(readableSupplyName("Toner noir"), "Toner noir");
assert.equal(readableSupplyName("ZZ"), "ZZ");

assert.equal(formatDateCourt(new Date("2026-11-13T23:30:00Z")), "13/11/2026");
assert.equal(formatDateCourt(new Date("2026-07-13T23:30:00Z")), "14/07/2026");
assert.equal(formatDateCourt(new Date("2026-01-02T00:30:00Z")), "02/01/2026");

const title = `État des consommables des imprimantes de l'AUBM en date ${formatDateCourt(new Date("2026-11-05T10:00:00Z"))}`;
const pdf = buildPdf([machine({ observation: "tête usée" })], { title, subtitle: "Sélection · 1 machine" });
const latin = Buffer.from(pdf).toString("latin1");
assert.equal(latin.slice(0, 8), "%PDF-1.4");
assert.equal(latin.slice(-5), "%%EOF");
const beige = latin.indexOf("0.96 0.95 0.93 rg");
const dark = latin.indexOf("0.12 0.13 0.15 rg");
const titleAt = latin.indexOf(title);
assert.ok(beige >= 0 && dark > beige && titleAt > dark, "le titre est dessiné en encre foncée");
assert.ok(latin.includes("Departement-Emplacement"));
assert.ok(latin.includes("tête usée"));
assert.equal(title.includes(":"), false);

console.log("tests ok", counts);
