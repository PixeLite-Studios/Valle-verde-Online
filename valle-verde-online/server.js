'use strict';
/* ============================================================
   Valle Verde · servidor multijugador
   - Sirve el juego (carpeta /public)
   - API REST: lista/creación de servidores, subida/descarga de modelos 3D
   - WebSocket (/ws): sincroniza jugadores, zombis, chat, botín y barricadas
   ============================================================ */
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

/* ---------- Configuración (variables de entorno) ---------- */
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS, 10) || 8;           // jugadores por servidor
const MAX_SERVERS = parseInt(process.env.MAX_SERVERS, 10) || 300;         // servidores en total
const MAX_MODEL_MB = parseFloat(process.env.MAX_MODEL_MB) || 20;          // modelo 3D máximo por jugador
const MAX_TOTAL_MODEL_MB = parseFloat(process.env.MAX_TOTAL_MODEL_MB) || 200; // memoria total para modelos
const PRUNE_DAYS = parseFloat(process.env.PRUNE_DAYS) || 30;              // borra servidores vacíos sin actividad
const CREATE_PER_HOUR = parseInt(process.env.CREATE_PER_HOUR, 10) || 8;   // servidores nuevos por IP y hora

const DIFFS = ['facil', 'normal', 'dificil', 'extremo'];
const DAY = 86400000;

/* ---------- Utilidades ---------- */
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString('hex');
function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function num(v, lo, hi, def) {
  v = Number(v);
  if (!isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, v));
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'x';
}

/* ---------- Estado: servidores (salas) ---------- */
/** @type {Map<string, any>} */
const rooms = new Map();

function newRoom(o) {
  return {
    id: o.id,
    name: o.name,
    seed: o.seed,
    seedText: o.seedText,
    diff: o.diff,
    created: o.created,
    lastActive: o.lastActive || o.created,
    wave: o.wave || 0,
    bestWave: o.bestWave || o.wave || 0,
    creator: o.creator || '',
    looted: new Set(o.looted || []),
    bars: o.bars || [],
    clients: new Map()
  };
}

function loadRooms() {
  try {
    const f = path.join(DATA_DIR, 'servers.json');
    if (!fs.existsSync(f)) return;
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const r of arr) if (r && r.id) rooms.set(r.id, newRoom(r));
    console.log('[datos] servidores cargados:', rooms.size);
  } catch (e) { console.warn('[datos] no se pudo leer servers.json:', e.message); }
}
let saveTimer = null;
function saveRoomsSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveRooms(); }, 5000);
}
function saveRooms() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const arr = [];
    for (const r of rooms.values()) {
      arr.push({
        id: r.id, name: r.name, seed: r.seed, seedText: r.seedText, diff: r.diff, created: r.created,
        lastActive: r.lastActive, wave: r.wave, bestWave: r.bestWave, creator: r.creator,
        looted: Array.from(r.looted).slice(-4000), bars: r.bars.slice(-400)
      });
    }
    const tmp = path.join(DATA_DIR, 'servers.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, path.join(DATA_DIR, 'servers.json'));
  } catch (e) { console.warn('[datos] no se pudo guardar:', e.message); }
}
loadRooms();

function publicInfo(r) {
  const names = [];
  for (const c of r.clients.values()) if (c.ready) names.push(c.name);
  return {
    id: r.id, name: r.name, seed: r.seed, seedText: r.seedText, diff: r.diff,
    created: r.created, lastActive: r.lastActive, wave: r.wave, bestWave: r.bestWave,
    creator: r.creator, players: names.length, max: MAX_PLAYERS, names: names.slice(0, 6)
  };
}

/* Limpieza de servidores vacíos y abandonados */
setInterval(() => {
  const t = now(); let changed = false;
  for (const [id, r] of rooms) {
    if (r.clients.size === 0 && t - r.lastActive > PRUNE_DAYS * DAY) { rooms.delete(id); changed = true; }
  }
  if (changed) saveRoomsSoon();
}, 60 * 60 * 1000);

/* ---------- Modelos 3D (en memoria) ---------- */
/** clave "sala:cid" -> { buf, ext, name, size } */
const models = new Map();
let modelBytes = 0;
function dropModel(key) {
  const m = models.get(key);
  if (m) { modelBytes -= m.size; models.delete(key); }
}

/* ---------- HTTP ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.get('/health', (req, res) => res.type('text').send('ok'));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const createLog = new Map(); // ip -> [timestamps]
function createAllowed(ip) {
  const t = now(); const a = (createLog.get(ip) || []).filter(x => t - x < 3600000);
  if (a.length >= CREATE_PER_HOUR) { createLog.set(ip, a); return false; }
  a.push(t); createLog.set(ip, a); return true;
}

app.get('/api/servers', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ servers: Array.from(rooms.values()).map(publicInfo), serverTime: now(), maxModelMB: MAX_MODEL_MB });
});

app.post('/api/servers', express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  if (!createAllowed(clientIp(req))) return res.status(429).json({ error: 'Has creado demasiados servidores. Espera un rato.' });
  if (rooms.size >= MAX_SERVERS) return res.status(507).json({ error: 'No caben más servidores en este momento.' });
  const name = clean(b.name, 24) || 'Servidor';
  const seedText = clean(b.seedText, 20);
  const seed = Math.floor(num(b.seed, 1, 1000002, 1));
  const diff = DIFFS.indexOf(b.diff) >= 0 ? b.diff : 'normal';
  const creator = clean(b.creator, 16);
  let id = rid(4);
  let created = now(), wave = 0, looted = [];
  // Restaurar un servidor propio que se perdió (p. ej. el plan gratis de Render se reinició)
  if (typeof b.id === 'string' && /^[a-f0-9]{8}$/.test(b.id)) {
    if (rooms.has(b.id)) return res.status(409).json({ error: 'Ese servidor ya existe.', id: b.id });
    id = b.id;
    created = Math.min(now(), Math.floor(num(b.created, 0, now(), now())));
    wave = Math.floor(num(b.wave, 0, 999, 0));
  }
  const r = newRoom({ id, name, seed, seedText, diff, created, wave, bestWave: wave, creator, looted });
  rooms.set(id, r); saveRoomsSoon();
  res.json({ server: publicInfo(r) });
});

// Subir tu modelo 3D (cuerpo binario crudo)
app.put('/api/model/:room/:cid', express.raw({ type: () => true, limit: Math.ceil(MAX_MODEL_MB) + 'mb' }), (req, res) => {
  const r = rooms.get(req.params.room);
  const c = r && r.clients.get(req.params.cid);
  if (!c || c.token !== req.get('x-token')) return res.status(403).json({ error: 'no autorizado' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'vacío' });
  if (buf.length > MAX_MODEL_MB * 1048576) return res.status(413).json({ error: 'Modelo demasiado grande (máx. ' + MAX_MODEL_MB + ' MB)' });
  const key = r.id + ':' + c.id;
  dropModel(key);
  if (modelBytes + buf.length > MAX_TOTAL_MODEL_MB * 1048576) return res.status(507).json({ error: 'El servidor no tiene espacio para más modelos ahora mismo.' });
  const ext = req.query.ext === 'obj' ? 'obj' : 'glb';
  models.set(key, { buf, ext, size: buf.length });
  modelBytes += buf.length;
  c.mdl = {
    v: rid(4), ext, name: clean(req.query.name, 40) || 'modelo', size: buf.length,
    on: req.query.on !== '0', scale: num(req.query.scale, 0.5, 2, 1), flip: req.query.flip === '1'
  };
  broadcast(r, { t: 'ap', id: c.id, mdl: c.mdl }, null);
  res.json({ ok: true, v: c.mdl.v });
});

// Descargar el modelo 3D de otro jugador
app.get('/api/model/:room/:cid', (req, res) => {
  const m = models.get(req.params.room + ':' + req.params.cid);
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(m.buf);
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Modelo demasiado grande (máx. ' + MAX_MODEL_MB + ' MB)' });
  console.warn('[http]', err && err.message);
  res.status(500).json({ error: 'error del servidor' });
});

const server = http.createServer(app);

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024, perMessageDeflate: false });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj, except) {
  const s = JSON.stringify(obj);
  for (const c of room.clients.values()) {
    if (c === except || !c.ready) continue;
    if (c.ws.readyState === 1) c.ws.send(s);
  }
}
function sysChat(room, text) { broadcast(room, { t: 'chat', id: '', n: '', m: text, sys: 1 }, null); }

function cleanCfg(c) {
  c = c || {};
  return {
    gender: c.gender === 'f' ? 'f' : 'm',
    skin: Math.floor(num(c.skin, 0, 5, 1)), hairStyle: Math.floor(num(c.hairStyle, 0, 4, 1)),
    hairColor: Math.floor(num(c.hairColor, 0, 6, 1)), face: Math.floor(num(c.face, 0, 2, 0)),
    mustache: Math.floor(num(c.mustache, 0, 2, 0)), height: num(c.height, 0.88, 1.12, 1),
    shirt: Math.floor(num(c.shirt, 0, 5, 0)), pants: Math.floor(num(c.pants, 0, 3, 0))
  };
}
function cleanEq(e) {
  e = e || {};
  const id = v => (typeof v === 'string' && /^[a-z0-9_]{1,24}$/.test(v)) ? v : null;
  return { head: id(e.head), chest: id(e.chest) || 'polo', legs: id(e.legs) || 'pantalon' };
}
function publicClient(c) {
  return { id: c.id, name: c.name, cfg: c.cfg, eq: c.eq, mdl: c.mdl, st: c.st };
}

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const room = rooms.get(u.searchParams.get('room') || '');
  if (!room) { ws.close(4004, 'not_found'); return; }
  if (room.clients.size >= MAX_PLAYERS) { ws.close(4003, 'full'); return; }

  const c = {
    id: rid(3), token: rid(8), ws, ready: false, name: 'Jugador', cfg: cleanCfg(), eq: cleanEq(),
    mdl: null, st: null, msgs: [], chatLog: [], alive: true
  };
  room.clients.set(c.id, c);
  const helloTimer = setTimeout(() => { if (!c.ready) ws.close(4000, 'hello_timeout'); }, 10000);

  ws.on('pong', () => { c.alive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    // Límite de mensajes por segundo
    const t = now();
    c.msgs = c.msgs.filter(x => t - x < 1000); c.msgs.push(t);
    if (c.msgs.length > 120) { if (c.msgs.length > 400) ws.close(4008, 'flood'); return; }
    let m;
    try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (!c.ready) {
      if (m.t !== 'hello') return;
      clearTimeout(helloTimer);
      c.name = clean(m.name, 16) || ('Jugador' + c.id.slice(0, 2));
      // evitar nombres repetidos
      let base = c.name, k = 2, taken = n => Array.from(room.clients.values()).some(o => o !== c && o.ready && o.name === n);
      while (taken(c.name)) c.name = base.slice(0, 13) + '#' + (k++);
      c.cfg = cleanCfg(m.cfg); c.eq = cleanEq(m.eq);
      c.ready = true; room.lastActive = now();
      const others = [];
      for (const o of room.clients.values()) if (o !== c && o.ready) others.push(publicClient(o));
      send(ws, {
        t: 'welcome', id: c.id, token: c.token, name: c.name, maxModelMB: MAX_MODEL_MB,
        room: publicInfo(room), players: others, looted: Array.from(room.looted), bars: room.bars
      });
      broadcast(room, { t: 'join', p: publicClient(c) }, c);
      sysChat(room, c.name + ' se unió al servidor');
      saveRoomsSoon();
      return;
    }

    switch (m.t) {
      case 'p': { // presencia (posición del jugador)
        c.st = {
          x: num(m.x, -1e6, 1e6, 0), y: num(m.y, -1000, 1000, 0), z: num(m.z, -1e6, 1e6, 0),
          yw: num(m.yw, -100, 100, 0), mv: num(m.mv, 0, 40, 0), hp: num(m.hp, 0, 100, 100),
          dd: m.dd ? 1 : 0, sw: m.sw ? 1 : 0, tp: m.tp ? 1 : 0
        };
        room.lastActive = t;
        broadcast(room, { t: 'p', id: c.id, ...c.st }, c);
        break;
      }
      case 'zs': case 'zh': case 'zk': case 'zx': case 'zr': case 'sh': { // zombis y disparos: reenvío directo
        if (JSON.stringify(m).length > 16000) return;
        m.f = c.id;
        broadcast(room, m, c);
        break;
      }
      case 'chat': {
        const text = clean(m.m, 160);
        if (!text) return;
        c.chatLog = c.chatLog.filter(x => t - x < 6000);
        if (c.chatLog.length >= 5) return;
        c.chatLog.push(t);
        broadcast(room, { t: 'chat', id: c.id, n: c.name, m: text }, null);
        break;
      }
      case 'loot': {
        const k = clean(m.k, 60);
        if (k && !room.looted.has(k) && room.looted.size < 20000) {
          room.looted.add(k); saveRoomsSoon();
          broadcast(room, { t: 'loot', k }, c);
        }
        break;
      }
      case 'bar': {
        const b = { x: num(m.x, -1e6, 1e6, 0), z: num(m.z, -1e6, 1e6, 0), r: num(m.r, -100, 100, 0) };
        room.bars.push(b); if (room.bars.length > 400) room.bars.shift();
        saveRoomsSoon();
        broadcast(room, { t: 'bar', ...b }, c);
        break;
      }
      case 'wave': {
        const n = Math.floor(num(m.n, 0, 9999, 0));
        if (n > room.wave && n <= room.wave + 1) {
          room.wave = n; room.bestWave = Math.max(room.bestWave, n); saveRoomsSoon();
          broadcast(room, { t: 'wave', n }, c);
          sysChat(room, '¡Oleada ' + n + '!');
        }
        break;
      }
      case 'ap': { // cambio de apariencia / equipo / ajustes del modelo
        if (m.cfg) c.cfg = cleanCfg(m.cfg);
        if (m.eq) c.eq = cleanEq(m.eq);
        if (m.mdl === null) { dropModel(room.id + ':' + c.id); c.mdl = null; }
        else if (m.mdl && c.mdl) {
          c.mdl.on = !!m.mdl.on; c.mdl.scale = num(m.mdl.scale, 0.5, 2, 1); c.mdl.flip = !!m.mdl.flip;
        }
        broadcast(room, { t: 'ap', id: c.id, cfg: c.cfg, eq: c.eq, mdl: c.mdl }, c);
        break;
      }
      case 'dead': {
        sysChat(room, c.name + ' ha muerto');
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    room.clients.delete(c.id);
    dropModel(room.id + ':' + c.id);
    room.lastActive = now();
    if (c.ready) {
      broadcast(room, { t: 'leave', id: c.id }, null);
      sysChat(room, c.name + ' salió del servidor');
    }
    saveRoomsSoon();
  });
  ws.on('error', () => {});
});

// Latido: elimina conexiones muertas (importante detrás de proxies)
setInterval(() => {
  for (const ws of wss.clients) {
    // buscamos el cliente por socket de forma barata: marcamos y esperamos pong
    if (ws._dead) { ws.terminate(); continue; }
    ws._dead = true;
    ws.once('pong', () => { ws._dead = false; });
    try { ws.ping(); } catch (_) {}
  }
}, 25000);

server.listen(PORT, () => {
  console.log('Valle Verde online escuchando en el puerto ' + PORT);
  console.log('Datos en: ' + DATA_DIR + ' · jugadores/servidor: ' + MAX_PLAYERS + ' · modelo máx.: ' + MAX_MODEL_MB + ' MB');
});

function shutdown() { try { saveRooms(); } catch (_) {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
