/**
 * ዘመን ቢንጎ / Harar Bingo - Telegram Bot (Telegraf)
 *
 * Companion bot to the Bingo Mini App. Handles the persistent reply-keyboard menu
 * (Play Game / Deposit / Withdraw / Balance / Invite & Earn / Support / Instructions),
 * deposit & withdrawal request flows with admin approval, and referral bonuses.
 *
 * ENV VARS REQUIRED (.env) - strictly required, no fallback defaults:
 *   BOT_TOKEN          - Telegram bot token from @BotFather
 *   APP_URL            - https URL of your Bingo Mini App (opened by the "Play Game" button)
 *   ADMIN_CHAT_ID      - your personal Telegram chat id, receives deposit/withdraw approvals
 *   SUPPORT_USERNAME   - optional, defaults to @hararbingo_bot
 *   CHANNEL_URL        - optional, defaults to https://t.me/harar_bingo
 *
 * STORAGE: this file uses simple in-memory Maps so it runs standalone with zero setup.
 * Everything resets when the process restarts. Swap `users` / `pendingDeposits` /
 * `pendingWithdrawals` for real database calls before going live - see the Postgres
 * schema outline in the comment block at the bottom of this file.
 *
 * COMPLIANCE NOTE: this bot moves real money via manual admin approval. Confirm running
 * a paid bingo game like this is legal in your target market before launching publicly.
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '@hararbingo_bot';
const CHANNEL_URL = process.env.CHANNEL_URL || 'https://t.me/harar_bingo';

const MIN_DEPOSIT = 50;
const MIN_WITHDRAW = 100;
const TELEBIRR_NUMBER = '0971952984';
const REFERRAL_BONUS = 10;              // Birr credited to referrer on referee's first approved deposit
const REFERRAL_MILESTONE_COUNT = 10;    // invite this many people...
const REFERRAL_MILESTONE_BONUS = 30;    // ...to earn this one-time extra bonus

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env - get one from @BotFather.');
  process.exit(1);
}
if (!APP_URL) {
  console.error('Missing APP_URL in .env - set it to your Bingo Mini App\'s https URL.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let BOT_USERNAME = 'your_bot'; // filled in at startup from bot.telegram.getMe()

/* =========================================================================
   DUMMY IN-MEMORY STORAGE (replace with a real DB - see schema outline below)
========================================================================= */
const users = new Map();               // telegram_id -> user record
const pendingDeposits = new Map();      // depositId -> record
const pendingWithdrawals = new Map();   // withdrawId -> record
const sessionState = new Map();         // telegram_id -> { step, data }
let depositCounter = 1;
let withdrawCounter = 1;

function getUser(ctx) {
  const id = String(ctx.from.id);
  if (!users.has(id)) {
    users.set(id, {
      id,
      username: ctx.from.username || ctx.from.first_name || 'player',
      balance_main: 0,
      balance_bonus: 0,
      hasDeposited: false,
      referredBy: null,
      referralBonusGiven: false, // prevents paying the referrer twice
      invitedCount: 0,
      earnedAmount: 0,
      milestoneAwarded: false
    });
  }
  const user = users.get(id);
  if (ctx.from.username) user.username = ctx.from.username; // keep it fresh
  return user;
}

function setSession(userId, step, data = {}) {
  sessionState.set(String(userId), { step, data });
}
function clearSession(userId) {
  sessionState.delete(String(userId));
}
function getSession(userId) {
  return sessionState.get(String(userId));
}

function mainKeyboard() {
  return Markup.keyboard([
    [Markup.button.webApp('🎮 Play Game', APP_URL)],
    ['💰 Deposit', '💸 Withdraw'],
    ['💳 Balance', '👥 Invite & Earn'],
    ['📞 Support', '📖 Instructions']
  ]).resize();
}

function money(n) {
  return Number(n).toFixed(0);
}

/* ---------------------------- /start ---------------------------- */
bot.start(async (ctx) => {
  const user = getUser(ctx);
  const payload = ctx.startPayload; // e.g. "ref_123456789"

  if (payload && payload.startsWith('ref_') && !user.referredBy) {
    const referrerId = payload.slice(4);
    if (referrerId && referrerId !== user.id) {
      user.referredBy = referrerId;
    }
  }

  // Persistent reply keyboard (bottom menu) for every subsequent message...
  await ctx.reply(`👋 Welcome back, @${user.username}!\n\nTap 🎮 Play Game to join the live room.`, mainKeyboard());

  // ...plus an inline Web App button right on the welcome message itself, so the game
  // is reachable in one tap even before the reply keyboard has rendered.
  await ctx.reply(
    '⬇️ Or launch it directly:',
    Markup.inlineKeyboard([Markup.button.webApp('🎮 Open ዘመን ቢንጎ', APP_URL)])
  );
});

/* ---------------------------- 💰 Deposit ---------------------------- */
bot.hears('💰 Deposit', (ctx) => {
  clearSession(ctx.from.id);
  setSession(ctx.from.id, 'await_deposit_amount');
  ctx.reply(
    '💰 ተቀማጭ (ገንዘብ ማስገባት)\n\n' +
    '💵 ምን ያህል ብር ማስገባት ይፈልጋሉ?\n' +
    `ዝቅተኛ: ${MIN_DEPOSIT} ብር\n\n` +
    'መጠኑን በቁጥር ይላኩ፤ ለምሳሌ 50',
    Markup.inlineKeyboard([Markup.button.callback('❌ Cancel', 'cancel_flow')])
  );
});

/* ---------------------------- 💸 Withdraw ---------------------------- */
bot.hears('💸 Withdraw', (ctx) => {
  const user = getUser(ctx);
  if (!user.hasDeposited) {
    return ctx.reply(
      '💸 ወጪ (ገንዘብ ማውጣት)\n\n' +
      'ወጪ ለማድረግዎ በፊት ቢያንስ አንድ ጊዜ ተቀማጭ ማድረግ ያስፈልጋል።\n' +
      `እባክዎ መጀመሪያ ቢያንስ ${MIN_DEPOSIT} ብር ያስገቡ፤ ከዚያ ወጪ ማድረግ ይችላሉ። 💰`
    );
  }
  clearSession(ctx.from.id);
  setSession(ctx.from.id, 'await_withdraw_amount');
  ctx.reply(
    '💸 ወጪ (ገንዘብ ማውጣት)\n\n' +
    `ምን ያህል ብር ማውጣት ይፈልጋሉ?\nዝቅተኛ: ${MIN_WITHDRAW} ብር\n\n` +
    'መጠኑን በቁጥር ይላኩ፤ ለምሳሌ 100',
    Markup.inlineKeyboard([Markup.button.callback('❌ Cancel', 'cancel_flow')])
  );
});

/* ---------------------------- 💳 Balance ---------------------------- */
bot.hears('💳 Balance', (ctx) => {
  const user = getUser(ctx);
  const total = user.balance_main + user.balance_bonus;
  ctx.reply(
    `💳 Your balance\n\n` +
    `💰 Main: ${money(user.balance_main)} birr\n` +
    `🎁 Bonus: ${money(user.balance_bonus)} birr\n` +
    `🧱 Total: ${money(total)} birr`
  );
});

/* ---------------------------- 👥 Invite & Earn ---------------------------- */
bot.hears('👥 Invite & Earn', (ctx) => {
  const user = getUser(ctx);
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${user.id}`;
  const text =
    `👥 Invite & Earn\n\n` +
    `Share your link. When someone joins and makes their first deposit, you earn ${REFERRAL_BONUS} birr in bonus credit.\n\n` +
    `🏆 Bonus milestones:\n` +
    `• Invite ${REFERRAL_MILESTONE_COUNT} -> +${REFERRAL_MILESTONE_BONUS} birr\n\n` +
    `📊 Invited: ${user.invitedCount} • Earned: ${money(user.earnedAmount)} birr\n\n` +
    `🔗 Your link (tap to copy):\n${link}`;

  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🎱 Join me on ዘመን ቢንጎ!')}`;
  ctx.reply(text, Markup.inlineKeyboard([Markup.button.url('📲 Share your link', shareUrl)]));
});

/* ---------------------------- 📞 Support ---------------------------- */
bot.hears('📞 Support', (ctx) => {
  ctx.reply(`📞 support\n\n1. Support: ${SUPPORT_USERNAME}\n2. channel: ${CHANNEL_URL}`);
});

/* ---------------------------- 📖 Instructions ---------------------------- */
bot.hears('📖 Instructions', (ctx) => {
  ctx.reply(
    '📖 የጨዋታ መመሪያ (How to Play)\n\n' +
    '1️⃣ ካርቴላ ይምረጡ\n' +
    'ከ1 እስከ 300 ካርቴላዎች ውስጥ የፈለጉትን ቁጥር ይምረጡ። እያንዳንዱ ካርቴላ የራሱ የሆነ ልዩ ቁጥሮች አለው።\n\n' +
    '2️⃣ ቁጥር መጥራት\n' +
    'ጨዋታው ሲጀምር ከ1 እስከ 75 ያሉ ቁጥሮች በዘፈቀደ ይጠራሉ። በካርቴላዎ ላይ የተጠራው ቁጥር ካለ ራሱ በራሱ ምልክት ይደረግበታል።\n\n' +
    '3️⃣ አሸናፊ ንድፎች (Winning Patterns)\n' +
    '• አግድም መስመር (ማንኛውም ረድፍ ሙሉ ሲሆን)\n' +
    '• ቋሚ መስመር (ማንኛውም አምድ ሙሉ ሲሆን)\n' +
    '• ሰያፍ መስመር (ዲያግናል ሙሉ ሲሆን)\n' +
    '• አራት ማዕዘናት (Four Corners) ሙሉ ሲሆኑ\n\n' +
    '4️⃣ "BINGO" ይጫኑ\n' +
    'ካርቴላዎ ላይ ካሉት ንድፎች አንዱ ሲሟላ በፍጥነት "BINGO" የሚለውን ቁልፍ ይጫኑ። ትክክለኛ ከሆነ አሸናፊ ይሆናሉ።\n\n' +
    '5️⃣ የሽልማት ክፍፍል (Prize Split)\n' +
    'ከተሰበሰበው ጠቅላላ ገንዘብ 30% ለመድረክ ኮሚሽን ይቀነሳል፤ ቀሪው 70% በዚያው ዙር ትክክለኛ "BINGO" በደወሉ ተጫዋቾች መካከል በእኩል ይከፈላል። ከአንድ በላይ አሸናፊ ካለ ገንዘቡ በእኩል ይካፈላሉ።\n\n' +
    '🎡 Spin & Win (የቀን ጉርሻ)\n' +
    'በየቀኑ አንድ ጊዜ Spin & Win በመጫወት ነጻ ጉርሻ ብር የማሸነፍ እድል አለዎት። ለመሽከርከር ቢያንስ አንድ ጊዜ ገንዘብ ማስገባት ወይም ንቁ ተጫዋች መሆን ያስፈልጋል፤ በቀን አንድ ሽክርክሪት ብቻ ይፈቀዳል።'
  );
});

/* =========================================================================
   TEXT INPUT ROUTER - handles the multi-step deposit / withdraw flows above
========================================================================= */
bot.on('text', async (ctx, next) => {
  const session = getSession(ctx.from.id);
  if (!session) return next(); // not in a flow - let other handlers (hears) take it

  const text = ctx.message.text.trim();
  const user = getUser(ctx);

  switch (session.step) {
    case 'await_deposit_amount': {
      const amount = parseInt(text, 10);
      if (!Number.isInteger(amount) || amount < MIN_DEPOSIT) {
        return ctx.reply(`እባክዎ ትክክለኛ መጠን ያስገቡ (ቢያንስ ${MIN_DEPOSIT} ብር)። ለምሳሌ 50`);
      }
      setSession(ctx.from.id, 'await_deposit_txn', { amount });
      return ctx.reply(
        `ወደ ሚከተለው ቁጥር ${amount} ብር ይላኩ፡\n\n` +
        `📱 Telebirr Agent: ${TELEBIRR_NUMBER}\n` +
        `🏦 CBE Birr: ${TELEBIRR_NUMBER}\n` +
        `🏦 CBE Account: ${TELEBIRR_NUMBER}\n\n` +
        'ከከፈሉ በኋላ የግብይት መለያ (Transaction ID) ይላኩ።',
        Markup.inlineKeyboard([Markup.button.callback('❌ Cancel', 'cancel_flow')])
      );
    }

    case 'await_deposit_txn': {
      if (!text) return ctx.reply('እባክዎ የግብይት መለያ (Transaction ID) ይላኩ።');
      setSession(ctx.from.id, 'await_deposit_screenshot', { amount: session.data.amount, txnId: text });
      return ctx.reply(
        '📸 አሁን የኤስኤምኤስ ማረጋገጫ screenshot ፎቶ ይላኩ (send the SMS confirmation screenshot as a photo).',
        Markup.inlineKeyboard([Markup.button.callback('❌ Cancel', 'cancel_flow')])
      );
    }

    case 'await_withdraw_amount': {
      const amount = parseInt(text, 10);
      if (!Number.isInteger(amount) || amount < MIN_WITHDRAW) {
        return ctx.reply(`እባክዎ ትክክለኛ መጠን ያስገቡ (ቢያንስ ${MIN_WITHDRAW} ብር)። ለምሳሌ 100`);
      }
      if (amount > user.balance_main) {
        return ctx.reply(`በቂ ሂሳብ የለዎትም። የሚገኝ ገንዘብ: ${money(user.balance_main)} ብር። ቦነስ ገንዘብ ሊወጣ አይችልም።`);
      }
      setSession(ctx.from.id, 'await_withdraw_account', { amount });
      return ctx.reply(
        'የሚከፈልበትን አካውንት/ስልክ ቁጥር ይላኩ (Telebirr/CBE phone or account number).',
        Markup.inlineKeyboard([Markup.button.callback('❌ Cancel', 'cancel_flow')])
      );
    }

    case 'await_withdraw_account': {
      if (!text) return ctx.reply('እባክዎ አካውንት/ስልክ ቁጥር ይላኩ።');
      const amount = session.data.amount;

      // Hold the funds immediately so the balance can't be double-spent while pending.
      user.balance_main -= amount;
      const id = withdrawCounter++;
      pendingWithdrawals.set(id, { id, telegram_id: user.id, username: user.username, amount, account: text, status: 'pending' });
      clearSession(ctx.from.id);

      if (ADMIN_CHAT_ID) {
        bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🟡 NEW WITHDRAWAL #${id}\nUser: @${user.username} (${user.id})\nAmount: ${amount} Birr\nAccount: ${text}`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve', `wd_approve:${id}`), Markup.button.callback('❌ Reject', `wd_reject:${id}`)]
          ])
        );
      }
      return ctx.reply('✅ ጥያቄዎ ተልኳል! አድሚን እስኪያረጋግጥ ይጠብቁ። (Request sent! Waiting for admin approval.)');
    }

    default:
      return next();
  }
});

/* Photo handler - only the last deposit step (SMS screenshot) needs this. */
bot.on('photo', async (ctx, next) => {
  const session = getSession(ctx.from.id);
  if (!session || session.step !== 'await_deposit_screenshot') return next();

  const user = getUser(ctx);
  const { amount, txnId } = session.data;
  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // highest resolution
  const id = depositCounter++;

  pendingDeposits.set(id, {
    id, telegram_id: user.id, username: user.username, amount, txnId,
    fileId: photo.file_id, status: 'pending'
  });
  clearSession(ctx.from.id);

  if (ADMIN_CHAT_ID) {
    bot.telegram.sendPhoto(ADMIN_CHAT_ID, photo.file_id, {
      caption: `🟢 NEW DEPOSIT #${id}\nUser: @${user.username} (${user.id})\nAmount: ${amount} Birr\nTxn ID: ${txnId}`,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve', `dep_approve:${id}`), Markup.button.callback('❌ Reject', `dep_reject:${id}`)]
      ])
    });
  }
  ctx.reply('✅ ጥያቄዎ ተልኳል! አድሚን እስኪያረጋግጥ ይጠብቁ። (Request sent! Waiting for admin approval.)');
});

/* ---------------------------- Cancel button ---------------------------- */
bot.action('cancel_flow', (ctx) => {
  clearSession(ctx.from.id);
  ctx.answerCbQuery();
  ctx.reply('ተሰርዟል::');
});

/* =========================================================================
   ADMIN APPROVAL CALLBACKS
========================================================================= */
function isAdmin(ctx) {
  return ADMIN_CHAT_ID && String(ctx.chat.id) === String(ADMIN_CHAT_ID);
}

bot.action(/dep_(approve|reject):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  const action = ctx.match[1];
  const id = Number(ctx.match[2]);
  const deposit = pendingDeposits.get(id);
  if (!deposit || deposit.status !== 'pending') return ctx.answerCbQuery('Already resolved or not found.');

  const user = users.get(deposit.telegram_id);

  if (action === 'approve') {
    deposit.status = 'approved';
    user.balance_main += deposit.amount;
    user.hasDeposited = true;

    // Referral bonus: pay the referrer once, on the referee's first approved deposit.
    if (user.referredBy && !user.referralBonusGiven) {
      user.referralBonusGiven = true;
      const referrer = users.get(user.referredBy);
      if (referrer) {
        referrer.balance_bonus += REFERRAL_BONUS;
        referrer.invitedCount += 1;
        referrer.earnedAmount += REFERRAL_BONUS;
        bot.telegram.sendMessage(referrer.id, `🎉 @${user.username} joined using your link and made their first deposit! You earned ${REFERRAL_BONUS} birr bonus.`).catch(() => {});

        if (referrer.invitedCount >= REFERRAL_MILESTONE_COUNT && !referrer.milestoneAwarded) {
          referrer.milestoneAwarded = true;
          referrer.balance_bonus += REFERRAL_MILESTONE_BONUS;
          referrer.earnedAmount += REFERRAL_MILESTONE_BONUS;
          bot.telegram.sendMessage(referrer.id, `🏆 Milestone reached! You invited ${REFERRAL_MILESTONE_COUNT} players and earned an extra ${REFERRAL_MILESTONE_BONUS} birr bonus.`).catch(() => {});
        }
      }
    }

    bot.telegram.sendMessage(deposit.telegram_id, `✅ የ${deposit.amount} ብር ተቀማጭዎ ጸድቋል። አዲስ ቀሪ ሂሳብ: ${money(user.balance_main)} ብር።`).catch(() => {});
  } else {
    deposit.status = 'rejected';
    bot.telegram.sendMessage(deposit.telegram_id, `❌ የ${deposit.amount} ብር ተቀማጭዎ ውድቅ ተደርጓል።`).catch(() => {});
  }

  await ctx.editMessageCaption(`${ctx.callbackQuery.message.caption}\n\n${action === 'approve' ? '✅ APPROVED' : '❌ REJECTED'}`).catch(() => {});
  ctx.answerCbQuery('Done.');
});

bot.action(/wd_(approve|reject):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  const action = ctx.match[1];
  const id = Number(ctx.match[2]);
  const withdrawal = pendingWithdrawals.get(id);
  if (!withdrawal || withdrawal.status !== 'pending') return ctx.answerCbQuery('Already resolved or not found.');

  const user = users.get(withdrawal.telegram_id);

  if (action === 'approve') {
    withdrawal.status = 'approved';
    bot.telegram.sendMessage(withdrawal.telegram_id, `✅ የ${withdrawal.amount} ብር ወጪ ጥያቄዎ ጸድቋል። ገንዘቡ በቅርቡ ይላክልዎታል።`).catch(() => {});
  } else {
    withdrawal.status = 'rejected';
    if (user) user.balance_main += withdrawal.amount; // refund the held amount
    bot.telegram.sendMessage(withdrawal.telegram_id, `❌ የ${withdrawal.amount} ብር ወጪ ጥያቄዎ ውድቅ ተደርጓል እና ገንዘቡ ተመላሽ ሆኗል።`).catch(() => {});
  }

  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n${action === 'approve' ? '✅ APPROVED - pay the user manually' : '❌ REJECTED'}`).catch(() => {});
  ctx.answerCbQuery('Done.');
});

/* ---------------------------- Launch ---------------------------- */
bot.telegram.getMe().then((me) => {
  BOT_USERNAME = me.username;
  console.log(`Bot @${BOT_USERNAME} identity loaded.`);
});

bot.launch().then(() => console.log('ዘመን ቢንጎ bot is running (polling).'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

/* =========================================================================
   POSTGRES SCHEMA OUTLINE (for production - replace the in-memory Maps above)
========================================================================= */
/*
CREATE TABLE users (
  telegram_id       TEXT PRIMARY KEY,
  username          TEXT,
  balance_main      INTEGER NOT NULL DEFAULT 0,   -- withdrawable
  balance_bonus     INTEGER NOT NULL DEFAULT 0,   -- non-withdrawable
  has_deposited     BOOLEAN NOT NULL DEFAULT FALSE,
  referred_by       TEXT REFERENCES users(telegram_id),
  referral_bonus_given BOOLEAN NOT NULL DEFAULT FALSE,
  invited_count     INTEGER NOT NULL DEFAULT 0,
  earned_amount     INTEGER NOT NULL DEFAULT 0,
  milestone_awarded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deposits (
  id                SERIAL PRIMARY KEY,
  telegram_id       TEXT NOT NULL REFERENCES users(telegram_id),
  amount            INTEGER NOT NULL,
  txn_id            TEXT NOT NULL,
  screenshot_file_id TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ
);

CREATE TABLE withdrawals (
  id                SERIAL PRIMARY KEY,
  telegram_id       TEXT NOT NULL REFERENCES users(telegram_id),
  amount            INTEGER NOT NULL,
  account_info      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ
);

-- MongoDB equivalent: three collections (users, deposits, withdrawals) with the same
-- fields; use telegram_id as the users._id and ObjectId refs for deposits/withdrawals.
*/
