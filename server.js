const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// ===================== CONFIG =====================
const CONFIG = {
  PORT: process.env.PORT || 3000,
  CLIENT_ORIGIN: 'https://test.streetartstudios.net',

  MAX_PLAYERS_PER_ROOM: 20,
  TICK_RATE: 15,
  WORLD_SIZE: 200,
  TREASURE_COUNT: 5,
  GAME_TIME_LIMIT: 300, // 5 minute
  INTERACT_DISTANCE: 5,
  PLAYER_SPEED_MAX: 30, // unități / secundă
  ROOM_CLEANUP_INTERVAL: 30000,
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

app.use(cors({
  origin: [CONFIG.CLIENT_ORIGIN],
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// Root endpoint simplu
app.get('/', (req, res) => {
  res.json({
    status: 'API OK',
    name: 'N TEST TREASURE HUNT Multiplayer Server',
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const roomCount = Object.keys(rooms).length;
  const playerCount = Object.values(rooms).reduce((sum, r) => sum + r.players.size, 0);

  res.json({
    status: 'ok',
    rooms: roomCount,
    players: playerCount,
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
  });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const stats = Object.entries(rooms).map(([id, room]) => ({
    id,
    players: room.players.size,
    maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
    started: room.started,
    ended: room.ended,
    elapsed: room.started ? Math.floor((Date.now() - room.startTime) / 1000) : 0,
    treasuresLeft: room.treasures.filter(t => !t.found).length,
  }));

  res.json({
    rooms: stats,
    totalPlayers: stats.reduce((sum, room) => sum + room.players, 0),
  });
});

const io = new Server(server, {
  cors: {
    origin: [CONFIG.CLIENT_ORIGIN],
    methods: ['GET', 'POST'],
  },
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e4,
  perMessageDeflate: false,
});

// ===================== ROOM MANAGEMENT =====================
const rooms = {};
let roomCounter = 0;

function createRoom() {
  const roomId = `room_${++roomCounter}_${Date.now().toString(36)}`;

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
    players: new Map(),
    treasures,
    started: false,
    ended: false,
    startTime: null,
    endTime: null,
    createdAt: Date.now(),
  };

  log(`Room created: ${roomId}`);
  return roomId;
}

function findAvailableRoom() {
  for (const [id, room] of Object.entries(rooms)) {
    if (room.players.size >= CONFIG.MAX_PLAYERS_PER_ROOM) continue;
    if (room.ended) continue;
    if (room.endTime && Date.now() > room.endTime) continue;
    return id;
  }

  return createRoom();
}

function cleanupRooms() {
  const now = Date.now();

  for (const [id, room] of Object.entries(rooms)) {
    if (room.players.size === 0 && now - room.createdAt > 60000) {
      delete rooms[id];
      log(`Room cleaned up: ${id}`);
      continue;
    }

    if (room.endTime && now - room.endTime > 120000) {
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
  socket.on('join', (data = {}) => {
    playerName = String(data.name || 'Jucător').substring(0, 20);

    const roomId = findAvailableRoom();
    const room = rooms[roomId];
    if (!room) return;

    currentRoom = roomId;
    socket.join(roomId);

    const playerData = {
      id: socket.id,
      name: playerName,
      x: (Math.random() - 0.5) * 20,
      z: (Math.random() - 0.5) * 20,
      angle: 0,
      score: 0,
      color: Math.floor(Math.random() * 8),
      lastUpdate: Date.now(),
    };

    room.players.set(socket.id, playerData);

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
        score: p.score,
      })),
      gameTime: CONFIG.GAME_TIME_LIMIT,
      started: room.started,
      ended: room.ended,
      elapsed: room.started && room.startTime
        ? Math.floor((Date.now() - room.startTime) / 1000)
        : 0,
    });

    socket.to(roomId).emit('player_joined', {
      id: socket.id,
      name: playerName,
      x: playerData.x,
      z: playerData.z,
      angle: playerData.angle,
      color: playerData.color,
      score: playerData.score,
    });

    log(`${playerName} joined ${roomId} (${room.players.size}/${CONFIG.MAX_PLAYERS_PER_ROOM})`);

    if (!room.started && !room.ended && (room.players.size >= 2 || CONFIG.DEV_MODE)) {
      startRoom(roomId);
    }
  });

  // ---- PLAYER POSITION UPDATE ----
  socket.on('pos', (data = {}) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.get(socket.id);
    if (!player) return;
    if (room.ended) return;

    const now = Date.now();
    const nextX = Number(data.x || 0);
    const nextZ = Number(data.z || 0);
    const nextA = Number(data.a || 0);

    const dx = nextX - player.x;
    const dz = nextZ - player.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const dt = (now - player.lastUpdate) / 1000;

    if (dt > 0 && dist / dt > CONFIG.PLAYER_SPEED_MAX) {
      log(`Speed hack detected: ${player.name} (${(dist / dt).toFixed(1)} u/s)`);
      return;
    }

    player.x = Math.max(-CONFIG.WORLD_SIZE, Math.min(CONFIG.WORLD_SIZE, nextX));
    player.z = Math.max(-CONFIG.WORLD_SIZE, Math.min(CONFIG.WORLD_SIZE, nextZ));
    player.angle = nextA;
    player.lastUpdate = now;
  });

  // ---- COLLECT TREASURE ----
  socket.on('collect', (data = {}) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.get(socket.id);
    if (!player || !room.started || room.ended) return;

    const treasureId = Number(data.id);
    const treasure = room.treasures.find(t => t.id === treasureId);
    if (!treasure || treasure.found) return;

    const dist = Math.hypot(player.x - treasure.x, player.z - treasure.z);
    if (dist > CONFIG.INTERACT_DISTANCE) {
      log(`Collect cheat attempt: ${player.name} dist=${dist.toFixed(1)}`);
      return;
    }

    treasure.found = true;
    treasure.foundBy = socket.id;
    player.score++;

    const code = 'NTEST-' + Math.random().toString(36).substring(2, 6).toUpperCase();

    socket.emit('collect_ok', {
      id: treasureId,
      prize: treasure.prize,
      code,
      score: player.score,
    });

    socket.to(currentRoom).emit('treasure_collected', {
      id: treasureId,
      byName: player.name,
      byId: socket.id,
    });

    log(`${player.name} collected treasure #${treasureId} in ${currentRoom}`);

    const allFound = room.treasures.every(t => t.found);
    if (allFound) {
      endRoom(currentRoom, 'all_found');
    }
  });

  // ---- CHAT ----
  socket.on('chat', (data = {}) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.get(socket.id);
    if (!player || room.ended) return;

    const text = String(data.text || '').substring(0, 120).trim();
    if (!text) return;

    io.to(currentRoom).emit('chat_msg', {
      name: player.name,
      text,
      system: false,
    });
  });

  // ---- PLAYER READY ----
  socket.on('ready', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!room.started && !room.ended) {
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
  if (!room || room.started || room.ended) return;

  room.started = true;
  room.startTime = Date.now();
  room.endTime = room.startTime + CONFIG.GAME_TIME_LIMIT * 1000;

  io.to(roomId).emit('game_start', {
    startTime: room.startTime,
    endTime: room.endTime,
    duration: CONFIG.GAME_TIME_LIMIT,
  });

  setTimeout(() => {
    if (rooms[roomId] && rooms[roomId].started && !rooms[roomId].ended) {
      endRoom(roomId, 'time_up');
    }
  }, CONFIG.GAME_TIME_LIMIT * 1000);

  log(`Game started in ${roomId} with ${room.players.size} players`);
}

function endRoom(roomId, reason) {
  const room = rooms[roomId];
  if (!room || room.ended) return;

  room.ended = true;
  const elapsed = room.startTime
    ? Math.floor((Date.now() - room.startTime) / 1000)
    : 0;

  const scoreboard = Array.from(room.players.values())
    .map(p => ({
      name: p.name,
      score: p.score,
    }))
    .sort((a, b) => b.score - a.score);

  io.to(roomId).emit('game_end', {
    reason,
    elapsed,
    scoreboard,
  });

  log(`Game ended in ${roomId}: ${reason} (${elapsed}s)`);
}

// ===================== GAME TICK =====================
setInterval(() => {
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.players.size === 0) continue;
    if (room.ended) continue;

    const positions = [];
    for (const [sid, p] of room.players) {
      positions.push({
        id: sid,
        x: Math.round(p.x * 100) / 100,
        z: Math.round(p.z * 100) / 100,
        a: Math.round(p.angle * 100) / 100,
      });
    }

    io.to(roomId).volatile.emit('tick', positions);
  }
}, 1000 / CONFIG.TICK_RATE);

// ===================== LOGGING =====================
function log(msg) {
  if (CONFIG.DEV_MODE) {
    console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`);
  }
}

// ===================== START =====================
server.listen(CONFIG.PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║   N TEST TREASURE HUNT — Multiplayer Server       ║
║   Port: ${String(CONFIG.PORT).padEnd(36, ' ')}║
║   Max per room: ${String(CONFIG.MAX_PLAYERS_PER_ROOM).padEnd(28, ' ')}║
║   Tick rate: ${String(CONFIG.TICK_RATE).padEnd(31, ' ')}║
║   Mode: ${CONFIG.DEV_MODE ? 'DEVELOPMENT' : 'PRODUCTION'}${CONFIG.DEV_MODE ? ' '.repeat(23) : ' '.repeat(24)}║
╚════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  io.emit('server_restart', {
    message: 'Server se restartează, reconectare automată...',
  });
  server.close(() => process.exit(0));
});