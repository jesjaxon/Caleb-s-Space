'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM || 5);
const ROOM_SAVE_FILE = process.env.ROOM_SAVE_FILE || path.join(__dirname, 'room-state.json');
const WORLD = { width: 18000, height: 13500, border: 160 };
const TICK_MS = 50;
const ENEMY_TYPES = {
  scout: { hp: 3, speed: 2.8, fireRange: 520, fireCooldown: 24, shotSpeed: 11, damage: 1, radius: 18, color: '#ffaa44' },
  fighter: { hp: 5, speed: 2.1, fireRange: 620, fireCooldown: 34, shotSpeed: 9, damage: 1, radius: 22, color: '#ff5555' },
  tank: { hp: 10, speed: 1.3, fireRange: 760, fireCooldown: 52, shotSpeed: 7, damage: 2, radius: 28, color: '#ff2200' }
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Space Arena multiplayer relay is running.\n');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

function createEmptyWorldState() {
  return { planets: [], bhs: [], asteroids: [], npcs: [] };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function send(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastRoom(room, payload, exceptId) {
  for (const [clientId, peer] of room.clients) {
    if (clientId === exceptId) continue;
    send(peer.ws, payload);
  }
}

function createRoom(id) {
  return {
    id,
    clients: new Map(),
    teams: new Map(),
    worldHostId: null,
    worldState: createEmptyWorldState(),
    enemies: [],
    enemyShots: [],
    playerShots: [],
    nextEnemyId: 1,
    nextShotId: 1,
    nextTeamId: 1,
    spawnCooldown: 0,
    tick: 0,
    awardLog: new Map(),
    lastActiveAt: Date.now()
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom(roomId));
  }
  return rooms.get(roomId);
}

function serializeRoom(room) {
  return {
    id: room.id,
    worldHostId: null,
    worldState: room.worldState || createEmptyWorldState(),
    enemies: room.enemies || [],
    enemyShots: room.enemyShots || [],
    playerShots: [],
    nextEnemyId: room.nextEnemyId || 1,
    nextShotId: room.nextShotId || 1,
    nextTeamId: room.nextTeamId || 1,
    spawnCooldown: room.spawnCooldown || 0,
    tick: room.tick || 0,
    lastActiveAt: room.lastActiveAt || Date.now()
  };
}

function hydrateRoom(raw) {
  const room = createRoom(String(raw.id || 'main'));
  room.worldState = raw.worldState || createEmptyWorldState();
  room.enemies = Array.isArray(raw.enemies) ? raw.enemies : [];
  room.enemyShots = Array.isArray(raw.enemyShots) ? raw.enemyShots : [];
  room.playerShots = [];
  room.nextEnemyId = Number(raw.nextEnemyId) || 1;
  room.nextShotId = Number(raw.nextShotId) || 1;
  room.nextTeamId = Number(raw.nextTeamId) || 1;
  room.spawnCooldown = Number(raw.spawnCooldown) || 0;
  room.tick = Number(raw.tick) || 0;
  room.lastActiveAt = Number(raw.lastActiveAt) || Date.now();
  return room;
}

function saveRoomsToDisk() {
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      rooms: [...rooms.values()].map(serializeRoom)
    };
    fs.writeFileSync(ROOM_SAVE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save rooms:', error.message);
  }
}

function loadRoomsFromDisk() {
  try {
    if (!fs.existsSync(ROOM_SAVE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ROOM_SAVE_FILE, 'utf8'));
    for (const roomData of raw.rooms || []) {
      const room = hydrateRoom(roomData);
      rooms.set(room.id, room);
    }
    console.log(`Loaded ${rooms.size} persisted room(s) from ${ROOM_SAVE_FILE}`);
  } catch (error) {
    console.error('Failed to load saved rooms:', error.message);
  }
}

loadRoomsFromDisk();

function teamList(room) {
  return [...room.teams.values()].map(team => ({
    id: team.id,
    leaderId: team.leaderId,
    members: [...team.members]
  }));
}

function broadcastTeams(room) {
  const payload = { type: 'team-state', teams: teamList(room) };
  for (const peer of room.clients.values()) send(peer.ws, payload);
}

function getTeam(room, teamId) {
  return teamId ? room.teams.get(teamId) || null : null;
}

function clearClientTeam(room, clientId) {
  const peer = room.clients.get(clientId);
  if (peer) peer.state.teamId = null;
}

function removeClientFromTeam(room, clientId) {
  const peer = room.clients.get(clientId);
  const teamId = peer?.state?.teamId || null;
  if (!teamId) return;
  const team = room.teams.get(teamId);
  clearClientTeam(room, clientId);
  if (!team) return;
  team.members.delete(clientId);
  if (team.leaderId === clientId) {
    team.leaderId = team.members.values().next().value || null;
  }
  if (team.members.size < 2) {
    for (const memberId of team.members) clearClientTeam(room, memberId);
    room.teams.delete(teamId);
  }
}

function createTeam(room, memberIds) {
  const members = [...new Set(memberIds)].filter(id => room.clients.has(id));
  if (members.length < 2) return null;
  const team = {
    id: `team-${room.nextTeamId++}`,
    leaderId: members[0],
    members: new Set(members)
  };
  room.teams.set(team.id, team);
  for (const memberId of members) {
    room.clients.get(memberId).state.teamId = team.id;
  }
  return team;
}

function addClientToTeam(room, clientId, teamId) {
  const team = getTeam(room, teamId);
  const peer = room.clients.get(clientId);
  if (!team || !peer) return null;
  removeClientFromTeam(room, clientId);
  team.members.add(clientId);
  peer.state.teamId = team.id;
  if (!team.leaderId) team.leaderId = clientId;
  return team;
}

function mergeTeams(room, primaryTeamId, secondaryTeamId) {
  if (!primaryTeamId || !secondaryTeamId || primaryTeamId === secondaryTeamId) {
    return getTeam(room, primaryTeamId || secondaryTeamId);
  }
  const primary = getTeam(room, primaryTeamId);
  const secondary = getTeam(room, secondaryTeamId);
  if (!primary || !secondary) return primary || secondary || null;
  for (const memberId of secondary.members) {
    primary.members.add(memberId);
    const peer = room.clients.get(memberId);
    if (peer) peer.state.teamId = primary.id;
  }
  room.teams.delete(secondary.id);
  return primary;
}

function findNearestTeammateCandidate(room, clientId, maxDistance) {
  const me = room.clients.get(clientId)?.state;
  if (!me) return null;
  let bestPeer = null;
  let bestDistance = maxDistance;
  for (const [peerId, peer] of room.clients) {
    if (peerId === clientId) continue;
    if (peer.state.alive === false) continue;
    const d = distance(me, peer.state);
    if (d <= bestDistance) {
      bestDistance = d;
      bestPeer = peer;
    }
  }
  return bestPeer;
}

function joinNearbyTeam(room, clientId, maxDistance) {
  const nearPeer = findNearestTeammateCandidate(room, clientId, maxDistance);
  if (!nearPeer) return null;
  const myPeer = room.clients.get(clientId);
  const myTeamId = myPeer.state.teamId || null;
  const otherTeamId = nearPeer.state.teamId || null;
  let team = null;
  if (!myTeamId && !otherTeamId) {
    team = createTeam(room, [clientId, nearPeer.state.id]);
  } else if (myTeamId && !otherTeamId) {
    team = addClientToTeam(room, nearPeer.state.id, myTeamId);
  } else if (!myTeamId && otherTeamId) {
    team = addClientToTeam(room, clientId, otherTeamId);
  } else {
    team = mergeTeams(room, myTeamId, otherTeamId);
  }
  return team ? { team, nearPeer } : null;
}

function awardTeamMembers(room, sourceClientId, award) {
  const sourcePeer = room.clients.get(sourceClientId);
  const teamId = sourcePeer?.state?.teamId || null;
  const team = getTeam(room, teamId);
  if (!team) return;

  const eventId = String(award.eventId || '').slice(0, 80);
  if (!eventId) return;
  const stamp = room.awardLog.get(eventId);
  if (stamp && room.tick - stamp < 20 * 60) return;
  room.awardLog.set(eventId, room.tick);

  const gems = clamp(Number(award.gems) || 0, 0, 5000);
  const rep = clamp(Number(award.rep) || 0, -100, 100);
  const faction = String(award.faction || '').slice(0, 24);
  const label = String(award.label || 'Team reward').slice(0, 80);

  for (const memberId of team.members) {
    if (memberId === sourceClientId) continue;
    const peer = room.clients.get(memberId);
    if (!peer) continue;
    send(peer.ws, {
      type: 'team-reward',
      fromId: sourceClientId,
      fromName: sourcePeer.state.name,
      teamId,
      reward: { gems, rep, faction, label }
    });
  }
}

function roomCenter(room) {
  const alive = [...room.clients.values()].filter(peer => peer.state.alive !== false);
  if (!alive.length) {
    return { x: 7000, y: 700 };
  }
  const sum = alive.reduce((acc, peer) => {
    acc.x += peer.state.x || 7000;
    acc.y += peer.state.y || 700;
    return acc;
  }, { x: 0, y: 0 });
  return { x: sum.x / alive.length, y: sum.y / alive.length };
}

function randomEnemyType() {
  const roll = Math.random();
  if (roll < 0.45) return 'scout';
  if (roll < 0.82) return 'fighter';
  return 'tank';
}

function spawnEnemy(room) {
  const center = roomCenter(room);
  const type = randomEnemyType();
  const def = ENEMY_TYPES[type];
  const ang = Math.random() * Math.PI * 2;
  const dist = 450 + Math.random() * 650;
  room.enemies.push({
    id: `e${room.nextEnemyId++}`,
    type,
    x: clamp(center.x + Math.cos(ang) * dist, WORLD.border, WORLD.width - WORLD.border),
    y: clamp(center.y + Math.sin(ang) * dist, WORLD.border, WORLD.height - WORLD.border),
    vx: 0,
    vy: 0,
    ang: Math.random() * Math.PI * 2,
    hp: def.hp,
    maxHp: def.hp,
    fireCooldown: 10 + Math.floor(Math.random() * def.fireCooldown)
  });
}

function removeClient(ws) {
  const { roomId, clientId } = ws.meta || {};
  if (!roomId || !clientId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  removeClientFromTeam(room, clientId);
  room.clients.delete(clientId);
  room.lastActiveAt = Date.now();
  if (room.worldHostId === clientId) {
    const nextHost = room.clients.keys().next().value || null;
    room.worldHostId = nextHost;
    if (nextHost) {
      const nextPeer = room.clients.get(nextHost);
      send(nextPeer.ws, { type: 'world-host', id: nextHost, isHost: true });
      broadcastRoom(room, { type: 'world-host', id: nextHost, isHost: false }, nextHost);
      if (room.worldState) {
        broadcastRoom(room, { type: 'room-world-state', world: room.worldState });
        send(nextPeer.ws, { type: 'room-world-state', world: room.worldState });
      }
    }
  }
  broadcastRoom(room, { type: 'peer-left', id: clientId });
  broadcastTeams(room);
  saveRoomsToDisk();
}

function handlePlayerShot(room, clientId, shot) {
  room.playerShots.push({
    id: `ps${room.nextShotId++}`,
    owner: clientId,
    x: Number(shot.x) || 0,
    y: Number(shot.y) || 0,
    vx: Number(shot.vx) || 0,
    vy: Number(shot.vy) || 0,
    dmg: clamp(Number(shot.dmg) || 1, 1, 30),
    life: 0,
    maxLife: clamp(Number(shot.maxLife) || 1, 0.2, 4)
  });
}

function fireEnemyShot(room, enemy, target, def) {
  const ang = Math.atan2(target.y - enemy.y, target.x - enemy.x);
  room.enemyShots.push({
    id: `es${room.nextShotId++}`,
    enemyId: enemy.id,
    x: enemy.x + Math.cos(ang) * (def.radius + 8),
    y: enemy.y + Math.sin(ang) * (def.radius + 8),
    vx: Math.cos(ang) * def.shotSpeed + enemy.vx * 0.2,
    vy: Math.sin(ang) * def.shotSpeed + enemy.vy * 0.2,
    dmg: def.damage,
    life: 0,
    maxLife: 1.8
  });
}

function updateEnemies(room) {
  const alivePlayers = [...room.clients.values()].filter(peer => peer.state.alive !== false);
  const desiredEnemies = clamp(alivePlayers.length * 3, 3, 12);
  if (room.enemies.length < desiredEnemies) {
    room.spawnCooldown--;
    if (room.spawnCooldown <= 0) {
      spawnEnemy(room);
      room.spawnCooldown = 12;
    }
  }

  for (const enemy of room.enemies) {
    const def = ENEMY_TYPES[enemy.type];
    let target = null;
    let best = Infinity;
    for (const peer of alivePlayers) {
      const d = distance(enemy, peer.state);
      if (d < best) {
        best = d;
        target = peer.state;
      }
    }
    if (!target) continue;
    const ang = Math.atan2(target.y - enemy.y, target.x - enemy.x);
    enemy.ang = ang;
    enemy.vx += Math.cos(ang) * def.speed * 0.18;
    enemy.vy += Math.sin(ang) * def.speed * 0.18;
    const speed = Math.hypot(enemy.vx, enemy.vy) || 1;
    if (speed > def.speed) {
      enemy.vx = enemy.vx / speed * def.speed;
      enemy.vy = enemy.vy / speed * def.speed;
    }
    enemy.x = clamp(enemy.x + enemy.vx, WORLD.border, WORLD.width - WORLD.border);
    enemy.y = clamp(enemy.y + enemy.vy, WORLD.border, WORLD.height - WORLD.border);
    enemy.vx *= 0.96;
    enemy.vy *= 0.96;
    enemy.fireCooldown--;
    if (best <= def.fireRange && enemy.fireCooldown <= 0) {
      fireEnemyShot(room, enemy, target, def);
      enemy.fireCooldown = def.fireCooldown;
    }
  }
}

function updatePlayerShots(room) {
  for (let i = room.playerShots.length - 1; i >= 0; i--) {
    const shot = room.playerShots[i];
    shot.x += shot.vx;
    shot.y += shot.vy;
    shot.life += 0.016;
    let hit = false;
    for (const enemy of room.enemies) {
      const def = ENEMY_TYPES[enemy.type];
      if (Math.hypot(shot.x - enemy.x, shot.y - enemy.y) <= def.radius + 7) {
        enemy.hp -= shot.dmg;
        hit = true;
        if (enemy.hp <= 0) {
          const killer = room.clients.get(shot.owner);
          if (killer) {
            killer.score = (killer.score || 0) + 1;
            send(killer.ws, {
              type: 'enemy-killed',
              enemyId: enemy.id,
              score: killer.score
            });
            awardTeamMembers(room, shot.owner, {
              eventId: `kill:${enemy.id}`,
              gems: 5,
              rep: 0,
              faction: '',
              label: 'Shared enemy destroyed +5 gems'
            });
          }
        }
        break;
      }
    }
    if (hit || shot.life > shot.maxLife || shot.x < 0 || shot.x > WORLD.width || shot.y < 0 || shot.y > WORLD.height) {
      room.playerShots.splice(i, 1);
    }
  }
  room.enemies = room.enemies.filter(enemy => enemy.hp > 0);
}

function updateEnemyShots(room) {
  for (let i = room.enemyShots.length - 1; i >= 0; i--) {
    const shot = room.enemyShots[i];
    shot.x += shot.vx;
    shot.y += shot.vy;
    shot.life += 0.016;
    let hit = false;
    for (const [clientId, peer] of room.clients) {
      if (peer.state.alive === false) continue;
      if (Math.hypot(shot.x - peer.state.x, shot.y - peer.state.y) <= 26) {
        hit = true;
        send(peer.ws, { type: 'player-hit', dmg: shot.dmg, x: shot.x, y: shot.y });
        break;
      }
    }
    if (hit || shot.life > shot.maxLife || shot.x < 0 || shot.x > WORLD.width || shot.y < 0 || shot.y > WORLD.height) {
      room.enemyShots.splice(i, 1);
    }
  }
}

function roomSnapshot(room) {
  return {
    type: 'room-state',
    enemies: room.enemies.map(enemy => ({
      id: enemy.id,
      type: enemy.type,
      x: enemy.x,
      y: enemy.y,
      ang: enemy.ang,
      hp: enemy.hp,
      maxHp: enemy.maxHp
    })),
    enemyShots: room.enemyShots.map(shot => ({
      id: shot.id,
      x: shot.x,
      y: shot.y,
      dmg: shot.dmg
    })),
    scores: [...room.clients.values()].map(peer => ({
      id: peer.state.id,
      name: peer.state.name,
      score: peer.score || 0
    }))
  };
}

function tickRoom(room) {
  room.tick++;
  updateEnemies(room);
  updatePlayerShots(room);
  updateEnemyShots(room);
  if (room.clients.size > 0 && room.tick % 2 === 0) {
    broadcastRoom(room, roomSnapshot(room));
    for (const peer of room.clients.values()) {
      send(peer.ws, roomSnapshot(room));
    }
  }
  if (room.tick % Math.round(5000 / TICK_MS) === 0) {
    saveRoomsToDisk();
  }
}

wss.on('connection', ws => {
  ws.meta = { roomId: null, clientId: randomUUID() };

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      const roomId = String(msg.room || 'caleb-sector').toLowerCase().slice(0, 32);
      const name = String(msg.name || 'Pilot').slice(0, 20);
      const room = getRoom(roomId);
      if (room.clients.size >= MAX_PLAYERS_PER_ROOM) {
        send(ws, { type: 'room-full', room: roomId, maxPlayers: MAX_PLAYERS_PER_ROOM });
        ws.close();
        return;
      }
      room.lastActiveAt = Date.now();
      ws.meta.roomId = roomId;
      if (!room.worldHostId) room.worldHostId = ws.meta.clientId;
      room.clients.set(ws.meta.clientId, {
        ws,
        score: 0,
        state: {
          id: ws.meta.clientId,
          name,
          x: 7000,
          y: 700,
          vx: 0,
          vy: 0,
          ang: 0,
          alive: true,
          hp: 10,
          teamId: null
        }
      });
      send(ws, { type: 'welcome', id: ws.meta.clientId, room: roomId });
      send(ws, { type: 'world-host', id: room.worldHostId, isHost: room.worldHostId === ws.meta.clientId });
      send(ws, {
        type: 'peers',
        players: [...room.clients.values()]
          .filter(peer => peer.ws !== ws)
          .map(peer => ({ ...peer.state, score: peer.score || 0 }))
      });
      send(ws, roomSnapshot(room));
      send(ws, { type: 'team-state', teams: teamList(room) });
      if (room.worldState) {
        send(ws, { type: 'room-world-state', world: room.worldState });
      }
      broadcastRoom(
        room,
        {
          type: 'peer-joined',
          id: ws.meta.clientId,
          name,
          player: room.clients.get(ws.meta.clientId).state
        },
        ws.meta.clientId
      );
      broadcastTeams(room);
      saveRoomsToDisk();
      return;
    }

    const { roomId, clientId } = ws.meta || {};
    if (!roomId || !clientId) return;
    const room = rooms.get(roomId);
    if (!room || !room.clients.has(clientId)) return;

    if (msg.type === 'state' && msg.state) {
      const peer = room.clients.get(clientId);
      peer.state = {
        ...peer.state,
        ...msg.state,
        id: clientId,
        name: String(msg.state.name || peer.state.name || 'Pilot').slice(0, 20),
        teamId: peer.state.teamId || null
      };
      room.lastActiveAt = Date.now();
      broadcastRoom(room, { type: 'peer-state', id: clientId, state: peer.state }, clientId);
      return;
    }

    if (msg.type === 'shot' && msg.shot) {
      handlePlayerShot(room, clientId, msg.shot);
      return;
    }

    if (msg.type === 'world-state' && msg.world && room.worldHostId === clientId) {
      room.worldState = msg.world;
      room.lastActiveAt = Date.now();
      broadcastRoom(room, { type: 'room-world-state', world: room.worldState }, clientId);
      saveRoomsToDisk();
      return;
    }

    if (msg.type === 'team-nearby') {
      const joined = joinNearbyTeam(room, clientId, clamp(Number(msg.range) || 260, 120, 500));
      if (!joined) {
        send(ws, { type: 'team-feedback', ok: false, message: 'No nearby pilot to team with.' });
        return;
      }
      const memberNames = [...joined.team.members]
        .map(memberId => room.clients.get(memberId)?.state?.name || 'Pilot')
        .filter(Boolean);
      broadcastTeams(room);
      for (const memberId of joined.team.members) {
        const peer = room.clients.get(memberId);
        if (!peer) continue;
        send(peer.ws, {
          type: 'team-feedback',
          ok: true,
          teamId: joined.team.id,
          message: `Team linked: ${memberNames.join(', ')}`
        });
      }
      room.lastActiveAt = Date.now();
      saveRoomsToDisk();
      return;
    }

    if (msg.type === 'team-award' && msg.award) {
      awardTeamMembers(room, clientId, msg.award);
      room.lastActiveAt = Date.now();
      saveRoomsToDisk();
    }
  });

  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

setInterval(() => {
  for (const room of rooms.values()) {
    tickRoom(room);
  }
}, TICK_MS);

server.listen(PORT, HOST, () => {
  console.log(`Space Arena multiplayer relay listening on ${HOST}:${PORT}`);
});
