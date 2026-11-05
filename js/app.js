import {
  esc, isLocal, isAntenne, tonerLevels, kitLevels, statut, statutLabel,
  motifs, fabricant, filtrer, trier, parDepartement, resume, toCsv, formatDate,
  readableSupplyName,
} from "./logic.js";
import { buildPdf } from "./pdf.js";

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
  user: null,
  users: null,
  places: [],
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
  if (!response.ok) {
    const error = new Error(data.error || "L'enregistrement a été refusé.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function canManage() {
  return state.user?.role === "admin";
}

function roleLabel(role) {
  return role === "admin" ? "Administrateur" : "Consultation";
}

async function refresh() {
  const [printers, journal, places] = await Promise.all([
    api("/api/printers"),
    api("/api/journal"),
    api("/api/places"),
  ]);
  if (!Array.isArray(printers.printers) || !Array.isArray(journal.entries) || !Array.isArray(places.departements)) {
    throw new Error("Réponse du serveur inattendue.");
  }
  state.printers = printers.printers;
  state.journal = journal.entries;
  state.places = places.departements;
  state.error = "";
}

function replacePrinter(printer) {
  const index = state.printers.findIndex((item) => item.id === printer.id);
  if (index === -1) state.printers.push(printer);
  else state.printers[index] = printer;
}

function uid(prefix) {
  let hex = "";
  try {
    const bytes = new Uint8Array(4);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else throw new Error("crypto");
    hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    hex = "";
  }
  if (!hex) {
    for (let index = 0; index < 8; index += 1) hex += Math.floor(Math.random() * 16).toString(16);
  }
  return `${prefix}-${hex}`;
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/tableau";
  const [path, id] = hash.split("/").filter(Boolean);
  if (path === "imprimante") return { name: "imprimante", id: id || "nouveau" };
  if (path === "parc" || path === "alertes" || path === "journal" || path === "tableau" || path === "utilisateurs" || path === "departements") return { name: path };
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
  document.body.classList.toggle("is-login", !state.user);
  if (!state.user) {
    document.getElementById("sidebar").innerHTML = "";
    document.getElementById("topbar").innerHTML = "";
    document.getElementById("view").innerHTML = gateHtml();
    document.body.classList.remove("nav-open");
    return;
  }
  const y = window.scrollY;
  const focus = focusId || (document.activeElement && document.activeElement.id === "q" ? "q" : "");
  const caret = focus ? document.activeElement.selectionStart : null;
  document.getElementById("sidebar").innerHTML = sidebarHtml();
  document.getElementById("topbar").innerHTML = topbarHtml();
  document.getElementById("view").innerHTML = viewHtml();
  bindComposers();
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
  if (canManage()) {
    items.push(["departements", "Départements"]);
    items.push(["utilisateurs", "Utilisateurs"]);
  }
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
      <p>${state.printers.length ? `${state.printers.length} machine${state.printers.length > 1 ? "s" : ""} suivie${state.printers.length > 1 ? "s" : ""}` : "Parc vide"}</p>
      <p>${esc(state.user.nom)} · ${esc(roleLabel(state.user.role))}</p>
    </div>`;
}

function topbarHtml() {
  const current = route();
  const titles = {
    tableau: ["Vue d'ensemble", "Ce qui demande une intervention, et l'état du parc."],
    parc: canManage()
      ? ["Inventaire", "Recherchez une machine, mettez à jour un niveau, ajoutez un équipement."]
      : ["Inventaire", "Recherchez une machine et consultez ses niveaux."],
    alertes: ["File des alertes", "Toners, kits et observations ouvertes, du plus urgent au plus stable."],
    journal: ["Journal des interventions", "Historique des mises à jour faites dans cette application."],
    imprimante: current.id === "nouveau"
      ? ["Nouvelle imprimante", "Ajoutez une machine au parc."]
      : ["Fiche machine", "Niveaux, kits et suivi."],
    utilisateurs: ["Utilisateurs", "Comptes autorisés à ouvrir le parc."],
    departements: ["Départements", "Chaque département regroupe ses emplacements."],
  };
  const [title, sub] = titles[current.name];
  return `
    <button class="menu" type="button" data-action="menu" aria-label="Ouvrir le menu">Menu</button>
    <div class="crumb">
      <h1>${esc(title)}</h1>
      <p>${esc(sub)}</p>
    </div>
    <div class="top-actions">
      ${canManage() && current.name === "parc" ? `<button class="btn" type="button" data-action="relever-parc">Lire les IP</button>` : ""}
      ${canManage() ? `<a class="btn btn-primary" href="#/imprimante/nouveau">Ajouter</a>` : ""}
      <button class="btn" type="button" data-action="export">CSV</button>
      <button class="btn" type="button" data-action="export-pdf">PDF</button>
      <button class="btn" type="button" data-action="logout">Quitter</button>
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
  if (current.name === "utilisateurs") return utilisateursHtml();
  if (current.name === "departements") return departementsHtml();
  return ficheHtml(current.id);
}

function gateHtml() {
  if (state.loading) {
    return `<section class="card empty-block"><h2>Chargement du parc…</h2><p>Vérification de la session.</p></section>`;
  }
  if (state.error) {
    return `<section class="card empty-block"><h2>Base indisponible</h2><p>${esc(state.error)}</p><button class="btn" type="button" data-action="retry">Réessayer</button></section>`;
  }
  return `<section class="login-wrap"><form id="login-form" class="card login-card">
    <img class="login-logo" src="img/logo-aubm.png" alt="Agence Urbaine de Beni Mellal">
    <h2>Parc imprimantes</h2>
    <p class="hint">Entrez votre identifiant pour consulter le parc.</p>
    <label class="field">Identifiant
      <input name="identifiant" autocomplete="username" required>
    </label>
    <label class="field">Mot de passe
      <input name="motDePasse" type="password" autocomplete="current-password" required>
    </label>
    <p class="form-error" id="form-error" hidden></p>
    <button class="btn btn-primary" type="submit">Entrer</button>
  </form></section>`;
}

function dashboardHtml() {
  const counts = resume(state.printers);
  const depts = parDepartement(state.printers);
  const maxDept = Math.max(...depts.map((row) => row.total), 1);
  const urgences = trier(state.printers.filter((printer) => statut(printer) !== "ok"), { key: "niveau", dir: "asc" }).slice(0, 7);
  const banner = counts.total
    ? `<section class="banner">
      <div>
        <p class="eyebrow">Parc</p>
        <h2>${counts.total} imprimante${counts.total > 1 ? "s" : ""} suivie${counts.total > 1 ? "s" : ""}.</h2>
        <p>${canManage()
          ? "Ajoutez une imprimante, ses cartouches et leurs pourcentages, les kits s'il y en a, puis l'observation."
          : "Les fiches, les filtres et les exports restent disponibles. Les modifications du parc sont réservées aux administrateurs."}</p>
      </div>
      <a class="btn btn-primary" href="#/alertes">Voir les ${counts.critique} alertes</a>
    </section>`
    : `<section class="banner">
      <div>
        <p class="eyebrow">Parc vide</p>
        <h2>Aucune imprimante pour le moment.</h2>
        <p>${canManage()
          ? "Ajoutez un département et ses emplacements, puis la première imprimante."
          : "Le parc ne contient encore aucune machine."}</p>
      </div>
      ${canManage() ? `<a class="btn btn-primary" href="#/imprimante/nouveau">Ajouter une imprimante</a>` : ""}
    </section>`;
  return `
    ${banner}
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
          ${depts.length ? depts.map((row) => `
            <li>
              <button type="button" data-action="filter-dept" data-dept="${esc(row.dept)}">
                <span>${esc(row.dept)}</span>
                <span class="bar"><i style="width:${Math.round((row.total / maxDept) * 100)}%"></i></span>
                <b>${row.alertes ? `${row.alertes} alerte${row.alertes > 1 ? "s" : ""}` : "RAS"}</b>
                <small>${row.total}</small>
              </button>
            </li>`).join("") : `<li class="empty">Aucun département.</li>`}
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
          ${rows.map(tableRow).join("") || `<tr><td colspan="7" class="empty">${state.printers.length ? "Aucune machine ne correspond." : "Le parc est vide."}</td></tr>`}
        </tbody>
      </table>
    </div>
    <ul class="cards">
      ${rows.map(cardRow).join("") || `<li class="empty">${state.printers.length ? "Aucune machine ne correspond." : "Le parc est vide."}</li>`}
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
  const names = new Set(state.printers.map((printer) => printer.departement).filter(Boolean));
  for (const departement of state.places || []) names.add(departement.nom);
  return [...names].sort((a, b) => a.localeCompare(b, "fr"));
}

function placeOptions(departement, emplacement) {
  const deptNames = departments();
  if (departement && !deptNames.includes(departement)) deptNames.unshift(departement);
  const selectedDept = departement || deptNames[0] || "";
  const known = (state.places || []).find((item) => item.nom === selectedDept);
  const lieux = known ? known.emplacements.map((item) => item.nom) : [];
  if (emplacement && !lieux.includes(emplacement)) lieux.unshift(emplacement);
  const deptHtml = deptNames.map((nom) => `<option value="${esc(nom)}" ${nom === selectedDept ? "selected" : ""}>${esc(nom)}</option>`).join("");
  const lieuHtml = lieux.map((nom) => `<option value="${esc(nom)}" ${nom === emplacement ? "selected" : ""}>${esc(nom)}</option>`).join("");
  return { departements: deptHtml || `<option value="">Aucun département</option>`, emplacements: lieuHtml || `<option value="">Aucun emplacement</option>` };
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
    <td><code>${esc(adresseLabel(printer))}</code></td>
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

function departementsHtml() {
  if (!canManage()) {
    return `<section class="card empty-block"><h2>Réservé aux administrateurs</h2><p>La gestion des départements n'est pas ouverte en consultation.</p><a class="btn" href="#/tableau">Retour au tableau</a></section>`;
  }
  const departements = state.places || [];
  return `
    <form id="dept-create" class="card">
      <h2>Nouveau département</h2>
      <div class="composer composer-pair">
        <input name="nom" required maxlength="80" placeholder="DAF, DIR, Antenne…" aria-label="Nom du département">
        <button class="btn btn-primary" type="submit">Ajouter</button>
      </div>
    </form>
    ${departements.map((departement) => `
      <section class="card">
        <form data-dept-id="${departement.id}" class="dept-form">
          <div class="composer composer-triple">
            <input name="nom" required maxlength="80" value="${esc(departement.nom)}" aria-label="Nom du département">
            <button class="btn" type="submit">Renommer</button>
            <button class="btn danger" type="button" data-action="delete-dept" data-id="${departement.id}">Retirer</button>
          </div>
        </form>
        <ul class="place-list">
          ${departement.emplacements.map((lieu) => `
            <li>
              <form data-lieu-id="${lieu.id}">
                <input name="nom" required maxlength="160" value="${esc(lieu.nom)}" aria-label="Nom de l'emplacement">
                <button class="btn" type="submit">Renommer</button>
                <button class="btn ghost" type="button" data-action="delete-lieu" data-id="${lieu.id}">Retirer</button>
              </form>
            </li>`).join("") || `<li class="fine">Aucun emplacement.</li>`}
        </ul>
        <form data-lieu-create="${departement.id}" class="composer composer-pair">
          <input name="nom" required maxlength="160" placeholder="Nouvel emplacement" aria-label="Nouvel emplacement">
          <button class="btn" type="submit">Ajouter l'emplacement</button>
        </form>
      </section>`).join("") || `<section class="card empty-block"><h2>Aucun département</h2><p>Ajoutez un département, puis ses emplacements.</p></section>`}`;
}

function utilisateursHtml() {
  if (!canManage()) {
    return `<section class="card empty-block">
      <h2>Réservé aux administrateurs</h2>
      <p>La gestion des comptes n'est pas ouverte en consultation.</p>
      <a class="btn" href="#/tableau">Retour au tableau</a>
    </section>`;
  }
  if (state.users === null) {
    return `<section class="card empty-block"><h2>Chargement des comptes…</h2><p>Lecture des utilisateurs autorisés.</p></section>`;
  }
  return `
    <section class="card">
      <header class="card-head">
        <h2>${state.users.length} compte${state.users.length > 1 ? "s" : ""}</h2>
      </header>
      <p class="hint">L'administrateur gère le parc. Le profil Consultation ouvre les fiches, les filtres et les exports, sans modifier les machines. Un compte ajouté peut être supprimé. Le premier administrateur reste en place.</p>
      <div class="user-list">
        ${state.users.map(userForm).join("")}
      </div>
    </section>
    <form id="user-create" class="card">
      <h2>Nouveau compte</h2>
      <div class="form-grid">
        <label class="field">Nom
          <input name="nom" required maxlength="160" autocomplete="name">
        </label>
        <label class="field">Identifiant
          <input name="identifiant" required minlength="3" maxlength="80" autocapitalize="none" autocomplete="off" spellcheck="false">
        </label>
        <label class="field">Mot de passe
          <input name="motDePasse" type="password" required minlength="8" autocomplete="new-password">
        </label>
        <label class="field">Profil
          <select name="role">
            <option value="consultation" selected>Consultation</option>
            <option value="admin">Administrateur</option>
          </select>
        </label>
      </div>
      <p class="fine">L'identifiant est enregistré en minuscules. Le mot de passe compte au moins 8 caractères.</p>
      <p class="form-error" hidden></p>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Créer le compte</button>
      </div>
    </form>`;
}

function userForm(user) {
  const self = state.user && state.user.id === user.id;
  return `<form class="user-card" data-user-id="${user.id}">
    <div class="form-grid">
      <label class="field">Nom
        <input name="nom" required maxlength="160" value="${esc(user.nom)}">
      </label>
      <label class="field">Identifiant
        <input value="${esc(user.identifiant)}" disabled>
      </label>
      <label class="field">Profil
        <select name="role">
          <option value="admin" ${user.role === "admin" ? "selected" : ""}>Administrateur</option>
          <option value="consultation" ${user.role === "consultation" ? "selected" : ""}>Consultation</option>
        </select>
      </label>
      <label class="field">Nouveau mot de passe
        <input name="motDePasse" type="password" minlength="8" autocomplete="new-password" placeholder="Laisser vide pour le conserver">
      </label>
      <label class="check span2">
        <input type="checkbox" name="actif" ${user.actif ? "checked" : ""} ${self ? "disabled" : ""}>
        Compte actif${self ? " — le vôtre reste actif" : ""}
      </label>
    </div>
    <p class="form-error" hidden></p>
    <div class="form-actions">
      <button class="btn" type="submit">Enregistrer</button>
      ${user.premier
        ? ""
        : `<button class="btn ghost" type="button" data-action="delete-user" data-id="${user.id}">Supprimer</button>`}
    </div>
    ${user.premier ? `<p class="fine">Le premier administrateur ne peut pas être supprimé.</p>` : ""}
  </form>`;
}

function journalHtml() {
  if (!state.journal.length) {
    return `<section class="card empty-block">
      <h2>Pas encore d'intervention</h2>
      <p>Quand vous mettez à jour une fiche ou enregistrez un remplacement, la trace apparaît ici.</p>
    </section>`;
  }
  return `<section class="card">
    <header class="card-head">
      <h2>${state.journal.length} entrée${state.journal.length > 1 ? "s" : ""}</h2>
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
  const manage = canManage();
  if (creating && !manage) {
    return `<section class="card empty-block"><h2>Consultation seule</h2><p>L'ajout d'une imprimante est réservé aux administrateurs.</p><a class="btn" href="#/parc">Retour au parc</a></section>`;
  }
  const printer = creating ? blankPrinter() : printerById(id);
  if (!printer) {
    return `<section class="card empty-block"><h2>Machine introuvable</h2><p>Elle a peut-être été retirée du parc.</p><a class="btn" href="#/parc">Retour au parc</a></section>`;
  }
  const code = creating ? "ok" : statut(printer);
  const history = state.journal.filter((entry) => entry.printerId === printer.id);
  const hasIp = isIpv4(printer.adresse);
  return `
    <p class="back"><a href="#/parc">← Retour au parc</a></p>
    <header class="fiche-head">
      <div>
        <p class="eyebrow">${creating ? "Création" : esc(printer.departement)}</p>
        <h2>${creating ? "Nouvelle imprimante" : esc(printer.nom)}</h2>
        ${creating ? "" : `<p class="subline">${esc(printer.emplacement)} · <code>${esc(adresseLabel(printer))}</code></p>`}
      </div>
      ${creating ? "" : `<span class="pill ${code}">${esc(statutLabel(code))}</span>`}
    </header>
    ${manage ? "" : `<p class="callout">Consultation seule. Les modifications du parc sont réservées aux administrateurs.</p>`}
    <form id="printer-form" data-id="${esc(printer.id || "")}">
      <fieldset class="plain" ${manage ? "" : "disabled"}>
      <div class="fiche-grid">
      <section class="card span2">
        <h2>Identité</h2>
        <div class="form-grid">
          <label class="field span2">Nom
            <input name="nom" required value="${esc(printer.nom)}" placeholder="HP Color LaserJet M552">
          </label>
          <label class="field">Département
            <select name="departement" required>
              ${departmentOptions(printer.departement)}
            </select>
          </label>
          <label class="field">Emplacement
            <select name="emplacement" required>
              ${emplacementOptions(printer.departement, printer.emplacement)}
            </select>
          </label>
          <p class="fine span2" data-lieu-note>${esc(lieuNote(printer.departement))}</p>
          ${manage ? `<div class="composer composer-pair span2" data-composer="dept">
            <input name="draftDept" maxlength="80" placeholder="Nouveau département" autocomplete="off" aria-label="Nouveau département">
            <button class="btn" type="button" data-action="add-dept">Ajouter le département</button>
          </div>
          <div class="composer composer-pair span2" data-composer="lieu" data-lieu-draft ${printer.departement ? "" : "hidden"}>
            <input name="draftLieu" maxlength="160" placeholder="Nouvel emplacement de ce département" autocomplete="off" aria-label="Nouvel emplacement">
            <button class="btn" type="button" data-action="add-lieu">Ajouter l'emplacement</button>
          </div>` : ""}
          <label class="check span2"><input type="checkbox" name="couleur" ${printer.couleur ? "checked" : ""}> Imprimante couleur</label>
          <label class="check span2"><input type="checkbox" name="aAdresse" ${hasIp ? "checked" : ""}> Cette imprimante a une adresse IP</label>
          <div class="ip-fields span2" ${hasIp ? "" : "hidden"}>
            <label class="field">Adresse IP
              <input name="adresse" value="${hasIp ? esc(printer.adresse) : ""}" placeholder="195.200.200.12" inputmode="decimal">
            </label>
            <label class="field">Communauté SNMP
              <input name="snmpCommunaute" value="${esc(printer.snmpCommunaute || "public")}" autocomplete="off">
            </label>
            ${manage ? `<div class="span2"><button class="btn" type="button" data-action="lire-snmp">Lire les cartouches et les kits</button><p class="fine">La requête SNMP remplit les noms et les niveaux. Vous pouvez les corriger avant d'enregistrer.</p></div>` : ""}
          </div>
          <p class="fine ip-local span2" ${hasIp ? "hidden" : ""}>Sans adresse IP, la machine est enregistrée comme poste local.</p>
          <label class="field span2">Observation
            <textarea name="observation" rows="3" placeholder="RAS ou le remplacement à prévoir">${esc(printer.observation || "")}</textarea>
          </label>
        </div>
      </section>
      <section class="card span2">
        <h2>Cartouches</h2>
        <p class="hint">${creating || !printer.niveauxLe ? "Indiquez la marque, le nom exact de la cartouche et le pourcentage." : `Dernière lecture : ${esc(formatDate(printer.niveauxLe))}.`} La lecture SNMP reprend le nom exact et le niveau renvoyés par l'imprimante.</p>
        ${manage ? `<div class="supply-grid composer" data-composer="toner">
          <input name="draftMarque" placeholder="Marque" autocomplete="off" aria-label="Marque de la cartouche">
          <input name="draftType" placeholder="Nom de la cartouche" autocomplete="off" aria-label="Nom de la cartouche">
          <input name="draftNiveau" type="number" min="0" max="100" placeholder="%" aria-label="Pourcentage de la cartouche">
          <button class="btn" type="button" data-action="add-toner">Ajouter</button>
        </div>` : ""}
        <div id="cartouches" class="kits">
          ${cartouchesOf(printer).map((item) => cartoucheRow(item, manage)).join("")}
        </div>
      </section>
      <section class="card span2">
        <header class="card-head"><h2>Kits et consommables</h2></header>
        ${manage ? `<div class="composer" data-composer="kit">
          <input name="draftKit" placeholder="Nom du kit" autocomplete="off" aria-label="Nom du nouveau kit">
          <input name="draftKitLevel" type="number" min="0" max="100" placeholder="%" aria-label="Pourcentage du nouveau kit">
          <button class="btn" type="button" data-action="add-kit">Ajouter</button>
        </div>` : ""}
        <div id="kits" class="kits">
          ${(printer.kits || []).map((kit) => kitRow(kit.label, kit.level, manage)).join("")}
        </div>
        <p class="form-error" id="form-error" hidden></p>
        <div class="form-actions">
          ${manage ? `<button class="btn btn-primary" type="submit">Enregistrer</button>` : ""}
          ${creating ? `<a class="btn" href="#/parc">Annuler</a>` : (manage ? `<button class="btn danger" type="button" data-action="delete" data-id="${esc(printer.id)}">Supprimer</button>` : "")}
        </div>
      </section>
      </div>
      </fieldset>
    </form>
    ${creating || !manage ? "" : interventionHtml(printer, history)}`;
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
    cartouches: [],
    kits: [],
    observation: "",
    releve: "",
    niveauxLe: null,
    snmpCommunaute: "public",
  };
}

function adresseLabel(printer) {
  return isLocal(printer) ? "Local" : printer.adresse;
}

function lieuOptions(departement) {
  const known = (state.places || []).find((item) => item.nom === departement);
  return known ? known.emplacements.map((item) => item.nom) : [];
}

function departmentOptions(current) {
  const names = departments();
  const options = [`<option value="">Choisir un département</option>`];
  for (const nom of names) {
    options.push(`<option value="${esc(nom)}" ${nom === current ? "selected" : ""}>${esc(nom)}</option>`);
  }
  return options.join("");
}

function emplacementOptions(departement, current) {
  const names = lieuOptions(departement);
  const placeholder = departement ? "Choisir un emplacement" : "Choisissez d'abord un département";
  const options = [`<option value="">${esc(placeholder)}</option>`];
  for (const nom of names) {
    options.push(`<option value="${esc(nom)}" ${nom === current ? "selected" : ""}>${esc(nom)}</option>`);
  }
  return options.join("");
}

function lieuNote(departement) {
  if (!departement) return "Choisissez un département pour afficher ses emplacements.";
  const count = lieuOptions(departement).length;
  if (!count) return `${departement} n'a pas encore d'emplacement.`;
  return `${count} emplacement${count > 1 ? "s" : ""} dans ${departement}.`;
}

function cartouchesOf(printer) {
  if (Array.isArray(printer.cartouches) && printer.cartouches.length) return printer.cartouches;
  const rows = [];
  for (const [key, label] of [["noir", "Noir"], ["cyan", "Cyan"], ["magenta", "Magenta"], ["jaune", "Jaune"]]) {
    if (printer[key] !== null && printer[key] !== undefined && printer[key] !== "") {
      rows.push({ key, marque: "", type: label, value: printer[key], swatch: "" });
    }
  }
  for (const item of printer.extra || []) {
    rows.push({
      key: item.key,
      marque: item.marque || "",
      type: item.type || item.label,
      value: item.value,
      swatch: item.swatch || "",
    });
  }
  return rows;
}

function cartoucheRow(item, editable = true) {
  const hasLevel = item.value !== null && item.value !== undefined && item.value !== "";
  let marque = readableSupplyName(item.marque || "");
  let type = readableSupplyName(item.nom || item.type || "");
  if (!type && marque) {
    type = marque;
    marque = "";
  }
  return `<div class="supply-grid cartouche-row" data-key="${esc(item.key || "")}" data-swatch="${esc(item.swatch || "")}">
    <input name="cartoucheMarque" value="${esc(marque)}" placeholder="Marque" aria-label="Marque de la cartouche">
    <input name="cartoucheType" value="${esc(type)}" placeholder="Nom de la cartouche" aria-label="Nom de la cartouche">
    <input name="cartoucheNiveau" type="number" min="0" max="100" value="${hasLevel ? Number(item.value) : ""}" placeholder="%" aria-label="Pourcentage de la cartouche">
    ${editable ? `<button class="btn ghost" type="button" data-action="remove-toner">Retirer</button>` : ""}
  </div>`;
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

function tonerRow(label, level, key = "", swatch = "", editable = true) {
  const hasLevel = level !== null && level !== undefined && level !== "";
  const tone = swatch || TONER_SWATCHES[0];
  return `<div class="kit-row toner-row" data-key="${esc(key)}" data-swatch="${esc(tone)}">
    <input name="tonerLabel" value="${esc(label)}" placeholder="Gris, noir photo, réservoir…" aria-label="Nom du toner">
    <input name="tonerLevel" type="number" min="0" max="100" value="${hasLevel ? Number(level) : ""}" placeholder="%" aria-label="Pourcentage du toner">
    ${editable ? `<button class="btn ghost" type="button" data-action="remove-toner">Retirer</button>` : ""}
  </div>`;
}

function kitRow(label, level, editable = true) {
  const hasLevel = level !== null && level !== undefined && level !== "";
  return `<div class="kit-row">
    <input name="kitLabel" value="${esc(readableSupplyName(label))}" placeholder="Kit de fusion, tambour…" aria-label="Nom du kit">
    <input name="kitLevel" type="number" min="0" max="100" value="${hasLevel ? Number(level) : ""}" placeholder="OK" aria-label="Niveau du kit en pourcentage">
    ${editable ? `<button class="btn ghost" type="button" data-action="remove-kit">Retirer</button>` : ""}
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
  const hasIp = data.get("aAdresse") === "on";
  let adresse = "Localhost";
  if (hasIp) {
    adresse = String(data.get("adresse") || "").trim();
    if (!isIpv4(adresse)) return { error: "Indiquez une adresse IPv4, ou décochez l'adresse IP pour un poste local." };
  }
  const kits = [...form.querySelectorAll(".kit-row")].map((row) => {
    const label = row.querySelector('[name="kitLabel"]').value.trim();
    const raw = row.querySelector('[name="kitLevel"]').value.trim();
    if (!label) return null;
    return { label, level: raw === "" ? null : clamp(raw) };
  }).filter(Boolean);
  const cartouches = readCartouches(form);
  if (cartouches.error) return cartouches;
  const brands = [...new Set(cartouches.rows.map((item) => item.marque).filter(Boolean))];

  const next = {
    ...(previous || {}),
    id: previous?.id || uid("imp"),
    nom,
    departement,
    emplacement,
    adresse,
    couleur: data.get("couleur") === "on",
    fourniture: brands.join(", ") || previous?.fourniture || "",
    snmpCommunaute: String(data.get("snmpCommunaute") || "").trim() || "public",
    observation: String(data.get("observation") || "").trim() || "RAS",
    cartouches: cartouches.rows,
    kits,
    releve: "",
    ecart: false,
  };
  const changed = JSON.stringify(tonerSnapshot(previous || {})) !== JSON.stringify(tonerSnapshot(next));
  if (!previous || changed) next.niveauxLe = new Date().toISOString();
  else next.niveauxLe = previous.niveauxLe || new Date().toISOString();
  return { printer: next, changed };
}

function readCartouches(form) {
  const rows = [];
  for (const row of form.querySelectorAll(".cartouche-row")) {
    const marque = row.querySelector('[name="cartoucheMarque"]').value.trim();
    const type = row.querySelector('[name="cartoucheType"]').value.trim();
    const raw = row.querySelector('[name="cartoucheNiveau"]').value.trim();
    if (!marque && !type && raw === "") continue;
    if (!type) return { error: "Indiquez le nom de chaque cartouche." };
    if (raw === "") return { error: `Indiquez le pourcentage de ${type}.` };
    rows.push({
      key: row.dataset.key || uid("ton"),
      marque,
      type,
      value: clamp(raw),
      swatch: row.dataset.swatch || TONER_SWATCHES[rows.length % TONER_SWATCHES.length],
    });
  }
  return { rows };
}

function tonerSnapshot(printer) {
  return {
    cartouches: cartouchesOf(printer).map((item) => ({
      marque: item.marque || "",
      type: item.type || "",
      value: item.value ?? null,
    })),
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

function showFormError(form, message) {
  const node = form.querySelector(".form-error");
  if (!node) return;
  node.hidden = !message;
  node.textContent = message || "";
  if (message) node.scrollIntoView({ block: "nearest" });
}

function sessionLost(err) {
  if (err.status !== 401) return false;
  state.user = null;
  state.users = null;
  state.printers = [];
  state.journal = [];
  state.selected = new Set();
  state.error = "";
  state.loading = false;
  paint();
  return true;
}

let usersRequest = null;

async function ensureUsers() {
  if (!canManage() || route().name !== "utilisateurs" || state.users !== null) return;
  if (!usersRequest) {
    usersRequest = api("/api/users").finally(() => {
      usersRequest = null;
    });
  }
  const data = await usersRequest;
  state.users = Array.isArray(data.users) ? data.users : [];
}

async function openSession() {
  state.loading = true;
  state.error = "";
  paint();
  try {
    state.user = await api("/api/me");
    await refresh();
    await ensureUsers();
    state.error = "";
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      state.users = null;
      state.error = "";
    } else {
      state.error = err.message;
    }
  } finally {
    state.loading = false;
    paint();
  }
}

async function login(form) {
  if (state.busy) return;
  state.busy = true;
  const identifiant = form.identifiant.value.trim();
  const motDePasse = form.motDePasse.value;
  try {
    state.user = await api("/api/login", {
      method: "POST",
      body: { identifiant, motDePasse },
    });
    state.error = "";
    state.loading = true;
    paint();
    await refresh();
    await ensureUsers();
    state.loading = false;
    paint();
  } catch (err) {
    state.loading = false;
    if (state.user && sessionLost(err)) return;
    if (!state.user) {
      paint();
      const next = document.getElementById("login-form");
      if (next) {
        next.identifiant.value = identifiant;
        showFormError(next, err.message);
      }
      return;
    }
    state.error = err.message;
    paint();
  } finally {
    state.busy = false;
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* La session locale est fermée même si le serveur ne répond plus. */
  }
  state.user = null;
  state.users = null;
  state.printers = [];
  state.journal = [];
  state.selected = new Set();
  state.error = "";
  state.loading = false;
  paint();
}

async function createUser(form) {
  if (state.busy) return;
  const data = new FormData(form);
  state.busy = true;
  showFormError(form, "");
  try {
    const saved = await api("/api/users", {
      method: "POST",
      body: {
        nom: String(data.get("nom") || "").trim(),
        identifiant: String(data.get("identifiant") || "").trim(),
        motDePasse: String(data.get("motDePasse") || ""),
        role: String(data.get("role") || "consultation"),
      },
    });
    state.users = [...(state.users || []), saved.user].sort((a, b) => (
      a.nom.localeCompare(b.nom, "fr") || a.identifiant.localeCompare(b.identifiant, "fr")
    ));
    toast(`Compte ${saved.user.identifiant} créé.`);
    paint();
  } catch (err) {
    if (sessionLost(err)) return;
    showFormError(form, err.message);
  } finally {
    state.busy = false;
  }
}

async function deleteUser(id) {
  if (state.busy) return;
  const user = (state.users || []).find((item) => item.id === id);
  if (!user || user.premier) return;
  state.busy = true;
  try {
    await api(`/api/users/${id}`, { method: "DELETE" });
    state.users = (state.users || []).filter((item) => item.id !== id);
    if (state.user && state.user.id === id) {
      toast("Compte supprimé.");
      await logout();
      return;
    }
    toast(`Compte ${user.identifiant} supprimé.`);
    paint();
  } catch (err) {
    if (!sessionLost(err)) toast(err.message);
  } finally {
    state.busy = false;
  }
}

async function saveUser(form) {
  if (state.busy) return;
  const id = Number(form.dataset.userId);
  const data = new FormData(form);
  const actifBox = form.querySelector('[name="actif"]');
  const motDePasse = String(data.get("motDePasse") || "");
  state.busy = true;
  showFormError(form, "");
  try {
    const saved = await api(`/api/users/${id}`, {
      method: "PUT",
      body: {
        nom: String(data.get("nom") || "").trim(),
        role: String(data.get("role") || ""),
        actif: actifBox ? (actifBox.disabled ? true : actifBox.checked) : true,
        ...(motDePasse ? { motDePasse } : {}),
      },
    });
    state.users = (state.users || []).map((user) => (user.id === saved.user.id ? saved.user : user));
    if (state.user && state.user.id === saved.user.id) {
      state.user = {
        ...state.user,
        nom: saved.user.nom,
        role: saved.user.role,
        actif: saved.user.actif,
      };
    }
    toast("Compte mis à jour.");
    paint();
  } catch (err) {
    if (sessionLost(err)) return;
    showFormError(form, err.message);
  } finally {
    state.busy = false;
  }
}

async function savePrinter(form) {
  if (!canManage()) return;
  if (state.busy) {
    showFormError(form, "Patientez, une lecture est encore en cours.");
    return;
  }
  const error = document.getElementById("form-error");
  const id = form.dataset.id;
  const previous = id ? printerById(id) : null;
  let result;
  try {
    result = readPrinter(form, previous);
  } catch (err) {
    if (error) {
      error.hidden = false;
      error.textContent = "L'enregistrement a échoué. Réessayez.";
    }
    return;
  }
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
    if (Array.isArray(saved.departements)) state.places = saved.departements;
    state.journal.unshift(saved.entry);
    toast(previous ? "Fiche enregistrée." : "Imprimante ajoutée au parc.");
    location.hash = `#/imprimante/${saved.printer.id}`;
    paint();
  } catch (err) {
    if (sessionLost(err)) return;
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
    cartouches: cartouchesOf(printer).map((item) => ({ ...item })),
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
    const key = map[type];
    const target = (next.cartouches || []).find((item) => item.key === key)
      || (next.cartouches || []).find((item) => String(item.type || "").toLowerCase() === key);
    if (target) target.value = 100;
    else if (next[key] !== null && next[key] !== undefined) next[key] = 100;
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
    if (!sessionLost(err)) toast(err.message);
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
    if (!sessionLost(err)) toast(err.message);
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

function bindComposers() {
  for (const button of document.querySelectorAll("[data-action=add-toner], [data-action=add-kit]")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        if (button.dataset.action === "add-toner") addDraftToner();
        else addDraftKit();
      } catch (err) {
        const form = document.getElementById("printer-form");
        if (form) showFormError(form, "L'ajout a échoué. Réessayez.");
      }
    });
  }
  for (const composer of document.querySelectorAll("[data-composer]")) {
    composer.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      const kind = composer.dataset.composer;
      if (kind === "toner") addDraftToner();
      else if (kind === "lieu") addDraftLieu();
      else if (kind === "dept") addDraftDept();
      else addDraftKit();
    });
  }
}

function addDraftToner() {
  const form = document.getElementById("printer-form");
  const list = document.getElementById("cartouches");
  if (!form || !list || !canManage()) return;
  const marque = form.draftMarque.value.trim();
  const type = form.draftType.value.trim();
  const raw = form.draftNiveau.value.trim();
  if (!type) {
    showFormError(form, "Indiquez le nom de la cartouche à ajouter.");
    form.draftType.focus();
    return;
  }
  if (raw === "" || Number.isNaN(Number(raw))) {
    showFormError(form, `Indiquez le pourcentage de ${type}.`);
    form.draftNiveau.focus();
    return;
  }
  const value = Math.max(0, Math.min(100, Math.round(Number(raw))));
  const swatch = TONER_SWATCHES[list.querySelectorAll(".cartouche-row").length % TONER_SWATCHES.length];
  list.insertAdjacentHTML("beforeend", cartoucheRow({ marque, type, value, key: uid("ton"), swatch }, true));
  form.draftMarque.value = "";
  form.draftType.value = "";
  form.draftNiveau.value = "";
  showFormError(form, "");
  list.lastElementChild?.scrollIntoView({ block: "nearest" });
  form.draftMarque.focus();
}

function addDraftKit() {
  const form = document.getElementById("printer-form");
  const list = document.getElementById("kits");
  if (!form || !list || !canManage()) return;
  const label = form.draftKit.value.trim();
  const raw = form.draftKitLevel.value.trim();
  if (!label) {
    showFormError(form, "Nommez le kit à ajouter.");
    form.draftKit.focus();
    return;
  }
  const level = raw === "" ? null : Math.max(0, Math.min(100, Math.round(Number(raw))));
  if (raw !== "" && Number.isNaN(Number(raw))) {
    showFormError(form, "Le pourcentage du kit est invalide.");
    return;
  }
  list.insertAdjacentHTML("beforeend", kitRow(label, level));
  form.draftKit.value = "";
  form.draftKitLevel.value = "";
  showFormError(form, "");
  list.lastElementChild?.scrollIntoView({ block: "nearest" });
  form.draftKit.focus();
}

function isIpv4(value) {
  const parts = String(value || "").split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

async function releverPrinter(id) {
  if (state.busy || !canManage()) return;
  const form = document.getElementById("printer-form");
  state.busy = true;
  toast("Lecture des niveaux…");
  try {
    const data = await api(`/api/printers/${encodeURIComponent(id)}/relever`, {
      method: "POST",
      body: {
        adresse: form?.adresse?.value?.trim() || "",
        communaute: form?.snmpCommunaute?.value?.trim() || "public",
      },
    });
    replacePrinter(data.printer);
    if (data.entry) state.journal.unshift(data.entry);
    toast(data.message || "Niveaux lus sur l'imprimante.");
    paint();
  } catch (err) {
    if (!sessionLost(err)) toast(err.message);
  } finally {
    state.busy = false;
  }
}

async function releverParc() {
  if (state.busy || !canManage()) return;
  const targets = state.printers.filter((printer) => isIpv4(printer.adresse));
  if (!targets.length) {
    toast("Aucune adresse IP à interroger.");
    return;
  }
  state.busy = true;
  let ok = 0;
  let failed = 0;
  toast(`Lecture de ${targets.length} adresse${targets.length > 1 ? "s" : ""}…`);
  try {
    for (const printer of targets) {
      try {
        const data = await api(`/api/printers/${encodeURIComponent(printer.id)}/relever`, {
          method: "POST",
          body: {},
        });
        replacePrinter(data.printer);
        if (data.entry) state.journal.unshift(data.entry);
        ok += 1;
      } catch (err) {
        if (sessionLost(err)) return;
        failed += 1;
      }
    }
  } finally {
    state.busy = false;
    paint();
  }
  toast(`${ok} imprimante${ok > 1 ? "s" : ""} lue${ok > 1 ? "s" : ""}${failed ? `, ${failed} sans réponse` : ""}.`);
}

async function savePlaces(path, method, body, success) {
  if (state.busy) return;
  state.busy = true;
  try {
    const saved = await api(path, { method, body });
    state.places = saved.departements;
    await refresh();
    toast(success);
    paint();
  } catch (err) {
    if (!sessionLost(err)) toast(err.message);
  } finally {
    state.busy = false;
  }
}

function onClick(event) {
  const actionNode = event.target.closest("[data-action]");
  const action = actionNode?.dataset.action;
  if (action === "logout") {
    logout();
    return;
  }
  if (action === "menu") {
    document.body.classList.toggle("nav-open");
    return;
  }
  if (action === "retry") {
    openSession();
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
    event.preventDefault();
    addDraftToner();
    return;
  }
  if (action === "remove-toner") {
    event.preventDefault();
    actionNode.closest(".cartouche-row")?.remove();
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
    event.preventDefault();
    addDraftKit();
    return;
  }
  if (action === "add-lieu") {
    event.preventDefault();
    addDraftLieu();
    return;
  }
  if (action === "add-dept") {
    event.preventDefault();
    addDraftDept();
    return;
  }
  if (action === "lire-snmp") {
    event.preventDefault();
    lireSnmpForm();
    return;
  }
  if (action === "relever") {
    event.preventDefault();
    releverPrinter(actionNode.dataset.id);
    return;
  }
  if (action === "relever-parc") {
    event.preventDefault();
    releverParc();
    return;
  }
  if (action === "delete-user") {
    event.preventDefault();
    if (!canManage()) return;
    const id = Number(actionNode.dataset.id);
    const user = (state.users || []).find((item) => item.id === id);
    if (!user || user.premier) return;
    if (actionNode.dataset.confirm !== "1") {
      actionNode.dataset.confirm = "1";
      actionNode.textContent = "Confirmer la suppression";
      return;
    }
    deleteUser(id);
    return;
  }
  if (action === "delete-dept") {
    event.preventDefault();
    if (actionNode.dataset.confirm !== "1") {
      actionNode.dataset.confirm = "1";
      actionNode.textContent = "Confirmer";
      return;
    }
    savePlaces(`/api/departements/${actionNode.dataset.id}`, "DELETE", null, "Département retiré.");
    return;
  }
  if (action === "delete-lieu") {
    event.preventDefault();
    if (actionNode.dataset.confirm !== "1") {
      actionNode.dataset.confirm = "1";
      actionNode.textContent = "Confirmer";
      return;
    }
    savePlaces(`/api/emplacements/${actionNode.dataset.id}`, "DELETE", null, "Emplacement retiré.");
    return;
  }
  if (action === "remove-kit") {
    event.preventDefault();
    actionNode.closest(".kit-row")?.remove();
    return;
  }
  if (action === "delete") {
    if (!canManage()) return;
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
  const form = event.target;
  if (form.id === "login-form") {
    event.preventDefault();
    login(form);
    return;
  }
  if (form.id === "user-create") {
    event.preventDefault();
    createUser(form);
    return;
  }
  if (form.dataset.userId) {
    event.preventDefault();
    saveUser(form);
    return;
  }
  if (form.id === "printer-form") {
    event.preventDefault();
    savePrinter(form);
    return;
  }
  if (form.id === "dept-create") {
    event.preventDefault();
    savePlaces("/api/departements", "POST", { nom: form.nom.value.trim() }, "Département ajouté.");
    return;
  }
  if (form.dataset.deptId) {
    event.preventDefault();
    savePlaces(`/api/departements/${form.dataset.deptId}`, "PUT", { nom: form.nom.value.trim() }, "Département renommé.");
    return;
  }
  if (form.dataset.lieuId) {
    event.preventDefault();
    savePlaces(`/api/emplacements/${form.dataset.lieuId}`, "PUT", { nom: form.nom.value.trim() }, "Emplacement renommé.");
    return;
  }
  if (form.dataset.lieuCreate) {
    event.preventDefault();
    savePlaces("/api/emplacements", "POST", {
      departementId: Number(form.dataset.lieuCreate),
      nom: form.nom.value.trim(),
    }, "Emplacement ajouté.");
  }
  if (form.id === "intervention-form") {
    event.preventDefault();
    applyIntervention(form);
  }
}

async function onNavigate() {
  if (!state.user) {
    paint();
    return;
  }
  try {
    if (canManage() && route().name === "utilisateurs" && state.users === null) {
      paint();
      await ensureUsers();
    }
  } catch (err) {
    if (!sessionLost(err)) state.error = err.message;
  }
  if (state.user) paint();
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

function syncEmplacements(form, preferred) {
  const select = form.emplacement;
  if (!select) return;
  const departement = form.departement.value.trim();
  const names = lieuOptions(departement);
  const wanted = preferred === undefined ? select.value : preferred;
  const keep = names.includes(wanted) ? wanted : "";
  select.innerHTML = emplacementOptions(departement, keep);
  select.value = keep;
  const draft = form.querySelector("[data-lieu-draft]");
  if (draft) draft.hidden = !departement;
  const note = form.querySelector("[data-lieu-note]");
  if (note) note.textContent = lieuNote(departement);
}

function syncDepartements(form, preferred) {
  const select = form.departement;
  if (!select) return;
  const names = departments();
  const wanted = preferred === undefined ? select.value : preferred;
  const keep = names.includes(wanted) ? wanted : "";
  select.innerHTML = departmentOptions(keep);
  select.value = keep;
  syncEmplacements(form);
}

async function addDraftDept() {
  const form = document.getElementById("printer-form");
  if (!form || !canManage()) return;
  if (state.busy) {
    showFormError(form, "Patientez, une opération est en cours.");
    return;
  }
  const nom = form.draftDept?.value.trim() || "";
  if (!nom) {
    showFormError(form, "Nommez le département à ajouter.");
    form.draftDept.focus();
    return;
  }
  state.busy = true;
  showFormError(form, "");
  try {
    try {
      const saved = await api("/api/departements", { method: "POST", body: { nom } });
      state.places = saved.departements;
    } catch (err) {
      if (err.status !== 409) throw err;
      const fresh = await api("/api/places");
      state.places = fresh.departements;
    }
    if (form.draftDept) form.draftDept.value = "";
    syncDepartements(form, nom);
    toast("Département ajouté.");
    form.draftLieu?.focus();
  } catch (err) {
    if (!sessionLost(err)) showFormError(form, err.message);
  } finally {
    state.busy = false;
  }
}

async function addDraftLieu() {
  const form = document.getElementById("printer-form");
  if (!form || !canManage()) return;
  if (state.busy) {
    showFormError(form, "Patientez, une opération est en cours.");
    return;
  }
  const departement = form.departement.value.trim();
  const nom = form.draftLieu?.value.trim() || "";
  if (!departement) {
    showFormError(form, "Choisissez le département avant d'ajouter un emplacement.");
    form.departement.focus();
    return;
  }
  if (!nom) {
    showFormError(form, "Nommez l'emplacement à ajouter.");
    form.draftLieu.focus();
    return;
  }
  state.busy = true;
  showFormError(form, "");
  try {
    let place = (state.places || []).find((item) => item.nom === departement);
    if (!place) {
      const created = await api("/api/departements", { method: "POST", body: { nom: departement } });
      state.places = created.departements;
      place = state.places.find((item) => item.nom === departement);
    }
    if (!place) throw new Error("Département introuvable.");
    let created = true;
    try {
      const saved = await api("/api/emplacements", {
        method: "POST",
        body: { departementId: place.id, nom },
      });
      state.places = saved.departements;
    } catch (err) {
      if (err.status !== 409) throw err;
      created = false;
      const fresh = await api("/api/places");
      state.places = fresh.departements;
    }
    if (form.draftLieu) form.draftLieu.value = "";
    syncEmplacements(form, nom);
    toast(created ? `Emplacement ajouté à ${departement}.` : `${nom} est déjà dans ${departement}.`);
  } catch (err) {
    if (!sessionLost(err)) showFormError(form, err.message);
  } finally {
    state.busy = false;
  }
}

async function lireSnmpForm() {
  const form = document.getElementById("printer-form");
  if (!form || !canManage() || state.busy || !form.aAdresse?.checked) return;
  const adresse = form.adresse.value.trim();
  if (!isIpv4(adresse)) {
    showFormError(form, "Indiquez une adresse IPv4 pour interroger l'imprimante.");
    form.adresse.focus();
    return;
  }
  state.busy = true;
  toast("Lecture des niveaux…");
  try {
    const data = await api("/api/snmp", {
      method: "POST",
      body: { adresse, communaute: form.snmpCommunaute?.value?.trim() || "public" },
    });
    mergeSupplyRows(document.getElementById("cartouches"), data.cartouches || [], "type", (item) => cartoucheRow(item, true));
    mergeSupplyRows(document.getElementById("kits"), data.kits || [], "label", (item) => kitRow(item.label, item.level, true));
    showFormError(form, "");
    toast(data.message || "Niveaux lus.");
  } catch (err) {
    if (!sessionLost(err)) toast(err.message);
  } finally {
    state.busy = false;
  }
}

function mergeSupplyRows(list, items, field, render) {
  if (!list) return;
  for (const item of items) {
    const name = readableSupplyName(item[field] || "").trim().toLowerCase();
    const rows = [...list.children];
    const found = rows.find((row) => {
      const input = row.querySelector(field === "type" ? "[name=cartoucheType]" : "[name=kitLabel]");
      return input && readableSupplyName(input.value).trim().toLowerCase() === name && name;
    });
    if (found) {
      const level = found.querySelector(field === "type" ? "[name=cartoucheNiveau]" : "[name=kitLevel]");
      if (level) level.value = field === "type" ? item.value : item.level;
      continue;
    }
    list.insertAdjacentHTML("beforeend", render(item));
  }
}

function onChange(event) {
  const field = event.target;
  if (field.name === "departement" && field.form?.id === "printer-form") {
    syncEmplacements(field.form);
    return;
  }
  if (field.name === "aAdresse" && field.form?.id === "printer-form") {
    const on = field.checked;
    const block = field.form.querySelector(".ip-fields");
    const note = field.form.querySelector(".ip-local");
    if (block) block.hidden = !on;
    if (note) note.hidden = on;
    if (on) field.form.adresse?.focus();
    return;
  }
  if (field.name === "adresse" && field.form?.id === "printer-form" && field.form.aAdresse?.checked) {
    lireSnmpForm();
    return;
  }
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
  window.addEventListener("hashchange", () => {
    onNavigate();
  });
  if (!location.hash) location.hash = "#/tableau";
  await openSession();
}

boot();
