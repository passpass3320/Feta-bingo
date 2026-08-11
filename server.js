/**
 * Telegram Bingo Mini App - Backend
 * Express + Socket.io + SQLite (better-sqlite3) + Telegram Bot (node-telegram-bot-api)
 *
 * ENV VARS REQUIRED (put these in a .env file or your host's env settings):
 *   BOT_TOKEN        - Telegram bot token from @BotFather
 *   ADMIN_CHAT_ID     - Your personal Telegram chat id (the admin who approves deposits/withdrawals)
 *   ADMIN_DASHBOARD_KEY - a secret string used to protect the /admin dashboard routes
 *   PORT              - optional, defaults to 3000
 *
 * NOTE ON COMPLIANCE:
 *   This app moves real money in/out of user wallets. Before going live, make sure
 *   running a paid bingo game with real-money deposits/withdrawals is legal in the
 *   jurisdiction you operate in, and that you hold any required gambling/payment license.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const ADMIN_DASHBOARD_KEY = process.env.ADMIN_DASHBOARD_KEY || 'change-me';

const MIN_DEPOSIT = 50;
const MIN_WITHDRAW = 100;
const SIGNUP_BONUS = 150; // Birr, credited to balance_bonus for brand new users (non-withdrawable)

// ---------- App / Server setup ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `receipt_${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'bingo.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  balance_real INTEGER NOT NULL DEFAULT 0,   -- withdrawable balance (deposits + real winnings), in Birr
  balance_bonus INTEGER NOT NULL DEFAULT 0,  -- non-withdrawable bonus balance, in Birr
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  screenshot_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  account_info TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);
`);

function getOrCreateUser(telegram_id, username) {
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) {
    // Brand new user: create the account and credit the signup bonus.
    // This goes to balance_bonus, which can be used to play but can never be withdrawn.
    db.prepare('INSERT INTO users (telegram_id, username, balance_real, balance_bonus) VALUES (?, ?, 0, ?)')
      .run(telegram_id, username || null, SIGNUP_BONUS);
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  } else if (username && user.username !== username) {
    db.prepare('UPDATE users SET username = ? WHERE telegram_id = ?').run(username, telegram_id);
  }
  return user;
}

// ---------- Telegram Bot ----------
let bot = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    getOrCreateUser(String(msg.chat.id), msg.from.username || msg.from.first_name);
    bot.sendMessage(msg.chat.id, 'Welcome to Bingo! Open the mini app to play, deposit, and withdraw.');
  });

  // Admin approves/rejects deposits and withdrawals via inline buttons
  bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(ADMIN_CHAT_ID)) {
      return bot.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    }
    const [action, type, id] = query.data.split(':'); // e.g. "approve:deposit:12"

    try {
      if (type === 'deposit') {
        const result = action === 'approve' ? approveDeposit(id) : rejectDeposit(id);
        await bot.editMessageText(
          `${query.message.text}\n\n${action === 'approve' ? '✅ APPROVED' : '❌ REJECTED'}`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
        if (action === 'approve' && result.telegram_id) {
          bot.sendMessage(result.telegram_id, `✅ Your deposit of ${result.amount} Birr has been approved. New balance: ${result.balance_real} Birr.`).catch(() => {});
        } else if (result.telegram_id) {
          bot.sendMessage(result.telegram_id, `❌ Your deposit of ${result.amount} Birr was rejected. Contact support if this is unexpected.`).catch(() => {});
        }
      } else if (type === 'withdraw') {
        const result = action === 'approve' ? approveWithdrawal(id) : rejectWithdrawal(id);
        await bot.editMessageText(
          `${query.message.text}\n\n${action === 'approve' ? '✅ APPROVED - please pay the user manually' : '❌ REJECTED'}`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
        if (result.telegram_id) {
          const msgText = action === 'approve'
            ? `✅ Your withdrawal of ${result.amount} Birr was approved. You will receive payment shortly.`
            : `❌ Your withdrawal of ${result.amount} Birr was rejected. Your balance has been refunded.`;
          bot.sendMessage(result.telegram_id, msgText).catch(() => {});
        }
      }
      bot.answerCallbackQuery(query.id, { text: 'Done.' });
    } catch (err) {
      console.error(err);
      bot.answerCallbackQuery(query.id, { text: 'Error: ' + err.message });
    }
  });
}

function notifyAdminDeposit(deposit) {
  if (!bot || !ADMIN_CHAT_ID) return;
  const text = `🟢 NEW DEPOSIT REQUEST #${deposit.id}\nUser: ${deposit.telegram_id}\nAmount: ${deposit.amount} Birr\nMethod: ${deposit.method}\nTxn ID: ${deposit.txn_id}`;
  const opts = {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:deposit:${deposit.id}` },
        { text: '❌ Reject', callback_data: `reject:deposit:${deposit.id}` }
      ]]
    }
  };
  if (deposit.screenshot_path) {
    bot.sendPhoto(ADMIN_CHAT_ID, path.join(uploadsDir, path.basename(deposit.screenshot_path)), {
      caption: text,
      reply_markup: opts.reply_markup
    }).catch(() => bot.sendMessage(ADMIN_CHAT_ID, text, opts));
  } else {
    bot.sendMessage(ADMIN_CHAT_ID, text, opts);
  }
}

function notifyAdminWithdrawal(withdrawal) {
  if (!bot || !ADMIN_CHAT_ID) return;
  const text = `🟡 NEW WITHDRAWAL REQUEST #${withdrawal.id}\nUser: ${withdrawal.telegram_id}\nAmount: ${withdrawal.amount} Birr\nAccount Info: ${withdrawal.account_info}`;
  bot.sendMessage(ADMIN_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:withdraw:${withdrawal.id}` },
        { text: '❌ Reject', callback_data: `reject:withdraw:${withdrawal.id}` }
      ]]
    }
  });
}

// ---------- Business logic ----------
function approveDeposit(id) {
  const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
  if (!deposit) throw new Error('Deposit not found');
  if (deposit.status !== 'pending') throw new Error('Already resolved');

  getOrCreateUser(deposit.telegram_id);
  db.prepare('UPDATE users SET balance_real = balance_real + ? WHERE telegram_id = ?')
    .run(deposit.amount, deposit.telegram_id);
  db.prepare("UPDATE deposits SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(id);

  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(deposit.telegram_id);
  return { telegram_id: deposit.telegram_id, amount: deposit.amount, balance_real: user.balance_real };
}

function rejectDeposit(id) {
  const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
  if (!deposit) throw new Error('Deposit not found');
  if (deposit.status !== 'pending') throw new Error('Already resolved');
  db.prepare("UPDATE deposits SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?").run(id);
  return { telegram_id: deposit.telegram_id, amount: deposit.amount };
}

function approveWithdrawal(id) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w) throw new Error('Withdrawal not found');
  if (w.status !== 'pending') throw new Error('Already resolved');
  // funds were already deducted (held) when the request was created
  db.prepare("UPDATE withdrawals SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(id);
  return { telegram_id: w.telegram_id, amount: w.amount };
}

function rejectWithdrawal(id) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w) throw new Error('Withdrawal not found');
  if (w.status !== 'pending') throw new Error('Already resolved');
  // refund the held amount back to the user's withdrawable balance
  db.prepare('UPDATE users SET balance_real = balance_real + ? WHERE telegram_id = ?').run(w.amount, w.telegram_id);
  db.prepare("UPDATE withdrawals SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?").run(id);
  return { telegram_id: w.telegram_id, amount: w.amount };
}

// ---------- API: Wallet ----------
app.get('/api/wallet/:telegram_id', (req, res) => {
  const user = getOrCreateUser(req.params.telegram_id, req.query.username);
  res.json({
    telegram_id: user.telegram_id,
    balance_real: user.balance_real,
    balance_bonus: user.balance_bonus,
    total_balance: user.balance_real + user.balance_bonus
  });
});

// ---------- API: Deposits ----------
app.post('/api/deposit', upload.single('screenshot'), (req, res) => {
  const { telegram_id, amount, method, txn_id, username } = req.body;
  const amt = parseInt(amount, 10);

  if (!telegram_id || !amt || !method || !txn_id) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (amt < MIN_DEPOSIT) {
    return res.status(400).json({ error: `Minimum deposit is ${MIN_DEPOSIT} Birr.` });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Please attach the SMS confirmation screenshot.' });
  }

  getOrCreateUser(telegram_id, username);
  const screenshot_path = `/uploads/${req.file.filename}`;

  const info = db.prepare(
    'INSERT INTO deposits (telegram_id, amount, method, txn_id, screenshot_path) VALUES (?, ?, ?, ?, ?)'
  ).run(telegram_id, amt, method, txn_id, screenshot_path);

  const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(info.lastInsertRowid);
  notifyAdminDeposit(deposit);

  res.json({ success: true, deposit_id: deposit.id, status: deposit.status });
});

app.get('/api/deposits/:telegram_id', (req, res) => {
  const rows = db.prepare('SELECT * FROM deposits WHERE telegram_id = ? ORDER BY id DESC').all(req.params.telegram_id);
  res.json(rows);
});

// ---------- API: Withdrawals ----------
app.post('/api/withdraw', (req, res) => {
  const { telegram_id, amount, account_info } = req.body;
  const amt = parseInt(amount, 10);

  if (!telegram_id || !amt || !account_info) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (amt < MIN_WITHDRAW) {
    return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW} Birr.` });
  }

  const user = getOrCreateUser(telegram_id);

  // Only the withdrawable (real) balance counts. Bonus balance can never be withdrawn.
  if (amt > user.balance_real) {
    return res.status(400).json({
      error: 'Insufficient withdrawable balance. Bonus balance cannot be withdrawn.',
      balance_real: user.balance_real,
      balance_bonus: user.balance_bonus
    });
  }

  // Hold the funds immediately so the user can't double-spend while pending.
  db.prepare('UPDATE users SET balance_real = balance_real - ? WHERE telegram_id = ?').run(amt, telegram_id);

  const info = db.prepare(
    'INSERT INTO withdrawals (telegram_id, amount, account_info) VALUES (?, ?, ?)'
  ).run(telegram_id, amt, account_info);

  const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(info.lastInsertRowid);
  notifyAdminWithdrawal(withdrawal);

  res.json({ success: true, withdrawal_id: withdrawal.id, status: withdrawal.status });
});

app.get('/api/withdrawals/:telegram_id', (req, res) => {
  const rows = db.prepare('SELECT * FROM withdrawals WHERE telegram_id = ? ORDER BY id DESC').all(req.params.telegram_id);
  res.json(rows);
});

// ---------- Admin dashboard (simple, key-protected) ----------
function requireAdminKey(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== ADMIN_DASHBOARD_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.get('/api/admin/deposits', requireAdminKey, (req, res) => {
  res.json(db.prepare("SELECT * FROM deposits WHERE status = 'pending' ORDER BY id DESC").all());
});

app.get('/api/admin/withdrawals', requireAdminKey, (req, res) => {
  res.json(db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY id DESC").all());
});

app.post('/api/admin/deposit/:id/approve', requireAdminKey, (req, res) => {
  try {
    const result = approveDeposit(req.params.id);
    if (bot) bot.sendMessage(result.telegram_id, `✅ Your deposit of ${result.amount} Birr has been approved. New balance: ${result.balance_real} Birr.`).catch(() => {});
    res.json({ success: true, result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/deposit/:id/reject', requireAdminKey, (req, res) => {
  try {
    const result = rejectDeposit(req.params.id);
    if (bot) bot.sendMessage(result.telegram_id, `❌ Your deposit of ${result.amount} Birr was rejected.`).catch(() => {});
    res.json({ success: true, result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/withdraw/:id/approve', requireAdminKey, (req, res) => {
  try {
    const result = approveWithdrawal(req.params.id);
    if (bot) bot.sendMessage(result.telegram_id, `✅ Your withdrawal of ${result.amount} Birr was approved.`).catch(() => {});
    res.json({ success: true, result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/withdraw/:id/reject', requireAdminKey, (req, res) => {
  try {
    const result = rejectWithdrawal(req.params.id);
    if (bot) bot.sendMessage(result.telegram_id, `❌ Your withdrawal of ${result.amount} Birr was rejected and refunded.`).catch(() => {});
    res.json({ success: true, result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/withdraw/:id/mark-paid', requireAdminKey, (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE withdrawals SET status = 'paid' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ---------- Bingo game / Socket.io (Amharic auto-caller) ----------
// Amharic number words 1-90 used to build "ቁጥር N" style announcements client-side via TTS.
// The server just tracks which numbers have been called and broadcasts them; the browser
// speaks them using the Web Speech API (see public/index.html).
const gameRooms = {}; // roomId -> { calledNumbers: [], remaining: [1..75], intervalId, takenCartellas: {} }
const CARTELLA_COUNT = 200;

// Deterministic PRNG so cartella #N always generates the exact same card for every player/session.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Standard 75-ball card: column B=1-15, I=16-30, N=31-45 (center FREE), G=46-60, O=61-75.
function generateCartella(id) {
  const rand = mulberry32((id * 2654435761) % 2147483647);
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  const cols = ranges.map(([lo, hi]) => {
    const nums = [];
    for (let n = lo; n <= hi; n++) nums.push(n);
    return shuffle(nums, rand).slice(0, 5);
  });
  cols[2][2] = 'FREE'; // middle cell of the N column
  return cols; // [ [B1..B5], [I1..I5], [N1..N5], [G1..G5], [O1..O5] ]
}

function createRoom(roomId) {
  gameRooms[roomId] = {
    calledNumbers: [],
    remaining: Array.from({ length: 75 }, (_, i) => i + 1),
    intervalId: null,
    takenCartellas: {} // cartellaId -> telegram_id
  };
  return gameRooms[roomId];
}

function getPlayerCount(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  return room ? room.size : 0;
}

function startCallingLoop(roomId) {
  const room = gameRooms[roomId] || createRoom(roomId);
  if (room.intervalId || room.remaining.length === 0) return; // already running or nothing left to call

  io.to(roomId).emit('callingState', { active: true });
  room.intervalId = setInterval(() => {
    if (room.remaining.length === 0) {
      clearInterval(room.intervalId);
      room.intervalId = null;
      io.to(roomId).emit('callingState', { active: false });
      io.to(roomId).emit('gameOver');
      return;
    }
    const idx = Math.floor(Math.random() * room.remaining.length);
    const number = room.remaining.splice(idx, 1)[0];
    room.calledNumbers.push(number);
    io.to(roomId).emit('numberCalled', { number, calledNumbers: room.calledNumbers });
  }, 4000); // one number every 4 seconds, adjust to taste
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (roomId) => {
    socket.join(roomId);
    const room = gameRooms[roomId] || createRoom(roomId);
    socket.emit('roomState', { calledNumbers: room.calledNumbers, playerCount: getPlayerCount(roomId) });
    socket.emit('cartellaState', { taken: room.takenCartellas });
    socket.emit('callingState', { active: !!room.intervalId });
    io.to(roomId).emit('playerCount', getPlayerCount(roomId));

    // Auto-start the shared caller for the room as soon as there's at least one player.
    // Calling is a room-wide, server-controlled process — no single player can start/stop it
    // for everyone else, which keeps the game fair in multiplayer.
    if (!room.intervalId && room.remaining.length > 0) {
      startCallingLoop(roomId);
    }
  });

  socket.on('selectCartella', ({ roomId, cartellaId, telegram_id }) => {
    const room = gameRooms[roomId] || createRoom(roomId);
    const id = Number(cartellaId);
    if (!Number.isInteger(id) || id < 1 || id > CARTELLA_COUNT) {
      return socket.emit('cartellaError', { message: 'Invalid cartella number.' });
    }
    if (room.takenCartellas[id] && room.takenCartellas[id] !== telegram_id) {
      return socket.emit('cartellaError', { message: 'This cartella is already taken. Pick another.' });
    }
    // Release any cartella this user held previously (one active cartella per player per room).
    Object.keys(room.takenCartellas).forEach((cid) => {
      if (room.takenCartellas[cid] === telegram_id) delete room.takenCartellas[cid];
    });
    room.takenCartellas[id] = telegram_id;
    socket.emit('cartellaAssigned', { cartellaId: id, card: generateCartella(id) });
    io.to(roomId).emit('cartellaState', { taken: room.takenCartellas });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        // subtract 1 since this socket hasn't left yet at 'disconnecting' time
        io.to(roomId).emit('playerCount', Math.max(0, getPlayerCount(roomId) - 1));
      }
    }
  });

  socket.on('startCalling', (roomId) => {
    startCallingLoop(roomId);
  });

  socket.on('stopCalling', (roomId) => {
    // Reserved for a future admin-only control panel — intentionally not exposed to the
    // player UI, so no single player can pause the caller for the whole room.
    if (String(socket.handshake.query.isAdmin) !== 'true') return;
    const room = gameRooms[roomId];
    if (room && room.intervalId) {
      clearInterval(room.intervalId);
      room.intervalId = null;
      io.to(roomId).emit('callingState', { active: false });
    }
  });

  socket.on('resetRoom', (roomId) => {
    if (gameRooms[roomId] && gameRooms[roomId].intervalId) {
      clearInterval(gameRooms[roomId].intervalId);
    }
    createRoom(roomId);
    io.to(roomId).emit('roomState', { calledNumbers: [], playerCount: getPlayerCount(roomId) });
    io.to(roomId).emit('cartellaState', { taken: {} });
    io.to(roomId).emit('callingState', { active: false });
    if (getPlayerCount(roomId) > 0) startCallingLoop(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Bingo server running on port ${PORT}`);
});
