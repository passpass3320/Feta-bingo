const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// Telegram /start command
bot.start((ctx) => {
  const appUrl = process.env.APP_URL;

  ctx.replyWithMarkdown(
    `*እንኳን ወደ ዘመን ቢንጎ በደህና መጡ!* 🎲\n\nለመጫወት ከታች ያለውን *Play Bingo* ቁልፍ ይጫኑ።`,
    Markup.inlineKeyboard([
      [Markup.button.webApp('🎮 Play Bingo', appUrl)]
    ])
  );
});

bot.launch().then(() => console.log('🤖 Telegram Bot Running!'));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

