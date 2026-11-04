import {
  esc, isLocal, isAntenne, tonerLevels, kitLevels, statut, statutLabel,
  motifs, fabricant, filtrer, trier, parDepartement, resume, toCsv, formatDate,
} from "./logic.js";
import { buildPdf } from "./pdf.js";

const RELEVE_DATE = "2025-06-04";

const INTERVENTION_TYPES = [
  ["toner-noir", "Remplacement toner noir"],
  ["toner-cyan", "Remplacement toner cyan"],
  ["toner-magenta", "Remplacement toner magenta"],
  ["toner-jaune", "Remplacement toner jaune"],
  ["kit", "Remplacement de kit"],
  ["photoconducteur", "Remplacement de l'unité photoconductrice"],
  ["autre", "Autre intervention"],
];

const state = {
  printers: [],
  journal: [],
  loading: true,
  error: "",
  busy: false,
  filters: { q: "", dept: "", statut: "", couleur: "", lien: "", lieu: "", marque: "" },
  sort: { key: "statut", dir: "asc" },
  selected: new Set(),
  toast: "",
};

const TONER_SWATCHES = ["#5b4636", "#6e4b86", "#2f6f5e", "#8d5a22", "#3e5278", "#7a3e4a"];

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Impossible de joindre le serveur.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "L'enregistrement a été refusé.");
  return data;
}

async function refresh() {
  const [printers, journal] = await Promise.all([
    api("/api/printers"),
    api("/api/journal"),
  ]);
  if (!Array.isArray(printers.printers) || !Array.isArray(journal.entries)) {
    throw new Error("Réponse du serveur inattendue.");
  }
  state.printers = printers.printers;
  state.journal = journal.entries;
  state.error = "";
}

function replacePrinter(printer) {
  const index = state.printers.findIndex((item) => item.id === printer.id);
  if (index === -1) state.printers.push(printer);
  else state.printers[index] = printer;
}

function uid(prefix) {
  const bytes = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${bytes}`;
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/tableau";
  const [path, id] = hash.split("/").filter(Boolean);
  if (path === "imprimante") return { name: "imprimante", id: id || "nouveau" };
  if (path === "parc" || path === "alertes" || path === "journal" || path === "tableau") return { name: path };
  return { name: "tableau" };
}

function printerById(id) {
  return state.printers.find((printer) => printer.id === id) || null;
}

function toast(message) {
  state.toast = message;
  const node = document.getElementById("toast");
  node.hidden = false;
  node.textContent = message;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

function paint({ preserveScroll = false, focusId = "" } = {}) {
  const y = window.scrollY;
  const focus = focusId || (document.activeElement && document.activeElement.id === "q" ? "q" : "");
  const caret = focus ? document.activeElement.selectionStart : null;
  document.getElementById("sidebar").innerHTML = sidebarHtml();
  document.getElementById("topbar").innerHTML = topbarHtml();
  document.getElementById("view").innerHTML = viewHtml();
  if (focus) {
    const field = document.getElementById(focus);
    if (field) {
      field.focus();
      if (caret !== null && field.setSelectionRange) field.setSelectionRange(caret, caret);
    }
  }
  if (preserveScroll) window.scrollTo(0, y);
  document.body.classList.remove("nav-open");
}

function sidebarHtml() {
  const current = route().name;
  const alerts = state.printers.filter((printer) => statut(printer) === "critique").length;
  const items = [
    ["tableau", "Tableau de bord"],
    ["parc", "Parc"],
    ["alertes", "Alertes"],
    ["journal", "Journal"],
  ];
  return `
    <a class="brand" href="#/tableau">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span><strong>AUBM</strong><small>Parc imprimantes</small></span>
    </a>
    <nav class="nav" aria-label="Sections">
      ${items.map(([id, label]) => `
        <a href="#/${id}" class="${current === id ? "active" : ""}" ${current === id ? 'aria-current="page"' : ""}>
          <span>${label}</span>
          ${id === "alertes" ? `<b class="badge">${alerts}</b>` : ""}
        </a>`).join("")}
    </nav>
    <div class="side-foot">
      <p>Relevé importé du <strong>${esc(formatDate(RELEVE_DATE))}</strong></p>
      <p>${state.printers.length} machine${state.printers.length > 1 ? "s" : ""} suivie${state.printers.length > 1 ? "s" : ""}</p>
    </div>`;
}

function topbarHtml() {
  const current = route();
  const titles = {
    tableau: ["Vue d'ensemble", "Ce qui demande une intervention, et l'état du parc."],
    parc: ["Inventaire", "Recherchez une machine, mettez à jour un niveau, ajoutez un équipement."],
    alertes: ["File des alertes", "Toners, kits et observations ouvertes, du plus urgent au plus stable."],
    journal: ["Journal des interventions", "Historique des mises à jour faites dans cette application."],
    imprimante: current.id === "nouveau"
      ? ["Nouvelle imprimante", "Ajoutez une machine au parc."]
      : ["Fiche machine", "Niveaux, kits et suivi."],
  };
  const [title, sub] = titles[current.name];
  return `
    <button class="menu" type="button" data-action="menu" aria-label="Ouvrir le menu">Menu</button>
    <div class="crumb">
      <h1>${esc(title)}</h1>
      <p>${esc(sub)}</p>
    </div>
    <div class="top-actions">
      <a class="btn btn-primary" href="#/imprimante/nouveau">Ajouter</a>
      <button class="btn" type="button" data-action="export">CSV</button>
      <button class="btn" type="button" data-action="export-pdf">PDF</button>
    </div>`;
}

function viewHtml() {
  if (state.loading) {
    return `<section class="card empty-block"><h2>Chargement du parc…</h2><p>Lecture de la base MySQL.</p></section>`;
  }
  if (state.error) {
    return `<section class="card empty-block"><h2>Base indisponible</h2><p>${esc(state.error)}</p><button class="btn" type="button" data-action="retry">Réessayer</button></section>`;
  }
  const current = route();
  if (current.name === "tableau") return dashboardHtml();
  if (current.name === "parc") return parcHtml();
  if (current.name === "alertes") return alertesHtml();
  if (current.name === "journal") return journalHtml();
  return ficheHtml(current.id);
}

function dashboardHtml() {
  const counts = resume(state.printers);
  const depts = parDepartement(state.printers);
  const maxDept = Math.max(...depts.map((row) => row.total), 1);
  const urgences = trier(state.printers.filter((printer) => statut(printer) !== "ok"), { key: "niveau", dir: "asc" }).slice(0, 7);
  return `
    <section class="banner">
      <div>
        <p class="eyebrow">Snapshot du relevé</p>
        <h2>Les niveaux datent du ${esc(formatDate(RELEVE_DATE))}.</h2>
        <p>Le relevé est dans MySQL. Ajoutez une imprimante, ses toners et leurs pourcentages, les kits s'il y en a, puis l'observation : la fiche est enregistrée sur le serveur.</p>
      </div>
      <a class="btn btn-primary" href="#/alertes">Voir les ${counts.critique} alertes</a>
    </section>
    <section class="kpis">
      ${kpi("Parc", counts.total, "machines", "parc", "")}
      ${kpi("À traiter", counts.critique, "critique", "statut", "critique")}
      ${kpi("À surveiller", counts.attention, "sous 30 %", "statut", "attention")}
      ${kpi("RAS", counts.ok, "rien à signaler", "statut", "ok")}
    </section>
    <section class="split">
      <article class="card">
        <header class="card-head"><h2>À traiter en premier</h2><a href="#/alertes">Toute la file</a></header>
        ${urgences.length ? `<ul class="urgent">${urgences.map(urgentRow).join("")}</ul>` : `<p class="empty">Aucune alerte. Le parc est au calme.</p>`}
      </article>
      <article class="card">
        <header class="card-head"><h2>Par département</h2></header>
        <ul class="bars">
          ${depts.map((row) => `
            <li>
              <button type="button" data-action="filter-dept" data-dept="${esc(row.dept)}">
                <span>${esc(row.dept)}</span>
                <span class="bar"><i style="width:${Math.round((row.total / maxDept) * 100)}%"></i></span>
                <b>${row.alertes ? `${row.alertes} alerte${row.alertes > 1 ? "s" : ""}` : "RAS"}</b>
                <small>${row.total}</small>
              </button>
            </li>`).join("")}
        </ul>
      </article>
    </section>
    <section class="split thirds">
      ${fact("Couleur", `${counts.couleur} couleur`, `${counts.total - counts.couleur} noir et blanc`)}
      ${fact("Réseau", `${counts.total - counts.local} adressées`, `${counts.local} en poste local`)}
      ${fact("Sites", `${counts.antenne} en antenne`, `${counts.total - counts.antenne} au siège`)}
    </section>
    <p class="fine">Seuils utilisés : une machine est à traiter dès 10 % ou dès qu'une observation n'est plus « RAS ». Elle est à surveiller entre 11 et 30 %.</p>`;
}

function kpi(label, value, hint, kind, code) {
  return `<button class="kpi" type="button" data-action="kpi" data-kind="${kind}" data-code="${esc(code)}">
    <span>${esc(label)}</span><strong>${value}</strong><small>${esc(hint)}</small>
  </button>`;
}

function fact(title, a, b) {
  return `<article class="card fact"><h2>${esc(title)}</h2><p>${esc(a)}</p><small>${esc(b)}</small></article>`;
}

function urgentRow(printer) {
  const code = statut(printer);
  return `<li>
    <a href="#/imprimante/${esc(printer.id)}">
      <span class="pill ${code}">${esc(statutLabel(code))}</span>
      <span class="who"><strong>${esc(printer.nom)}</strong><small>${esc(printer.emplacement)} · ${esc(printer.departement)}</small></span>
      <span class="why">${esc(motifs(printer).slice(0, 2).join(" · "))}</span>
    </a>
  </li>`;
}

function parcHtml() {
  return `
    <section class="filters">
      <label class="search">
        <span class="sr">Recherche</span>
        <input id="q" data-filter="q" type="search" placeholder="Nom, bureau, adresse, observation…" value="${esc(state.filters.q)}">
      </label>
      ${select("dept", "Département", [["", "Tous les départements"], ...departments().map((dept) => [dept, dept])])}
      ${select("statut", "État", [["", "Tous les états"], ["critique", "À traiter"], ["attention", "À surveiller"], ["ok", "RAS"]])}
      ${select("couleur", "Impression", [["", "Couleur et N&B"], ["oui", "Couleur"], ["non", "Noir et blanc"]])}
      ${select("lien", "Connexion", [["", "Réseau et local"], ["reseau", "Réseau"], ["local", "Poste local"]])}
      ${select("lieu", "Site", [["", "Siège et antennes"], ["siege", "Siège"], ["antenne", "Antennes"]])}
      ${select("marque", "Marque", [["", "Toutes les marques"], ...marques().map((brand) => [brand, brand])])}
      <button class="btn ghost" type="button" data-action="clear-filters">Effacer</button>
    </section>
    <div id="results">${resultsHtml()}</div>`;
}

function resultsHtml() {
  const rows = visiblePrinters();
  return `
    <p class="result-count">${rows.length} machine${rows.length > 1 ? "s" : ""}${selectionNote(rows)}</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th><button type="button" data-action="select-visible">${allVisibleSelected(rows) ? "Aucune" : "Tout"}</button></th>
            ${th("nom", "Machine")}
            ${th("departement", "Département")}
            ${th("emplacement", "Emplacement")}
            ${th("adresse", "Adresse")}
            <th>Niveaux</th>
            ${th("statut", "État")}
          </tr>
        </thead>
        <tbody>
          ${rows.map(tableRow).join("") || `<tr><td colspan="7" class="empty">Aucune machine ne correspond.</td></tr>`}
        </tbody>
      </table>
    </div>
    <ul class="cards">
      ${rows.map(cardRow).join("") || `<li class="empty">Aucune machine ne correspond.</li>`}
    </ul>`;
}

function th(key, label) {
  const active = state.sort.key === key;
  const arrow = active ? (state.sort.dir === "asc" ? " ↑" : " ↓") : "";
  return `<th><button type="button" data-action="sort" data-key="${key}">${esc(label)}${arrow}</button></th>`;
}

function select(key, label, options) {
  return `<label class="field">${esc(label)}
    <select data-filter="${key}" id="f-${key}">
      ${options.map(([value, text]) => `<option value="${esc(value)}" ${state.filters[key] === value ? "selected" : ""}>${esc(text)}</option>`).join("")}
    </select>
  </label>`;
}

function visiblePrinters() {
  return trier(filtrer(state.printers, state.filters), state.sort);
}

function departments() {
  return [...new Set(state.printers.map((printer) => printer.departement).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
}

function marques() {
  return [...new Set(state.printers.map(fabricant))].sort((a, b) => a.localeCompare(b, "fr"));
}

function lieux() {
  return [...new Set(state.printers.map((printer) => printer.emplacement).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
}

function tableRow(printer) {
  const code = statut(printer);
  return `<tr class="row-link ${code}" data-href="#/imprimante/${esc(printer.id)}">
    <td class="check-cell"><input type="checkbox" data-action="select" data-id="${esc(printer.id)}" ${state.selected.has(printer.id) ? "checked" : ""} aria-label="Sélectionner ${esc(printer.nom)}"></td>
    <td><a href="#/imprimante/${esc(printer.id)}"><strong>${esc(printer.nom)}</strong></a><small>${esc(fabricant(printer))}${printer.couleur ? " · couleur" : " · N&B"}</small></td>
    <td>${esc(printer.departement)}</td>
    <td>${esc(printer.emplacement)}</td>
    <td><code>${esc(printer.adresse)}</code></td>
    <td>${miniLevels(printer)}</td>
    <td><span class="pill ${code}">${esc(statutLabel(code))}</span></td>
  </tr>`;
}

function cardRow(printer) {
  const code = statut(printer);
  return `<li class="pick-card">
    <label><input type="checkbox" data-action="select" data-id="${esc(printer.id)}" ${state.selected.has(printer.id) ? "checked" : ""} aria-label="Sélectionner ${esc(printer.nom)}"></label>
    <a href="#/imprimante/${esc(printer.id)}">
      <span class="pill ${code}">${esc(statutLabel(code))}</span>
      <strong>${esc(printer.nom)}</strong>
      <small>${esc(printer.departement)} · ${esc(printer.emplacement)}</small>
      ${miniLevels(printer)}
    </a>
  </li>`;
}

function allVisibleSelected(rows) {
  return rows.length > 0 && rows.every((printer) => state.selected.has(printer.id));
}

function selectionNote(rows) {
  const count = rows.filter((printer) => state.selected.has(printer.id)).length;
  if (!count) return ". Sans coche, le PDF et le CSV reprennent cette liste.";
  return ` · ${count} sélectionnée${count > 1 ? "s" : ""} pour l'export.`;
}

function miniLevels(printer) {
  const levels = tonerLevels(printer);
  if (!levels.length) return `<span class="muted">—</span>`;
  return `<span class="minis">${levels.map((level) => `<i title="${esc(level.label)} ${level.value} %" style="--v:${level.value}%;--c:${level.swatch}"></i>`).join("")}</span>`;
}

function alertesHtml() {
  const ordered = trier(state.printers.filter((printer) => statut(printer) !== "ok"), { key: "statut", dir: "asc" });
  const groups = [
    ["critique", "À traiter maintenant"],
    ["attention", "À surveiller"],
  ];
  return groups.map(([code, title]) => {
    const items = ordered.filter((printer) => statut(printer) === code);
    return `<section class="card stack">
      <header class="card-head"><h2>${esc(title)}</h2><span class="pill ${code}">${items.length}</span></header>
      ${items.length ? `<ul class="urgent">${items.map(urgentRow).join("")}</ul>` : `<p class="empty">Rien dans cette catégorie.</p>`}
    </section>`;
  }).join("");
}

function journalHtml() {
  if (!state.journal.length) {
    return `<section class="card empty-block">
      <h2>Pas encore d'intervention</h2>
      <p>Quand vous mettez à jour une fiche ou enregistrez un remplacement, la trace apparaît ici.</p>
      <button class="btn" type="button" data-action="reset">Restaurer le relevé d'origine</button>
    </section>`;
  }
  return `<section class="card">
    <header class="card-head">
      <h2>${state.journal.length} entrée${state.journal.length > 1 ? "s" : ""}</h2>
      <button class="btn ghost" type="button" data-action="reset">Restaurer le relevé</button>
    </header>
    <ol class="journal">
      ${state.journal.map((entry) => {
        const exists = printerById(entry.printerId);
        const who = exists
          ? `<a href="#/imprimante/${esc(entry.printerId)}">${esc(entry.printerNom)}</a>`
          : esc(entry.printerNom);
        return `<li>
          <time>${esc(formatDate(entry.at, true))}</time>
          <div><strong>${who}</strong><span>${esc(entry.typeLabel || entry.type)}</span><p>${esc(entry.detail || "")}</p></div>
        </li>`;
      }).join("")}
    </ol>
  </section>`;
}

function ficheHtml(id) {
  const creating = id === "nouveau";
  const printer = creating ? blankPrinter() : printerById(id);
  if (!printer) {
    return `<section class="card empty-block"><h2>Machine introuvable</h2><p>Elle a peut-être été retirée du parc.</p><a class="btn" href="#/parc">Retour au parc</a></section>`;
  }
  const code = creating ? "ok" : statut(printer);
  const history = state.journal.filter((entry) => entry.printerId === printer.id);
  return `
    <p class="back"><a href="#/parc">← Retour au parc</a></p>
    <header class="fiche-head">
      <div>
        <p class="eyebrow">${creating ? "Création" : esc(printer.departement)}</p>
        <h2>${creating ? "Nouvelle imprimante" : esc(printer.nom)}</h2>
        ${creating ? "" : `<p class="subline">${esc(printer.emplacement)} · <code>${esc(printer.adresse)}</code></p>`}
      </div>
      ${creating ? "" : `<span class="pill ${code}">${esc(statutLabel(code))}</span>`}
    </header>
    ${printer.ecart ? `<p class="callout">Sur le relevé du 4 juin 2025, le texte des toners et les colonnes de pourcentages ne disent pas la même chose. Les niveaux ci-dessous sont ceux des colonnes. Le texte d'origine reste visible plus bas.</p>` : ""}
    <form id="printer-form" class="fiche-grid" data-id="${esc(printer.id || "")}">
      <section class="card">
        <h2>Niveaux</h2>
        <p class="hint">${creating || !printer.niveauxLe ? "Saisissez les pourcentages connus." : `Dernière lecture : ${esc(formatDate(printer.niveauxLe))}.`} Laissez vide ce qui ne concerne pas la machine.</p>
        <div class="gauges">${levelFields(printer)}</div>
        <header class="card-head"><h2>Autres toners</h2>
          <button class="btn ghost" type="button" data-action="add-toner">Ajouter</button>
        </header>
        <div id="toners" class="kits">
          ${customToners(printer).map((item) => tonerRow(item.label, item.value, item.key, item.swatch)).join("")}
        </div>
        <label class="field">Marque des cartouches
          <input name="fourniture" value="${esc(printer.fourniture || "")}" placeholder="HP, Canon, Ricoh…">
        </label>
      </section>
      <section class="card">
        <h2>Identité</h2>
        <div class="form-grid">
          <label class="field span2">Nom
            <input name="nom" required value="${esc(printer.nom)}" placeholder="HP Color LaserJet M552">
          </label>
          <label class="field">Département
            <input name="departement" required list="dept-list" value="${esc(printer.departement)}">
          </label>
          <label class="field">Emplacement
            <input name="emplacement" required list="lieu-list" value="${esc(printer.emplacement)}">
          </label>
          <label class="field span2">Adresse
            <input name="adresse" value="${esc(printer.adresse)}" placeholder="195.200.200.12 ou Localhost">
          </label>
          <label class="check span2"><input type="checkbox" name="couleur" ${printer.couleur ? "checked" : ""}> Imprimante couleur</label>
          <label class="field span2">Observation
            <textarea name="observation" rows="3" placeholder="RAS ou le remplacement à prévoir">${esc(printer.observation || "")}</textarea>
          </label>
        </div>
        <datalist id="dept-list">${departments().map((dept) => `<option value="${esc(dept)}"></option>`).join("")}</datalist>
        <datalist id="lieu-list">${lieux().map((lieu) => `<option value="${esc(lieu)}"></option>`).join("")}</datalist>
      </section>
      <section class="card span2">
        <header class="card-head"><h2>Kits et consommables</h2>
          <button class="btn ghost" type="button" data-action="add-kit">Ajouter</button>
        </header>
        <div id="kits" class="kits">
          ${(printer.kits || []).map((kit) => kitRow(kit.label, kit.level)).join("")}
        </div>
        ${printer.releve ? `<p class="releve"><span>Texte du relevé du ${esc(formatDate(RELEVE_DATE))}</span> ${esc(printer.releve)}</p>` : ""}
        <p class="form-error" id="form-error" hidden></p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Enregistrer</button>
          ${creating ? `<a class="btn" href="#/parc">Annuler</a>` : `<button class="btn danger" type="button" data-action="delete" data-id="${esc(printer.id)}">Supprimer</button>`}
        </div>
      </section>
    </form>
    ${creating ? "" : interventionHtml(printer, history)}`;
}

function blankPrinter() {
  return {
    id: "",
    nom: "",
    departement: "",
    emplacement: "",
    adresse: "",
    couleur: false,
    fourniture: "",
    noir: null,
    cyan: null,
    magenta: null,
    jaune: null,
    extra: null,
    kits: [],
    observation: "",
    releve: "",
    niveauxLe: null,
  };
}

function customToners(printer) {
  return (printer.extra || []).filter((item) => String(item.key || "").startsWith("ton-"));
}

function fixedExtra(printer) {
  return (printer.extra || []).filter((item) => !String(item.key || "").startsWith("ton-"));
}

function levelFields(printer) {
  const fixed = fixedExtra(printer);
  if (fixed.length && ["noir", "cyan", "magenta", "jaune"].every((key) => printer[key] == null || printer[key] === "")) {
    return fixed.map((item) => slider(item.key, item.label, item.value, item.swatch, true)).join("");
  }
  const fields = [
    ["noir", "Noir", printer.noir, "#2b3038"],
    ["cyan", "Cyan", printer.cyan, "#0b7c8c"],
    ["magenta", "Magenta", printer.magenta, "#b5336b"],
    ["jaune", "Jaune", printer.jaune, "#c89208"],
  ];
  return fields.map(([key, label, value, swatch]) => slider(key, label, value, swatch, false)).join("");
}

function slider(key, label, value, swatch, extra) {
  const known = value !== null && value !== undefined && value !== "";
  const shown = known ? Number(value) : 0;
  return `<div class="gauge ${known ? "" : "is-empty"}">
    <div class="gauge-top">
      <span class="swatch" style="background:${swatch}"></span>
      <span>${esc(label)}</span>
      <strong data-val="${esc(key)}">${known ? `${shown} %` : "—"}</strong>
    </div>
    <div class="gauge-controls">
      <input type="range" min="0" max="100" step="1" value="${shown}" data-sync="${esc(key)}" aria-label="${esc(label)}">
      <input type="number" min="0" max="100" step="1" name="${extra ? `extra:${key}` : key}" data-sync="${esc(key)}" value="${known ? shown : ""}" placeholder="—" inputmode="numeric" aria-label="${esc(label)} en pourcentage">
    </div>
    <div class="track" aria-hidden="true"><div class="fill" style="width:${known ? shown : 0}%;background:${swatch}"></div></div>
  </div>`;
}

function tonerRow(label, level, key = "", swatch = "") {
  const hasLevel = level !== null && level !== undefined && level !== "";
  const tone = swatch || TONER_SWATCHES[0];
  return `<div class="kit-row toner-row" data-key="${esc(key)}" data-swatch="${esc(tone)}">
    <input name="tonerLabel" value="${esc(label)}" placeholder="Gris, noir photo, réservoir…" aria-label="Nom du toner">
    <input name="tonerLevel" type="number" min="0" max="100" value="${hasLevel ? Number(level) : ""}" placeholder="%" aria-label="Pourcentage du toner">
    <button class="btn ghost" type="button" data-action="remove-toner">Retirer</button>
  </div>`;
}

function kitRow(label, level) {
  const hasLevel = level !== null && level !== undefined && level !== "";
  return `<div class="kit-row">
    <input name="kitLabel" value="${esc(label)}" placeholder="Kit de fusion, tambour…" aria-label="Nom du kit">
    <input name="kitLevel" type="number" min="0" max="100" value="${hasLevel ? Number(level) : ""}" placeholder="OK" aria-label="Niveau du kit en pourcentage">
    <button class="btn ghost" type="button" data-action="remove-kit">Retirer</button>
  </div>`;
}

function interventionHtml(printer, history) {
  return `<section class="split">
    <form id="intervention-form" class="card" data-id="${esc(printer.id)}">
      <h2>Enregistrer une intervention</h2>
      <p class="hint">L'intervention est enregistrée dans MySQL et appliquée à la fiche.</p>
      <label class="field">Type
        <select name="type">${INTERVENTION_TYPES.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("")}</select>
      </label>
      <label class="field">Commentaire
        <textarea name="detail" rows="3" placeholder="Cartouche jaune posée, référence, technicien…"></textarea>
      </label>
      <label class="check"><input type="checkbox" name="cloture" checked> Passer l'observation à RAS</label>
      <button class="btn btn-primary" type="submit">Enregistrer l'intervention</button>
    </form>
    <article class="card">
      <h2>Historique de cette machine</h2>
      ${history.length ? `<ol class="journal compact">${history.map((entry) => `<li><time>${esc(formatDate(entry.at, true))}</time><div><span>${esc(entry.typeLabel || "")}</span><p>${esc(entry.detail || "")}</p></div></li>`).join("")}</ol>` : `<p class="empty">Aucune intervention enregistrée pour cette machine.</p>`}
    </article>
  </section>`;
}

function readPrinter(form, previous) {
  const data = new FormData(form);
  const nom = String(data.get("nom") || "").trim();
  const departement = String(data.get("departement") || "").trim();
  const emplacement = String(data.get("emplacement") || "").trim();
  if (!nom || !departement || !emplacement) {
    return { error: "Le nom, le département et l'emplacement sont obligatoires." };
  }
  const kits = [...form.querySelectorAll(".kit-row")].filter((row) => !row.classList.contains("toner-row")).map((row) => {
    const label = row.querySelector('[name="kitLabel"]').value.trim();
    const raw = row.querySelector('[name="kitLevel"]').value.trim();
    if (!label) return null;
    return { label, level: raw === "" ? null : clamp(raw) };
  }).filter(Boolean);
  const added = readCustomToners(form);
  if (added.error) return added;

  const next = {
    ...(previous || {}),
    id: previous?.id || uid("imp"),
    nom,
    departement,
    emplacement,
    adresse: String(data.get("adresse") || "").trim() || "Localhost",
    couleur: data.get("couleur") === "on",
    fourniture: String(data.get("fourniture") || "").trim(),
    observation: String(data.get("observation") || "").trim() || "RAS",
    kits,
    releve: previous?.releve || "",
    ecart: previous?.ecart || false,
  };

  const before = JSON.stringify(tonerSnapshot(previous || {}));
  const fixed = fixedExtra(previous || {});
  if (fixed.length && form.querySelector('[name^="extra:"]')) {
    next.extra = [
      ...fixed.map((item) => ({
        ...item,
        value: clamp(data.get(`extra:${item.key}`), item.value),
      })),
      ...added.rows,
    ];
    next.noir = null;
    next.cyan = null;
    next.magenta = null;
    next.jaune = null;
  } else {
    next.extra = added.rows.length ? added.rows : null;
    next.noir = emptyOrNumber(data.get("noir"));
    next.cyan = emptyOrNumber(data.get("cyan"));
    next.magenta = emptyOrNumber(data.get("magenta"));
    next.jaune = emptyOrNumber(data.get("jaune"));
  }
  const changed = before !== JSON.stringify(tonerSnapshot(next));
  if (!previous || changed) next.niveauxLe = new Date().toISOString();
  else next.niveauxLe = previous.niveauxLe || RELEVE_DATE;
  return { printer: next, changed };
}

function readCustomToners(form) {
  const rows = [];
  for (const row of form.querySelectorAll(".toner-row")) {
    const label = row.querySelector('[name="tonerLabel"]').value.trim();
    const raw = row.querySelector('[name="tonerLevel"]').value.trim();
    if (!label && raw === "") continue;
    if (!label) return { error: "Nommez chaque toner ajouté." };
    if (raw === "") return { error: `Indiquez le pourcentage de ${label}.` };
    rows.push({
      key: row.dataset.key || uid("ton"),
      label,
      value: clamp(raw),
      swatch: row.dataset.swatch || TONER_SWATCHES[rows.length % TONER_SWATCHES.length],
    });
  }
  return { rows };
}

function tonerSnapshot(printer) {
  return {
    noir: printer.noir ?? null,
    cyan: printer.cyan ?? null,
    magenta: printer.magenta ?? null,
    jaune: printer.jaune ?? null,
    extra: printer.extra || null,
    kits: printer.kits || [],
  };
}

function emptyOrNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return clamp(value);
}

function clamp(value, fallback = 0) {
  const number = Number(value);
  if (Number.isNaN(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

async function savePrinter(form) {
  if (state.busy) return;
  const id = form.dataset.id;
  const previous = id ? printerById(id) : null;
  const result = readPrinter(form, previous);
  const error = document.getElementById("form-error");
  if (result.error) {
    error.hidden = false;
    error.textContent = result.error;
    return;
  }
  error.hidden = true;
  const journal = previous
    ? {
      type: "mise-a-jour",
      detail: result.changed ? "Niveaux ou kits modifiés." : "Informations modifiées.",
    }
    : {
      type: "creation",
      detail: `${result.printer.emplacement} · ${result.printer.departement}`,
    };
  state.busy = true;
  try {
    const saved = await api(previous ? `/api/printers/${encodeURIComponent(previous.id)}` : "/api/printers", {
      method: previous ? "PUT" : "POST",
      body: { printer: result.printer, journal },
    });
    replacePrinter(saved.printer);
    state.journal.unshift(saved.entry);
    toast(previous ? "Fiche enregistrée." : "Imprimante ajoutée au parc.");
    location.hash = `#/imprimante/${saved.printer.id}`;
    paint();
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

function clonePrinter(printer) {
  return {
    ...printer,
    kits: (printer.kits || []).map((kit) => ({ ...kit })),
    extra: printer.extra ? printer.extra.map((item) => ({ ...item })) : null,
  };
}

async function applyIntervention(form) {
  if (state.busy) return;
  const printer = printerById(form.dataset.id);
  if (!printer) return;
  const data = new FormData(form);
  const type = String(data.get("type"));
  const detail = String(data.get("detail") || "").trim();
  const next = clonePrinter(printer);
  const map = {
    "toner-noir": "noir",
    "toner-cyan": "cyan",
    "toner-magenta": "magenta",
    "toner-jaune": "jaune",
  };
  if (map[type]) {
    if (next.extra?.length) {
      const target = next.extra.find((item) => item.key === map[type]);
      if (target) target.value = 100;
    } else if (next[map[type]] !== null && next[map[type]] !== undefined) {
      next[map[type]] = 100;
    }
    next.niveauxLe = new Date().toISOString();
  }
  if (type === "kit") {
    for (const kit of next.kits || []) {
      if (kit.level !== null && kit.level !== undefined && Number(kit.level) <= 30) kit.level = 100;
    }
    next.niveauxLe = new Date().toISOString();
  }
  if (data.get("cloture") === "on") next.observation = "RAS";
  state.busy = true;
  try {
    const saved = await api(`/api/printers/${encodeURIComponent(next.id)}`, {
      method: "PUT",
      body: {
        printer: next,
        journal: { type, detail: detail || "Intervention enregistrée." },
      },
    });
    replacePrinter(saved.printer);
    state.journal.unshift(saved.entry);
    toast("Intervention enregistrée.");
    paint();
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
  }
}

async function removePrinter(id) {
  if (state.busy) return;
  const printer = printerById(id);
  if (!printer) return;
  state.busy = true;
  try {
    const saved = await api(`/api/printers/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.printers = state.printers.filter((item) => item.id !== id);
    state.journal.unshift(saved.entry);
    toast("Imprimante retirée du parc.");
    location.hash = "#/parc";
    paint();
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
  }
}

function chosenPrinters() {
  const current = route();
  let base = state.printers;
  if (current.name === "parc") base = visiblePrinters();
  else if (current.name === "alertes") base = state.printers.filter((printer) => statut(printer) !== "ok");
  else if (current.name === "imprimante" && current.id && current.id !== "nouveau") {
    const one = printerById(current.id);
    base = one ? [one] : [];
  }
  if (current.name === "parc") {
    const picked = base.filter((printer) => state.selected.has(printer.id));
    if (picked.length) return picked;
  }
  return base;
}

function exportCsv() {
  const source = chosenPrinters();
  if (!source.length) {
    toast("Aucune machine à exporter.");
    return;
  }
  const blob = new Blob([toCsv(source)], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "aubm-imprimantes.csv";
  link.click();
  URL.revokeObjectURL(link.href);
  toast(`CSV de ${source.length} machine${source.length > 1 ? "s" : ""} téléchargé.`);
}

function exportPdf() {
  const source = chosenPrinters();
  if (!source.length) {
    toast("Aucune machine à exporter.");
    return;
  }
  const onParc = route().name === "parc";
  const picked = onParc && visiblePrinters().some((printer) => state.selected.has(printer.id));
  const filtered = onParc && Object.values(state.filters).some((value) => String(value || "").trim());
  const subtitle = picked ? "Sélection" : (filtered ? "Liste filtrée" : "Parc complet");
  const bytes = buildPdf(source, {
    title: "AUBM — Parc imprimantes",
    subtitle: `${subtitle} · ${source.length} machine${source.length > 1 ? "s" : ""}`,
    generated: formatDate(new Date().toISOString(), true),
    tonerLevels,
    statut,
    statutLabel,
  });
  const blob = new Blob([bytes], { type: "application/pdf" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "aubm-imprimantes.pdf";
  link.click();
  URL.revokeObjectURL(link.href);
  toast(`PDF de ${source.length} machine${source.length > 1 ? "s" : ""} téléchargé.`);
}

async function resetData() {
  if (state.busy) return;
  state.busy = true;
  try {
    const data = await api("/api/reset", { method: "POST" });
    state.printers = data.printers;
    state.journal = data.entries || [];
    toast("Relevé du 4 juin 2025 restauré.");
    paint();
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
  }
}

function onClick(event) {
  const actionNode = event.target.closest("[data-action]");
  const action = actionNode?.dataset.action;
  if (action === "menu") {
    document.body.classList.toggle("nav-open");
    return;
  }
  if (action === "retry") {
    state.loading = true;
    state.error = "";
    paint();
    refresh()
      .catch((err) => {
        state.error = err.message;
      })
      .finally(() => {
        state.loading = false;
        paint();
      });
    return;
  }
  if (action === "export") {
    exportCsv();
    return;
  }
  if (action === "export-pdf") {
    exportPdf();
    return;
  }
  if (action === "select") {
    const id = actionNode.dataset.id;
    if (actionNode.checked) state.selected.add(id);
    else state.selected.delete(id);
    const note = document.querySelector(".result-count");
    if (note) note.textContent = `${visiblePrinters().length} machine${visiblePrinters().length > 1 ? "s" : ""}${selectionNote(visiblePrinters())}`;
    return;
  }
  if (action === "select-visible") {
    const rows = visiblePrinters();
    const clear = allVisibleSelected(rows);
    for (const printer of rows) {
      if (clear) state.selected.delete(printer.id);
      else state.selected.add(printer.id);
    }
    paint({ preserveScroll: true });
    return;
  }
  if (action === "add-toner") {
    const swatch = TONER_SWATCHES[document.querySelectorAll(".toner-row").length % TONER_SWATCHES.length];
    document.getElementById("toners").insertAdjacentHTML("beforeend", tonerRow("", "", uid("ton"), swatch));
    return;
  }
  if (action === "remove-toner") {
    actionNode.closest(".toner-row")?.remove();
    return;
  }
  if (action === "reset") {
    if (actionNode.dataset.confirm !== "1") {
      actionNode.dataset.confirm = "1";
      actionNode.textContent = "Confirmer la restauration";
      return;
    }
    resetData();
    return;
  }
  if (action === "clear-filters") {
    state.filters = { q: "", dept: "", statut: "", couleur: "", lien: "", lieu: "", marque: "" };
    paint();
    return;
  }
  if (action === "sort") {
    const key = actionNode.dataset.key;
    if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    else state.sort = { key, dir: "asc" };
    paint({ preserveScroll: true });
    return;
  }
  if (action === "kpi") {
    state.filters = { q: "", dept: "", statut: "", couleur: "", lien: "", lieu: "", marque: "" };
    if (actionNode.dataset.kind === "statut") state.filters.statut = actionNode.dataset.code;
    location.hash = "#/parc";
    paint();
    return;
  }
  if (action === "filter-dept") {
    state.filters = { q: "", dept: actionNode.dataset.dept, statut: "", couleur: "", lien: "", lieu: "", marque: "" };
    location.hash = "#/parc";
    paint();
    return;
  }
  if (action === "add-kit") {
    document.getElementById("kits").insertAdjacentHTML("beforeend", kitRow("", null));
    return;
  }
  if (action === "remove-kit") {
    actionNode.closest(".kit-row")?.remove();
    return;
  }
  if (action === "delete") {
    if (actionNode.dataset.confirm !== "1") {
      actionNode.dataset.confirm = "1";
      actionNode.textContent = "Confirmer la suppression";
      return;
    }
    removePrinter(actionNode.dataset.id);
    return;
  }
  const row = event.target.closest("tr.row-link");
  if (row && !event.target.closest("a, button, input, label")) {
    location.hash = row.dataset.href;
  }
}

function onSubmit(event) {
  if (event.target.id === "printer-form") {
    event.preventDefault();
    savePrinter(event.target);
  }
  if (event.target.id === "intervention-form") {
    event.preventDefault();
    applyIntervention(event.target);
  }
}

function onInput(event) {
  const field = event.target;
  if (field.dataset.sync) {
    for (const node of document.querySelectorAll(`[data-sync="${field.dataset.sync}"]`)) {
      if (node !== field) node.value = field.value;
    }
    const label = document.querySelector(`[data-val="${field.dataset.sync}"]`);
    if (label) label.textContent = field.value === "" ? "—" : `${field.value} %`;
    const gauge = field.closest(".gauge");
    const fill = gauge?.querySelector(".fill");
    if (fill) fill.style.width = `${field.value === "" ? 0 : field.value}%`;
    gauge?.classList.toggle("is-empty", field.value === "");
    return;
  }
  if (field.dataset.filter === "q") {
    state.filters.q = field.value;
    const slot = document.getElementById("results");
    if (slot) slot.innerHTML = resultsHtml();
    else paint({ preserveScroll: true, focusId: "q" });
  }
}

function onChange(event) {
  const field = event.target;
  if (field.dataset.filter && field.dataset.filter !== "q") {
    state.filters[field.dataset.filter] = field.value;
    paint({ preserveScroll: true });
  }
}

async function boot() {
  document.body.addEventListener("click", onClick);
  document.body.addEventListener("submit", onSubmit);
  document.body.addEventListener("input", onInput);
  document.body.addEventListener("change", onChange);
  window.addEventListener("hashchange", () => paint());
  if (!location.hash) location.hash = "#/tableau";
  paint();
  try {
    await refresh();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
  }
  paint();
}

boot();
