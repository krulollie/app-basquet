/* Marcador mini: sigue en directo un partido de la FCBQ sumando los parciales por periodo. */
import { createClient, regulationPeriods, FcbqError } from './fcbq.js';

const SETTINGS_KEY = 'basquet-settings-v2';
const SNAPSHOT_KEY = 'basquet-snapshots-v2';
const LIVE_POLL_MS = 10000;
const WAIT_POLL_MS = 60000;
const DEFAULT_CLUB = '1'; // Club Bàsquet Granollers

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

/* ---------- ajustes y caché ---------- */
function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }
function saveJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }

let settings = loadJSON(SETTINGS_KEY, {});
let snapshots = loadJSON(SNAPSHOT_KEY, {});
const apiKey = () => settings.apiKey || (window.FCBQ_CONFIG && window.FCBQ_CONFIG.apiKey) || '';

let api = buildClient();
function buildClient() {
  if (DEMO) return demoClient();
  return createClient({ apiKey: apiKey() });
}

/* ---------- estado y navegación ---------- */
const state = { screen: 'home', season: [], match: null, live: null, error: null, loading: false, lastUpdate: null };
let timer = null;

function go(screen, extra = {}) {
  clearTimeout(timer); timer = null;
  Object.assign(state, { screen, error: null }, extra);
  render();
  if (screen === 'home') loadSeason();
  if (screen === 'match') loadMatch();
}

/* ---------- carga de datos ---------- */
async function loadSeason() {
  if (!settings.teamId) { go('setup'); return; }
  state.loading = true; render();
  try {
    state.season = (await api.teamSeason(settings.teamId)).sort((a, b) => (a.date || 0) - (b.date || 0));
    state.loading = false;
    const auto = pickMatch(state.season);
    if (auto && !params.has('list') && !state.visitedList) { go('match', { match: auto }); return; }
    state.visitedList = true;
    render();
  } catch (e) { fail(e); }
}

/* Partido a abrir automáticamente: el que está en juego, si no el de hoy, si no el próximo. */
function pickMatch(season) {
  const now = Date.now();
  const live = season.find((m) => m.isLive);
  if (live) return live;
  const today = season.find((m) => m.date && Math.abs(m.date - now) < 4 * 3600e3);
  if (today) return today;
  const recent = season.filter((m) => m.played && m.date && now - m.date < 20 * 3600e3).pop();
  if (recent) return recent;
  return null;
}

async function loadMatch() {
  const m = state.match;
  if (!m) { go('home'); return; }
  state.loading = !state.live; render();
  try {
    if (!m.adGameId) {
      // Aún no existe acta digital: refrescamos el calendario hasta que aparezca.
      const season = await api.teamSeason(settings.teamId);
      const fresh = season.find((x) => x.idMatch === m.idMatch);
      if (fresh) state.match = fresh;
      state.season = season;
      state.loading = false;
      if (!state.match.adGameId) { render(); schedule(WAIT_POLL_MS); return; }
    }
    let live = null;
    try {
      live = await api.live(state.match.adGameId);
    } catch (e) {
      // Con el partido acabado el servidor responde sin cabeceras CORS y el navegador lo trata
      // como fallo de red: lo interpretamos como "ya no hay directo".
      if (!state.match.played) throw e;
    }
    state.lastUpdate = new Date();
    state.loading = false;
    if (live) {
      state.live = live;
      snapshots[live.adGameId] = { savedAt: Date.now(), live };
      pruneSnapshots(); saveJSON(SNAPSHOT_KEY, snapshots);
      render(); schedule(LIVE_POLL_MS);
    } else {
      // Partido acabado (o todavía sin arrancar): usamos la última instantánea guardada.
      const snap = snapshots[state.match.adGameId];
      state.live = snap ? snap.live : null;
      state.finished = state.match.played || Boolean(snap);
      if (!state.live) {
        const detail = await api.matchDetail(state.match.adGameId).catch(() => null);
        if (detail) state.match = { ...state.match, ...detail };
      }
      render();
      if (!state.match.played) schedule(WAIT_POLL_MS);
    }
  } catch (e) { fail(e); schedule(LIVE_POLL_MS * 3); }
}

function pruneSnapshots() {
  const ids = Object.keys(snapshots).sort((a, b) => snapshots[b].savedAt - snapshots[a].savedAt);
  for (const id of ids.slice(10)) delete snapshots[id];
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => { if (!document.hidden) loadMatch(); else schedule(2000); }, ms);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.screen === 'match') loadMatch(); });

function fail(e) {
  console.error(e);
  state.loading = false;
  state.error = e instanceof FcbqError && e.code === 'NOKEY'
    ? 'Falta la clave de acceso. Ponla en Ajustes.'
    : e instanceof FcbqError && /DENIED/i.test(e.message)
      ? 'La FCBQ ha rechazado la clave (puede que la hayan cambiado). Revísala en Ajustes.'
      : `No se han podido cargar los datos (${e.message}).`;
  render();
}

/* ---------- utilidades de presentación ---------- */
const fmtDate = (d) => d ? d.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '';
const fmtTime = (d) => d ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
const periodLabel = (i, reg) => (i < reg ? `P${i + 1}` : `PR${i - reg + 1}`);
const pad2 = (n) => String(n).padStart(2, '0');
const short = (name, n = 14) => (name || '').length > n ? name.slice(0, n - 1) + '…' : name || '';

function mineSide(match) {
  if (!settings.teamId) return null;
  if (match.home.id === settings.teamId) return 'home';
  if (match.away.id === settings.teamId) return 'away';
  return null;
}

/* ---------- render ---------- */
function render() {
  const view = $('#view');
  $('#btn-back').hidden = state.screen === 'home' || (state.screen === 'setup' && !settings.teamId);
  $('#btn-refresh').hidden = state.screen === 'setup';
  $('#btn-calendar').hidden = state.screen !== 'match';
  $('#title').textContent = state.screen === 'setup' ? 'Ajustes' : short(settings.teamName || 'Marcador mini', 26);
  const html = { setup: renderSetup, home: renderHome, match: renderMatch }[state.screen]();
  view.innerHTML = (state.error ? `<div class="banner error">${esc(state.error)}</div>` : '') + html;
  bind(view);
}

function renderSetup() {
  return `
  <section class="card">
    <h2>Tu equipo</h2>
    <p class="hint">Escribe el número del club (el de su URL en basquetcatala.cat) y elige el equipo.</p>
    <form id="club-form" class="row">
      <input id="club-id" inputmode="numeric" placeholder="Nº de club" value="${esc(settings.clubId || DEFAULT_CLUB)}" required>
      <button class="btn">Buscar</button>
    </form>
    <div id="club-teams">${settings.teamName ? `<p class="hint">Equipo actual: <strong>${esc(settings.teamName)}</strong></p>` : ''}</div>
  </section>
  <section class="card">
    <h2>Clave de acceso</h2>
    <p class="hint">Solo hace falta si la app no la trae ya configurada o la federación la cambia.</p>
    <form id="key-form" class="row">
      <input id="api-key" placeholder="${apiKey() ? 'Configurada (' + apiKey().slice(0, 4) + '…)' : 'Pega aquí la clave'}" autocomplete="off" spellcheck="false">
      <button class="btn">Guardar</button>
    </form>
  </section>
  <section class="card">
    <h2>Datos guardados</h2>
    <button id="btn-reset" class="btn ghost">Borrar ajustes y caché</button>
  </section>`;
}

function renderHome() {
  if (state.loading && !state.season.length) return `<div class="loading">Cargando calendario…</div>`;
  const rows = state.season.map((m) => {
    const side = mineSide(m);
    const res = m.played && m.home.score !== null ? `${m.home.score}–${m.away.score}` : m.isLive ? 'EN JUEGO' : fmtTime(m.date);
    const won = side && m.played && m.home.score !== null ? ((m.home.score > m.away.score) === (side === 'home') ? 'win' : 'loss') : '';
    return `<li class="match-row ${won}" data-id="${esc(m.idMatch)}">
      <span class="m-date">${fmtDate(m.date)}</span>
      <span class="m-teams">${esc(m.home.name)}<br>${esc(m.away.name)}</span>
      <span class="m-res ${m.isLive ? 'live' : ''}">${esc(res)}</span></li>`;
  }).join('');
  return `<section class="card"><h2>Calendario</h2><ul class="matches">${rows || '<li class="hint">Sin partidos esta temporada.</li>'}</ul></section>`;
}

function renderMatch() {
  const m = state.match, live = state.live;
  const side = mineSide(m);
  const reg = regulationPeriods(m.category);
  const header = `
    <div class="meta">${esc(m.category || '')} · ${esc(m.competition || '')}${m.matchDay ? ` · J${m.matchDay}` : ''}</div>`;

  if (!live) {
    const status = m.played && m.home.score !== null
      ? `<div class="status final">FINAL</div>`
      : `<div class="status wait">${state.loading ? 'Cargando…' : m.adGameId ? 'Esperando datos en directo' : 'Sin acta digital todavía'}</div>`;
    return header + `
    <section class="card scoreboard">
      ${teamBlock(m.home, m.home.score, side === 'home')}
      <div class="middle">${status}<div class="diff">${fmtDate(m.date)} ${fmtTime(m.date)}</div></div>
      ${teamBlock(m.away, m.away.score, side === 'away')}
    </section>
    <section class="card info">
      <div>📍 ${esc(m.venue || '')}<br><span class="hint">${esc(m.address || '')}</span></div>
      <p class="hint">${m.played ? 'El feed en directo se cierra al acabar el partido; si lo seguiste desde aquí verás los parciales guardados.' : 'La página se actualiza sola cuando la mesa abre el acta digital.'}</p>
    </section>`;
  }

  const tH = live.home.total, tA = live.away.total;
  const nPer = Math.max(reg, live.home.periods.length, live.away.periods.length);
  const d = tH - tA;
  let diffText = d === 0 ? 'Empate' : `${short(d > 0 ? live.home.name : live.away.name)} +${Math.abs(d)}`;
  if (side) { const mine = side === 'home' ? d : -d; diffText = mine === 0 ? 'Empate' : mine > 0 ? `Ganamos de ${mine}` : `Perdemos de ${-mine}`; }
  const finished = state.finished || (live.period >= nPer && live.clock && live.clock.minute === 0 && live.clock.second === 0);
  const clock = live.clock ? `${live.clock.minute}:${pad2(live.clock.second)}` : '';
  const periodTxt = periodLabel(live.period - 1, reg);
  const cumH = cumulative(live.home.periods), cumA = cumulative(live.away.periods);

  const cells = (team, other) => Array.from({ length: nPer }, (_, i) => {
    const v = team.periods[i], o = other.periods[i];
    const cls = [i === live.period - 1 && !finished ? 'active' : '', v !== undefined && o !== undefined && v > o ? 'won' : '', v === undefined ? 'empty' : ''].join(' ');
    return `<td class="${cls}">${v === undefined ? '·' : v}</td>`;
  }).join('');
  const cumRow = (cum) => Array.from({ length: nPer }, (_, i) => `<td>${cum[i] !== undefined ? cum[i] : ''}</td>`).join('');

  const wonH = live.home.periods.filter((v, i) => v > (live.away.periods[i] ?? 0)).length;
  const wonA = live.away.periods.filter((v, i) => v > (live.home.periods[i] ?? 0)).length;
  const best = (t) => t.periods.length ? Math.max(...t.periods) : 0;

  const plays = live.moves.slice(-12).reverse().map((p) => `
    <li class="${p.team || ''} ${p.points ? 'basket' : ''}">
      <span class="p-time">${periodLabel(p.period - 1, reg)} ${p.min}:${pad2(p.sec)}</span>
      <span class="p-text">${p.player ? `<strong>${esc(short(p.player, 22))}</strong> ` : ''}${esc(p.move)}</span>
      <span class="p-score">${p.points ? `${p.total.home}–${p.total.away}` : ''}</span></li>`).join('');

  const scorers = (t) => t.players.filter((p) => p.points > 0).slice(0, 5).map((p) =>
    `<li><span>${p.dorsal ? `<em>${esc(p.dorsal)}</em> ` : ''}${esc(short(p.name, 24))}</span><strong>${p.points}</strong></li>`).join('') || '<li class="hint">Sin puntos aún</li>';

  return header + `
    <section class="card scoreboard">
      ${teamBlock(live.home, tH, side === 'home', tH > tA)}
      <div class="middle">
        <div class="status ${finished ? 'final' : 'live'}">${finished ? 'FINAL' : `${periodTxt} · ${clock}`}</div>
        <div class="diff">${esc(diffText)}</div>
        <div class="period-score">${finished ? '' : `este periodo ${live.home.periods[live.period - 1] ?? 0}–${live.away.periods[live.period - 1] ?? 0}`}</div>
      </div>
      ${teamBlock(live.away, tA, side === 'away', tA > tH)}
    </section>

    <section class="card periods">
      <div class="card-head">Parciales</div>
      <div class="table-wrap"><table>
        <thead><tr><th class="team-col"></th>${Array.from({ length: nPer }, (_, i) => `<th class="${i === live.period - 1 && !finished ? 'active' : ''}">${periodLabel(i, reg)}</th>`).join('')}<th>Tot</th></tr></thead>
        <tbody>
          <tr class="home"><td class="team-col">${esc(live.home.shortName)}</td>${cells(live.home, live.away)}<td class="total-col">${tH}</td></tr>
          <tr class="away"><td class="team-col">${esc(live.away.shortName)}</td>${cells(live.away, live.home)}<td class="total-col">${tA}</td></tr>
          <tr class="cum"><td class="team-col">acum.</td>${cumRow(cumH)}<td></td></tr>
          <tr class="cum"><td class="team-col">acum.</td>${cumRow(cumA)}<td></td></tr>
        </tbody></table></div>
      <div class="stats">
        <div class="stat"><span class="stat-label">Periodos ganados</span><span class="stat-val">${wonH} · ${wonA}</span></div>
        <div class="stat"><span class="stat-label">Mejor parcial</span><span class="stat-val">${best(live.home)} · ${best(live.away)}</span></div>
        <div class="stat"><span class="stat-label">Faltas</span><span class="stat-val">${live.home.fouls} · ${live.away.fouls}</span></div>
        <div class="stat"><span class="stat-label">Actualizado</span><span class="stat-val">${state.lastUpdate ? fmtTime(state.lastUpdate) : '—'}</span></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">Últimas jugadas</div>
      <ul class="plays">${plays || '<li class="hint">Todavía no hay jugadas.</li>'}</ul>
    </section>

    <section class="card scorers">
      <div class="card-head">Anotadoras</div>
      <div class="two-col">
        <div><h3 class="home">${esc(short(live.home.name, 18))}</h3><ul>${scorers(live.home)}</ul></div>
        <div><h3 class="away">${esc(short(live.away.name, 18))}</h3><ul>${scorers(live.away)}</ul></div>
      </div>
    </section>`;
}

function teamBlock(team, score, mine, leading = false) {
  return `<div class="team ${mine ? 'mine' : ''} ${leading ? 'leading' : ''}">
    <div class="team-name">${esc(team.name)}</div>
    <div class="total">${score === null || score === undefined ? '–' : score}</div>
  </div>`;
}

function cumulative(arr) { let acc = 0; return arr.map((v) => (acc += v)); }

/* ---------- eventos ---------- */
function bind(view) {
  view.querySelectorAll('.match-row').forEach((li) => li.addEventListener('click', () => {
    const m = state.season.find((x) => x.idMatch === li.dataset.id);
    if (m) go('match', { match: m, live: null, finished: false });
  }));
  const clubForm = $('#club-form', view);
  if (clubForm) clubForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clubId = $('#club-id', view).value.trim();
    const box = $('#club-teams', view);
    box.innerHTML = '<p class="hint">Buscando…</p>';
    try {
      const club = await api.club(clubId);
      box.innerHTML = `<p class="hint">${esc(club.name)}</p><ul class="teams">${club.teams.map((t) =>
        `<li data-id="${esc(t.id)}" data-name="${esc(t.name)}" class="${t.id === settings.teamId ? 'sel' : ''}"><span>${esc(t.name)}</span><small>${esc(t.category)}</small></li>`).join('')}</ul>`;
      box.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
        settings = { ...settings, clubId, teamId: li.dataset.id, teamName: li.dataset.name };
        saveJSON(SETTINGS_KEY, settings);
        go('home');
      }));
    } catch (err) { box.innerHTML = `<p class="banner error">${esc(err.message)}</p>`; }
  });
  const keyForm = $('#key-form', view);
  if (keyForm) keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const k = $('#api-key', view).value.trim();
    if (k) { settings = { ...settings, apiKey: k }; saveJSON(SETTINGS_KEY, settings); api = buildClient(); }
    go(settings.teamId ? 'home' : 'setup');
  });
  const reset = $('#btn-reset', view);
  if (reset) reset.addEventListener('click', () => {
    localStorage.removeItem(SETTINGS_KEY); localStorage.removeItem(SNAPSHOT_KEY);
    settings = {}; snapshots = {}; api = buildClient(); go('setup');
  });
}

$('#btn-back').addEventListener('click', () => { state.visitedList = true; go(state.screen === 'match' ? 'home' : settings.teamId ? 'home' : 'setup'); });
$('#btn-settings').addEventListener('click', () => go('setup'));
$('#btn-calendar').addEventListener('click', () => { state.visitedList = true; go('home'); });
$('#btn-refresh').addEventListener('click', () => { if (state.screen === 'match') loadMatch(); else loadSeason(); });
if (state.screen === 'home') history.replaceState(null, '', location.pathname + (params.has('list') ? '?list' : '') + (DEMO ? (params.has('list') ? '&' : '?') + 'demo' : ''));

/* ---------- modo demo: datos fijos para desarrollo ---------- */
function demoClient() {
  const load = (p) => fetch(p).then((r) => r.json());
  return {
    async club() { return { name: 'CLUB DEMO', teams: [{ id: '91044', name: 'CB GRANOLLERS 2', category: 'C.T. MINI FEMENÍ 1R. ANY' }] }; },
    async teamSeason() {
      const { normalizeMatch } = await import('./fcbq.js');
      const ms = (await load('fixtures/season-91044.json')).map(normalizeMatch);
      const live = ms.find((m) => m.adGameId === '302995');
      if (live) { live.isLive = true; live.played = false; live.adGameId = '303367'; live.home.score = null; live.away.score = null; }
      return ms;
    },
    async matchDetail() { return {}; },
    async live() {
      const { normalizeLive } = await import('./fcbq.js');
      return normalizeLive(await load('fixtures/live-303367.json'));
    },
  };
}

/* arranque */
if (DEMO && !settings.teamId) settings = { teamId: '91044', teamName: 'DEMO · CB GRANOLLERS 2' };
go(settings.teamId ? 'home' : 'setup');
