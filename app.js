/* Granollers Live: segueix en directe un partit de la FCBQ sumant els parcials per període.
   Interfície en català; comentaris en castellano. */
import { createClient, regulationPeriods, FcbqError } from './fcbq.js';

const SETTINGS_KEY = 'basquet-settings-v2';
const SNAPSHOT_KEY = 'basquet-snapshots-v2';
const STANDINGS_KEY = 'basquet-standings-v1';
const STANDINGS_TTL_MS = 30 * 60 * 1000;
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const LIVE_POLL_MS = DEMO ? 3000 : 10000;
const WAIT_POLL_MS = 60000;
const DEFAULT_CLUB = '1'; // Club Bàsquet Granollers

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- ajustes y caché ---------- */
function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }
function saveJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }

let settings = loadJSON(SETTINGS_KEY, {});
let snapshots = loadJSON(SNAPSHOT_KEY, {});
if (!Array.isArray(settings.favorites)) settings.favorites = [];
if (!settings.players || typeof settings.players !== 'object') settings.players = {}; // { teamId: { id, name } }
if (settings.teamId && !settings.favorites.some((f) => f.id === settings.teamId)) {
  settings.favorites.push({ id: settings.teamId, name: settings.teamName, category: '', clubId: settings.clubId || '' });
}
importConfigFromUrl();

const apiKey = () => settings.apiKey || (window.FCBQ_CONFIG && window.FCBQ_CONFIG.apiKey) || '';
let api = buildClient();
function buildClient() { return DEMO ? demoClient() : createClient({ apiKey: apiKey() }); }

/* Configuración compartida por QR: ?cfg=<base64url de JSON>. */
function importConfigFromUrl() {
  const cfg = params.get('cfg');
  if (!cfg) return;
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cfg.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    const favorites = [...(json.favorites || [])];
    for (const f of settings.favorites) if (!favorites.some((x) => x.id === f.id)) favorites.push(f);
    settings = { ...settings, ...json, favorites: favorites.slice(0, 8) };
    saveJSON(SETTINGS_KEY, settings);
    params.delete('cfg');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params.toString() : ''));
    setTimeout(() => toast('Configuració importada'), 400);
  } catch (_) { /* enlace mal formado: se ignora */ }
}

function exportConfigUrl() {
  const json = JSON.stringify({ teamId: settings.teamId, teamName: settings.teamName, clubId: settings.clubId, favorites: settings.favorites, apiKey: apiKey() || undefined });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}?cfg=${b64}`;
}

/* ---------- estado ---------- */
const state = { screen: 'home', season: [], match: null, live: null, error: null, loading: false, lastUpdate: null, selectedPeriod: null, homeTab: 'calendar', standings: null, standingsLoading: false, finished: false, visitedList: false };
const clubCache = {}; // { clubId: { name, teams } }
const fx = { adGameId: null, home: null, away: null, mine: null, moveKey: null, celebrated: false, wakeLock: null, postFinal: 0 };
let timer = null;

function go(screen, extra = {}) {
  clearTimeout(timer); timer = null;
  Object.assign(state, { screen, error: null }, extra);
  render();
  if (screen === 'home' || screen === 'standings') loadSeason();
  if (screen === 'match') loadMatch();
  window.scrollTo(0, 0);
}

/* Pestanya "Partit": el partit en joc o el d'avui; si no n'hi ha, l'últim obert o el següent. */
async function openMatchTab() {
  clearTimeout(timer); timer = null;
  if (!settings.teamId) { go('setup'); return; }
  if (!state.season.length) {
    state.loading = true; state.screen = 'match'; state.match = null; render();
    try { state.season = (await api.teamSeason(settings.teamId)).sort((a, b) => (a.date || 0) - (b.date || 0)); }
    catch (e) { fail(e); return; }
    state.loading = false;
  }
  const auto = pickMatch(state.season);
  if (auto && (!state.match || state.match.idMatch !== auto.idMatch)) { go('match', { match: auto, live: null, finished: false, selectedPeriod: null }); return; }
  if (state.match) { go('match'); return; }
  state.screen = 'match'; render();
}

function selectTeam(team) {
  const favorites = settings.favorites.filter((f) => f.id !== team.id);
  favorites.unshift({ id: team.id, name: team.name, category: team.category || '', clubId: team.clubId || '' });
  settings = { ...settings, clubId: team.clubId || settings.clubId, teamId: team.id, teamName: team.name, favorites: favorites.slice(0, 8) };
  saveJSON(SETTINGS_KEY, settings);
  Object.assign(state, { season: [], match: null, live: null, standings: null, finished: false });
  openMatchTab();
}

function removeFavorite(id) {
  settings = { ...settings, favorites: settings.favorites.filter((f) => f.id !== id) };
  if (settings.teamId === id) {
    const next = settings.favorites[0];
    settings = { ...settings, teamId: next ? next.id : null, teamName: next ? next.name : null };
  }
  saveJSON(SETTINGS_KEY, settings);
  render();
}

/* Jugadora seguida (una por equipo). */
const myPlayer = () => (settings.players || {})[settings.teamId] || null;
function togglePlayer(p) {
  const cur = myPlayer();
  const players = { ...settings.players };
  if (cur && cur.id === p.id) delete players[settings.teamId]; else players[settings.teamId] = { id: p.id, name: p.name };
  settings = { ...settings, players };
  saveJSON(SETTINGS_KEY, settings);
  render();
}

/* ---------- carga de datos ---------- */
async function loadSeason() {
  if (!settings.teamId) { go('setup'); return; }
  state.loading = true; render();
  try {
    state.season = (await api.teamSeason(settings.teamId)).sort((a, b) => (a.date || 0) - (b.date || 0));
    state.loading = false;
    render();
    if (state.screen === 'standings') loadStandings();
  } catch (e) { fail(e); }
}

/* Partido a abrir automáticamente: el que está en juego, si no el de hoy, si no el último reciente. */
function pickMatch(season) {
  const now = Date.now();
  const live = season.find((m) => m.isLive);
  if (live) return live;
  const today = season.find((m) => m.date && Math.abs(m.date - now) < 4 * 3600e3);
  if (today) return today;
  const recent = season.filter((m) => m.played && m.date && now - m.date < 20 * 3600e3).pop();
  return recent || null;
}

async function loadMatch() {
  const m = state.match;
  if (!m) { state.screen = 'match'; render(); return; }
  state.loading = !state.live; render();
  try {
    if (!m.adGameId) {
      const season = await api.teamSeason(settings.teamId);
      const fresh = season.find((x) => x.idMatch === m.idMatch);
      if (fresh) state.match = fresh;
      state.season = season;
      state.loading = false;
      if (!state.match.adGameId) { render(); schedule(WAIT_POLL_MS); return; }
    }
    let live = null;
    try { live = await api.live(state.match.adGameId); }
    catch (e) { if (!state.match.played) throw e; } // acabado: el feed ya no está; se usa la instantánea
    state.lastUpdate = new Date();
    state.loading = false;
    if (live) {
      state.live = live;
      // Final detectado por la propia acta: "Final de període" del último período con el marcador desnivelado.
      const last = live.moves[live.moves.length - 1];
      const reg = regulationPeriods(state.match.category);
      if (last && last.kind === 'period' && live.period >= reg && live.home.total !== live.away.total) state.finished = true;
      snapshots[live.adGameId] = { ...(snapshots[live.adGameId] || {}), savedAt: Date.now(), live, finished: state.finished };
      pruneSnapshots(); saveJSON(SNAPSHOT_KEY, snapshots);
      render();
      if (state.finished) { if (fx.postFinal++ < 3) schedule(30000); }
      else schedule(LIVE_POLL_MS);
    } else {
      const snap = snapshots[state.match.adGameId];
      state.live = snap ? migrateLive(snap.live) : null;
      state.finished = state.match.played || Boolean(snap);
      if (!state.live) {
        const detail = await api.matchDetail(state.match.adGameId).catch(() => null);
        if (detail) state.match = mergeMatch(state.match, detail);
      }
      render();
      if (!state.match.played) schedule(WAIT_POLL_MS);
    }
  } catch (e) { fail(e); schedule(LIVE_POLL_MS * 3); }
}

function mergeMatch(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined) continue;
    if (k === 'home' || k === 'away') {
      out[k] = { ...base[k] };
      for (const [k2, v2] of Object.entries(v)) if (v2 !== null && v2 !== undefined) out[k][k2] = v2;
    } else out[k] = v;
  }
  return out;
}

/* Instantáneas con formatos anteriores. */
function migrateLive(live) {
  if (!live) return live;
  const zero = () => ({ t1: { made: 0, att: 0 }, t2: { made: 0, att: 0 }, t3: { made: 0, att: 0 } });
  const fix = (t) => {
    if (t.periods.length && typeof t.periods[0] === 'number') t.periods = t.periods.map((n) => ({ score: n, fouls: 0, ...zero() }));
    t.shots = t.shots || zero();
    t.players = (t.players || []).map((p) => ({ fouls: 0, ...zero(), ...p }));
  };
  fix(live.home); fix(live.away);
  live.moves = (live.moves || []).map((mv) => ({ kind: mv.points ? 'basket' : 'other', text: mv.text || mv.move, ...mv }));
  return live;
}

function pruneSnapshots() {
  const ids = Object.keys(snapshots).sort((a, b) => snapshots[b].savedAt - snapshots[a].savedAt);
  for (const id of ids.slice(10)) delete snapshots[id];
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => { if (!document.hidden) loadMatch(); else schedule(2000); }, ms);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.screen === 'match') loadMatch();
  if (state.screen === 'match' && state.live && !state.finished) requestWakeLock();
});

function fail(e) {
  console.error(e);
  state.loading = false;
  state.error = e instanceof FcbqError && e.code === 'NOKEY'
    ? "Falta la clau d'accés. Posa-la a Ajustos."
    : e instanceof FcbqError && /DENIED/i.test(e.message)
      ? "La FCBQ ha rebutjat la clau (potser l'han canviada). Revisa-la a Ajustos."
      : `No s'han pogut carregar les dades (${e.message}).`;
  render();
}

/* ---------- clasificación (calculada con los calendarios del grupo) ---------- */
function currentGroupId(season) {
  const ref = pickMatch(season) || season.filter((m) => m.played).pop() || season[0];
  return ref ? ref.groupId : null;
}

async function loadStandings(force = false) {
  const groupId = currentGroupId(state.season);
  if (!groupId) { state.standings = { rows: [], groupId: null }; render(); return; }
  const cache = loadJSON(STANDINGS_KEY, {});
  const hit = cache[groupId];
  if (!force && hit && Date.now() - hit.savedAt < STANDINGS_TTL_MS) { state.standings = hit; render(); return; }
  state.standingsLoading = true; render();
  try {
    const inGroup = state.season.filter((m) => m.groupId === groupId);
    const teamIds = [...new Set(inGroup.flatMap((m) => [m.home.id, m.away.id]).filter(Boolean))];
    const seasons = await Promise.all(teamIds.map((id) => id === settings.teamId ? state.season : api.teamSeason(id).catch(() => [])));
    const matches = new Map(); const info = {};
    for (const list of seasons) for (const m of list) {
      if (m.groupId !== groupId) continue;
      matches.set(m.idMatch, m);
      info[m.home.id] = { name: m.home.name, logo: m.home.logo || (info[m.home.id] || {}).logo };
      info[m.away.id] = { name: m.away.name, logo: m.away.logo || (info[m.away.id] || {}).logo };
    }
    const table = {};
    for (const id of Object.keys(info)) table[id] = { id, name: info[id].name, logo: info[id].logo, J: 0, G: 0, P: 0, PF: 0, PC: 0 };
    for (const m of matches.values()) {
      if (!m.played || m.home.score === null || m.away.score === null) continue;
      for (const [id, pf, pc] of [[m.home.id, m.home.score, m.away.score], [m.away.id, m.away.score, m.home.score]]) {
        const t = table[id]; if (!t) continue;
        t.J++; t.PF += pf; t.PC += pc; if (pf > pc) t.G++; else t.P++;
      }
    }
    const rows = Object.values(table).map((t) => ({ ...t, pts: 2 * t.G + t.P, diff: t.PF - t.PC }))
      .sort((a, b) => b.pts - a.pts || b.diff - a.diff || b.PF - a.PF);
    const sample = inGroup[0];
    state.standings = { groupId, rows, savedAt: Date.now(), title: `${sample.category || ''} · ${sample.competition || ''}${sample.group ? ' · grup ' + sample.group : ''}`, played: [...matches.values()].filter((m) => m.played).length, total: matches.size };
    cache[groupId] = state.standings; saveJSON(STANDINGS_KEY, cache);
  } catch (e) {
    console.error(e);
    state.standings = { groupId, rows: [], error: "No s'ha pogut calcular la classificació." };
  }
  state.standingsLoading = false; render();
}

/* ---------- utilidades de presentación ---------- */
const fmtDate = (d) => d ? d.toLocaleDateString('ca-ES', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '';
const fmtTime = (d) => d ? d.toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' }) : '';
const periodLabel = (i, reg) => (i < reg ? `P${i + 1}` : `PR${i - reg + 1}`);
const pad2 = (n) => String(n).padStart(2, '0');
const short = (name, n = 14) => (name || '').length > n ? name.slice(0, n - 1) + '…' : name || '';
const ago = (d) => { if (!d) return '—'; const s = Math.max(0, Math.round((Date.now() - d) / 1000)); return s < 60 ? `fa ${s} s` : `fa ${Math.round(s / 60)} min`; };

function mineSide(match) {
  if (!settings.teamId) return null;
  if (match.home.id === settings.teamId) return 'home';
  if (match.away.id === settings.teamId) return 'away';
  return null;
}

/* ---------- render ---------- */
function render() {
  const view = $('#view');
  $('#btn-refresh').hidden = state.screen === 'setup';
  $('#btn-share').hidden = state.screen !== 'match' || !state.match;
  $('#title-text').textContent = state.screen === 'setup' ? 'Ajustos' : short(settings.teamName || 'Granollers Live', 24);
  const canSwitch = settings.favorites.length > 1 && state.screen !== 'setup';
  $('#title').classList.toggle('switchable', canSwitch);
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('sel', b.dataset.screen === state.screen);
    b.disabled = !settings.teamId && b.dataset.screen !== 'setup';
  });
  const html = { setup: renderSetup, home: renderHome, standings: renderStandingsScreen, match: renderMatch }[state.screen]();
  view.innerHTML = (state.error ? `<div class="banner error">${esc(state.error)}</div>` : '') + html;
  bind(view);
  runEffects(view);
}

async function loadClubTeams(clubId) {
  if (!clubId || !apiKey() && !DEMO) return;
  if (clubCache[clubId]) return;
  clubCache[clubId] = { loading: true };
  render();
  try { clubCache[clubId] = await api.club(clubId); }
  catch (e) { clubCache[clubId] = { error: e instanceof FcbqError && /DENIED/i.test(e.message) ? "La FCBQ ha rebutjat la clau." : "No s'ha pogut carregar el club." }; }
  render();
}

function renderSetup() {
  const hasKey = Boolean(apiKey()) || DEMO;
  if (!hasKey) {
    return `
    <section class="card onboarding">
      <div class="step">1</div>
      <h2>Clau d'accés</h2>
      <p class="hint">L'app llegeix les dades de la federació amb una clau. Si un altre pare ja la té, demana-li el QR d'Ajustos i escaneja'l: ho tindràs tot configurat. Si no, enganxa-la aquí.</p>
      <form id="key-form" class="row">
        <input id="api-key" placeholder="Enganxa aquí la clau" autocomplete="off" spellcheck="false" required>
        <button class="btn">Desa</button>
      </form>
    </section>
    <section class="card dim">
      <div class="step">2</div>
      <h2>Tria l'equip</h2>
      <p class="hint">Després de la clau, aquí sortiran els equips del CB Granollers per triar el teu.</p>
    </section>`;
  }
  const favs = settings.favorites.map((f) => `
    <li class="fav ${f.id === settings.teamId ? 'sel' : ''}" data-id="${esc(f.id)}">
      <span class="fav-pick"><strong>${esc(f.name)}</strong><small>${esc(f.category || '')}</small></span>
      <button class="fav-remove" data-id="${esc(f.id)}" aria-label="Treu">✕</button></li>`).join('');
  return `
  <section class="card">
    <h2>Equips preferits</h2>
    ${favs ? `<ul class="teams favs">${favs}</ul><p class="hint">El marcat amb ★ és l'actual. Per canviar-lo des de qualsevol pantalla, toca el nom de l'equip a dalt de tot.</p>` : '<p class="hint">Encara no has desat cap equip.</p>'}
  </section>
  <section class="card">
    ${settings.favorites.length ? '' : '<div class="step">2</div>'}
    <h2>${settings.favorites.length ? 'Afegeix un equip' : "Tria l'equip"}</h2>
    ${clubTeamsBlock(state.clubId || DEFAULT_CLUB)}
    <details class="other-club">
      <summary>Un altre club</summary>
      <p class="hint">Escriu el número del club: és el de la seva adreça a basquetcatala.cat/clubs. El CB Granollers és l'1 i el Pia Sabadell el 104.</p>
      <form id="club-form" class="row">
        <input id="club-id" inputmode="numeric" placeholder="Núm. de club" value="${esc(state.clubId || '')}">
        <button class="btn">Mostra'n els equips</button>
      </form>
    </details>
  </section>
  <section class="card">
    <h2>Comparteix la configuració</h2>
    <p class="hint">Un codi QR amb els teus equips i la clau: un altre pare l'escaneja i té l'app llesta en deu segons.</p>
    <button id="btn-qr" class="btn ghost-ink" style="margin-top:8px"><svg class="btn-ico"><use href="#i-qr"/></svg> Mostra el QR</button>
    <div id="qr-box" hidden></div>
  </section>
  <section class="card">
    <h2>Clau d'accés</h2>
    <p class="hint">Només cal si l'app no la porta configurada o la federació la canvia.</p>
    <form id="key-form" class="row">
      <input id="api-key" placeholder="${apiKey() ? 'Configurada (' + apiKey().slice(0, 4) + '…)' : 'Enganxa aquí la clau'}" autocomplete="off" spellcheck="false">
      <button class="btn">Desa</button>
    </form>
  </section>
  <section class="card">
    <h2>Dades desades</h2>
    <button id="btn-reset" class="btn ghost">Esborra ajustos i memòria cau</button>
  </section>`;
}

function clubTeamsBlock(clubId) {
  const c = clubCache[clubId];
  if (!c) { setTimeout(() => loadClubTeams(clubId), 0); return '<p class="hint">Carregant els equips…</p>'; }
  if (c.loading) return '<p class="hint">Carregant els equips…</p>';
  if (c.error) return `<p class="banner error">${esc(c.error)}</p>`;
  const groups = {};
  for (const t of c.teams) (groups[t.category || 'Altres'] = groups[t.category || 'Altres'] || []).push(t);
  const order = (cat) => (/PRE-MINI/i.test(cat) ? 1 : /MINI/i.test(cat) ? 0 : /PRE-INF/i.test(cat) ? 2 : /INFANTIL/i.test(cat) ? 3 : /CADET/i.test(cat) ? 4 : /J[UÚ]NIOR/i.test(cat) ? 5 : 9);
  const cats = Object.keys(groups).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return `<p class="hint club-name">${esc(c.name)} · ${c.teams.length} equips</p>
    <input id="team-filter" class="filter" placeholder="Filtra: mini femení, cadet…" autocomplete="off">
    <ul class="teams grouped">${cats.map((cat) => `<li class="cat" data-cat="${esc(cat.toLowerCase())}">${esc(cat)}</li>` + groups[cat].map((t) =>
      `<li data-id="${esc(t.id)}" data-name="${esc(t.name)}" data-cat="${esc(t.category)}" data-club="${esc(clubId)}" class="pick ${t.id === settings.teamId || settings.favorites.some((f) => f.id === t.id) ? 'sel' : ''}"><span>${esc(t.name)}</span><small>${esc(t.category)}</small>${settings.favorites.some((f) => f.id === t.id) ? '<em>★</em>' : ''}</li>`).join('')).join('')}</ul>`;
}

function renderHome() {
  if (state.loading && !state.season.length) return `<div class="loading">Carregant el calendari…</div>`;
  const rows = state.season.map((m) => {
    const side = mineSide(m);
    const res = m.played && m.home.score !== null ? `${m.home.score}–${m.away.score}` : m.isLive ? 'EN JOC' : fmtTime(m.date);
    const won = side && m.played && m.home.score !== null ? ((m.home.score > m.away.score) === (side === 'home') ? 'win' : 'loss') : '';
    return `<li class="match-row ${won}" data-id="${esc(m.idMatch)}">
      <span class="m-date">${fmtDate(m.date)}</span>
      <span class="m-teams"><span class="m-team">${crest(m.home.logo, 'crest-sm')}${esc(m.home.name)}</span><span class="m-team">${crest(m.away.logo, 'crest-sm')}${esc(m.away.name)}</span></span>
      <span class="m-res ${m.isLive ? 'live' : ''}">${esc(res)}</span></li>`;
  }).join('');
  return `<section class="card"><ul class="matches">${rows || '<li class="hint">Sense partits aquesta temporada.</li>'}</ul></section>`;
}

function teamChips() {
  return settings.favorites.length > 1 ? `<div class="chips">${settings.favorites.map((f) =>
    `<button class="team-chip ${f.id === settings.teamId ? 'sel' : ''}" data-id="${esc(f.id)}">${esc(short(f.name, 22))}</button>`).join('')}</div>` : '';
}

function renderStandingsScreen() {
  if (state.loading && !state.season.length) return `<div class="loading">Carregant…</div>`;
  return renderStandings();
}

function renderStandings() {
  const s = state.standings;
  if (state.standingsLoading || !s) return `<section class="card"><div class="loading">Calculant la classificació…</div></section>`;
  if (s.error) return `<section class="card"><p class="banner error">${esc(s.error)}</p></section>`;
  if (!s.rows.length) return `<section class="card"><p class="hint">Encara no hi ha resultats en aquest grup.</p></section>`;
  const body = s.rows.map((t, i) => `<tr class="${t.id === settings.teamId ? 'mine' : ''}">
      <td class="pos">${i + 1}</td>
      <td class="nm"><div>${crest(t.logo, 'crest-sm')}<span>${esc(t.name)}</span></div></td>
      <td>${t.J}</td><td>${t.G}</td><td>${t.P}</td><td class="pf">${t.PF}</td><td class="pf">${t.PC}</td><td class="b">${t.pts}</td></tr>`).join('');
  return `<section class="card standings">
    <div class="card-head">${esc(s.title || 'Classificació')}</div>
    <div class="table-wrap"><table class="stand"><thead><tr><th class="pos">#</th><th class="nm">Equip</th><th>J</th><th>G</th><th>P</th><th class="pf">PF</th><th class="pf">PC</th><th>Pts</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="hint">Calculada amb els ${s.played} partits jugats de ${s.total}. 2 punts per victòria i 1 per derrota; els empats s'ordenen per diferència. Actualitzada a les ${fmtTime(new Date(s.savedAt))}.</p>
  </section>`;
}

function renderNoMatch() {
  if (state.loading) return `<div class="loading">Carregant…</div>`;
  const next = state.season.find((m) => !m.played && m.date && m.date > Date.now() - 4 * 3600e3);
  const last = [...state.season].reverse().find((m) => m.played);
  const card = (m, label) => m ? `<section class="card next" data-open="${esc(m.idMatch)}">
      <div class="card-head">${label}</div>
      <div class="next-row">${crest(m.home.logo, 'crest-sm')}<strong>${esc(m.home.name)}</strong></div>
      <div class="next-row">${crest(m.away.logo, 'crest-sm')}<strong>${esc(m.away.name)}</strong></div>
      <p class="hint">${m.played && m.home.score !== null ? `Final ${m.home.score}–${m.away.score}` : `${fmtDate(m.date)} · ${fmtTime(m.date)}${m.venue ? ' · ' + esc(m.venue) : ''}`} · toca per obrir-lo</p>
    </section>` : '';
  return `<section class="card empty"><div class="empty-ball"><svg><use href="#i-ball"/></svg></div><h2>Cap partit en joc ara</h2><p class="hint">Quan ${esc(short(settings.teamName || 'el teu equip', 24))} jugui, aquesta pestanya s'obrirà sola en directe.</p></section>` + card(next, 'Proper partit') + card(last, 'Últim partit');
}

function renderMatch() {
  if (!state.match) return renderNoMatch();
  const m = state.match, live = state.live;
  const side = mineSide(m);
  const reg = regulationPeriods(m.category);
  const header = `<div class="meta">${esc(m.category || '')} · ${esc(m.competition || '')}${m.matchDay ? ` · J${m.matchDay}` : ''}</div>`;

  if (!live) {
    const status = m.played && m.home.score !== null
      ? `<div class="status final">FINAL</div>`
      : `<div class="status wait">${state.loading ? 'Carregant…' : m.adGameId ? 'Esperant dades en directe' : 'Encara no hi ha acta digital'}</div>`;
    return header + `
    <section class="card scoreboard">
      ${teamBlock(m.home, m.home.score, side === 'home', false, m.home.logo)}
      <div class="middle">${status}<div class="diff">${fmtDate(m.date)} ${fmtTime(m.date)}</div></div>
      ${teamBlock(m.away, m.away.score, side === 'away', false, m.away.logo)}
    </section>
    ${venueCard(m)}
    ${m.played && m.uuid ? `<a class="card venue" href="https://www.basquetcatala.cat/estadistica/partit/${esc(m.uuid)}" target="_blank" rel="noopener"><svg class="venue-icon"><use href="#i-stats"/></svg><span class="venue-text"><strong>Estadístiques del partit</strong><br><span class="hint">Parcials, jugades i jugadores a basquetcatala.cat</span></span><span class="venue-go">Obre ›</span></a>` : ''}
    <section class="card info">
      <p class="hint" style="margin:0">${m.played
        ? "Partit acabat. El detall en directe (parcials, faltes, jugades i plantilles) es desa aquí només si l'app era oberta durant el partit; si no, consulta'l a la pàgina oficial."
        : "Quan la taula obri l'acta digital, aquesta pantalla passarà sola al directe amb parcials per període, faltes, jugades i plantilles. Es comprova cada minut."}</p>
    </section>`;
  }

  const H = live.home, A = live.away;
  const tH = H.total, tA = A.total;
  const nPer = Math.max(reg, H.periods.length, A.periods.length);
  const cur = live.period - 1;
  const finished = state.finished || (live.period >= nPer && live.clock && live.clock.minute === 0 && live.clock.second === 0);
  const sel = state.selectedPeriod === null || state.selectedPeriod === undefined ? (finished ? 'all' : cur) : state.selectedPeriod;
  const d = tH - tA;
  let diffText = d === 0 ? 'Empat' : `${short(d > 0 ? H.name : A.name)} +${Math.abs(d)}`;
  if (side) { const mine = side === 'home' ? d : -d; diffText = mine === 0 ? 'Empat' : mine > 0 ? `Guanyem de ${mine}` : `Perdem de ${-mine}`; }
  const clock = live.clock ? `${live.clock.minute}:${pad2(live.clock.second)}` : '';
  const ps = (t, i) => t.periods[i] ? t.periods[i].score : undefined;
  const cumH = cumulative(H.periods.map((p) => p.score)), cumA = cumulative(A.periods.map((p) => p.score));

  const cells = (team, other) => Array.from({ length: nPer }, (_, i) => {
    const v = ps(team, i), o = ps(other, i);
    const cls = [i === sel ? 'active' : '', v !== undefined && o !== undefined && v > o ? 'won' : '', v === undefined ? 'empty' : ''].join(' ');
    return `<td class="${cls}" data-i="${i}">${v === undefined ? '·' : v}</td>`;
  }).join('');
  const numRow = (arr) => Array.from({ length: nPer }, (_, i) => `<td data-i="${i}">${arr[i] !== undefined ? arr[i] : ''}</td>`).join('');
  const wonH = H.periods.filter((p, i) => p.score > (ps(A, i) ?? 0)).length;
  const wonA = A.periods.filter((p, i) => p.score > (ps(H, i) ?? 0)).length;

  const zero = { score: 0, fouls: 0, t1: { made: 0, att: 0 }, t2: { made: 0, att: 0 }, t3: { made: 0, att: 0 } };
  const pick = (t) => sel === 'all' ? { score: t.total, fouls: t.fouls, ...t.shots } : (t.periods[sel] || zero);
  const dH = pick(H), dA = pick(A);
  const selLabel = sel === 'all' ? 'Partit' : periodLabel(sel, reg);
  const shotTxt = (x) => `${x.made}/${x.att}`;
  const cmpRow = (label, a, b, hi = true) => `<div class="cmp"><span class="${hi && a > b ? 'hi' : ''}">${a}</span><span class="cmp-label">${label}</span><span class="${hi && b > a ? 'hi' : ''}">${b}</span></div>`;
  const detail = `
    <div class="chips periods-sel">
      <button class="team-chip ${sel === 'all' ? 'sel' : ''}" data-p="all">Partit</button>
      ${Array.from({ length: nPer }, (_, i) => `<button class="team-chip ${sel === i ? 'sel' : ''} ${i > cur ? 'future' : ''}" data-p="${i}">${periodLabel(i, reg)}</button>`).join('')}
    </div>
    <div class="detail-head"><span class="home">${esc(H.shortName)}</span><strong>${esc(selLabel)}${sel === cur && !finished ? ' · en joc' : ''}</strong><span class="away">${esc(A.shortName)}</span></div>
    ${cmpRow('Punts', dH.score, dA.score)}
    ${cmpRow('Faltes', dH.fouls, dA.fouls, false)}
    ${cmpRow('Tirs lliures', shotTxt(dH.t1), shotTxt(dA.t1), false)}
    ${cmpRow('Tirs de 2', shotTxt(dH.t2), shotTxt(dA.t2), false)}
    ${cmpRow('Tirs de 3', shotTxt(dH.t3), shotTxt(dA.t3), false)}`;

  const mine = myPlayer();
  const mineTeam = side === 'away' ? A : H;
  const minePl = mine ? mineTeam.players.find((p) => p.id === mine.id) : null;
  const ICON = { basket: '🏀', foul: '✋', miss: '○', sub: '⇄', timeout: '⏸', period: '▮', other: '' };
  const movesSel = (sel === 'all' ? live.moves.slice(-20) : live.moves.filter((p) => p.period - 1 === sel)).reverse();
  const plays = movesSel.map((p) => `
    <li class="${p.team || ''} k-${p.kind} ${mine && p.playerId === mine.id ? 'mine' : ''}">
      <span class="p-time">${periodLabel(p.period - 1, reg)} ${p.min}:${pad2(p.sec)}</span>
      <span class="p-text"><span class="p-icon">${ICON[p.kind] || ''}</span>${p.player ? `<strong>${esc(short(p.player, 22))}</strong> ` : ''}${esc(p.text || p.move)}</span>
      <span class="p-score">${p.points ? `${p.total.home}–${p.total.away}` : ''}</span></li>`).join('');

  const roster = (t, cls) => `
    <h3 class="${cls}">${esc(short(t.name, 26))} <small>${t.fouls} faltes · TL ${shotTxt(t.shots.t1)} · T2 ${shotTxt(t.shots.t2)} · T3 ${shotTxt(t.shots.t3)}</small></h3>
    <div class="table-wrap"><table class="roster" data-team="${cls}"><thead><tr><th class="num">#</th><th class="nm">Jugadora</th><th>PTS</th><th>FAL</th><th>MIN</th><th>T1</th><th>T2</th><th>T3</th></tr></thead><tbody>
    ${t.players.map((p) => `<tr class="${p.timePlayed === 0 ? 'bench' : ''} ${mine && p.id === mine.id ? 'mine' : ''}" data-pid="${esc(p.id)}" data-pname="${esc(p.name)}"><td class="num">${esc(p.dorsal || '')}</td><td class="nm">${mine && p.id === mine.id ? '★ ' : ''}${esc(short(p.name, 24))}${p.captain ? ' <em>C</em>' : ''}</td><td class="b">${p.points}</td><td class="${p.fouls >= 4 ? 'warn' : ''}">${p.fouls}</td><td>${p.timePlayed}</td><td>${shotTxt(p.t1)}</td><td>${shotTxt(p.t2)}</td><td>${shotTxt(p.t3)}</td></tr>`).join('')}
    </tbody></table></div>`;
  const mineFirst = side === 'away' ? [[A, 'away'], [H, 'home']] : [[H, 'home'], [A, 'away']];

  const playerCard = minePl ? `
    <section class="card player ${side || 'home'}">
      <div class="player-head"><span class="player-star">★</span><div><strong>${esc(minePl.name)}</strong><small>${minePl.dorsal ? `#${esc(minePl.dorsal)} · ` : ''}${esc(short(mineTeam.name, 24))}</small></div></div>
      <div class="player-stats">
        <div><b data-pts="${minePl.points}">${minePl.points}</b><span>punts</span></div>
        <div><b class="${minePl.fouls >= 4 ? 'warn' : ''}">${minePl.fouls}</b><span>faltes</span></div>
        <div><b>${minePl.timePlayed}</b><span>min</span></div>
        <div><b>${shotTxt(minePl.t2)}</b><span>T2</span></div>
        <div><b>${shotTxt(minePl.t1)}</b><span>TL</span></div>
      </div>
    </section>` : '';

  return header + `
    <section class="card scoreboard">
      ${teamBlock(H, tH, side === 'home', tH > tA, m.home.logo)}
      <div class="middle">
        <div class="status ${finished ? 'final' : 'live'}">${finished ? 'FINAL' : `${periodLabel(cur, reg)} · ${clock}`}</div>
        <div class="diff">${esc(diffText)}</div>
        <div class="period-score">${finished ? '' : `aquest període ${ps(H, cur) ?? 0}–${ps(A, cur) ?? 0} · faltes ${H.periods[cur] ? H.periods[cur].fouls : 0}–${A.periods[cur] ? A.periods[cur].fouls : 0}`}</div>
      </div>
      ${teamBlock(A, tA, side === 'away', tA > tH, m.away.logo)}
    </section>
    ${lastPlayBand(live, reg, mine)}
    ${playerCard}

    <section class="card periods">
      <div class="card-head">Parcials <span class="hint-inline">toca un període per veure'n el detall</span></div>
      <div class="table-wrap"><table id="partials">
        <thead><tr><th class="team-col"></th>${Array.from({ length: nPer }, (_, i) => `<th class="${i === sel ? 'active' : ''}" data-i="${i}">${periodLabel(i, reg)}</th>`).join('')}<th class="${sel === 'all' ? 'active' : ''}" data-i="all">Tot</th></tr></thead>
        <tbody>
          <tr class="home"><td class="team-col">${esc(H.shortName)}</td>${cells(H, A)}<td class="total-col">${tH}</td></tr>
          <tr class="away"><td class="team-col">${esc(A.shortName)}</td>${cells(A, H)}<td class="total-col">${tA}</td></tr>
          <tr class="cum"><td class="team-col">acum.</td>${numRow(cumH)}<td></td></tr>
          <tr class="cum"><td class="team-col">acum.</td>${numRow(cumA)}<td></td></tr>
          <tr class="cum fouls"><td class="team-col">faltes</td>${numRow(H.periods.map((p) => p.fouls))}<td>${H.fouls}</td></tr>
          <tr class="cum fouls"><td class="team-col">faltes</td>${numRow(A.periods.map((p) => p.fouls))}<td>${A.fouls}</td></tr>
        </tbody></table></div>
      <div class="stats">
        <div class="stat"><span class="stat-label">Períodes guanyats</span><span class="stat-val">${wonH} · ${wonA}</span></div>
        <div class="stat"><span class="stat-label">Actualitzat</span><span class="stat-val"><span class="pulse ${finished ? 'off' : ''}"></span><span id="upd">${ago(state.lastUpdate)}</span></span></div>
      </div>
    </section>

    <section class="card detail">${detail}</section>

    <section class="card">
      <div class="card-head">Jugades · ${esc(selLabel)}</div>
      <ul class="plays">${plays || '<li class="hint">Encara no hi ha jugades.</li>'}</ul>
    </section>

    <section class="card rosters">
      <div class="card-head">Plantilles</div>
      ${mineFirst.map(([t, cls]) => roster(t, cls)).join('')}
      <p class="hint">PTS punts · FAL faltes · MIN minuts jugats · T1/T2/T3 tirs anotats/intentats. <strong>Toca una jugadora del teu equip per seguir-la.</strong></p>
    </section>
    ${venueCard(m)}`;
}

/* ---------- efectos ---------- */
function lastPlayBand(live, reg, mine) {
  const p = [...live.moves].reverse().find((x) => x.kind === 'basket' || x.kind === 'foul' || x.kind === 'timeout' || x.kind === 'period');
  if (!p) return '';
  const ICON = { basket: '🏀', foul: '✋', timeout: '⏸', period: '▮' };
  const key = `${p.period}-${p.min}-${p.sec}-${p.move}-${p.player || ''}`;
  return `<div class="band ${p.team || ''} k-${p.kind} ${mine && p.playerId === mine.id ? 'mine' : ''}" data-key="${esc(key)}">
    <span class="band-icon">${ICON[p.kind] || ''}</span>
    <span class="band-text">${p.player ? `<strong>${esc(short(p.player, 22))}</strong> · ` : ''}${esc(p.text || p.move)}${p.points ? ` <b>+${p.points}</b>` : ''}</span>
    <span class="band-time">${periodLabel(p.period - 1, reg)} ${p.min}:${pad2(p.sec)}</span></div>`;
}

function runEffects(view) {
  if (state.screen !== 'match' || !state.live) { releaseWakeLock(); return; }
  const live = state.live, m = state.match, side = mineSide(m);
  const totals = view.querySelectorAll('.scoreboard .total');
  const sameMatch = fx.adGameId === live.adGameId;
  fx.adGameId = live.adGameId;
  const mine = myPlayer();
  const mineTeam = side === 'away' ? live.away : live.home;
  const minePts = mine ? ((mineTeam.players.find((p) => p.id === mine.id) || {}).points || 0) : null;

  if (sameMatch && fx.home !== null) {
    const bump = (el, delta, cls) => {
      if (!delta || !el) return;
      el.classList.add('pop');
      const f = document.createElement('span');
      f.className = `float ${cls}`; f.textContent = `+${delta}`;
      el.parentElement.appendChild(f);
      setTimeout(() => f.remove(), 1600);
    };
    const dH = live.home.total - fx.home, dA = live.away.total - fx.away;
    bump(totals[0], dH > 0 ? dH : 0, 'home');
    bump(totals[1], dA > 0 ? dA : 0, 'away');
    const mineScored = (side === 'home' && dH > 0) || (side === 'away' && dA > 0);
    const herScored = mine && fx.mine !== null && minePts > fx.mine;
    if (herScored) {
      const b = view.querySelector('.player-stats b[data-pts]');
      if (b) b.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate([40, 60, 40, 60, 80]);
    } else if (mineScored && navigator.vibrate) navigator.vibrate([30, 40, 30]);
  }
  fx.home = live.home.total; fx.away = live.away.total; fx.mine = minePts;

  const band = view.querySelector('.band');
  if (band) {
    if (sameMatch && fx.moveKey && band.dataset.key !== fx.moveKey) band.classList.add('slide');
    fx.moveKey = band.dataset.key;
  }

  if (view.querySelector('.status.final')) {
    releaseWakeLock();
    const won = side && ((side === 'home') === (live.home.total > live.away.total)) && live.home.total !== live.away.total;
    if (won && !fx.celebrated && !(snapshots[live.adGameId] || {}).celebrated && !reducedMotion) {
      fx.celebrated = true;
      if (snapshots[live.adGameId]) { snapshots[live.adGameId].celebrated = true; saveJSON(SNAPSHOT_KEY, snapshots); }
      confetti(side === 'home' ? live.home.color : live.away.color);
    }
  } else requestWakeLock();
}

setInterval(() => { const el = $('#upd'); if (el) el.textContent = ago(state.lastUpdate); }, 5000);

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || fx.wakeLock || document.hidden) return;
  try {
    fx.wakeLock = await navigator.wakeLock.request('screen');
    fx.wakeLock.addEventListener('release', () => { fx.wakeLock = null; });
  } catch (_) { fx.wakeLock = null; }
}
function releaseWakeLock() {
  if (fx.wakeLock) { fx.wakeLock.release().catch(() => {}); fx.wakeLock = null; }
}

function confetti(teamColor) {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const palette = [teamColor && !/^#?(fff|ffffff)$/i.test(teamColor) ? teamColor : '#0b3d5c', '#f6b31c', '#1aa38f', '#ffffff', '#e53935'];
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * innerWidth, y: -20 - Math.random() * innerHeight * 0.5,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
    vx: -1.5 + Math.random() * 3, vy: 2 + Math.random() * 3,
    rot: Math.random() * Math.PI, vr: -0.2 + Math.random() * 0.4,
    color: palette[Math.floor(Math.random() * palette.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = (now - start) / 1000;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.03;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = t > 2.5 ? Math.max(0, 1 - (t - 2.5) / 0.8) : 1;
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < 3.3) requestAnimationFrame(frame); else canvas.remove();
  })(start);
}

/* ---------- compartir ---------- */
function shareText() {
  const m = state.match, live = state.live, reg = regulationPeriods(m.category);
  const lines = [];
  if (live) {
    const H = live.home, A = live.away;
    const nPer = Math.max(H.periods.length, A.periods.length);
    const finished = state.finished || (live.period >= Math.max(reg, nPer) && live.clock && live.clock.minute === 0 && live.clock.second === 0);
    lines.push(`${H.name} ${H.total} – ${A.total} ${A.name}`);
    lines.push(finished ? 'Final' : `${periodLabel(live.period - 1, reg)}${live.clock ? ` · ${live.clock.minute}:${pad2(live.clock.second)}` : ''} · aquest període ${H.periods[live.period - 1]?.score ?? 0}-${A.periods[live.period - 1]?.score ?? 0}`);
    lines.push('Parcials: ' + Array.from({ length: nPer }, (_, i) => `${periodLabel(i, reg)} ${H.periods[i]?.score ?? 0}-${A.periods[i]?.score ?? 0}`).join(', '));
  } else {
    const res = m.home.score !== null && m.away.score !== null ? `${m.home.score} – ${m.away.score}` : `${fmtDate(m.date)} ${fmtTime(m.date)}`;
    lines.push(`${m.home.name} ${res} ${m.away.name}`);
    if (m.played && m.home.score !== null) lines.push('Final');
  }
  lines.push(`${m.category || ''}${m.matchDay ? ` · J${m.matchDay}` : ''}`.trim());
  return lines.join('\n');
}

async function shareMatch() {
  const text = shareText();
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Resultat copiat'); }
  catch (_) { window.prompt('Copia el resultat:', text); }
}

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* QR de configuración: la librería se carga solo cuando hace falta. */
async function showQr(box) {
  box.hidden = false;
  box.innerHTML = '<p class="hint">Generant el codi…</p>';
  try {
    if (!window.QRCode) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const url = exportConfigUrl();
    box.innerHTML = '<div id="qr-code"></div><p class="hint">Obre la càmera del mòbil i enfoca el codi. Inclou la clau d\'accés: comparteix-lo només amb qui vulguis.</p>';
    new window.QRCode($('#qr-code', box), { text: url, width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M });
  } catch (_) { box.innerHTML = '<p class="banner error">No s\'ha pogut generar el QR (cal connexió).</p>'; }
}

/* ---------- mapas y bloques ---------- */
function mapsUrl(m) {
  if (m.lat && m.lon) return `https://www.google.com/maps/search/?api=1&query=${m.lat},${m.lon}`;
  const q = [m.venue, m.address].filter(Boolean).join(', ');
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}

function venueCard(m) {
  if (!m.venue && !m.address) return '';
  const url = mapsUrl(m);
  const body = `<svg class="venue-icon"><use href="#i-pin"/></svg><span class="venue-text"><strong>${esc(m.venue || 'Pavelló')}</strong><br><span class="hint">${esc(m.address || '')}</span></span>${url ? '<span class="venue-go">Com arribar-hi ›</span>' : ''}`;
  return url ? `<a class="card venue" href="${url}" target="_blank" rel="noopener">${body}</a>` : `<section class="card venue">${body}</section>`;
}

function crest(url, cls = 'crest', color = null) {
  const ring = color && !/^#?(fff|ffffff)$/i.test(color) ? ` style="border-color:${esc(color)}"` : '';
  const img = url ? `<img src="${esc(url)}" alt="" ${cls === 'crest' ? '' : 'loading="lazy"'} onerror="this.parentElement.classList.add('crest-empty')">` : '';
  return `<span class="${cls} ${url ? '' : 'crest-empty'}"${ring}>${img}</span>`;
}

function teamBlock(team, score, mine, leading = false, logo = null) {
  return `<div class="team ${mine ? 'mine' : ''} ${leading ? 'leading' : ''}">
    ${crest(logo, 'crest', team.color)}
    <div class="team-name ${(team.name || '').length > 16 ? 'long' : ''}">${esc(team.name)}</div>
    <div class="total">${score === null || score === undefined ? '–' : score}</div>
  </div>`;
}

function cumulative(arr) { let acc = 0; return arr.map((v) => (acc += v)); }

/* ---------- eventos ---------- */
function bind(view) {
  view.querySelectorAll('.match-row').forEach((li) => li.addEventListener('click', () => {
    const m = state.season.find((x) => x.idMatch === li.dataset.id);
    if (m) go('match', { match: m, live: null, finished: false, selectedPeriod: null });
  }));
  view.querySelectorAll('.card.next[data-open]').forEach((c) => c.addEventListener('click', () => {
    const m = state.season.find((x) => x.idMatch === c.dataset.open);
    if (m) go('match', { match: m, live: null, finished: false, selectedPeriod: null });
  }));
  const selectPeriod = (v) => { state.selectedPeriod = v === 'all' ? 'all' : Number(v); render(); };
  view.querySelectorAll('.periods-sel .team-chip').forEach((b) => b.addEventListener('click', () => selectPeriod(b.dataset.p)));
  view.querySelectorAll('#partials th[data-i], #partials td[data-i]').forEach((c) => c.addEventListener('click', () => selectPeriod(c.dataset.i)));
  view.querySelectorAll('table.roster tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    const side = mineSide(state.match) || 'home';
    if (tr.closest('table').dataset.team !== side) { toast('Només pots seguir jugadores del teu equip'); return; }
    togglePlayer({ id: Number(tr.dataset.pid), name: tr.dataset.pname });
    toast(myPlayer() ? `Segueixes ${short(tr.dataset.pname, 20)}` : 'Has deixat de seguir-la');
  }));
  view.querySelectorAll('.fav-remove').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeFavorite(b.dataset.id); }));
  view.querySelectorAll('li.fav .fav-pick').forEach((el) => el.addEventListener('click', () => {
    const f = settings.favorites.find((x) => x.id === el.parentElement.dataset.id);
    if (f) selectTeam(f);
  }));
  view.querySelectorAll('.team-chip[data-id]').forEach((b) => b.addEventListener('click', () => {
    const f = settings.favorites.find((x) => x.id === b.dataset.id);
    if (f && f.id !== settings.teamId) selectTeam(f);
  }));
  const clubForm = $('#club-form', view);
  if (clubForm) clubForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const clubId = $('#club-id', view).value.trim();
    if (clubId) { state.clubId = clubId; render(); }
  });
  view.querySelectorAll('.teams.grouped li.pick').forEach((li) => li.addEventListener('click', () =>
    selectTeam({ id: li.dataset.id, name: li.dataset.name, category: li.dataset.cat, clubId: li.dataset.club })));
  const filter = $('#team-filter', view);
  if (filter) filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = filter.nextElementSibling;
    const visibleCats = new Set();
    list.querySelectorAll('li.pick').forEach((li) => {
      const hay = (li.dataset.name + ' ' + li.dataset.cat).toLowerCase();
      const ok = q.every((w) => hay.includes(w));
      li.hidden = !ok; if (ok) visibleCats.add(li.dataset.cat.toLowerCase());
    });
    list.querySelectorAll('li.cat').forEach((li) => { li.hidden = !visibleCats.has(li.dataset.cat); });
  });
  const keyForm = $('#key-form', view);
  if (keyForm) keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const k = $('#api-key', view).value.trim();
    if (k) { settings = { ...settings, apiKey: k }; saveJSON(SETTINGS_KEY, settings); api = buildClient(); }
    if (!settings.teamId) go('setup'); else if (params.has('list')) go('home'); else openMatchTab();
  });
  const qr = $('#btn-qr', view);
  if (qr) qr.addEventListener('click', () => showQr($('#qr-box', view)));
  const reset = $('#btn-reset', view);
  if (reset) reset.addEventListener('click', () => {
    localStorage.removeItem(SETTINGS_KEY); localStorage.removeItem(SNAPSHOT_KEY); localStorage.removeItem(STANDINGS_KEY);
    settings = { favorites: [], players: {} }; snapshots = {}; api = buildClient(); go('setup');
  });
}

function openSheet() {
  const sheet = $('#sheet');
  $('#sheet-list').innerHTML = settings.favorites.map((f) => `
    <li class="${f.id === settings.teamId ? 'sel' : ''}" data-id="${esc(f.id)}">
      <span class="fav-pick"><strong>${esc(f.name)}</strong><small>${esc(f.category || '')}</small></span>${f.id === settings.teamId ? '<em>★</em>' : ''}</li>`).join('');
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
  sheet.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    closeSheet();
    const f = settings.favorites.find((x) => x.id === li.dataset.id);
    if (f && f.id !== settings.teamId) selectTeam(f);
  }));
}
function closeSheet() {
  const sheet = $('#sheet');
  sheet.classList.remove('open');
  setTimeout(() => { sheet.hidden = true; }, 220);
}
$('#title').addEventListener('click', () => { if (settings.favorites.length > 1 && state.screen !== 'setup') openSheet(); });
$('#sheet .sheet-bg').addEventListener('click', closeSheet);
$('#sheet-add').addEventListener('click', () => { closeSheet(); go('setup'); });

$('#btn-share').addEventListener('click', shareMatch);
$('#btn-refresh').addEventListener('click', refreshCurrent);
document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => {
  const s = b.dataset.screen;
  if (s === 'match') openMatchTab(); else go(s);
}));
function refreshCurrent() {
  if (state.screen === 'match') { if (state.match) loadMatch(); else openMatchTab(); }
  else if (state.screen === 'standings') { state.season.length ? loadStandings(true) : loadSeason(); }
  else loadSeason();
}

/* Deslizar hacia abajo desde arriba para actualizar. */
(function pullToRefresh() {
  const ind = $('#ptr'); let startY = null, pulling = false;
  document.addEventListener('touchstart', (e) => { startY = window.scrollY <= 0 ? e.touches[0].clientY : null; pulling = false; }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 20) { pulling = dy > 80; ind.style.transform = `translate(-50%, ${Math.min(dy / 2, 60)}px) rotate(${dy * 2}deg)`; ind.classList.add('show'); ind.classList.toggle('ready', pulling); }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (startY !== null && pulling && state.screen !== 'setup') { ind.classList.add('spin'); refreshCurrent(); setTimeout(() => ind.classList.remove('spin'), 900); }
    startY = null; pulling = false; ind.style.transform = ''; ind.classList.remove('show', 'ready');
  });
})();

history.replaceState(null, '', location.pathname + (params.has('list') ? '?list' : '') + (DEMO ? (params.has('list') ? '&' : '?') + 'demo' : ''));
if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

/* ---------- modo demo: datos fijos para desarrollo ---------- */
let demoTick = 0;
function demoClient() {
  const load = (p) => fetch(p).then((r) => r.json());
  return {
    async club() { return { name: 'CLUB DEMO', teams: [{ id: '91044', name: 'CB GRANOLLERS 2', category: 'C.T. MINI FEMENÍ 1R. ANY' }] }; },
    async teamSeason(teamId) {
      const { normalizeMatch } = await import('./fcbq.js');
      if (teamId && teamId !== '91044') {
        return (await load('fixtures/group-24024.json')).map(normalizeMatch).filter((m) => m.home.id === teamId || m.away.id === teamId);
      }
      const ms = (await load('fixtures/season-91044.json')).map(normalizeMatch);
      const live = ms.find((m) => m.adGameId === '302995');
      if (live) { live.isLive = true; live.played = false; live.adGameId = '303367'; live.home.score = null; live.away.score = null; }
      return ms;
    },
    async matchDetail() { return {}; },
    async live() {
      const { normalizeLive } = await import('./fcbq.js');
      const raw = await load('fixtures/live-303367.json');
      demoTick++;
      if (params.has('final')) {
        raw.period = 8; raw.matchTime = { minute: 0, second: 0 };
        for (const t of raw.teams) while (t.periods.length < 8) t.periods.push({ ...t.periods[0], score: 2, faults: 0 });
      } else if (demoTick > 1) {
        for (let i = 1; i < demoTick; i++) {
          const t = raw.teams[i % 3 === 0 ? 0 : 1];
          const per = t.periods[raw.period - 1]; per.score += 2; per.shotsOfTwoSuccessful = (per.shotsOfTwoSuccessful || 0) + 1;
          const pl = t.players[i % t.players.length]; pl.data.score = (pl.data.score || 0) + 2;
          raw.moves.push({ idTeam: t.teamIdIntern, actorName: pl.name, actorId: pl.id, actorShirtNumber: pl.dorsal, move: 'Cistella de 2', period: raw.period, min: 1, sec: Math.max(0, 7 - i), score: '0-0' });
        }
      }
      if (params.has('long')) { raw.teams[0].name = 'BASQUETPIASABADELL VERD'; raw.teams[1].name = 'JOVENTUT BADALONA NEGRE'; raw.period = 6; raw.matchTime = { minute: 6, second: 0 }; }
      return normalizeLive(raw);
    },
  };
}

/* arranque */
if (DEMO && !settings.teamId) settings = { ...settings, teamId: '91044', teamName: 'DEMO · CB GRANOLLERS 2', favorites: [{ id: '91044', name: 'CB GRANOLLERS 2', category: 'C.T. MINI FEMENÍ 1R. ANY' }, { id: '91045', name: 'CB GRANOLLERS 2', category: 'C.T. PRE-MINI FEMENÍ' }] };
if (!settings.teamId) go('setup'); else if (params.has('list')) go('home'); else openMatchTab();
