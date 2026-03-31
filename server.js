// ============================================================
// N TEST TREASURE HUNT — Multiplayer Server
// Node.js + Express + Socket.io
//
// Arhitectură:
// - Rooms cu max 20 jucători
// - Auto-matchmaking (intri → ești pus în room disponibil)
// - Server-side validation pentru colectare (anti-cheat)
// - Broadcast optimizat (doar pozițiile, 15 tick/s)
// - Poate rula pe un VPS de 5€ pentru test
// - Scalabil pe mai multe procese/servere
//
// Usage:
//   npm install
//   npm start           (production, port 3000)
//   npm run dev          (dev mode cu logging)
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

// ===================== CONFIG =====================
const CONFIG = {
  PORT: process.env.PORT || 3000,
  MAX_PLAYERS_PER_ROOM: 20,
  TICK_RATE: 15,                    // updates pe secundă trimise la clienți
  WORLD_SIZE: 200,
  TREASURE_COUNT: 5,
  GAME_TIME_LIMIT: 300,             // 5 minute
  INTERACT_DISTANCE: 5,             // distanță colectare (server-side check)
  PLAYER_SPEED_MAX: 0.5,            // viteză maximă acceptată (anti-speed-hack)
  ROOM_CLEANUP_INTERVAL: 30000,     // curăță rooms goale la 30s
  DEV_MODE: process.argv.includes('--dev'),

  PRIZES: [
    'Voucher 50 RON - Restaurant Costinești',
    'Brățară NIBIRU Ediție Limitată',
    'Bilet VIP Party NIBIRU',
    'Tricou NIBIRU Exclusive',
    'Voucher 100 RON - Beach Bar',
  ],
};

// ===================== SERVER SETUP =====================
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',  // În producție: pune domeniul exact
    methods: ['GET', 'POST'],
  },
  // Optimizări pentru multe conexiuni
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e4,  // 10KB max per message
  perMessageDeflate: false, // dezactivat pentru latență mai mică
});

// Servește frontend-ul static
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'client')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Health check endpoint (pentru load balancer)
app.get('/health', (req, res) => {
  const roomCount = Object.keys(rooms).length;
  const playerCount = Object.values(rooms).reduce((sum, r) => sum + r.players.size, 0);
  res.json({
    status: 'ok',
    rooms: roomCount,
    players: playerCount,
    uptime: Math.floor(process.uptime()),
  });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const stats = Object.entries(rooms).map(([id, room]) => ({
    id,
    players: room.players.size,
    maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
    started: room.started,
    elapsed: room.started ? Math.floor((Date.now() - room.startTime) / 1000) : 0,
    treasuresLeft: room.treasures.filter(t => !t.found).length,
  }));
  res.json({ rooms: stats, totalPlayers: stats.reduce((s, r) => s + r.players, 0) });
});

// ===================== ROOM MANAGEMENT =====================
const rooms = {};
let roomCounter = 0;

function createRoom() {
  const roomId = `room_${++roomCounter}_${Date.now().toString(36)}`;

  // Generează poziții treasure random (server-side = sursă de adevăr)
  const treasures = [];
  for (let i = 0; i < CONFIG.TREASURE_COUNT; i++) {
    let pos;
    let attempts = 0;
    do {
      pos = {
        x: (Math.random() - 0.5) * CONFIG.WORLD_SIZE * 0.8,
        z: (Math.random() - 0.5) * CONFIG.WORLD_SIZE * 0.8,
      };
      attempts++;
    } while (
      attempts < 50 &&
      treasures.some(t => Math.hypot(t.x - pos.x, t.z - pos.z) < 20)
    );

    treasures.push({
      id: i,
      x: pos.x,
      z: pos.z,
      found: false,
      foundBy: null,
      prize: CONFIG.PRIZES[i % CONFIG.PRIZES.length],
    });
  }

  rooms[roomId] = {
    id: roomId,
    players: new Map(),       // socketId → playerData
    treasures,
    started: false,
    startTime: null,
    endTime: null,
    createdAt: Date.now(),
  };

  log(`Room created: ${roomId}`);
  return roomId;
}

function findAvailableRoom() {
  // Caută un room cu loc care nu a început încă sau e recent
  for (const [id, room] of Object.entries(rooms)) {
    if (room.players.size < CONFIG.MAX_PLAYERS_PER_ROOM) {
      // Nu pune în rooms expirate
      if (room.started && room.endTime && Date.now() > room.endTime) continue;
      return id;
    }
  }
  // Nu există room disponibil, creează unul nou
  return createRoom();
}

function cleanupRooms() {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    // Șterge rooms goale mai vechi de 60s
    if (room.players.size === 0 && now - room.createdAt > 60000) {
      delete rooms[id];
      log(`Room cleaned up: ${id}`);
    }
    // Șterge rooms expirate (jocul terminat de > 2 min)
    if (room.endTime && now - room.endTime > 120000) {
      // Deconectează jucătorii rămași
      for (const [sid] of room.players) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('room_expired');
      }
      delete rooms[id];
      log(`Room expired and cleaned: ${id}`);
    }
  }
}

setInterval(cleanupRooms, CONFIG.ROOM_CLEANUP_INTERVAL);

// ===================== SOCKET HANDLING =====================
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = null;

  log(`Player connected: ${socket.id}`);

  // ---- JOIN ----
  socket.on('join', (data) => {
    playerName = (data.name || 'Jucător').substring(0, 20); // truncate name
    const roomId = findAvailableRoom();
    const room = rooms[roomId];
    if (!room) return;

    currentRoom = roomId;
    socket.join(roomId);

    // Player data
    const playerData = {
      id: socket.id,
      name: playerName,
      x: (Math.random() - 0.5) * 20,  // spawn aproape de centru
      z: (Math.random() - 0.5) * 20,
      angle: 0,
      score: 0,
      color: Math.floor(Math.random() * 8), // index culoare
      lastUpdate: Date.now(),
    };

    room.players.set(socket.id, playerData);

    // Trimite jucătorului info-ul room-ului
    socket.emit('joined', {
      roomId,
      playerId: socket.id,
      treasures: room.treasures.map(t => ({
        id: t.id,
        x: t.x,
        z: t.z,
        found: t.found,
      })),
      players: Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        z: p.z,
        angle: p.angle,
        color: p.color,
      })),
      gameTime: CONFIG.GAME_TIME_LIMIT,
      started: room.started,
      elapsed: room.started ? Math.floor((Date.now() - room.startTime) / 1000) : 0,
    });

    // Anunță ceilalți jucători
    socket.to(roomId).emit('player_joined', {
      id: socket.id,
      name: playerName,
      x: playerData.x,
      z: playerData.z,
      angle: 0,
      color: playerData.color,
    });

    log(`${playerName} joined ${roomId} (${room.players.size}/${CONFIG.MAX_PLAYERS_PER_ROOM})`);

    // Auto-start când sunt minim 2 jucători (sau imediat pe dev)
    if (!room.started && (room.players.size >= 2 || CONFIG.DEV_MODE)) {
      startRoom(roomId);
    }
  });

  // ---- PLAYER POSITION UPDATE ----
  socket.on('pos', (data) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.get(socket.id);
    if (!player) return;

    // Anti-cheat: verifică viteza
    const dx = data.x - player.x;
    const dz = data.z - player.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const dt = (Date.now() - player.lastUpdate) / 1000;

    if (dt > 0 && dist / dt > CONFIG.PLAYER_SPEED_MAX * 60) {
      // Mișcare prea rapidă — probabil hack, ignoră
      log(`Speed hack detected: ${player.name} (${(dist/dt).toFixed(1)} u/s)`);
      return;
    }

    // Clamp la world bounds
    player.x = Math.max(-CONFIG.WORLD_SIZE, Math.min(CONFIG.WORLD_SIZE, data.x || 0));
    player.z = Math.max(-CONFIG.WORLD_SIZE, Math.min(CONFIG.WORLD_SIZE, data.z || 0));
    player.angle = data.a || 0;
    player.lastUpdate = Date.now();
  });

  // ---- COLLECT TREASURE ----
  socket.on('collect', (data) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.get(socket.id);
    if (!player || !room.started) return;

    const treasureId = data.id;
    const treasure = room.treasures.find(t => t.id === treasureId);
    if (!treasure || treasure.found) return;

    // Server-side distance check (anti-cheat)
    const dist = Math.hypot(player.x - treasure.x, player.z - treasure.z);
    if (dist > CONFIG.INTERACT_DISTANCE) {
      log(`Collect cheat attempt: ${player.name} dist=${dist.toFixed(1)}`);
      return;
    }

    // Valid collection!
    treasure.found = true;
    treasure.foundBy = socket.id;
    player.score++;

    // Generează cod premiu
    const code = 'NTEST-' + Math.random().toString(36).substring(2, 6).toUpperCase();

    // Trimite confirmarea celui care a colectat
    socket.emit('collect_ok', {
      id: treasureId,
      prize: treasure.prize,
      code: code,
      score: player.score,
    });

    // Anunță toți ceilalți din room
    socket.to(currentRoom).emit('treasure_collected', {
      id: treasureId,
      byName: player.name,
      byId: socket.id,
    });

    log(`${player.name} collected treasure #${treasureId} in ${currentRoom}`);

    // Check dacă toate comorile au fost găsite
    const allFound = room.treasures.every(t => t.found);
    if (allFound) {
      endRoom(currentRoom, 'all_found');
    }
  });

  // ---- CHAT ----
  socket.on('chat', (data) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.get(socket.id);
    if (!player) return;

    const text = (data.text || '').substring(0, 120); // truncate
    if (!text) return;

    // Broadcast la toți din room (inclusiv sender)
    io.to(currentRoom).emit('chat_msg', {
      name: player.name,
      text,
      system: false,
    });
  });

  // ---- PLAYER READY (apasă Start Hunt) ----
  socket.on('ready', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!room.started) {
      startRoom(currentRoom);
    }
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      const player = room.players.get(socket.id);
      const name = player ? player.name : 'Unknown';

      room.players.delete(socket.id);

      // Anunță ceilalți
      socket.to(currentRoom).emit('player_left', {
        id: socket.id,
        name,
      });

      log(`${name} left ${currentRoom} (${room.players.size} remaining)`);
    }
  });
});

// ===================== ROOM LIFECYCLE =====================
function startRoom(roomId) {
  const room = rooms[roomId];
  if (!room || room.started) return;

  room.started = true;
  room.startTime = Date.now();
  room.endTime = Date.now() + CONFIG.GAME_TIME_LIMIT * 1000;

  io.to(roomId).emit('game_start', {
    startTime: room.startTime,
    endTime: room.endTime,
    duration: CONFIG.GAME_TIME_LIMIT,
  });

  // Timer server-side pentru expirare
  setTimeout(() => {
    if (rooms[roomId] && rooms[roomId].started && !rooms[roomId].ended) {
      endRoom(roomId, 'time_up');
    }
  }, CONFIG.GAME_TIME_LIMIT * 1000);

  log(`Game started in ${roomId} with ${room.players.size} players`);
}

function endRoom(roomId, reason) {
  const room = rooms[roomId];
  if (!room) return;

  room.ended = true;
  const elapsed = Math.floor((Date.now() - room.startTime) / 1000);

  // Scoreboard
  const scoreboard = Array.from(room.players.values())
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  io.to(roomId).emit('game_end', {
    reason,
    elapsed,
    scoreboard,
  });

  log(`Game ended in ${roomId}: ${reason} (${elapsed}s)`);
}

// ===================== GAME TICK (broadcast positions) =====================
setInterval(() => {
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.players.size === 0) continue;

    // Construiește array compact de poziții
    const positions = [];
    for (const [sid, p] of room.players) {
      positions.push({
        id: sid,
        x: Math.round(p.x * 100) / 100,  // 2 decimale e suficient
        z: Math.round(p.z * 100) / 100,
        a: Math.round(p.angle * 100) / 100,
      });
    }

    // Broadcast la toți din room
    io.to(roomId).volatile.emit('tick', positions);
  }
}, 1000 / CONFIG.TICK_RATE);

// ===================== LOGGING =====================
function log(msg) {
  if (CONFIG.DEV_MODE) {
    console.log(`[${new Date().toISOString().substr(11, 8)}] ${msg}`);
  }
}

// ===================== START =====================
server.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   N TEST TREASURE HUNT — Multiplayer Server  ║
║   Port: ${CONFIG.PORT}                              ║
║   Max per room: ${CONFIG.MAX_PLAYERS_PER_ROOM}                          ║
║   Tick rate: ${CONFIG.TICK_RATE} Hz                          ║
║   Mode: ${CONFIG.DEV_MODE ? 'DEVELOPMENT' : 'PRODUCTION '}                     ║
╚══════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  io.emit('server_restart', { message: 'Server se restartează, reconectare automată...' });
  server.close(() => process.exit(0));
});
