# Granollers Live

Web app móvil para seguir en directo un partido de la FCBQ con el **marcador global**, que la app
oficial no muestra en minibàsquet (allí el marcador se reinicia en cada periodo).

- Sin dependencias ni build: `index.html` + `app.js` + `fcbq.js` + `styles.css`.
- Se añade a la pantalla de inicio del móvil (PWA básica). Los ajustes y la última instantánea de
  cada partido se guardan en `localStorage`.
- Flujo: eliges club y equipo una vez → la app abre sola el partido en juego (o el de hoy, o el último)
  → cada 10 s consulta el feed en directo y suma los parciales.

## Desarrollo

```bash
python3 -m http.server 5297
```

- <http://localhost:5297> → app real (pide club/equipo la primera vez).
- <http://localhost:5297/?demo> → datos fijos de `fixtures/` para trabajar la interfaz. Las capturas del feed
  (`fixtures/live-*.json`) contienen nombres de jugadoras y no se suben al repo; se regeneran con
  `curl https://streaming.optimalwayconsulting.com/fcbq/streaming/match-id/<adGameId> -o fixtures/live-<adGameId>.json`.
- <http://localhost:5297/?list> → no abre partido automáticamente, muestra el calendario.

## Publicación

Se sirve tal cual desde GitHub Pages (rama `main`, raíz). Como `config.local.js` no está en el repo,
en el móvil se pega la clave una vez en Ajustes y queda guardada en el navegador.

## Fuente de datos

Los mismos servicios que usan la web y la app oficial (proveedor Optimal Way Consulting). Todo son
GET públicos con CORS abierto, así que el navegador del móvil los llama directamente.

| Uso | URL |
|---|---|
| Ficha de club (equipos e ids de temporada) | `https://esb.optimalwayconsulting.com/fcbq/1/<KEY>/FCBQWeb/fitxaClub/<idClub>` |
| Calendario y resultados de un equipo | `.../fcbq/1/<KEY>/Match/getByTeamAllSeason/<idEquipo>` |
| Detalle de un partido | `.../fcbq/1/<KEY>/Match/getMatchByAdGame/<adGameId>` |
| Partidos en directo | `.../fcbq/1/<KEY>/Match/getAllMatchInLiveVisibleWeb` |
| **Feed en directo** (parciales, jugadas, jugadoras) | `https://streaming.optimalwayconsulting.com/fcbq/streaming/match-id/<adGameId>` (sin clave) |

- Las respuestas del ESB son JSON codificado en base64 dentro de un sobre `{result, errorCode, message, messageData}`.
  Todos los escalares llegan como texto.
- `<KEY>` es la clave que la web entrega a cada navegador; va en `config.local.js` (ignorado por git) o
  se pega en Ajustes. Si la federación la rota, el ESB responde `ACCESS DENIED` y hay que capturarla
  de nuevo en la pestaña Red de basquetcatala.cat.
- `adGameId` solo existe cuando la mesa abre el acta digital. Al acabar el partido el feed devuelve `{}`;
  la app conserva la última instantánea que vio.
- En minibàsquet `score` y `teams[].score` son del **periodo en curso**; el total es la suma de
  `teams[].periods[].score`. El marcador acumulado de cada jugada lo calcula la app a partir de
  "Cistella de 1/2/3".
- Ids de equipo (`idSignedTeam`) cambian cada temporada. Club Bàsquet Granollers = 1;
  CB GRANOLLERS 2 (C.T. Mini Femení 1r any) 2026-27 = 91044. Ojo: el club tiene varios equipos
  llamados "CB GRANOLLERS 2" en distintas categorías.
- Las estadísticas de partidos acabados (`msstats.optimalwayconsulting.com`) exigen autenticación y no se usan.
- La clasificación no tiene API (la web la pinta en servidor): la app la calcula con los calendarios de todos los
  equipos del grupo (`idGroup`), 2 puntos por victoria y 1 por derrota, empates por diferencia. Coincide con la
  oficial en primera fase; se cachea 30 minutos.

## Autor

Hecha por carlos.c, desde la grada del CB Granollers, en noviembre de 2026.

## Aviso

basquetcatala.cat prohíbe en sus condiciones de uso la extracción automatizada de datos. Esta app es de
uso personal y hace una petición cada 10 segundos a un solo partido; aun así, es una integración no
oficial que puede dejar de funcionar sin previo aviso.
