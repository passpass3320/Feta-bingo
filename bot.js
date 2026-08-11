const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();

// 1. Verify environment variables
if (!process.env.BOT_TOKEN) {
  console.error('❌ Error: BOT_TOKEN is missing in .env file!');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// 2. Main Menu Keyboard Definition
const getMainMenu = (appUrl) => {
  return Markup.inlineKeyboard([
    [Markup.button.webApp('🎮 ጨዋታውን ጀምር (Play Bingo)', appUrl)],
    [
      Markup.button.url('📢 ቻናል (Channel)', 'https://t.me/your_channel'),
      Markup.button.url('💬 ድጋፍ (Support)', 'https://t.me/your_support')
    ]
  ]);
};

// 3. Command: /start
bot.start(async (ctx) => {
  try {
    const appUrl = process.env.APP_URL || 'https://feta-bingo-production.up.railway.app';
    const userName = ctx.from.first_name || 'ተጫዋች';

    const welcomeMessage = 
      `ሰላም *${userName}* 👋\n` +
      `እንኳን ወደ *ዘመን ቢንጎ* በደህና መጡ!\n\n` +
      `🎯 *ለመጫወት የሚከተሉትን ደረጃዎች ይከተሉ:*\n` +
      `1. ከታች ያለውን *Play Bingo* ቁልፍ ይጫኑ\n` +
      `2. የካርቴላ መጠንዎን ይምረጡ\n` +
      `3. ጨዋታውን አሁኑኑ ይጀምሩ!`;

    await ctx.replyWithMarkdown(welcomeMessage, getMainMenu(appUrl));
  } catch (error) {
    console.error('❌ Error handling /start command:', error);
  }
});

// 4. Command: /help
bot.help((ctx) => {
  ctx.replyWithMarkdown(
    `*እርዳታና መመሪያ* ℹ️\n\n` +
    `• ጨዋታ ለመጀመር ከታች ያለውን Mini App ይክፈቱ።\n` +
    `• የተቀማጭ ገንዘብ (Deposit) እና የማውጣት (Withdraw) ጥያቄዎችን በ Mini App ውስጥ ማከናወን ይችላሉ።\n` +
    `• ለተጨማሪ ጥያቄዎች አስተዳዳሪውን ያናግሩ።`
  );
});

// 5. Error Handling Middleware
bot.catch((err, ctx) => {
  console.error(`❌ Bot Error for ${ctx.updateType}:`, err);
});

// 6. Launch Bot
bot.launch()
  .then(() => console.log('🤖 Telegram Bot started successfully!'))
  .catch((err) => console.error('❌ Failed to start Telegram Bot:', err));

// 7. Enable Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

