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
if (!Array.isArray(settings.favorites)) settings.favorites = [];
if (settings.teamId && !settings.favorites.some((f) => f.id === settings.teamId)) {
  settings.favorites.push({ id: settings.teamId, name: settings.teamName, category: '', clubId: settings.clubId || '' });
}

function selectTeam(team) {
  const favorites = settings.favorites.filter((f) => f.id !== team.id);
  favorites.unshift({ id: team.id, name: team.name, category: team.category || '', clubId: team.clubId || '' });
  settings = { ...settings, clubId: team.clubId || settings.clubId, teamId: team.id, teamName: team.name, favorites: favorites.slice(0, 8) };
  saveJSON(SETTINGS_KEY, settings);
  state.season = []; state.match = null; state.live = null; state.visitedList = false;
  go('home');
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
let snapshots = loadJSON(SNAPSHOT_KEY, {});
const apiKey = () => settings.apiKey || (window.FCBQ_CONFIG && window.FCBQ_CONFIG.apiKey) || '';

let api = buildClient();
function buildClient() {
  if (DEMO) return demoClient();
  return createClient({ apiKey: apiKey() });
}

/* ---------- estado y navegación ---------- */
const state = { screen: 'home', season: [], match: null, live: null, error: null, loading: false, lastUpdate: null, selectedPeriod: null };
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
      state.live = snap ? migrateLive(snap.live) : null;
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

/* Instantáneas guardadas con el formato antiguo (parciales como números). */
function migrateLive(live) {
  if (!live) return live;
  const fix = (t) => {
    if (t.periods.length && typeof t.periods[0] === 'number') {
      t.periods = t.periods.map((n) => ({ score: n, fouls: 0, t1: { made: 0, att: 0 }, t2: { made: 0, att: 0 }, t3: { made: 0, att: 0 } }));
    }
    t.shots = t.shots || { t1: { made: 0, att: 0 }, t2: { made: 0, att: 0 }, t3: { made: 0, att: 0 } };
    t.players = (t.players || []).map((p) => ({ fouls: 0, t1: { made: 0, att: 0 }, t2: { made: 0, att: 0 }, t3: { made: 0, att: 0 }, ...p }));
  };
  fix(live.home); fix(live.away);
  live.moves = (live.moves || []).map((mv) => ({ kind: mv.points ? 'basket' : 'other', ...mv }));
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
  const favs = settings.favorites.map((f) => `
    <li class="fav ${f.id === settings.teamId ? 'sel' : ''}" data-id="${esc(f.id)}">
      <span class="fav-pick"><strong>${esc(f.name)}</strong><small>${esc(f.category || '')}</small></span>
      <button class="fav-remove" data-id="${esc(f.id)}" aria-label="Quitar">✕</button></li>`).join('');
  return `
  <section class="card">
    <h2>Equipos favoritos</h2>
    ${favs ? `<ul class="teams favs">${favs}</ul><p class="hint">Toca uno para seguirlo. El marcado con ★ es el actual.</p>` : '<p class="hint">Todavía no has guardado ningún equipo.</p>'}
  </section>
  <section class="card">
    <h2>Añadir equipo</h2>
    <p class="hint">Escribe el número del club (el de su URL en basquetcatala.cat) y elige el equipo.</p>
    <form id="club-form" class="row">
      <input id="club-id" inputmode="numeric" placeholder="Nº de club" value="${esc(settings.clubId || DEFAULT_CLUB)}" required>
      <button class="btn">Buscar</button>
    </form>
    <div id="club-teams"></div>
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
  const chips = settings.favorites.length > 1 ? `<div class="chips">${settings.favorites.map((f) =>
    `<button class="team-chip ${f.id === settings.teamId ? 'sel' : ''}" data-id="${esc(f.id)}">${esc(short(f.name, 22))}</button>`).join('')}</div>` : '';
  return chips + `<section class="card"><h2>Calendario</h2><ul class="matches">${rows || '<li class="hint">Sin partidos esta temporada.</li>'}</ul></section>`;
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
    ${venueCard(m)}
    ${m.played && m.uuid ? `<a class="card venue" href="https://www.basquetcatala.cat/estadistica/partit/${esc(m.uuid)}" target="_blank" rel="noopener"><span class="venue-icon">📊</span><span class="venue-text"><strong>Estadísticas del partido</strong><br><span class="hint">Parciales, jugadas y jugadoras en basquetcatala.cat</span></span><span class="venue-go">Abrir ›</span></a>` : ''}
    <section class="card info">
      <p class="hint" style="margin:0">${m.played
        ? 'Partido acabado. El detalle en directo (parciales, faltas, jugadas y plantillas) se guarda aquí solo si la app estuvo abierta durante el partido; si no, consúltalo en la página oficial.'
        : 'Cuando la mesa abra el acta digital, esta pantalla pasará sola al directo con parciales por periodo, faltas, jugadas y plantillas. Se comprueba cada minuto.'}</p>
    </section>`;
  }

  const H = live.home, A = live.away;
  const tH = H.total, tA = A.total;
  const nPer = Math.max(reg, H.periods.length, A.periods.length);
  const cur = live.period - 1;
  const finished = state.finished || (live.period >= nPer && live.clock && live.clock.minute === 0 && live.clock.second === 0);
  const sel = state.selectedPeriod === null || state.selectedPeriod === undefined ? cur : state.selectedPeriod; // índice o 'all'
  const d = tH - tA;
  let diffText = d === 0 ? 'Empate' : `${short(d > 0 ? H.name : A.name)} +${Math.abs(d)}`;
  if (side) { const mine = side === 'home' ? d : -d; diffText = mine === 0 ? 'Empate' : mine > 0 ? `Ganamos de ${mine}` : `Perdemos de ${-mine}`; }
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

  // Detalle del periodo seleccionado (o del partido entero).
  const pick = (t) => sel === 'all' ? { score: t.total, fouls: t.fouls, ...t.shots } : (t.periods[sel] || { score: 0, fouls: 0, t1: { made: 0, att: 0 }, t2: { made: 0, att: 0 }, t3: { made: 0, att: 0 } });
  const dH = pick(H), dA = pick(A);
  const selLabel = sel === 'all' ? 'Partido' : periodLabel(sel, reg);
  const shotTxt = (x) => `${x.made}/${x.att}`;
  const cmpRow = (label, a, b, hi = true) => `<div class="cmp"><span class="${hi && a > b ? 'hi' : ''}">${a}</span><span class="cmp-label">${label}</span><span class="${hi && b > a ? 'hi' : ''}">${b}</span></div>`;
  const detail = `
    <div class="chips periods-sel">
      <button class="team-chip ${sel === 'all' ? 'sel' : ''}" data-p="all">Partido</button>
      ${Array.from({ length: nPer }, (_, i) => `<button class="team-chip ${sel === i ? 'sel' : ''} ${i > cur ? 'future' : ''}" data-p="${i}">${periodLabel(i, reg)}</button>`).join('')}
    </div>
    <div class="detail-head"><span class="home">${esc(H.shortName)}</span><strong>${esc(selLabel)}${sel === cur && !finished ? ' · en juego' : ''}</strong><span class="away">${esc(A.shortName)}</span></div>
    ${cmpRow('Puntos', dH.score, dA.score)}
    ${cmpRow('Faltas', dH.fouls, dA.fouls, false)}
    ${cmpRow('Tiros libres', shotTxt(dH.t1), shotTxt(dA.t1), false)}
    ${cmpRow('Tiros de 2', shotTxt(dH.t2), shotTxt(dA.t2), false)}
    ${cmpRow('Tiros de 3', shotTxt(dH.t3), shotTxt(dA.t3), false)}`;

  // Jugadas: todas las del periodo elegido, o las últimas del partido.
  const ICON = { basket: '🏀', foul: '✋', miss: '○', sub: '⇄', timeout: '⏸', period: '▮', other: '' };
  const movesSel = (sel === 'all' ? live.moves.slice(-20) : live.moves.filter((p) => p.period - 1 === sel)).reverse();
  const plays = movesSel.map((p) => `
    <li class="${p.team || ''} k-${p.kind}">
      <span class="p-time">${periodLabel(p.period - 1, reg)} ${p.min}:${pad2(p.sec)}</span>
      <span class="p-text"><span class="p-icon">${ICON[p.kind] || ''}</span>${p.player ? `<strong>${esc(short(p.player, 22))}</strong> ` : ''}${esc(p.move)}</span>
      <span class="p-score">${p.points ? `${p.total.home}–${p.total.away}` : ''}</span></li>`).join('');

  // Plantilla completa.
  const roster = (t, cls) => `
    <h3 class="${cls}">${esc(short(t.name, 26))} <small>${t.fouls} faltas · TL ${shotTxt(t.shots.t1)} · T2 ${shotTxt(t.shots.t2)} · T3 ${shotTxt(t.shots.t3)}</small></h3>
    <div class="table-wrap"><table class="roster"><thead><tr><th class="num">#</th><th class="nm">Jugadora</th><th>PTS</th><th>FAL</th><th>MIN</th><th>T1</th><th>T2</th><th>T3</th></tr></thead><tbody>
    ${t.players.map((p) => `<tr class="${p.timePlayed === 0 ? 'bench' : ''}"><td class="num">${esc(p.dorsal || '')}</td><td class="nm">${esc(short(p.name, 24))}${p.captain ? ' <em>C</em>' : ''}</td><td class="b">${p.points}</td><td class="${p.fouls >= 4 ? 'warn' : ''}">${p.fouls}</td><td>${p.timePlayed}</td><td>${shotTxt(p.t1)}</td><td>${shotTxt(p.t2)}</td><td>${shotTxt(p.t3)}</td></tr>`).join('')}
    </tbody></table></div>`;
  const mineFirst = side === 'away' ? [[A, 'away'], [H, 'home']] : [[H, 'home'], [A, 'away']];

  return header + `
    <section class="card scoreboard">
      ${teamBlock(H, tH, side === 'home', tH > tA)}
      <div class="middle">
        <div class="status ${finished ? 'final' : 'live'}">${finished ? 'FINAL' : `${periodLabel(cur, reg)} · ${clock}`}</div>
        <div class="diff">${esc(diffText)}</div>
        <div class="period-score">${finished ? '' : `este periodo ${ps(H, cur) ?? 0}–${ps(A, cur) ?? 0} · faltas ${H.periods[cur] ? H.periods[cur].fouls : 0}–${A.periods[cur] ? A.periods[cur].fouls : 0}`}</div>
      </div>
      ${teamBlock(A, tA, side === 'away', tA > tH)}
    </section>

    <section class="card periods">
      <div class="card-head">Parciales <span class="hint-inline">toca un periodo para ver su detalle</span></div>
      <div class="table-wrap"><table id="partials">
        <thead><tr><th class="team-col"></th>${Array.from({ length: nPer }, (_, i) => `<th class="${i === sel ? 'active' : ''}" data-i="${i}">${periodLabel(i, reg)}</th>`).join('')}<th class="${sel === 'all' ? 'active' : ''}" data-i="all">Tot</th></tr></thead>
        <tbody>
          <tr class="home"><td class="team-col">${esc(H.shortName)}</td>${cells(H, A)}<td class="total-col">${tH}</td></tr>
          <tr class="away"><td class="team-col">${esc(A.shortName)}</td>${cells(A, H)}<td class="total-col">${tA}</td></tr>
          <tr class="cum"><td class="team-col">acum.</td>${numRow(cumH)}<td></td></tr>
          <tr class="cum"><td class="team-col">acum.</td>${numRow(cumA)}<td></td></tr>
          <tr class="cum fouls"><td class="team-col">faltas</td>${numRow(H.periods.map((p) => p.fouls))}<td>${H.fouls}</td></tr>
          <tr class="cum fouls"><td class="team-col">faltas</td>${numRow(A.periods.map((p) => p.fouls))}<td>${A.fouls}</td></tr>
        </tbody></table></div>
      <div class="stats">
        <div class="stat"><span class="stat-label">Periodos ganados</span><span class="stat-val">${wonH} · ${wonA}</span></div>
        <div class="stat"><span class="stat-label">Actualizado</span><span class="stat-val">${state.lastUpdate ? fmtTime(state.lastUpdate) : '—'}</span></div>
      </div>
    </section>

    <section class="card detail">
      ${detail}
    </section>

    <section class="card">
      <div class="card-head">Jugadas · ${esc(selLabel)}</div>
      <ul class="plays">${plays || '<li class="hint">Todavía no hay jugadas.</li>'}</ul>
    </section>

    <section class="card rosters">
      <div class="card-head">Plantillas</div>
      ${mineFirst.map(([t, cls]) => roster(t, cls)).join('')}
      <p class="hint">PTS puntos · FAL faltas · MIN minutos jugados · T1/T2/T3 tiros anotados/intentados.</p>
    </section>
    ${venueCard(m)}`;
}

/* Enlace a Google Maps: por coordenadas si las hay, si no por dirección. Abre la app si está instalada. */
function mapsUrl(m) {
  if (m.lat && m.lon) return `https://www.google.com/maps/search/?api=1&query=${m.lat},${m.lon}`;
  const q = [m.venue, m.address].filter(Boolean).join(', ');
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}

function venueCard(m) {
  if (!m.venue && !m.address) return '';
  const url = mapsUrl(m);
  const body = `<span class="venue-icon">📍</span><span class="venue-text"><strong>${esc(m.venue || 'Pabellón')}</strong><br><span class="hint">${esc(m.address || '')}</span></span>${url ? '<span class="venue-go">Cómo llegar ›</span>' : ''}`;
  return url
    ? `<a class="card venue" href="${url}" target="_blank" rel="noopener">${body}</a>`
    : `<section class="card venue">${body}</section>`;
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
    if (m) go('match', { match: m, live: null, finished: false, selectedPeriod: null });
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
        `<li data-id="${esc(t.id)}" data-name="${esc(t.name)}" data-cat="${esc(t.category)}" class="${t.id === settings.teamId ? 'sel' : ''}"><span>${esc(t.name)}</span><small>${esc(t.category)}</small></li>`).join('')}</ul>`;
      box.querySelectorAll('li').forEach((li) => li.addEventListener('click', () =>
        selectTeam({ id: li.dataset.id, name: li.dataset.name, category: li.dataset.cat, clubId })));
    } catch (err) { box.innerHTML = `<p class="banner error">${esc(err.message)}</p>`; }
  });
  view.querySelectorAll('.fav-remove').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeFavorite(b.dataset.id); }));
  view.querySelectorAll('li.fav .fav-pick').forEach((el) => el.addEventListener('click', () => {
    const f = settings.favorites.find((x) => x.id === el.parentElement.dataset.id);
    if (f) selectTeam(f);
  }));
  view.querySelectorAll('.team-chip[data-id]').forEach((b) => b.addEventListener('click', () => {
    const f = settings.favorites.find((x) => x.id === b.dataset.id);
    if (f && f.id !== settings.teamId) selectTeam(f);
  }));
  const selectPeriod = (v) => { state.selectedPeriod = v === 'all' ? 'all' : Number(v); render(); };
  view.querySelectorAll('.periods-sel .team-chip').forEach((b) => b.addEventListener('click', () => selectPeriod(b.dataset.p)));
  view.querySelectorAll('#partials th[data-i], #partials td[data-i]').forEach((c) => c.addEventListener('click', () => selectPeriod(c.dataset.i)));
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
    settings = { favorites: [] }; snapshots = {}; api = buildClient(); go('setup');
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
if (DEMO && !settings.teamId) settings = { teamId: '91044', teamName: 'DEMO · CB GRANOLLERS 2', favorites: [{ id: '91044', name: 'CB GRANOLLERS 2', category: 'C.T. MINI FEMENÍ 1R. ANY' }, { id: '91045', name: 'CB GRANOLLERS 2', category: 'C.T. PRE-MINI FEMENÍ' }] };
go(settings.teamId ? 'home' : 'setup');
