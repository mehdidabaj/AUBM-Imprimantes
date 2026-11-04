import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRINTERS, RELEVE_DATE } from "../js/data.js";
import { filtrer, minLevel, statut, resume } from "../js/logic.js";

const byId = (id) => PRINTERS.find((printer) => printer.id === id);

assert.equal(PRINTERS.length, 36);
assert.equal(new Set(PRINTERS.map((printer) => printer.id)).size, 36);

assert.equal(statut(byId("imp-01")), "critique", "photoconducteur à remplacer");
assert.equal(statut(byId("imp-02")), "ok");
assert.equal(statut(byId("imp-13")), "attention", "toner à 25 %");
assert.equal(statut(byId("imp-22")), "critique", "toners vides");
assert.equal(statut(byId("imp-11")), "critique", "jaune à 10 %");
assert.equal(statut(byId("imp-19")), "attention", "gris du traceur");
assert.equal(statut(byId("imp-17")), "ok");
assert.equal(minLevel(byId("imp-16")), 10);

const counts = resume(PRINTERS);
assert.equal(counts.total, 36);
assert.ok(counts.critique >= 8);
assert.equal(counts.critique + counts.attention + counts.ok, 36);

const m552 = filtrer(PRINTERS, { q: "m552" });
assert.equal(m552.length, 8);

const kh = filtrer(PRINTERS, { dept: "A. KH" });
assert.equal(kh.length, 4);

assert.equal(statut({ nom: "Nouvelle", observation: "RAS", kits: [] }), "attention");

const locaux = filtrer(PRINTERS, { lien: "local" });
assert.ok(locaux.every((printer) => /^localhost$/i.test(printer.adresse)));
assert.equal(locaux.length, 10);

const seed = JSON.parse(readFileSync(new URL("../server/seed.json", import.meta.url), "utf8"));
assert.equal(seed.length, PRINTERS.length);
for (const printer of PRINTERS) {
  const stored = seed.find((item) => item.id === printer.id);
  assert.ok(stored, printer.id);
  assert.equal(stored.niveauxLe, RELEVE_DATE);
  const { niveauxLe, ...rest } = stored;
  assert.deepEqual(rest, printer);
}

console.log("tests ok", counts);
