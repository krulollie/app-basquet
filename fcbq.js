/* Adaptador de datos de la FCBQ (backend ESB y feed en directo de Optimal Way).
   Todo son peticiones GET públicas con CORS abierto; la clave del ESB es la que la web
   oficial entrega a cada navegador y la federación la puede rotar. */

const ESB_BASE = 'https://esb.optimalwayconsulting.com/fcbq/1';
const LIVE_BASE = 'https://streaming.optimalwayconsulting.com/fcbq/streaming';

export class FcbqError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function decodeEnvelope(text) {
  let payload;
  try {
    const bytes = Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    payload = JSON.parse(text); // los errores llegan en JSON plano
  }
  if (String(payload.result).toUpperCase() !== 'OK') {
    throw new FcbqError(payload.message || 'Error del servidor FCBQ', payload.errorCode);
  }
  return payload.messageData;
}

/* El backend devuelve colecciones a veces como array y a veces como objeto indexado. */
const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

export function createClient({ apiKey, fetchImpl = fetch } = {}) {
  async function esb(path) {
    if (!apiKey) throw new FcbqError('Falta la clave de acceso al ESB', 'NOKEY');
    const res = await fetchImpl(`${ESB_BASE}/${apiKey}/${path}`, { cache: 'no-store' });
    if (!res.ok) throw new FcbqError(`HTTP ${res.status} al pedir ${path}`, res.status);
    return decodeEnvelope(await res.text());
  }

  return {
    /* Ficha del club: nombre y equipos inscritos esta temporada. */
    async club(clubId) {
      const card = await esb(`FCBQWeb/fitxaClub/${clubId}`);
      const teams = [];
      for (const cat of asList(card.categories)) {
        for (const t of asList(cat.teams)) {
          teams.push({ id: String(t.idSignedTeam), name: t.name, category: t.categoriesRegistredName || cat.name, season: t.season });
        }
      }
      return { name: card.name, teams };
    },

    /* Todos los partidos de la temporada de un equipo. */
    async teamSeason(teamId) {
      return asList(await esb(`Match/getByTeamAllSeason/${teamId}`)).map(normalizeMatch);
    },

    /* Detalle de un partido por su adGameId (id del acta digital). */
    async matchDetail(adGameId) {
      return normalizeMatch(await esb(`Match/getMatchByAdGame/${adGameId}`));
    },

    /* Feed en directo. Devuelve null si el partido no está en juego (el servidor manda {}). */
    async live(adGameId) {
      const res = await fetchImpl(`${LIVE_BASE}/match-id/${adGameId}`, { cache: 'no-store' });
      if (!res.ok) throw new FcbqError(`HTTP ${res.status} en el directo`, res.status);
      const data = await res.json();
      return data && data.teams ? normalizeLive(data) : null;
    },
  };
}

const txt = (v) => (v === null || v === undefined || v === '' ? null : String(v).trim());
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export function normalizeMatch(m) {
  return {
    idMatch: txt(m.idMatch),
    adGameId: txt(m.adGameId),
    uuid: txt(m.matchCallUuid),
    matchDay: num(m.numMatchDay),
    date: txt(m.matchDay) ? new Date(m.matchDay.replace(' ', 'T')) : null,
    category: txt(m.nameCategory),
    competition: txt(m.nameCompetition),
    group: txt(m.nameGroup),
    home: { id: txt(m.idLocalTeam), name: txt(m.nameLocalTeam), score: num(m.localScore), logo: txt(m.localClubLogo) },
    away: { id: txt(m.idVisitorTeam), name: txt(m.nameVisitorTeam), score: num(m.visitorScore), logo: txt(m.visitorClubLogo) },
    venue: txt(m.nameField),
    address: [txt(m.adressField), txt(m.nameTown)].filter(Boolean).join(', '),
    played: txt(m.state) === '1',
    isLive: Boolean(m.isLive),
    startedAt: txt(m.matchStartedHour),
  };
}

/* Número de periodos reglamentarios según la categoría: mini y pre-mini juegan 8. */
export function regulationPeriods(category) {
  return /MINI/i.test(category || '') ? 8 : 4;
}

const BASKET_RE = /^Cistella de (\d)/i;

export function normalizeLive(d) {
  const teams = d.teams.map((t) => ({
    internId: t.teamIdIntern,
    id: String(t.teamIdExtern),
    name: t.name,
    shortName: t.shortName,
    color: t.colorRgb,
    periods: (t.periods || []).map((p) => p.score || 0),
    total: (t.periods || []).reduce((a, p) => a + (p.score || 0), 0),
    fouls: t.data ? t.data.faults || 0 : 0,
    players: (t.players || [])
      .map((p) => ({ name: p.name, dorsal: p.dorsal, points: p.data ? p.data.score || 0 : 0, timePlayed: p.timePlayed || 0 }))
      .sort((a, b) => b.points - a.points),
  }));
  const home = teams.find((t) => t.internId === d.localId) || teams[0];
  const away = teams.find((t) => t.internId === d.visitId) || teams[1];

  // Marcador acumulado tras cada jugada, calculado por nosotros: el campo `score` del feed
  // se reinicia en cada periodo en minibàsquet.
  let h = 0, a = 0;
  const moves = (d.moves || []).map((m) => {
    const pts = BASKET_RE.test(m.move) ? Number(m.move.match(BASKET_RE)[1]) : 0;
    if (pts) { if (m.idTeam === home.internId) h += pts; else a += pts; }
    return {
      team: m.idTeam === home.internId ? 'home' : m.idTeam === away.internId ? 'away' : null,
      player: m.actorName || null,
      dorsal: m.actorShirtNumber || null,
      move: m.move,
      period: m.period,
      min: m.min, sec: m.sec,
      points: pts,
      total: { home: h, away: a },
    };
  });

  return {
    adGameId: String(d.idMatchIntern),
    period: d.period,
    periodMinutes: d.periodDurationList || [],
    clock: d.matchTime ? { minute: d.matchTime.minute, second: d.matchTime.second } : null,
    timestamp: d.timestamp,
    home, away, moves,
  };
}
