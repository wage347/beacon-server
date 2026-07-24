/**
 * Beacon server
 * Express REST API + WebSocket push channel + JSON-file storage.
 * No external database required — everything lives under ./data
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { WebSocketServer, WebSocket } = require('ws');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SECRET_PATH = path.join(DATA_DIR, '.secret');
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* JWT secret: generate once, persist across restarts                  */
/* ------------------------------------------------------------------ */
function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_PATH, secret);
  return secret;
}
const JWT_SECRET = loadOrCreateSecret();

/* ------------------------------------------------------------------ */
/* Tiny JSON-file datastore                                            */
/* ------------------------------------------------------------------ */
function defaultDB() {
  return { users: {}, friendships: [], friendRequests: [], messages: {} };
}
function loadDB() {
  if (!fs.existsSync(DB_PATH)) return defaultDB();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('Could not parse data/db.json, starting fresh.', e);
    return defaultDB();
  }
}
let db = loadDB();
function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function convKey(a, b) {
  return [a.toLowerCase(), b.toLowerCase()].sort().join('|');
}
function areFriends(aLower, bLower) {
  return db.friendships.some((p) => (p[0] === aLower && p[1] === bLower) || (p[0] === bLower && p[1] === aLower));
}
function toPublicUser(u) {
  if (!u) return null;
  return {
    username: u.username,
    displayName: u.displayName,
    avatarColor: u.avatarColor,
    avatarEmoji: u.avatarEmoji,
    presence: u.presence,
    statusText: u.statusText,
    bio: u.bio
  };
}

const COLORS = ['#ffb454', '#4fa8c9', '#6fcf97', '#e8574a', '#c084fc', '#f472a6', '#7c8794', '#f2c14e'];
const EMOJIS = ['🙂', '🚀', '🌙', '🔥', '🐺', '🎧', '☕', '🌊', '🛰️', '🎲', '🌵', '⚡'];

/* ------------------------------------------------------------------ */
/* Express app                                                          */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function signToken(username) {
  return jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users[payload.sub.toLowerCase()];
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Your session expired — please log in again.' });
  }
}

/* ------------------------------------------------------------------ */
/* Auth routes                                                         */
/* ------------------------------------------------------------------ */
app.post('/api/signup', (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter a username and password.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Usernames are 3-20 characters: letters, numbers, underscores.' });
  }
  if (String(password).length < 4) return res.status(400).json({ error: 'Password needs at least 4 characters.' });

  const lower = username.toLowerCase();
  if (db.users[lower]) return res.status(409).json({ error: 'That username is taken. Try logging in instead.' });

  const user = {
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    displayName: (displayName || '').trim() || username,
    avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)],
    avatarEmoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
    presence: 'online',
    statusText: '',
    bio: '',
    createdAt: Date.now()
  };
  db.users[lower] = user;
  saveDB();
  res.json({ token: signToken(user.username), user: toPublicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });
  const user = db.users[username.toLowerCase()];
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: "That username and password don't match." });
  }
  res.json({ token: signToken(user.username), user: toPublicUser(user) });
});

/* ------------------------------------------------------------------ */
/* Profile routes                                                      */
/* ------------------------------------------------------------------ */
app.get('/api/me', authMiddleware, (req, res) => {
  res.json(toPublicUser(req.user));
});

app.put('/api/me', authMiddleware, (req, res) => {
  const u = req.user;
  const { displayName, avatarColor, avatarEmoji, presence, statusText, bio } = req.body || {};
  if (typeof displayName === 'string' && displayName.trim()) u.displayName = displayName.trim().slice(0, 40);
  if (typeof avatarColor === 'string' && COLORS.includes(avatarColor)) u.avatarColor = avatarColor;
  if (typeof avatarEmoji === 'string' && EMOJIS.includes(avatarEmoji)) u.avatarEmoji = avatarEmoji;
  if (typeof presence === 'string' && ['online', 'idle', 'dnd', 'offline'].includes(presence)) u.presence = presence;
  if (typeof statusText === 'string') u.statusText = statusText.slice(0, 60);
  if (typeof bio === 'string') u.bio = bio.slice(0, 200);
  saveDB();

  const meLower = u.username.toLowerCase();
  db.friendships.forEach((pair) => {
    if (pair[0] === meLower || pair[1] === meLower) {
      const otherLower = pair[0] === meLower ? pair[1] : pair[0];
      const other = db.users[otherLower];
      if (other) sendToUser(other.username, { type: 'presence', user: toPublicUser(u) });
    }
  });

  res.json(toPublicUser(u));
});

/* ------------------------------------------------------------------ */
/* Friend routes                                                       */
/* ------------------------------------------------------------------ */
app.get('/api/friends', authMiddleware, (req, res) => {
  const meLower = req.user.username.toLowerCase();
  const friends = db.friendships
    .filter((pair) => pair[0] === meLower || pair[1] === meLower)
    .map((pair) => (pair[0] === meLower ? pair[1] : pair[0]))
    .map((lower) => toPublicUser(db.users[lower]))
    .filter(Boolean);
  res.json(friends);
});

app.get('/api/friends/requests', authMiddleware, (req, res) => {
  const meLower = req.user.username.toLowerCase();
  const incoming = db.friendRequests
    .filter((r) => r.to === meLower)
    .map((r) => {
      const fromUser = db.users[r.from];
      return { from: fromUser ? fromUser.username : r.from, displayName: fromUser ? fromUser.displayName : r.from };
    });
  res.json(incoming);
});

app.post('/api/friends/request', authMiddleware, (req, res) => {
  const meLower = req.user.username.toLowerCase();
  const target = (req.body && req.body.username || '').trim();
  if (!target) return res.status(400).json({ error: 'Enter a username to add.' });
  const targetLower = target.toLowerCase();
  if (targetLower === meLower) return res.status(400).json({ error: "You can't add yourself." });
  const targetUser = db.users[targetLower];
  if (!targetUser) return res.status(404).json({ error: 'No one goes by that username.' });
  if (areFriends(meLower, targetLower)) return res.status(400).json({ error: `You're already connected with ${targetUser.displayName}.` });
  if (db.friendRequests.some((r) => r.from === meLower && r.to === targetLower)) {
    return res.status(400).json({ error: 'Request already sent.' });
  }
  db.friendRequests.push({ from: meLower, to: targetLower, createdAt: Date.now() });
  saveDB();
  sendToUser(targetUser.username, { type: 'friend_request', from: req.user.username, displayName: req.user.displayName });
  res.json({ ok: true });
});

app.post('/api/friends/requests/:username/accept', authMiddleware, (req, res) => {
  const meLower = req.user.username.toLowerCase();
  const fromLower = req.params.username.toLowerCase();
  const idx = db.friendRequests.findIndex((r) => r.from === fromLower && r.to === meLower);
  if (idx === -1) return res.status(404).json({ error: 'That request no longer exists.' });
  db.friendRequests.splice(idx, 1);
  const pair = [meLower, fromLower].sort();
  if (!db.friendships.some((p) => p[0] === pair[0] && p[1] === pair[1])) db.friendships.push(pair);
  saveDB();
  const fromUser = db.users[fromLower];
  if (fromUser) sendToUser(fromUser.username, { type: 'friend_accept', by: req.user.username });
  res.json(toPublicUser(fromUser));
});

app.post('/api/friends/requests/:username/decline', authMiddleware, (req, res) => {
  const meLower = req.user.username.toLowerCase();
  const fromLower = req.params.username.toLowerCase();
  db.friendRequests = db.friendRequests.filter((r) => !(r.from === fromLower && r.to === meLower));
  saveDB();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Messaging routes                                                     */
/* ------------------------------------------------------------------ */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname || ''))
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

app.get('/api/messages/:username', authMiddleware, (req, res) => {
  const meLower = req.user.username.toLowerCase();
  const friendLower = req.params.username.toLowerCase();
  if (!areFriends(meLower, friendLower)) return res.status(403).json({ error: 'You need to be connected to see this conversation.' });
  const key = convKey(meLower, friendLower);
  res.json(db.messages[key] || []);
});

app.post('/api/messages/:username', authMiddleware, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message === 'File too large' ? 'That file is too big — keep attachments under 8 MB.' : 'Could not upload that file.' });
    next();
  });
}, (req, res) => {
  const meLower = req.user.username.toLowerCase();
  const friendLower = req.params.username.toLowerCase();
  const friendUser = db.users[friendLower];
  if (!friendUser || !areFriends(meLower, friendLower)) {
    return res.status(403).json({ error: 'You need to be connected to message this person.' });
  }
  const text = (req.body.text || '').trim();
  let file = null;
  if (req.file) {
    file = { name: req.file.originalname, type: req.file.mimetype, size: req.file.size, url: '/uploads/' + req.file.filename };
  }
  if (!text && !file) return res.status(400).json({ error: "Message can't be empty." });

  const key = convKey(meLower, friendLower);
  const message = { id: crypto.randomUUID(), from: req.user.username, text, file, ts: Date.now() };
  db.messages[key] = db.messages[key] || [];
  db.messages[key].push(message);
  saveDB();

  sendToUser(friendUser.username, { type: 'new_message', conv: key, message });
  res.json(message);
});

/* ------------------------------------------------------------------ */
/* Fallback to SPA                                                      */
/* ------------------------------------------------------------------ */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ */
/* HTTP + WebSocket server                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const connectedSockets = new Map(); // usernameLower -> Set<ws>

function sendToUser(username, payload) {
  const set = connectedSockets.get(username.toLowerCase());
  if (!set) return;
  const data = JSON.stringify(payload);
  set.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

wss.on('connection', (ws, req) => {
  let username = null;
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users[payload.sub.toLowerCase()];
    if (!user) throw new Error('no such user');
    username = user.username;
  } catch (e) {
    ws.close();
    return;
  }
  const lower = username.toLowerCase();
  if (!connectedSockets.has(lower)) connectedSockets.set(lower, new Set());
  connectedSockets.get(lower).add(ws);
  ws.on('close', () => {
    const set = connectedSockets.get(lower);
    if (set) set.delete(ws);
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Beacon is running at http://localhost:${PORT}`);
});
