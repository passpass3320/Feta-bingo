// ===============================
// Telegram Bingo Server
// ===============================
// Set your Bot Token as an environment variable:
//   export BOT_TOKEN=123456:ABC-DEF1234gh...
// ===============================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getAudioUrl } = require('google-tts-api');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN'; // <-- PLUG YOUR TOKEN HERE
const ADMIN_KEY = process.env.ADMIN_KEY || 'super-secret-admin-key'; // change in production
const PORT = process.env.PORT || 3000;

// ---------- Database Setup ----------
const db = new Database('bingo.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE,
    username TEXT,
    first_seen TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS wallets (
    user_id INTEGER PRIMARY KEY,
    balance REAL DEFAULT 100,   -- 100 Birr welcome bonus
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,   -- 'purchase', 'deposit', 'withdrawal', 'win', 'bonus'
    amount REAL,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS deposit_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    screenshot_path TEXT,
    status TEXT DEFAULT 'pending',   -- pending, approved, rejected
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    account_details TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS game_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS game_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER,
    user_id INTEGER,
    numbers TEXT,  -- JSON array of 25 numbers (middle = 0)
    marked TEXT DEFAULT '[]',  -- JSON array of marked indices
    is_winner INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS drawn_numbers (
    round_id INTEGER,
    number INTEGER,
    drawn_at TEXT DEFAULT (datetime('now'))
  );
`);

// Initialize game state if missing
const initState = db.prepare('INSERT OR IGNORE INTO game_state (key, value) VALUES (?, ?)');
initState.run('current_round', '0');
initState.run('status', 'idle');        // idle | active | finished
initState.run('pot', '0');
initState.run('total_cards', '200');
initState.run('sold_cards', '0');
initState.run('drawn_index', '0');
initState.run('last_draw_time', '0');

// Helper: read game state
function getGameState() {
  const row = db.prepare('SELECT key, value FROM game_state').all();
  const state = {};
  row.forEach(r => { state[r.key] = r.value; });
  state.pot = parseFloat(state.pot);
  state.total_cards = parseInt(state.total_cards);
  state.sold_cards = parseInt(state.sold_cards);
  state.current_round = parseInt(state.current_round);
  state.drawn_index = parseInt(state.drawn_index);
  return state;
}

function setGameState(key, value) {
  db.prepare('UPDATE game_state SET value = ? WHERE key = ?').run(String(value), key);
}

// ---------- Multer for file uploads ----------
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ---------- Telegram initData verification ----------
function validateInitData(initData) {
  const data = Object.fromEntries(new URLSearchParams(initData));
  const hash = data.hash;
  delete data.hash;
  const checkString = Object.keys(data)
    .sort()
    .map(k => `${k}=${data[k]}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  return calculatedHash === hash;
}

// ---------- Auth endpoint ----------
app.post('/auth', (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });
  if (!validateInitData(initData)) return res.status(403).json({ error: 'Invalid data' });

  const params = Object.fromEntries(new URLSearchParams(initData));
  const userData = JSON.parse(params.user || '{}');
  const telegramId = String(userData.id);
  const username = userData.username || userData.first_name || 'Player';

  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  let isNew = false;
  if (!user) {
    const result = db.prepare('INSERT INTO users (telegram_id, username) VALUES (?, ?)').run(telegramId, username);
    user = { id: result.lastInsertRowid, telegram_id: telegramId, username };
    isNew = true;
    // Welcome bonus
    db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 100)').run(user.id);
    db.prepare("INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'bonus', 100, 'Welcome bonus')").run(user.id);
  }

  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id);
  res.json({
    userId: user.id,
    telegramId: user.telegram_id,
    username: user.username,
    balance: wallet ? wallet.balance : 100,
    isNew
  });
});

// ---------- Buy Card ----------
app.post('/buy-card', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const state = getGameState();
  if (state.status !== 'idle') return res.status(400).json({ error: 'Game already started' });
  if (state.sold_cards >= state.total_cards) return res.status(400).json({ error: 'All cards sold' });

  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
  if (!wallet || wallet.balance < 10) return res.status(400).json({ error: 'Insufficient balance' });

  // Deduct 10 Birr
  db.prepare('UPDATE wallets SET balance = balance - 10 WHERE user_id = ?').run(userId);
  db.prepare("INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'purchase', -10, 'Card purchase')").run(userId);

  // Generate Bingo card
  const numbers = generateCardNumbers();
  const cardId = db.prepare(
    'INSERT INTO game_cards (round_id, user_id, numbers) VALUES (?, ?, ?)'
  ).run(state.current_round, userId, JSON.stringify(numbers)).lastInsertRowid;

  // Update game state: 7 Birr to pot, 3 Birr commission (handled via pot logic)
  const newPot = state.pot + 7;
  const newSold = state.sold_cards + 1;
  setGameState('pot', newPot);
  setGameState('sold_cards', newSold);

  // Broadcast updated pot & sold count
  io.emit('game_update', {
    pot: newPot,
    soldCards: newSold,
    totalCards: state.total_cards,
    status: state.status
  });

  res.json({
    success: true,
    cardId,
    numbers,
    balance: wallet.balance - 10
  });
});

// ---------- Generate a Bingo card ----------
function generateCardNumbers() {
  const ranges = [
    [1, 15], [16, 30], [31, 45], [46, 60], [61, 75]
  ];
  const card = [];
  for (const [min, max] of ranges) {
    const col = [];
    while (col.length < 5) {
      const num = Math.floor(Math.random() * (max - min + 1)) + min;
      if (!col.includes(num)) col.push(num);
    }
    card.push(...col);
  }
  card[12] = 0; // middle free cell
  return card;
}

// ---------- Get game state & user cards ----------
app.get('/game-state', (req, res) => {
  const userId = req.query.userId;
  const state = getGameState();
  const drawn = db.prepare('SELECT number FROM drawn_numbers WHERE round_id = ? ORDER BY drawn_at').all(state.current_round).map(r => r.number);
  let userCards = [];
  if (userId) {
    userCards = db.prepare('SELECT * FROM game_cards WHERE round_id = ? AND user_id = ?').all(state.current_round, userId);
  }
  const wallet = userId ? db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId) : null;

  res.json({
    ...state,
    drawnNumbers: drawn,
    userCards,
    balance: wallet ? wallet.balance : 0
  });
});

// ---------- Deposit & Withdrawal requests ----------
app.post('/deposit', upload.single('screenshot'), (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount || !req.file) return res.status(400).json({ error: 'Missing fields' });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const dbRes = db.prepare(
    'INSERT INTO deposit_requests (user_id, amount, screenshot_path) VALUES (?, ?, ?)'
  ).run(userId, amt, req.file.path);

  res.json({ success: true, requestId: dbRes.lastInsertRowid });
});

app.post('/withdraw', (req, res) => {
  const { userId, amount, accountDetails } = req.body;
  if (!userId || !amount || !accountDetails) return res.status(400).json({ error: 'Missing fields' });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
  if (!wallet || wallet.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

  db.prepare('INSERT INTO withdrawal_requests (user_id, amount, account_details) VALUES (?, ?, ?)').run(userId, amt, accountDetails);
  res.json({ success: true });
});

// ---------- Admin endpoints ----------
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

app.get('/admin/deposits', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.username, u.telegram_id FROM deposit_requests d
    JOIN users u ON d.user_id = u.id ORDER BY d.created_at DESC
  `).all();
  res.json(rows);
});

app.post('/admin/deposits/:id/approve', adminAuth, (req, res) => {
  const { id } = req.params;
  const reqDep = db.prepare('SELECT * FROM deposit_requests WHERE id = ? AND status = "pending"').get(id);
  if (!reqDep) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE deposit_requests SET status = "approved" WHERE id = ?').run(id);
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(reqDep.amount, reqDep.user_id);
  db.prepare("INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'deposit', ?, 'TeleBirr/CBE deposit approved')").run(reqDep.user_id, reqDep.amount);
  res.json({ success: true });
});

app.post('/admin/deposits/:id/reject', adminAuth, (req, res) => {
  const { id } = req.params;
  db.prepare('UPDATE deposit_requests SET status = "rejected" WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get('/admin/withdrawals', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT w.*, u.username, u.telegram_id FROM withdrawal_requests w
    JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC
  `).all();
  res.json(rows);
});

app.post('/admin/withdrawals/:id/approve', adminAuth, (req, res) => {
  const { id } = req.params;
  const reqW = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ? AND status = "pending"').get(id);
  if (!reqW) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE withdrawal_requests SET status = "approved" WHERE id = ?').run(id);
  db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?').run(reqW.amount, reqW.user_id, reqW.amount);
  db.prepare("INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'withdrawal', ?, 'Withdrawal approved')").run(reqW.user_id, -reqW.amount);
  res.json({ success: true });
});

app.post('/admin/withdrawals/:id/reject', adminAuth, (req, res) => {
  const { id } = req.params;
  db.prepare('UPDATE withdrawal_requests SET status = "rejected" WHERE id = ?').run(id);
  res.json({ success: true });
});

// Start new round
app.post('/admin/start-round', adminAuth, (req, res) => {
  let state = getGameState();
  if (state.status !== 'idle' && state.status !== 'finished') return res.status(400).json({ error: 'Game already running' });

  const newRound = state.current_round + 1;
  setGameState('current_round', newRound);
  setGameState('status', 'idle');
  setGameState('pot', 0);
  setGameState('sold_cards', 0);
  setGameState('drawn_index', 0);
  db.prepare('DELETE FROM drawn_numbers WHERE round_id = ?').run(newRound);

  io.emit('game_update', {
    round: newRound,
    pot: 0,
    soldCards: 0,
    totalCards: 200,
    status: 'idle'
  });
  res.json({ success: true, round: newRound });
});

// ==================== Socket.IO Bingo Engine ====================
let drawInterval = null;
let currentRound = getGameState().current_round;

function startDrawInterval() {
  if (drawInterval) clearInterval(drawInterval);
  drawInterval = setInterval(drawNumber, 5000);
}

function stopDrawInterval() {
  if (drawInterval) {
    clearInterval(drawInterval);
    drawInterval = null;
  }
}

// Called every 5 seconds
async function drawNumber() {
  let state = getGameState();
  if (state.status !== 'active') return;

  const allNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
  const drawn = db.prepare('SELECT number FROM drawn_numbers WHERE round_id = ?').all(state.current_round).map(r => r.number);
  const remaining = allNumbers.filter(n => !drawn.includes(n));
  if (remaining.length === 0) {
    // All numbers drawn, no winner -> game finishes
    setGameState('status', 'finished');
    stopDrawInterval();
    io.emit('game_over', { message: 'Game over – no winner. Jackpot stays for next round.' });
    return;
  }

  const nextNumber = remaining[Math.floor(Math.random() * remaining.length)];
  db.prepare('INSERT INTO drawn_numbers (round_id, number) VALUES (?, ?)').run(state.current_round, nextNumber);

  // Amharic voice caller
  const amharicText = `ቁጥር ${numberToAmharicWords(nextNumber)}`;
  let audioUrl = '';
  try {
    audioUrl = getAudioUrl(amharicText, { lang: 'am', slow: false });
  } catch (e) {
    console.error('TTS error:', e);
  }

  io.emit('new_number', { number: nextNumber, amharicText, audioUrl });

  // Check for winners
  const cards = db.prepare('SELECT * FROM game_cards WHERE round_id = ?').all(state.current_round);
  let winnerCard = null;
  for (const card of cards) {
    if (checkBingo(card, nextNumber)) {
      winnerCard = card;
      break;
    }
  }

  if (winnerCard) {
    state = getGameState();
    setGameState('status', 'finished');
    stopDrawInterval();

    // Credit prize pool to winner
    const prize = state.pot;
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(prize, winnerCard.user_id);
    db.prepare("INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'win', ?, 'Bingo winner')").run(winnerCard.user_id, prize);
    db.prepare('UPDATE game_cards SET is_winner = 1 WHERE id = ?').run(winnerCard.id);

    const winnerUser = db.prepare('SELECT username, telegram_id FROM users WHERE id = ?').get(winnerCard.user_id);
    io.emit('game_winner', {
      winner: winnerUser,
      prize,
      cardId: winnerCard.id,
      message: `🎉 ${winnerUser.username} won ${prize} Birr!`
    });
  }
}

// Check if a card has Bingo after marking a new number
function checkBingo(card, newNumber) {
  const numbers = JSON.parse(card.numbers);
  const marked = new Set(JSON.parse(card.marked).map(Number));
  // Find index of new number (if present)
  const idx = numbers.indexOf(newNumber);
  if (idx !== -1) marked.add(idx);
  // Save updated marked set
  db.prepare('UPDATE game_cards SET marked = ? WHERE id = ?').run(JSON.stringify(Array.from(marked)), card.id);

  // Build a 5x5 grid (0-24)
  const grid = Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => r * 5 + c));
  // Check rows
  for (let r = 0; r < 5; r++) {
    if (grid[r].every(i => marked.has(i) || numbers[i] === 0)) return true;
  }
  // Check columns
  for (let c = 0; c < 5; c++) {
    if ([0,1,2,3,4].every(r => marked.has(r*5+c) || numbers[r*5+c] === 0)) return true;
  }
  // Diagonals
  if ([0,6,12,18,24].every(i => marked.has(i) || numbers[i] === 0)) return true;
  if ([4,8,12,16,20].every(i => marked.has(i) || numbers[i] === 0)) return true;

  return false;
}

// Convert 1-75 to Amharic words (simplified)
function numberToAmharicWords(num) {
  const ones = ['', 'አንድ', 'ሁለት', 'ሦስት', 'አራት', 'አምስት', 'ስድስት', 'ሰባት', 'ስምንት', 'ዘጠኝ'];
  const tens = ['', '', 'ሃያ', 'ሰላሳ', 'አርባ', 'ሃምሳ', 'ስልሳ', 'ሰባ'];
  if (num <= 9) return ones[num];
  if (num === 10) return 'አስር';
  if (num < 20) return 'አስራ ' + ones[num - 10];
  const ten = Math.floor(num / 10);
  const one = num % 10;
  const tenWord = tens[ten];
  if (one === 0) return tenWord;
  return tenWord + ' ' + ones[one];
}

// Admin can start the draw (transition from idle to active)
app.post('/admin/start-draw', adminAuth, (req, res) => {
  let state = getGameState();
  if (state.status !== 'idle') return res.status(400).json({ error: 'Game not in idle state' });
  setGameState('status', 'active');
  startDrawInterval();
  io.emit('game_update', { status: 'active', pot: state.pot, soldCards: state.sold_cards });
  res.json({ success: true });
});

// Handle Socket.IO connections
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', (userId) => {
    socket.userId = userId;
    const state = getGameState();
    const drawn = db.prepare('SELECT number FROM drawn_numbers WHERE round_id = ?').all(state.current_round).map(r => r.number);
    socket.emit('game_update', {
      round: state.current_round,
      pot: state.pot,
      soldCards: state.sold_cards,
      totalCards: state.total_cards,
      status: state.status,
      drawnNumbers: drawn
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Bingo server running on port ${PORT}`);
  // If game was previously active, restart draw interval
  const state = getGameState();
  if (state.status === 'active') {
    startDrawInterval();
  }
});
