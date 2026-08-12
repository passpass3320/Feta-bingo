<!DOCTYPE html>
<html lang="am">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ዘመን ቢንጎ</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root { --bg: #1c1c1e; --card: #2c2c2e; --accent: #0a84ff; --text: #ffffff; --subtext: #8e8e93; --success: #30d158; --danger: #ff453a; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 16px; padding-bottom: 80px; }
    .header { text-align: center; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 24px; color: var(--accent); }
    .balance-card { background: var(--card); padding: 16px; border-radius: 12px; text-align: center; margin-bottom: 20px; }
    .balance-card .amount { font-size: 28px; font-weight: bold; color: var(--success); }
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab { flex: 1; padding: 12px; background: var(--card); border: none; color: var(--text); border-radius: 8px; font-size: 16px; cursor: pointer; }
    .tab.active { background: var(--accent); }
    .view { display: none; }
    .view.active { display: block; }
    .btn { width: 100%; padding: 14px; background: var(--accent); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 10px; }
    .btn.danger { background: var(--danger); }
    .btn.success { background: var(--success); }
    .btn:disabled { background: var(--subtext); cursor: not-allowed; }
    .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin: 15px 0; }
    .grid-item { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; background: var(--card); border-radius: 8px; font-weight: bold; font-size: 18px; }
    .grid-item.called { background: var(--accent); color: white; }
    .grid-item.marked { background: var(--success); color: white; }
    .grid-item.free { background: #ff9f0a; color: black; }
    .status { text-align: center; padding: 10px; background: var(--card); border-radius: 8px; margin-bottom: 15px; font-size: 14px; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 100; align-items: center; justify-content: center; }
    .modal.active { display: flex; }
    .modal-content { background: var(--card); padding: 20px; border-radius: 12px; width: 90%; max-width: 400px; }
    .modal-content h3 { margin-top: 0; }
    .input-group { margin-bottom: 15px; }
    .input-group label { display: block; margin-bottom: 5px; color: var(--subtext); font-size: 14px; }
    .input-group input, .input-group select { width: 100%; padding: 10px; background: var(--bg); border: 1px solid #444; border-radius: 8px; color: var(--text); font-size: 16px; box-sizing: border-box; }
    .cartella-select { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 15px 0; }
    .cartella-btn { padding: 10px; background: var(--card); border: 2px solid transparent; border-radius: 8px; color: var(--text); font-weight: bold; cursor: pointer; text-align: center; }
    .cartella-btn.taken { background: #444; color: #888; cursor: not-allowed; text-decoration: line-through; }
    .cartella-btn.selected { border-color: var(--accent); background: rgba(10, 132, 255, 0.2); }
    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--danger); color: white; padding: 12px 24px; border-radius: 8px; display: none; z-index: 200; }
  </style>
</head>
<body>

  <div class="header">
    <h1>🎲 ዘመን ቢንጎ</h1>
    <p id="userGreeting">እንኳን ደህና መጡ!</p>
  </div>

  <div class="balance-card">
    <div>ጠቅላላ ባለንስ</div>
    <div class="amount" id="totalBalance">0</div>
    <div style="font-size: 12px; color: var(--subtext);">ብር</div>
  </div>

  <div class="tabs">
    <button class="tab active" onclick="switchView('wallet')">💰 ባለንስ</button>
    <button class="tab" onclick="switchView('game')">🎮 ጨዋታ</button>
  </div>

  <!-- WALLET VIEW -->
  <div id="walletView" class="view active">
    <button class="btn" onclick="openModal('depositModal')">➕ ገንዘብ መቀመጥ (Deposit)</button>
    <button class="btn danger" onclick="openModal('withdrawModal')">➖ ገንዘብ ማውጣት (Withdraw)</button>
    
    <div style="margin-top: 20px; background: var(--card); padding: 15px; border-radius: 12px;">
      <h3 style="margin-top:0;">🎁 የጥቆማ ስርዓት (Referral)</h3>
      <p style="color: var(--subtext); font-size: 14px;">ጓደኛዎን ይጋብዙ፣ እያንዳንዱ ሲቀላቀል <b>50 ብር</b> ያግኙ!</p>
      <div style="background: var(--bg); padding: 10px; border-radius: 8px; word-break: break-all; font-size: 14px;" id="refLink">ሊንክዎን ለማግኘት ይጫኑ...</div>
      <button class="btn" style="margin-top:10px;" onclick="copyRefLink()">📋 ሊንኩን ቅዳ</button>
    </div>
  </div>

  <!-- GAME VIEW -->
  <div id="gameView" class="view">
    <div class="status" id="gameStatus">ጨዋታውን ለመጀመር ክፍል (Room) ይቀላቀሉ...</div>
    
    <div id="lobbySection">
      <h3>ካርድ ይምረጡ (10 ብር)</h3>
      <div class="cartella-select" id="cartellaGrid"></div>
      <button class="btn success" id="joinGameBtn" onclick="joinGame()" disabled>ጨዋታውን ቀላቀል</button>
    </div>

    <div id="playingSection" style="display:none;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
        <div>ፖት: <b id="potAmount">0</b> ብር</div>
        <div>ተጫዋቾች: <b id="playerCount">0</b></div>
      </div>
      
      <h4>የወጡ ቁጥሮች</h4>
      <div class="grid" id="calledNumbersGrid"></div>
      
      <h4>የእርስዎ ካርድ</h4>
      <div class="grid" id="myCardGrid"></div>
      
      <button class="btn success" id="bingoBtn" onclick="claimWin()" style="display:none;">🏆 ቢንጎ! አሸነፍኩ!</button>
    </div>
  </div>

  <!-- DEPOSIT MODAL -->
  <div id="depositModal" class="modal">
    <div class="modal-content">
      <h3>ገንዘብ መቀመጥ</h3>
      <div class="input-group">
        <label>መጠን (ቢያንስ 50 ብር)</label>
        <input type="number" id="depAmount" placeholder="100">
      </div>
      <div class="input-group">
        <label>የክፍያ ዘዴ</label>
        <select id="depMethod">
          <option value="CBE">CBE (Commercial Bank)</option>
          <option value="Telebirr">Telebirr</option>
          <option value="Awash">Awash Bank</option>
        </select>
      </div>
      <div class="input-group">
        <label>የትራንዛክሽን ID (Txn ID)</label>
        <input type="text" id="depTxn" placeholder="1234567

<</think>ሰላም! ስለ `bot.js` ለመጠየቅዎ እናመሰግናለን። እንዲሁም ባለፈው መልዕክት `server.js` መጨረሻ ላይ ተቋርጦ ነበር፣ እና `public/index.html` ላይ አልገባም ነበር። እነዚህን ሁሉ አሁን ሙሉ በሙሉ እየሰጠሁ ነው።

### ስለ `bot.js` ማብራሪያ
**ለምን `bot.js` ለብትሉ ፋይል አልሰጠሁም?** 
የቴሌግራም ቦት (Telegram Bot) ኮድ በቀጥታ በ `server.js` ውስጥ ተካትቷል። ሁለት የተለያዩ ፋይሎች (`server.js` እና `bot.js`) ቢኖሩ፣ የመረጃ ቋት (Database) ላይ ግጭት ይፈጥራል፣ እንዲሁም የቀጥታ ጨዋታ (Socket.io) መረጃዎችን በትክክል ማመሳሰል አይቻልም። ስለዚህ **`bot.js` ለየብትሉ አያስፈልግም**፤ የቦቱ ሎጂክ፣ የዌብ ሰርቨሩ እና የጨዋታው ሞተር ሁሉም በ `server.js` ውስጥ አንድ ላይ ይሰራሉ።

ከታች የቀረውን የ `server.js` መጨረሻ ክፍል እና ሙሉ የሆነውን `public/index.html` ይውሰዱ።

---

### 4. `server.js` (የቀረው መጨረሻ ክፍል)
*ማሳሰቢያ፡ ይህን ከቀድሞው የ `server.js` መጨረሻ (`socket.on('joinRoom'` የሚለው ቦታ) ጀምሮ ይጨምሩት ወይም ሙሉውን ከዚህ በታች ያለውን ኮድ ይተኩት።*

```javascript
// ... (ያለፈው የ server.js ኮድ እዚህ ይቀጥላል) ...

io.on('connection', (socket) => {
  socket.on('joinRoom', (data) => {
    const { roomId, telegram_id, username } = data;
    if (!roomId || !telegram_id) return;
    getOrCreateUser(telegram_id, username);
    socket.join(roomId);
    socket.data.telegram_id = telegram_id;
    socket.data.roomId = roomId;
    
    const room = gameRooms[roomId] || createRoom(roomId);
    socket.emit('roomState', { calledNumbers: room.calledNumbers, playerCount: getPlayerCount(roomId) + room.bots.length });
    socket.emit('cartellaState', { taken: room.takenCartellas, bots: room.bots });
    socket.emit('callingState', { active: !!room.intervalId });
    socket.emit('potUpdate', { pot: room.pot, players: getPlayerCount(roomId) + room.bots.length });
    
    ensureBots(roomId);
    if (getPlayerCount(roomId) + room.bots.length >= MIN_PLAYERS_FOR_ROUND && !room.intervalId) {
      startCallingLoop(roomId);
    }
  });

  socket.on('claimCartella', (data) => {
    const { roomId, cartellaId } = data;
    const telegram_id = socket.data.telegram_id;
    if (!roomId || !cartellaId || !telegram_id) return;
    
    const room = gameRooms[roomId] || createRoom(roomId);
    if (room.takenCartellas[cartellaId]) return socket.emit('error', { msg: 'ይህ ካርድ ተይዟል!' });
    if (room.playerCartellas[telegram_id]) return socket.emit('error', { msg: 'ቀድሞውኑ ካርድ ይዘዋል!' });
    
    const walletTotal = getWalletTotal(telegram_id);
    if (walletTotal < STAKE) return socket.emit('error', { msg: 'በቂ ባለንስ የለም!' });
    
    deductStake(telegram_id, STAKE);
    room.takenCartellas[cartellaId] = telegram_id;
    room.playerCartellas[telegram_id] = cartellaId;
    room.playerStakes[telegram_id] = (room.playerStakes[telegram_id] || 0) + STAKE;
    room.pot += STAKE;
    
    io.to(roomId).emit('cartellaState', { taken: room.takenCartellas, bots: room.bots });
    io.to(roomId).emit('potUpdate', { pot: room.pot, players: getPlayerCount(roomId) + room.bots.length });
    socket.emit('myCartella', { cartellaId, card: generateCartella(cartellaId) });
    
    if (getPlayerCount(roomId) + room.bots.length >= MIN_PLAYERS_FOR_ROUND && !room.intervalId) {
      startCallingLoop(roomId);
    }
  });

  socket.on('claimWin', (data) => {
    const { roomId } = data;
    const telegram_id = socket.data.telegram_id;
