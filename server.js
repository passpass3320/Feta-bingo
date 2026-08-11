/**
 * ዘመን ቢንጎ (Zemen Bingo) - Telegram Bingo Mini App Backend
 * Express + Socket.io + SQLite (better-sqlite3) + Telegram Bot (node-telegram-bot-api)
 *
 * ENV VARS REQUIRED (.env file):
 *   BOT_TOKEN            - Telegram bot token from @BotFather
 *   ADMIN_CHAT_ID        - Your personal Telegram chat id (admin who approves deposits/withdrawals)
 *   ADMIN_DASHBOARD_KEY  - secret string protecting the /api/admin/* routes
 *   PORT                 - optional, defaults to 3000
 *
 * COMPLIANCE NOTE: this app moves real money in and out of user wallets and pays out
 * game winnings automatically. Confirm running a paid bingo game like this is legal
 * in your target market and that you hold any required gambling/payment license
 * before launching publicly.
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

// ---------- Game / money constants ----------
const MIN_DEPOSIT = 50;
const MIN_WITHDRAW = 100;
const SIGNUP_BONUS = 150;       // Birr credited to balance_bonus for brand new users (non-withdrawable)
const STAKE = 10;                // Birr per cartella, per round
const COMMISSION_RATE = 0.30;    // platform takes 30% of the pot
const MIN_PLAYERS_FOR_ROUND = 4; // bots fill up to this many "players" when real players are short
const CALL_INTERVAL_MS = 4000;
const WINNER_WINDOW_MS = 5000;   // window during which other valid winners can also claim, to split the pot
const NEXT_ROUND_DELAY_MS = 8000;

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

CREATE TABLE IF NOT EXISTS commission_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT,
  pot INTEGER,
  commission INTEGER,
  payout INTEGER,
  winners_count INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

function getOrCreateUser(telegram_id, username) {
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) {
    // Brand new user: create the account and credit the signup bonus.
    // Goes to balance_bonus - playable, but can never be withdrawn.
    db.prepare('INSERT INTO users (telegram_id, username, balance_real, balance_bonus) VALUES (?, ?, 0, ?)')
      .run(telegram_id, username || null, SIGNUP_BONUS);
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  } else if (username && user.username !== username) {
    db.prepare('UPDATE users SET username = ? WHERE telegram_id = ?').run(username, telegram_id);
  }
  return user;
}

function getWalletTotal(telegram_id) {
  const user = getOrCreateUser(telegram_id);
  return user.balance_real + user.balance_bonus;
}

// Deducts a stake, spending bonus balance first (so promo bonus gets used before real money).
function deductStake(telegram_id, amount) {
  const user = getOrCreateUser(telegram_id);
  const fromBonus = Math.min(user.balance_bonus, amount);
  const fromReal = amount - fromBonus;
  db.prepare('UPDATE users SET balance_bonus = balance_bonus - ?, balance_real = balance_real - ? WHERE telegram_id = ?')
    .run(fromBonus, fromReal, telegram_id);
}

// Winnings are always real, withdrawable money.
function creditWinnings(telegram_id, amount) {
  db.prepare('UPDATE users SET balance_real = balance_real + ? WHERE telegram_id = ?').run(amount, telegram_id);
}

function refundStake(telegram_id, amount) {
  db.prepare('UPDATE users SET balance_real = balance_real + ? WHERE telegram_id = ?').run(amount, telegram_id);
}

// ---------- Telegram Bot ----------
let bot = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    getOrCreateUser(String(msg.chat.id), msg.from.username || msg.from.first_name);
    bot.sendMessage(msg.chat.id, `እንኳን ደህና መጡ ወደ ዘመን ቢንጎ! ${SIGNUP_BONUS} ብር ቦነስ አግኝተዋል። ጨዋታውን ለመክፈት Mini App ይክፈቱ።`);
  });

  bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(ADMIN_CHAT_ID)) {
      return bot.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    }
    const [action, type, id] = query.data.split(':');

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

function notifyAdminRound(roomId, pot, commission, winners, share) {
  if (!bot || !ADMIN_CHAT_ID) return;
  const text = winners.length > 0
    ? `🏆 Round finished (${roomId})\nPot: ${pot} Birr\nCommission (30%): ${commission} Birr\nWinners: ${winners.length} x ${share} Birr each`
    : `↩️ Round finished (${roomId}) with no winner — pot of ${pot} Birr fully refunded to players.`;
  bot.sendMessage(ADMIN_CHAT_ID, text).catch(() => {});
}

// ---------- Deposit / Withdrawal business logic ----------
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
  db.prepare("UPDATE withdrawals SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(id);
  return { telegram_id: w.telegram_id, amount: w.amount };
}

function rejectWithdrawal(id) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w) throw new Error('Withdrawal not found');
  if (w.status !== 'pending') throw new Error('Already resolved');
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
    total_balance: user.balance_real + user.balance_bonus,
    stake: STAKE
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

app.get('/api/admin/commission-log', requireAdminKey, (req, res) => {
  res.json(db.prepare('SELECT * FROM commission_log ORDER BY id DESC LIMIT 200').all());
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

// ================= BINGO GAME ENGINE =================

// Deterministic PRNG: cartella #N always generates the exact same card for everyone.
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
const CARTELLA_COUNT = 200;
// Standard 75-ball card: B=1-15, I=16-30, N=31-45 (center FREE), G=46-60, O=61-75.
function generateCartella(id) {
  const rand = mulberry32((id * 2654435761) % 2147483647);
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  const cols = ranges.map(([lo, hi]) => {
    const nums = [];
    for (let n = lo; n <= hi; n++) nums.push(n);
    return shuffle(nums, rand).slice(0, 5);
  });
  cols[2][2] = 'FREE';
  return cols; // [ [B1..5], [I1..5], [N1..5], [G1..5], [O1..5] ]
}

function isCardWinning(card, calledSet) {
  const isMarked = (col, row) => {
    const v = card[col][row];
    return v === 'FREE' || calledSet.has(v);
  };
  for (let row = 0; row < 5; row++) if ([0, 1, 2, 3, 4].every((col) => isMarked(col, row))) return true;
  for (let col = 0; col < 5; col++) if ([0, 1, 2, 3, 4].every((row) => isMarked(col, row))) return true;
  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, i))) return true;
  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, 4 - i))) return true;
  if (isMarked(0, 0) && isMarked(4, 0) && isMarked(0, 4) && isMarked(4, 4)) return true;
  return false;
}

const BOT_NAMES = ['ሰላም 🤖', 'አበል 🤖', 'መቅደስ 🤖', 'ናሆም 🤖', 'ቤቲ 🤖', 'ዮናስ 🤖', 'ሳራ 🤖', 'ዳዊት 🤖', 'ሄለን 🤖', 'ካሌብ 🤖'];

const gameRooms = {}; // roomId -> room state

function createRoom(roomId) {
  gameRooms[roomId] = {
    calledNumbers: [],
    remaining: Array.from({ length: 75 }, (_, i) => i + 1),
    intervalId: null,
    takenCartellas: {},    // cartellaId -> telegram_id (or 'bot_<id>' for filler bots)
    playerCartellas: {},   // telegram_id -> [cartellaId, ...] - a player may hold several cards
    bots: [],               // [{ cartellaId, name }]
    playerStakes: {},      // telegram_id -> total amount staked this round (real players only)
    pot: 0,
    pendingWinners: [],    // [{ telegram_id, cartellaId }] who validly claimed Bingo this round
    winnerWindowTimer: null
  };
  return gameRooms[roomId];
}

function getPlayerCount(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  return room ? room.size : 0;
}

// Fills the room with cosmetic bot "players" (each auto-picking a cartella) whenever real
// players are alone or too few, so a round always feels populated and can always start.
// Bots never pay a stake, are never eligible to win, and never dilute the real pot.
function ensureBots(roomId) {
  const room = gameRooms[roomId] || createRoom(roomId);
  const realCount = getPlayerCount(roomId);
  const targetBots = realCount >= 1 && realCount < MIN_PLAYERS_FOR_ROUND ? (MIN_PLAYERS_FOR_ROUND - realCount) : 0;

  while (room.bots.length > targetBots) {
    const removed = room.bots.pop();
    delete room.takenCartellas[removed.cartellaId];
  }
  while (room.bots.length < targetBots) {
    const available = [];
    for (let i = 1; i <= CARTELLA_COUNT; i++) if (!room.takenCartellas[i]) available.push(i);
    if (available.length === 0) break;
    const cartellaId = available[Math.floor(Math.random() * available.length)];
    const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    room.takenCartellas[cartellaId] = 'bot_' + cartellaId;
    room.bots.push({ cartellaId, name });
  }

  io.to(roomId).emit('cartellaState', { taken: room.takenCartellas, bots: room.bots });
  io.to(roomId).emit('playerCount', realCount + room.bots.length);
}

function startCallingLoop(roomId) {
  const room = gameRooms[roomId] || createRoom(roomId);
  if (room.intervalId || room.remaining.length === 0) return;

  io.to(roomId).emit('callingState', { active: true });
  room.intervalId = setInterval(() => {
    if (room.remaining.length === 0) {
      clearInterval(room.intervalId);
      room.intervalId = null;
      io.to(roomId).emit('callingState', { active: false });
      io.to(roomId).emit('gameOver');
      // No one claimed a valid Bingo before the pot ran out of numbers - refund everyone.
      if (!room.winnerWindowTimer) settleRoundWithNoWinner(roomId);
      return;
    }
    const idx = Math.floor(Math.random() * room.remaining.length);
    const number = room.remaining.splice(idx, 1)[0];
    room.calledNumbers.push(number);
    io.to(roomId).emit('numberCalled', { number, calledNumbers: room.calledNumbers });
  }, CALL_INTERVAL_MS);
}

function settleRoundWithNoWinner(roomId) {
  const room = gameRooms[roomId];
  if (!room) return;
  Object.keys(room.playerStakes).forEach((tid) => refundStake(tid, room.playerStakes[tid]));
  io.to(roomId).emit('roundResult', { winners: [], pot: room.pot, commission: 0, payout: 0, share: 0, refunded: true });
  notifyAdminRound(roomId, room.pot, 0, [], 0);
  scheduleNextRound(roomId);
}

function finalizeRound(roomId) {
  const room = gameRooms[roomId];
  if (!room) return;
  if (room.intervalId) { clearInterval(room.intervalId); room.intervalId = null; }
  room.winnerWindowTimer = null;

  const winners = room.pendingWinners.slice(); // [{ telegram_id, cartellaId }]
  const pot = room.pot;
  const commission = Math.round(pot * COMMISSION_RATE * 100) / 100;
  const payout = Math.round((pot - commission) * 100) / 100;
  const share = winners.length > 0 ? Math.round((payout / winners.length) * 100) / 100 : 0;

  winners.forEach((w) => creditWinnings(w.telegram_id, share));

  db.prepare('INSERT INTO commission_log (room_id, pot, commission, payout, winners_count) VALUES (?, ?, ?, ?, ?)')
    .run(roomId, pot, commission, payout, winners.length);

  io.to(roomId).emit('callingState', { active: false });
  io.to(roomId).emit('roundResult', { winners, pot, commission, payout, share });
  notifyAdminRound(roomId, pot, commission, winners.map((w) => w.telegram_id), share);
  scheduleNextRound(roomId);
}

function scheduleNextRound(roomId) {
  setTimeout(() => {
    createRoom(roomId);
    io.to(roomId).emit('roomState', { calledNumbers: [], playerCount: getPlayerCount(roomId) });
    io.to(roomId).emit('cartellaState', { taken: {}, bots: [] });
    io.to(roomId).emit('callingState', { active: false });
    io.to(roomId).emit('potUpdate', { pot: 0, players: 0 });
    // Refresh bot fillers for atmosphere only - calling still waits for a real
    // player to pick a cartella via selectCartella, same rule as the first round.
    if (getPlayerCount(roomId) > 0) ensureBots(roomId);
  }, NEXT_ROUND_DELAY_MS);
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (roomId) => {
    socket.join(roomId);
    const room = gameRooms[roomId] || createRoom(roomId);
    socket.emit('roomState', { calledNumbers: room.calledNumbers, playerCount: getPlayerCount(roomId) + room.bots.length, stake: STAKE });
    socket.emit('cartellaState', { taken: room.takenCartellas, bots: room.bots });
    socket.emit('potUpdate', { pot: room.pot, players: Object.keys(room.playerStakes).length });
    socket.emit('callingState', { active: !!room.intervalId });

    // NOTE: bots are still refreshed here for atmosphere (so the lobby looks populated),
    // but calling numbers does NOT start here anymore - see selectCartella below.
    ensureBots(roomId);
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        setTimeout(() => ensureBots(roomId), 100); // let the room's member count update first
      }
    }
  });

  socket.on('selectCartella', ({ roomId, cartellaId, telegram_id }) => {
    const room = gameRooms[roomId] || createRoom(roomId);
    const id = Number(cartellaId);
    if (!Number.isInteger(id) || id < 1 || id > CARTELLA_COUNT) {
      return socket.emit('cartellaError', { code: 'INVALID', message: 'Invalid cartella number.' });
    }
    if (room.takenCartellas[id]) {
      return socket.emit('cartellaError', { code: 'TAKEN', message: 'This cartella is already taken. Pick another.' });
    }

    // Each additional card costs another stake (multiple cards = better odds, same as
    // real bingo halls selling several tickets to one player).
    if (getWalletTotal(telegram_id) < STAKE) {
      return socket.emit('cartellaError', {
        code: 'INSUFFICIENT_BALANCE',
        message: `በቂ ሂሳብ የለዎትም። ለመጫወት ${STAKE} ብር ወይም ከዚያ በላይ ያስፈልጋል። እባክዎ ገንዘብ ያስገቡ። (Insufficient balance - deposit at least ${STAKE} Birr to play.)`
      });
    }
    deductStake(telegram_id, STAKE);
    room.playerStakes[telegram_id] = (room.playerStakes[telegram_id] || 0) + STAKE;
    room.pot += STAKE;
    io.to(roomId).emit('potUpdate', { pot: room.pot, players: Object.keys(room.playerStakes).length });

    room.takenCartellas[id] = telegram_id;
    if (!room.playerCartellas[telegram_id]) room.playerCartellas[telegram_id] = [];
    room.playerCartellas[telegram_id].push(id);

    socket.emit('cartellaAssigned', { cartellaId: id, card: generateCartella(id), myCartellas: room.playerCartellas[telegram_id] });
    io.to(roomId).emit('cartellaState', { taken: room.takenCartellas, bots: room.bots });

    // Number drawing only begins once a real player has actually picked a cartella -
    // never just from opening the app / joining the room.
    if (!room.intervalId && room.remaining.length > 0) startCallingLoop(roomId);
  });

  socket.on('deselectCartella', ({ roomId, cartellaId, telegram_id }) => {
    const room = gameRooms[roomId];
    if (!room || room.intervalId) return; // no refunds/changes once calling has started
    const id = Number(cartellaId);
    if (room.takenCartellas[id] !== telegram_id) return;
    delete room.takenCartellas[id];
    room.playerCartellas[telegram_id] = (room.playerCartellas[telegram_id] || []).filter((c) => c !== id);
    room.playerStakes[telegram_id] = Math.max(0, (room.playerStakes[telegram_id] || 0) - STAKE);
    room.pot = Math.max(0, room.pot - STAKE);
    refundStake(telegram_id, STAKE);
    io.to(roomId).emit('potUpdate', { pot: room.pot, players: Object.keys(room.playerStakes).length });
    io.to(roomId).emit('cartellaState', { taken: room.takenCartellas, bots: room.bots });
    socket.emit('cartellaReleased', { cartellaId: id, myCartellas: room.playerCartellas[telegram_id] });
  });

  socket.on('claimBingo', ({ roomId, telegram_id }) => {
    const room = gameRooms[roomId];
    if (!room) return;
    const myCartellas = room.playerCartellas[telegram_id] || [];
    if (myCartellas.length === 0) {
      return socket.emit('bingoError', { message: 'እባክዎ መጀመሪያ ካርቴላ ይምረጡ (Pick a cartella first).' });
    }
    const calledSet = new Set(room.calledNumbers);
    // A player with several cards wins if ANY one of them is complete.
    const winningCartellaId = myCartellas.find((cid) => isCardWinning(generateCartella(cid), calledSet));
    if (winningCartellaId === undefined) {
      return socket.emit('bingoError', { message: 'ገና ትክክለኛ ቢንጎ የለዎትም (Not a valid Bingo yet).' });
    }
    if (!room.pendingWinners.some((w) => w.telegram_id === telegram_id)) {
      room.pendingWinners.push({ telegram_id, cartellaId: winningCartellaId });
      io.to(roomId).emit('winnerClaimed', { telegram_id, cartellaId: winningCartellaId, pendingCount: room.pendingWinners.length });
    }
    if (!room.winnerWindowTimer) {
      if (room.intervalId) { clearInterval(room.intervalId); room.intervalId = null; } // freeze calling once a winner appears
      io.to(roomId).emit('winnerWindowOpen', { seconds: WINNER_WINDOW_MS / 1000 });
      room.winnerWindowTimer = setTimeout(() => finalizeRound(roomId), WINNER_WINDOW_MS);
    }
  });

  // Reserved for a future admin-only control panel - not exposed to the player UI, so no
  // single player can stop the shared caller for everyone else.
  socket.on('adminStopCalling', ({ roomId, adminKey }) => {
    if (adminKey !== ADMIN_DASHBOARD_KEY) return;
    const room = gameRooms[roomId];
    if (room && room.intervalId) {
      clearInterval(room.intervalId);
      room.intervalId = null;
      io.to(roomId).emit('callingState', { active: false });
    }
  });
});

server.listen(PORT, () => {
  console.log(`ዘመን ቢንጎ server running on port ${PORT}`);
});
