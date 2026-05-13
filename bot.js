const https = require('https');

const TOKEN = '8723109846:AAGgik2d-BW3pkFnIxArFG6rIYnN_XNWSYY';
const API = `https://api.telegram.org/bot${TOKEN}`;

let offset = 0;

const WELCOME = `🧥 *Welcome to Premium Hoodies*

The most trusted vendor directory on Telegram.

✅ 18+ verified vendors
🌍 Worldwide network
🔒 Escrow protected
💰 Earn with Premium Pays

Choose an option below 👇`;

const KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🏪 Vendor Portal', web_app: { url: 'https://premiumhoodies.io/mini-app' } }
    ],
    [
      { text: '🔒 Escrow Service', url: 'https://t.me/+a-9vZgKXXIg5M2U0' },
      { text: '💰 Get Paid', url: 'https://t.me/+78SyhmdNqvFmYmM0' }
    ],
    [
      { text: '📋 Get Listed', url: 'https://t.me/tim_identity' },
      { text: '📩 Contact Us', url: 'https://t.me/tim_identity' }
    ],
    [
      { text: '🌐 Website', url: 'https://premiumhoodies.io' }
    ]
  ]
};

function api(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendWelcome(chatId) {
  await api('sendMessage', {
    chat_id: chatId,
    text: WELCOME,
    parse_mode: 'Markdown',
    reply_markup: KEYBOARD
  });
}

async function poll() {
  try {
    const res = await api('getUpdates', { offset, timeout: 30, limit: 100 });
    if (!res.ok || !res.result.length) return;

    for (const update of res.result) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg) continue;

      const text = msg.text || '';
      const chatId = msg.chat.id;
      const name = msg.from?.first_name || 'friend';

      if (text === '/start' || text === '/menu') {
        await sendWelcome(chatId);
      } else {
        // Any other message → show menu
        await api('sendMessage', {
          chat_id: chatId,
          text: `Hey ${name}! Use the menu below to navigate 👇`,
          reply_markup: KEYBOARD
        });
      }
    }
  } catch(e) {
    console.error('Poll error:', e.message);
  }
  setTimeout(poll, 1000);
}

async function start() {
  const me = await api('getMe', {});
  console.log(`✅ Bot started: @${me.result.username}`);

  // Set bot commands
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Open Premium Hoodies menu' },
      { command: 'menu', description: 'Show menu' }
    ]
  });

  // Set menu button to open mini-app
  await api('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: '🏪 Vendor Portal',
      web_app: { url: 'https://premiumhoodies.io/mini-app' }
    }
  });

  console.log('✅ Menu button set to Mini App');
  poll();
}

start();
