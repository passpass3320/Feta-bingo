# ዘመን ቢንጎ (Zemen Bingo) — Telegram Mini App

Express + Socket.io + SQLite backend for a real-money multiplayer bingo mini app.

## Features

- **Amharic auto-caller**: numbers are called live over Socket.io and spoken in Amharic
  via the Web Speech API ("ቁጥር 15", etc). Falls back to the system default voice reading
  the same Amharic text if no `am-ET` voice is installed on the device.
- **Wallet**: two balances per user — `balance_real` (withdrawable: deposits + winnings)
  and `balance_bonus` (150 Birr signup bonus, playable but never withdrawable).
- **Deposit flow**: user submits amount + method + transaction ID + SMS confirmation
  screenshot (min 50 Birr) → admin gets a Telegram message with Approve/Reject buttons →
  approving credits `balance_real` instantly.
- **Withdrawal flow**: user submits amount (min 100 Birr, checked only against
  `balance_real`) + payout account → funds are held immediately → admin Approve/Reject →
  approving finalizes it (pay the user manually, then mark it paid from the dashboard).
- **200 cartellas**: numbered 1–200, each a real deterministic 5×5 bingo card
  (B 1-15 / I 16-30 / N 31-45 w/ FREE center / G 46-60 / O 61-75). Same cartella number
  always generates the same card. Server-side locking means two players can never hold
  the same cartella in the same room.
- **Fair shared multiplayer caller**: one server-controlled calling loop per room,
  broadcast to everyone — no single player can start/stop it for the group.
- **Bot filler players**: if fewer than 4 real players are in the room, cosmetic bot
  "players" auto-pick open cartellas to fill the room up to 4 total. Bots never pay a
  stake, are never eligible to win, and never dilute the real pot — they exist purely so
  a solo player still sees an active-feeling room.
- **Stake, pot, commission, payout**: selecting a cartella charges the player `STAKE`
  Birr (10 by default, bonus balance spent first) into the room pot. When a player calls
  Bingo with a card that's actually complete (row / column / diagonal / four corners),
  a 5-second window opens for other valid winners to also claim. When it closes, the
  platform keeps **30% commission**, and the remaining **70% is split equally** among
  everyone who validly claimed in that window, credited straight to their withdrawable
  `balance_real`. If the numbers run out with no valid winner, every stake is refunded.
- **Insufficient balance → spectator mode**: a player without enough combined balance to
  cover the stake sees a "Spectator mode — deposit to play" banner instead of being
  blocked from the app; they can still watch the live board and calls, and one tap opens
  the deposit modal.
- **Redesigned splash/loading screen** matching a richer purple/gold theme, shown until
  both the wallet and the live socket connection are ready (4s failsafe).

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your BOT_TOKEN, ADMIN_CHAT_ID, ADMIN_DASHBOARD_KEY
npm start
```

Serves the frontend at `http://localhost:3000`. `bingo.db` (SQLite) is created
automatically on first run.

## Key constants (top of `server.js`)

```js
const MIN_DEPOSIT = 50;
const MIN_WITHDRAW = 100;
const SIGNUP_BONUS = 150;
const STAKE = 10;                 // Birr per cartella per round
const COMMISSION_RATE = 0.30;     // platform's cut of the pot
const MIN_PLAYERS_FOR_ROUND = 4;  // bots fill up to this many "players"
const CALL_INTERVAL_MS = 4000;    // time between number calls
const WINNER_WINDOW_MS = 5000;    // window for other players to also claim Bingo
```

Adjust these to change stake size, commission %, calling speed, etc.

## Admin dashboard API

All under `/api/admin/*`, protected by `ADMIN_DASHBOARD_KEY` (`?key=...` or header
`x-admin-key`):

- `GET /api/admin/deposits` / `withdrawals` — pending requests
- `POST /api/admin/deposit/:id/approve` / `/reject`
- `POST /api/admin/withdraw/:id/approve` / `/reject` / `/mark-paid`
- `GET /api/admin/commission-log` — history of pot/commission/payout per finished round

Approvals can also be done straight from Telegram via the inline buttons on each
admin notification — no dashboard required for daily use.

## Important: compliance

This app now automatically moves real money between users based on game outcomes
(stake → pot → commission → winner payout), on top of manual deposit/withdrawal
approval. Confirm running this kind of paid bingo game is legal in your target market
and that you hold any required gambling/payment license before launching publicly.
