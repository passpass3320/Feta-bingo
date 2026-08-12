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
const WEB_APP_URL = process.env.WEB_APP_URL || `http://localhost:${PORT}`;

const MIN_DEPOSIT = 50;
const MIN_WITHDRAW = 100;
const SIGNUP_BONUS = 150;
const REFERRAL_BONUS = 50; 
const STAKE = 10;
const COMMISSION_RATE = 0.30;
const MIN_PLAYERS_FOR_ROUND = 4;
const CALL_INTERVAL_MS = 4000;
const WINNER_WINDOW_MS = 5000;
const NEXT_ROUND_DELAY_MS = 8000;

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

const db = new Database(path.join(__dirname, 'bingo.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY, username TEXT, balance_real INTEGER NOT NULL DEFAULT 0,
  balance_bonus INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, amount INTEGER NOT NULL,
  method TEXT NOT NULL, txn_id TEXT NOT NULL, screenshot_path TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, amount INTEGER NOT NULL,
  account_info TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS commission_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, pot INTEGER, commission INTEGER,
  payout INTEGER, winners_count INTEGER, created_at TEXT DEFAULT (datetime('now'))
);
`);

const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('referred_by')) db.exec("ALTER TABLE users ADD COLUMN referred_by TEXT");
if (!userCols.includes('referral_code')) db.exec("ALTER TABLE users ADD COLUMN referral_code TEXT");
if (!userCols.includes('referral_count')) db.exec("ALTER TABLE users ADD COLUMN referral_count INTEGER DEFAULT 0");
if (!userCols.includes('referral_earnings')) db.exec("ALTER TABLE users ADD COLUMN referral_earnings INTEGER DEFAULT 0");

function getOrCreateUser(telegram_id, username, referred_by = null) {
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) {
    const refCode = `pref_${telegram_id}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    db.prepare('INSERT INTO users (telegram_id, username, balance_real, balance_bonus, referred_by, referral_code) VALUES (?, ?, 0, ?, ?, ?)')
      .run(telegram_id, username || null, SIGNUP_BONUS, referred_by, refCode);
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);

    if (referred_by && referred_by !== telegram_id) {
      const referrer = db.prepare('SELECT * FROM users WHERE telegram_id = ? OR referral_code = ?').get(referred_by, referred_by);
      if (referrer) {
        db.prepare('UPDATE users SET balance_bonus = balance_bonus + ?, referral_count = referral_count + 1, referral_earnings = referral_earnings + ? WHERE telegram_id = ?')
          .run(REFERRAL_BONUS, REFERRAL_BONUS, referrer.telegram_id);
        if (bot) bot.sendMessage(referrer.telegram_id, `🎉 Your friend joined! You earned ${REFERRAL_BONUS} Birr bonus.`).catch(()=>{});
      }
    }
  } else if (username && user.username !== username) {
    db.prepare('UPDATE users SET username = ? WHERE telegram_id = ?').run(username, telegram_id);
  }
  return user;
}

function getWalletTotal(telegram_id) { const u = getOrCreateUser(telegram_id); return u.balance_real + u.balance_bonus; }
function deductStake(telegram_id, amount) {
  const u = getOrCreateUser(telegram_id);
  const fromBonus = Math.min(u.balance_bonus, amount);
  const fromReal = amount - fromBonus;
  db.prepare('UPDATE users SET balance_bonus = balance_bonus - ?, balance_real = balance_real - ? WHERE telegram_id = ?').run(fromBonus, fromReal, telegram_id);
}
function creditWinnings(telegram_id, amount) { db.prepare('UPDATE users SET balance_real = balance_real + ? WHERE telegram_id = ?').run(amount, telegram_id); }
function refundStake(telegram_id, amount) { db.prepare('UPDATE users SET balance_real = balance_real + ? WHERE telegram_id = ?').run(amount, telegram_id); }

let bot = null;
let BOT_USERNAME = 'YourBotUsername';

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  bot.getMe().then(me => { BOT_USERNAME = me.username; }).catch(() => {});

  bot.onText(/\/start(?: (.*))?/, (msg, match) => {
    const chatId = String(msg.chat.id);
    const username = msg.from.username || msg.from.first_name;
    const referralParam = match[1]; 
    const user = getOrCreateUser(chatId, username, referralParam);
    const refLink = `https://t.me/${BOT_USERNAME}?start=${user.referral_code}`;
    
    bot.sendMessage(chatId, 
      `Welcome! You received ${SIGNUP_BONUS} Birr bonus.\n\n🎁 Invite friends and earn ${REFERRAL_BONUS} Birr!\nLink: ${refLink}`,
      { reply_markup: { inline_keyboard: [[ { text: '🎮 Play Game', web_app: { url: WEB_APP_URL } } ]] } }
    );
  });

  bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(ADMIN_CHAT_ID)) return bot.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    const [action, type, id] = query.data.split(':');
    try {
      if (type === 'deposit') {
        const result = action === 'approve' ? approveDeposit(id) : rejectDeposit(id);
        await bot.editMessageText(`${query.message.text}\n\n${action === 'approve' ? '✅ APPROVED' : '❌ REJECTED'}`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        if (result.telegram_id) bot.sendMessage(result.telegram_id, action === 'approve' ? `✅ Deposit of ${result.amount} Birr approved.` : `❌ Deposit rejected.`).catch(() => {});
      } else if (type === 'withdraw') {
        const result = action === 'approve' ? approveWithdrawal(id) : rejectWithdrawal(id);
        await bot.editMessageText(`${query.message.text}\n\n${action === 'approve' ? '✅ APPROVED' : '❌ REJECTED'}`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        if (result.telegram_id) bot.sendMessage(result.telegram_id, action === 'approve' ? `✅ Withdrawal of ${result.amount} Birr approved.` : `❌ Withdrawal rejected & refunded.`).catch(() => {});
      }
      bot.answerCallbackQuery(query.id, { text: 'Done.' });
    } catch (err) { bot.answerCallbackQuery(query.id, { text: 'Error: ' + err.message }); }
  });
}

function notifyAdminDeposit(d) {
  if (!bot || !ADMIN_CHAT_ID) return;
  const text = `🟢 NEW DEPOSIT #${d.id}\nUser: ${d.telegram_id}\nAmount: ${d.amount} Birr\nMethod: ${d.method}\nTxn: ${d.txn_id}`;
  const opts = { reply_markup: { inline_keyboard: [[ { text: '✅ Approve', callback_data: `approve:deposit:${d.id}` }, { text: '❌ Reject', callback_data: `reject:deposit:${d.id}` } ]] } };
  if (d.screenshot_path) bot.sendPhoto(ADMIN_CHAT_ID, path.join(uploadsDir, path.basename(d.screenshot_path)), { caption: text, reply_markup: opts.reply_markup }).catch(() => bot.sendMessage(ADMIN_CHAT_ID, text, opts));
  else bot.sendMessage(ADMIN_CHAT_ID, text, opts);
}
function notifyAdminWithdrawal(w) {
  if (!bot || !ADMIN_CHAT_ID) return;
  const text = `🟡 NEW WITHDRAWAL #${w.id}\nUser: ${w.telegram_id}\nAmount: ${w.amount} Birr\nAccount: ${w.account_info}`;
  bot.sendMessage(ADMIN_CHAT_ID, text, { reply_markup: { inline_keyboard: [[ { text: '✅ Approve', callback_data: `approve:withdraw:${w.id}` }, { text: '❌ Reject', callback_data: `reject:withdraw:${w.id}` } ]] } });
}
function notifyAdminRound(roomId, pot, commission, winners, share) {
  if (!bot || !ADMIN_CHAT_ID) return;
  const text = winners.length > 0 ? `🏆 Round (${roomId})\nPot: ${pot} | Comm: ${commission}\nWinners: ${winners.length} x ${share}` : `↩️ Round (${roomId}) no winner. Refunded.`;
  bot.sendMessage(ADMIN_CHAT_ID, text).catch(() => {});
}

function approveDeposit(id) {
  const d = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
  if (!d || d.status !== 'pending') throw new Error('Invalid');
  getOrCreateUser(d.telegram_id);
  db.prepare('UPDATE users SET balance_real = balance_real + ? WHERE telegram_id = ?').run(d.amount, d.telegram_id);
  db.prepare("UPDATE deposits SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(id);
  return { telegram_id: d.telegram_id, amount: d.amount };
}
function rejectDeposit(id) {
  const d = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
  if (!d || d.status !== 'pending') throw new Error('Invalid');
  db.prepare("UPDATE deposits SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?").run(id);
  return { telegram_id: d.telegram_id, amount: d.amount };
}
function approveWithdrawal(id) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w || w.status !== 'pending') throw new Error('Invalid');
  db.prepare("UPDATE withdrawals SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(id);
  return { telegram_id: w.telegram_id, amount: w.amount };
}
function rejectWithdrawal(id) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w || w.status !== 'pending') throw new Error('Invalid');
  db.prepare('UPDATE users SET balance_real = balance_real + ? WHERE telegram_id = ?').run(w.amount, w.telegram_id);
  db.prepare("UPDATE withdrawals SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?").run(id);
  return { telegram_id: w.telegram_id, amount: w.amount };
}

app.get('/api/wallet/:telegram_id', (req, res) => {
  const user = getOrCreateUser(req.params.telegram_id, req.query.username);
  res.json({ ...user, total_balance: user.balance_real + user.balance_bonus, stake: STAKE });
});

app.post('/api/deposit', upload.single('screenshot'), (req, res) => {
  const { telegram_id, amount, method, txn_id, username } = req.body;
  const amt = parseInt(amount, 10);
  if (!telegram_id || !amt || !method || !txn_id) return res.status(400).json({ error: 'Missing fields.' });
  if (amt < MIN_DEPOSIT) return res.status(400).json({ error: `Min deposit is ${MIN_DEPOSIT}.` });
  if (!req.file) return res.status(400).json({ error: 'Attach screenshot.' });
  getOrCreateUser(telegram_id, username);
  const info = db.prepare('INSERT INTO deposits (telegram_id, amount, method, txn_id, screenshot_path) VALUES (?, ?, ?, ?, ?)').run(telegram_id, amt, method, txn_id, `/uploads/${req.file.filename}`);
  notifyAdminDeposit(db.prepare('SELECT * FROM deposits WHERE id = ?').get(info.lastInsertRowid));
  res.json({ success: true });
});

app.post('/api/withdraw', (req, res) => {
  const { telegram_id, amount, account_info } = req.body;
  const amt = parseInt(amount, 10);
  if (!telegram_id || !amt || !account_info) return res.status(400).json({ error: 'Missing fields.' });
  if (amt < MIN_WITHDRAW) return res.status(400).json({ error: `Min withdraw is ${MIN_WITHDRAW}.` });
  const user = getOrCreateUser(telegram_id);
  if (amt > user.balance_real) return res.status(400).json({ error: 'Insufficient withdrawable balance.' });
  db.prepare('UPDATE users SET balance_real = balance_real - ? WHERE telegram_id = ?').run(amt, telegram_id);
  const info = db.prepare('INSERT INTO withdrawals (telegram_id, amount, account_info) VALUES (?, ?, ?)').run(telegram_id, amt, account_info);
  notifyAdminWithdrawal(db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(info.lastInsertRowid));
  res.json({ success: true });
});

function requireAdminKey(req, res, next) {
  if ((req.query.key || req.headers['x-admin-key']) !== ADMIN_DASHBOARD_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}
app.get('/api/admin/deposits', requireAdminKey, (req, res) => res.json(db.prepare("SELECT * FROM deposits WHERE status = 'pending'").all()));
app.get('/api/admin/withdrawals', requireAdminKey, (req, res) => res.json(db.prepare("SELECT * FROM withdrawals WHERE status = 'pending'").all()));
app.post('/api/admin/deposit/:id/approve', requireAdminKey, (req, res) => { try { res.json({ success: true, result: approveDeposit(req.params.id) }); } catch(e) { res.status(400).json({error:e.message})} });
app.post('/api/admin/deposit/:id/reject', requireAdminKey, (req, res) => { try { res.json({ success: true, result: rejectDeposit(req.params.id) }); } catch(e) { res.status(400).json({error:e.message})} });
app.post('/api/admin/withdraw/:id/approve', requireAdminKey, (req, res) => { try { res.json({ success: true, result: approveWithdrawal(req.params.id) }); } catch(e) { res.status(400).json({error:e.message})} });
app.post('/api/admin/withdraw/:id/reject', requireAdminKey, (req, res) => { try { res.json({ success: true, result: rejectWithdrawal(req.params.id) }); } catch(e) { res.status(400).json({error:e.message})} });

// ================= BINGO ENGINE =================
function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const CARTELLA_COUNT = 200;
function generateCartella(id) {
  const rand = mulberry32((id * 2654435761) % 2147483647);
  const cols = [[1,15],[16,30],[31,45],[46,60],[61,75]].map(([lo, hi]) => { const nums = []; for (let n = lo; n <= hi; n++) nums.push(n); return shuffle(nums, rand).slice(0, 5); });
  cols[2][2] = 'FREE'; return cols;
}
function isCardWinning(card, calledSet) {
  const isMarked = (c, r) => card[c][r] === 'FREE' || calledSet.has(card[c][r]);
  for (let r = 0; r < 5; r++) if ([0,1,2,3,4].every(c => isMarked(c, r))) return true;
  for (let c = 0; c < 5; c++) if ([0,1,2,3,4].every(r => isMarked(c, r))) return true;
  if ([0,1,2,3,4].every(i => isMarked(i, i))) return true;
  if ([0,1,2,3,4].every(i => isMarked(i, 4 - i))) return true;
  if (isMarked(0,0) && isMarked(4,0) && isMarked(0,4) && isMarked(4,4)) return true;
  return false;
}

const BOT_NAMES = ['Bot_A', 'Bot_B', 'Bot_C', 'Bot_D', 'Bot_E', 'Bot_F', 'Bot_G', 'Bot_H', 'Bot_I', 'Bot_J'];
const gameRooms = {};

function createRoom(roomId) {
  gameRooms[roomId] = { calledNumbers: [], remaining: Array.from({ length: 75 }, (_, i) => i + 1), intervalId: null, takenCartellas: {}, playerCartellas: {}, bots: [], playerStakes: {}, pendingWinners: [], winnerWindowTimer: null, pot: 0 };
  return gameRooms[roomId];
}
function getPlayerCount(roomId) { const room = io.sockets.adapter.rooms.get(roomId); return room ? room.size : 0; }
function ensureBots(roomId) {
  const room = gameRooms[roomId] || createRoom(roomId);
  const realCount = getPlayerCount(roomId);
  const targetBots = realCount >= 1 && realCount < MIN_PLAYERS_FOR_ROUND ? (MIN_PLAYERS_FOR_ROUND - realCount) : 0;
  while (room.bots.length > targetBots) { const removed = room.bots.pop(); delete room.takenCartellas[removed.cartellaId]; }
  while (room.bots.length < targetBots) {
    const available = []; for (let i = 1; i <= CARTELLA_COUNT; i++) if (!room.takenCartellas[i]) available.push(i);
    if (available.length === 0) break;
    const cartellaId = available[Math.floor(Math.random() * available.length)];
    room.takenCartellas[cartellaId] = 'bot_' + cartellaId;
    room.bots.push({ cartellaId, name: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] });
  }
  io.to(roomId).emit('cartellaState', { taken: room.takenCartellas, bots: room.bots });
  io.to(roomId).emit('playerCount', realCount + room.bots.length);
}
function startCallingLoop(roomId) {
  const room = gameRooms[roomId] || createRoom(roomId);
  if (room.intervalId || room.remaining.length === 0) return;
  io.to(roomId).emit('callingState', { active: true });
  room.intervalId = setInterval(() => {
    if (room.remaining.length === 0) { clearInterval(room.intervalId); room.intervalId = null; io.to(roomId).emit('callingState', { active: false }); io.to(roomId).emit('gameOver'); if (!room.winnerWindowTimer) settleRoundWithNoWinner(roomId); return; }
    const idx = Math.floor(Math.random() * room.remaining.length);
    const number = room.remaining.splice(idx, 1)[0];
    room.calledNumbers.push(number);
    io.to(roomId).emit('numberCalled', { number, calledNumbers: room.calledNumbers });
  }, CALL_INTERVAL_MS);
}
function settleRoundWithNoWinner(roomId) {
  const room = gameRooms[roomId]; if (!room) return;
  Object.keys(room.playerStakes).forEach(tid => refundStake(tid, room.playerStakes[tid]));
  io.to(roomId).emit('roundResult', { winners: [], pot: room.pot, commission: 0, payout: 0, share: 0, refunded: true });
  notifyAdminRound(roomId, room.pot, 0, [], 0); scheduleNextRound(roomId);
}
function finalizeRound(roomId) {
  const room = gameRooms[roomId]; if (!room) return;
  if (room.intervalId) { clearInterval(room.intervalId); room.intervalId = null; }
  room.winnerWindowTimer = null;
  const winners = room.pendingWinners.slice(); const pot = room.pot;
  const commission = Math.round(pot * COMMISSION_RATE * 100) / 100;
  const payout = Math.round((pot - commission) * 100) / 100;
  const share = winners.length > 0 ? Math.round((payout / winners.length) * 100) / 100 : 0;
  winners.forEach(w => creditWinnings(w.telegram_id, share));
  db.prepare('INSERT INTO commission_log (room_id, pot, commission, payout, winners_count) VALUES (?, ?, ?, ?, ?)').run(roomId, pot, commission, payout, winners.length);
  io.to(roomId).emit('callingState', { active: false });
  io.to(roomId).emit('roundResult', { winners, pot, commission, payout, share });
  notifyAdminRound(roomId, pot, commission, winners.map(w => w.telegram_id), share);
  scheduleNextRound(roomId);
}
function scheduleNextRound(roomId) {
  setTimeout(() => {
    createRoom(roomId);
    io.to(roomId).emit('roomState', { calledNumbers: [], playerCount: getPlayerCount(roomId) });
    io.to(roomId).emit('cartellaState', { taken: {}, bots: [] });
    io.to(roomId).emit('callingState', { active: false });
    io.to(roomId).emit('potUpdate', { pot: 0, players: 0 });
    if (getPlayerCount(roomId) > 0) ensureBots(roomId);
  }, NEXT_ROUND_DELAY_MS);
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (data)
