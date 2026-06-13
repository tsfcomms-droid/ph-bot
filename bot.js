const https = require('https');
const fs    = require('fs');

const TOKEN      = '8723109846:AAGgik2d-BW3pkFnIxArFG6rIYnN_XNWSYY';
const ADMIN_ID   = 7031425680;
const CHANNEL_ID = -1002289726091;

// ── Firestore REST (for referral tracking) ────────────────────────────────────
const FB_KEY  = 'AIzaSyBPHV_-_y8cmITx_Ye3psmODNXt3z9p1yc';
const FS_BASE = 'firestore.googleapis.com';
const FS_PATH = '/v1/projects/premium-hoodies/databases/(default)/documents';

function fsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: FS_BASE,
      path:     `${FS_PATH}/${path}?key=${FB_KEY}`,
      method,
      headers:  { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fsVal(v) {
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'string') return { stringValue: v };
  return { stringValue: String(v) };
}

async function fsGet(col, doc) {
  return fsRequest('GET', `${col}/${doc}`, null);
}

async function fsPatch(col, doc, fields) {
  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) firestoreFields[k] = fsVal(v);
  const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ fields: firestoreFields });
    const req  = https.request({
      hostname: FS_BASE,
      path:     `${FS_PATH}/${col}/${doc}?${updateMask}&key=${FB_KEY}`,
      method:   'PATCH',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function recordReferral(handle, newChatId, name, username) {
  try {
    // Check if this user was already referred
    const joinDoc = await fsGet('referral_joins', String(newChatId));
    if (joinDoc.fields) return null; // already counted

    // Get referrer info
    const refDoc = await fsGet('referrers', handle);
    if (!refDoc.fields) return null; // handle doesn't exist

    const referrerChatId = parseInt(refDoc.fields.chatId?.integerValue || 0);
    const currentRefs    = parseInt(refDoc.fields.totalRefs?.integerValue || 0);

    // Record the join
    await fsPatch('referral_joins', String(newChatId), {
      referrerHandle: handle,
      newUserChatId:  newChatId,
      newUserName:    name || '',
      joinedAt:       String(Date.now())
    });

    // Increment referrer count
    await fsPatch('referrers', handle, { totalRefs: currentRefs + 1 });

    return referrerChatId;
  } catch(e) {
    console.error('Referral error:', e.message);
    return null;
  }
}

const USERS_FILE      = './users.json';
const BROADCASTS_FILE = './broadcasts.json';
const CONFIG_FILE     = './config.json';
const REPORTS_FILE    = './reports.json';

let offset = 0;
const pending = new Map(); // chatId → { action, ...data }

// ── Default config ────────────────────────────────────────────────────────────

const DEFAULTS = {
  welcomeMessage: `🧥 *Welcome to Premium Hoodies*\n\nThe most trusted vendor directory on Telegram.\n\n✅ 18+ verified vendors\n🌍 Worldwide network\n🔒 Escrow protected\n💰 Earn with Premium Pays\n\nChoose an option below 👇`,
  closedMessage:  `🔒 We're currently closed. Check back soon!`,
  shopOpen:       true,
  autoReply:      true,
  notifications:  true,
  links: {
    shopUrl:   'https://premiumhoodies.io/mini-app',
    escrow:    'https://t.me/+a-9vZgKXXIg5M2U0',
    getPaid:   'https://t.me/+78SyhmdNqvFmYmM0',
    getListed: 'https://t.me/tim_identity',
    contact:   'https://t.me/tim_identity',
    website:   'https://premiumhoodies.io'
  },
  admins:    [],
  whitelist: []
};

// ── Persistence ───────────────────────────────────────────────────────────────

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function loadConfig() {
  const saved = loadJSON(CONFIG_FILE, {});
  return { ...DEFAULTS, ...saved, links: { ...DEFAULTS.links, ...(saved.links || {}) } };
}
function saveConfig(cfg) { saveJSON(CONFIG_FILE, cfg); }

function isAdmin(chatId) {
  const cfg = loadConfig();
  return chatId === ADMIN_ID || cfg.admins.includes(chatId);
}

function trackUser(chatId, name, username) {
  const users    = loadJSON(USERS_FILE, []);
  const existing = users.find(u => u.chatId === chatId);
  if (!existing) {
    users.push({ chatId, name: name || 'Unknown', username: username || '', joinedAt: Date.now() });
    saveJSON(USERS_FILE, users);
    logReport('newUser');
    // Persist to Firestore (non-blocking)
    fsPatch('bot_users', String(chatId), {
      chatId, name: name || 'Unknown', username: username || '', joinedAt: Date.now()
    }).catch(() => {});
  } else {
    existing.name     = name     || existing.name;
    existing.username = username || existing.username;
    saveJSON(USERS_FILE, users);
    // Keep Firestore in sync
    fsPatch('bot_users', String(chatId), {
      name: existing.name, username: existing.username
    }).catch(() => {});
  }
}

async function recoverUsersFromFirestore() {
  try {
    console.log('🔄 users.json missing — recovering from Firestore...');
    let pageToken = '';
    const recovered = [];
    do {
      const url = `${FS_PATH}/bot_users?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}&key=${FB_KEY}`;
      const res = await new Promise((resolve, reject) => {
        const req = https.request({ hostname: FS_BASE, path: url, method: 'GET' }, r => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        req.on('error', reject); req.end();
      });
      if (res.documents) {
        for (const doc of res.documents) {
          const f = doc.fields || {};
          recovered.push({
            chatId:   parseInt(f.chatId?.integerValue   || 0),
            name:     f.name?.stringValue                || 'Unknown',
            username: f.username?.stringValue            || '',
            joinedAt: parseInt(f.joinedAt?.integerValue || 0)
          });
        }
      }
      pageToken = res.nextPageToken || '';
    } while (pageToken);

    if (recovered.length) {
      saveJSON(USERS_FILE, recovered);
      console.log(`✅ Recovered ${recovered.length} users from Firestore`);
    } else {
      console.log('ℹ️ No users found in Firestore yet');
    }
  } catch(e) {
    console.error('⚠️ Could not recover users from Firestore:', e.message);
  }
}

function logReport(type) {
  const today   = new Date().toISOString().slice(0, 10);
  const reports = loadJSON(REPORTS_FILE, []);
  let day       = reports.find(r => r.date === today);
  if (!day) { day = { date: today, messages: 0, newUsers: 0 }; reports.push(day); }
  if (type === 'message') day.messages++;
  if (type === 'newUser') day.newUsers++;
  saveJSON(REPORTS_FILE, reports);
}

// ── Telegram API ──────────────────────────────────────────────────────────────

function api(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (!parsed.ok) console.error(`❌ API [${method}]:`, parsed.description);
          resolve(parsed);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Keyboards ─────────────────────────────────────────────────────────────────

function userKeyboard(cfg) {
  return {
    inline_keyboard: [
      [{ text: '🏪 Vendor Portal', web_app: { url: cfg.links.shopUrl } }],
      [{ text: '🔒 Escrow Service', url: cfg.links.escrow }, { text: '💰 Get Paid', url: cfg.links.getPaid }],
      [{ text: '📋 Get Listed', url: cfg.links.getListed }, { text: '📩 Contact Us', url: cfg.links.contact }],
      [{ text: '🌐 Website', url: cfg.links.website }]
    ]
  };
}

function backBtn(to = 'adm:menu') {
  return [{ text: '← Back', callback_data: to }];
}

function adminMainKb(cfg) {
  return {
    inline_keyboard: [
      [{ text: '📊 Dashboard',            callback_data: 'adm:dash'    }],
      [{ text: '👥 Users List',            callback_data: 'adm:users:0' }],
      [{ text: '📝 Edit Welcome Message',  callback_data: 'adm:edit_welcome' }],
      [{ text: `🔔 Notifications: ${cfg.notifications ? 'ON ✅' : 'OFF ❌'}`, callback_data: 'adm:toggle_notif' }],
      [{ text: '📣 Broadcast',             callback_data: 'adm:broadcast'    }],
      [{ text: '🗑 Delete Last Broadcast', callback_data: 'adm:del_broadcast' }],
      [{ text: '🔗 Edit Links',            callback_data: 'adm:links'   }],
      [{ text: '🆔 Manage IDs',            callback_data: 'adm:ids'     }],
      [{ text: '⚙️ Configuration',         callback_data: 'adm:cfg'     }],
      [{ text: '📈 Reports',               callback_data: 'adm:reports' }]
    ]
  };
}

// ── Admin panel screens ───────────────────────────────────────────────────────

async function showAdminMenu(chatId, msgId = null) {
  const cfg    = loadConfig();
  const users  = loadJSON(USERS_FILE, []);
  const bcast  = loadJSON(BROADCASTS_FILE, []);
  const text   = `🛠 *Admin Panel — Premium Hoodies*\n\n👥 Users: *${users.length}*  |  📣 Broadcasts: *${bcast.length}*\n🏪 Shop: *${cfg.shopOpen ? 'Open ✅' : 'Closed 🔒'}*  |  🤖 Auto-reply: *${cfg.autoReply ? 'ON' : 'OFF'}*`;
  const params = { chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: adminMainKb(cfg) };
  if (msgId) await api('editMessageText', { ...params, message_id: msgId });
  else       await api('sendMessage', params);
}

async function showDashboard(chatId, msgId) {
  const users   = loadJSON(USERS_FILE, []);
  const bcast   = loadJSON(BROADCASTS_FILE, []);
  const reports = loadJSON(REPORTS_FILE, []);
  const cfg     = loadConfig();
  const today   = new Date().toISOString().slice(0, 10);
  const todayR  = reports.find(r => r.date === today) || { messages: 0, newUsers: 0 };
  const last7   = reports.slice(-7);
  const wMsgs   = last7.reduce((s, r) => s + r.messages, 0);
  const wNew    = last7.reduce((s, r) => s + r.newUsers, 0);

  const text = `📊 *Dashboard*\n\n` +
    `👥 Total users: *${users.length}*\n` +
    `📩 Messages today: *${todayR.messages}*\n` +
    `🆕 New users today: *${todayR.newUsers}*\n` +
    `📅 This week: *${wMsgs}* msgs · *${wNew}* new users\n\n` +
    `🏪 Shop: *${cfg.shopOpen ? 'Open' : 'Closed'}*\n` +
    `🤖 Auto-reply: *${cfg.autoReply ? 'ON' : 'OFF'}*\n` +
    `🔔 Notifications: *${cfg.notifications ? 'ON' : 'OFF'}*\n` +
    `📣 Broadcasts sent: *${bcast.length}*`;

  await api('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backBtn()] } });
}

async function showUsersList(chatId, msgId, page) {
  const users   = loadJSON(USERS_FILE, []);
  const perPage = 10;
  const pages   = Math.max(1, Math.ceil(users.length / perPage));
  const slice   = users.slice(page * perPage, page * perPage + perPage);

  let text = `👥 *Users List* (${users.length} total) — Page ${page + 1}/${pages}\n\n`;
  if (!slice.length) { text += '_No users yet._'; }
  else slice.forEach((u, i) => {
    const d = new Date(u.joinedAt).toLocaleDateString('en-GB');
    text += `${page * perPage + i + 1}. *${u.name}*${u.username ? ' @' + u.username : ''} — ${d}\n`;
  });

  const nav = [];
  if (page > 0)           nav.push({ text: '← Prev', callback_data: `adm:users:${page - 1}` });
  if (page + 1 < pages)   nav.push({ text: 'Next →', callback_data: `adm:users:${page + 1}` });

  const kb = { inline_keyboard: [] };
  if (nav.length) kb.inline_keyboard.push(nav);
  kb.inline_keyboard.push(backBtn());

  await api('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown', reply_markup: kb });
}

async function showLinks(chatId, msgId) {
  const l    = loadConfig().links;
  const text = `🔗 *Edit Links*\n\n` +
    `🏪 Shop: \`${l.shopUrl}\`\n` +
    `🔒 Escrow: \`${l.escrow}\`\n` +
    `💰 Get Paid: \`${l.getPaid}\`\n` +
    `📋 Get Listed: \`${l.getListed}\`\n` +
    `📩 Contact: \`${l.contact}\`\n` +
    `🌐 Website: \`${l.website}\``;

  await api('editMessageText', {
    chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🏪 Shop URL',   callback_data: 'adm:link:shopUrl'   }],
      [{ text: '🔒 Escrow',     callback_data: 'adm:link:escrow'    }],
      [{ text: '💰 Get Paid',   callback_data: 'adm:link:getPaid'   }],
      [{ text: '📋 Get Listed', callback_data: 'adm:link:getListed' }],
      [{ text: '📩 Contact',    callback_data: 'adm:link:contact'   }],
      [{ text: '🌐 Website',    callback_data: 'adm:link:website'   }],
      backBtn()
    ]}
  });
}

async function showConfig(chatId, msgId) {
  const cfg = loadConfig();
  await api('editMessageText', {
    chat_id: chatId, message_id: msgId, text: '⚙️ *Configuration*', parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: `🏪 Shop: ${cfg.shopOpen ? 'Open ✅' : 'Closed 🔒'}`,     callback_data: 'adm:cfg:shop'      }],
      [{ text: `🤖 Auto-reply: ${cfg.autoReply ? 'ON ✅' : 'OFF ❌'}`,   callback_data: 'adm:cfg:autoreply' }],
      [{ text: '📝 Edit Closed Message', callback_data: 'adm:cfg:closed_msg' }],
      backBtn()
    ]}
  });
}

async function showIDs(chatId, msgId) {
  const cfg    = loadConfig();
  const admins = [ADMIN_ID, ...cfg.admins].filter(Boolean);
  const text   = `🆔 *Manage IDs*\n\n*Admins:*\n${admins.map(id => `• \`${id}\``).join('\n') || '_None_'}\n\n*Whitelist:*\n${cfg.whitelist.length ? cfg.whitelist.map(id => `• \`${id}\``).join('\n') : '_Empty — all users allowed_'}`;
  await api('editMessageText', {
    chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '➕ Add Admin',         callback_data: 'adm:ids:add_admin' }],
      [{ text: '➖ Remove Admin',      callback_data: 'adm:ids:rm_admin'  }],
      [{ text: '➕ Add to Whitelist',  callback_data: 'adm:ids:add_wl'    }],
      [{ text: '➖ Remove Whitelist',  callback_data: 'adm:ids:rm_wl'     }],
      backBtn()
    ]}
  });
}

async function showReports(chatId, msgId) {
  const reports = loadJSON(REPORTS_FILE, []);
  const last7   = reports.slice(-7).reverse();
  let text = `📈 *Activity — Last 7 Days*\n\n`;
  if (!last7.length) text += '_No data yet._';
  else last7.forEach(r => { text += `📅 \`${r.date}\` — ${r.messages} msgs, ${r.newUsers} new users\n`; });
  await api('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backBtn()] } });
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

async function sendBroadcast(text) {
  const users = loadJSON(USERS_FILE, []);
  const sent  = [];
  for (const u of users) {
    try {
      const res = await api('sendMessage', { chat_id: u.chatId, text, parse_mode: 'Markdown' });
      if (res.ok) sent.push({ chatId: u.chatId, messageId: res.result.message_id });
    } catch(e) { /* blocked or deleted */ }
  }
  const broadcasts = loadJSON(BROADCASTS_FILE, []);
  broadcasts.push({ timestamp: Date.now(), text, messages: sent });
  saveJSON(BROADCASTS_FILE, broadcasts);
  return sent.length;
}

async function deleteLastBroadcast() {
  const broadcasts = loadJSON(BROADCASTS_FILE, []);
  if (!broadcasts.length) return null;
  const last    = broadcasts[broadcasts.length - 1];
  let   deleted = 0;
  for (const { chatId, messageId } of last.messages) {
    try { const res = await api('deleteMessage', { chat_id: chatId, message_id: messageId }); if (res.ok) deleted++; }
    catch(e) { /* already gone */ }
  }
  broadcasts.pop();
  saveJSON(BROADCASTS_FILE, broadcasts);
  return deleted;
}

// ── Callback query handler ────────────────────────────────────────────────────

async function handleCallback(cb) {
  await api('answerCallbackQuery', { callback_query_id: cb.id });

  const chatId = cb.from?.id;
  const msgId  = cb.message?.message_id;
  const data   = cb.data;

  if (!chatId || !msgId) return;
  if (!isAdmin(chatId)) return;

  // Navigation
  if (data === 'adm:menu')    return showAdminMenu(chatId, msgId);
  if (data === 'adm:dash')    return showDashboard(chatId, msgId);
  if (data === 'adm:links')   return showLinks(chatId, msgId);
  if (data === 'adm:cfg')     return showConfig(chatId, msgId);
  if (data === 'adm:ids')     return showIDs(chatId, msgId);
  if (data === 'adm:reports') return showReports(chatId, msgId);

  if (data.startsWith('adm:users:')) {
    return showUsersList(chatId, msgId, parseInt(data.split(':')[2]) || 0);
  }

  // Edit welcome message
  if (data === 'adm:edit_welcome') {
    pending.set(chatId, { action: 'edit_welcome', msgId });
    return api('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text: '📝 *Edit Welcome Message*\n\nSend the new welcome message now.\n_Markdown formatting supported._',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backBtn()] }
    });
  }

  // Toggle notifications
  if (data === 'adm:toggle_notif') {
    const cfg = loadConfig(); cfg.notifications = !cfg.notifications; saveConfig(cfg);
    return showAdminMenu(chatId, msgId);
  }

  // Broadcast
  if (data === 'adm:broadcast') {
    const users = loadJSON(USERS_FILE, []);
    pending.set(chatId, { action: 'broadcast', msgId });
    return api('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text: `📣 *Broadcast*\n\nSend your message now.\nWill be delivered to *${users.length} users*.\n\n_Markdown formatting supported._`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backBtn()] }
    });
  }

  if (data === 'adm:broadcast:confirm') {
    const p = pending.get(chatId);
    if (!p || p.action !== 'broadcast_confirm') {
      return api('editMessageText', { chat_id: chatId, message_id: msgId, text: '⚠️ Session expired. Try again.', reply_markup: { inline_keyboard: [backBtn()] } });
    }
    pending.delete(chatId);
    await api('editMessageText', { chat_id: chatId, message_id: msgId, text: '📤 Sending broadcast...', reply_markup: { inline_keyboard: [] } });
    const count = await sendBroadcast(p.text);
    return api('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text: `✅ Broadcast sent to *${count}* users.`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backBtn()] }
    });
  }

  if (data === 'adm:broadcast:cancel') {
    pending.delete(chatId);
    return showAdminMenu(chatId, msgId);
  }

  // Delete last broadcast
  if (data === 'adm:del_broadcast') {
    const broadcasts = loadJSON(BROADCASTS_FILE, []);
    if (!broadcasts.length) {
      return api('editMessageText', { chat_id: chatId, message_id: msgId, text: '⚠️ No broadcasts to delete.', reply_markup: { inline_keyboard: [backBtn()] } });
    }
    const last = broadcasts[broadcasts.length - 1];
    const prev = last.text.length > 80 ? last.text.slice(0, 80) + '…' : last.text;
    return api('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text: `🗑 *Delete Last Broadcast?*\n\n"${prev}"\n\nSent to *${last.messages.length}* users.`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Yes, delete it', callback_data: 'adm:del_broadcast:confirm' }],
        [{ text: '❌ Cancel',         callback_data: 'adm:menu' }]
      ]}
    });
  }

  if (data === 'adm:del_broadcast:confirm') {
    const count = await deleteLastBroadcast();
    return api('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text: `✅ Deleted from *${count ?? 0}* chats.`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backBtn()] }
    });
  }

  // Config toggles
  if (data === 'adm:cfg:shop') {
    const cfg = loadConfig(); cfg.shopOpen = !cfg.shopOpen; saveConfig(cfg);
    return showConfig(chatId, msgId);
  }
  if (data === 'adm:cfg:autoreply') {
    const cfg = loadConfig(); cfg.autoReply = !cfg.autoReply; saveConfig(cfg);
    return showConfig(chatId, msgId);
  }
  if (data === 'adm:cfg:closed_msg') {
    pending.set(chatId, { action: 'edit_closed', msgId });
    const cfg = loadConfig();
    return api('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text: `📝 *Edit Closed Message*\n\nCurrent:\n"${cfg.closedMessage}"\n\nSend the new message:`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backBtn('adm:cfg')] }
    });
  }

  // Link editing
  if (data.startsWith('adm:link:')) {
    const key    = data.split(':')[2];
    const labels = { shopUrl: 'Shop URL', escrow: 'Escrow', getPaid: 'Get Paid', getListed: 'Get Listed', contact: 'Contact', website: 'Website' };
    const cfg    = loadConfig();
    pending.set(chatId, { action: 'edit_link', key, msgId });
    return api('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text: `🔗 *Edit ${labels[key] || key}*\n\nCurrent:\n\`${cfg.links[key]}\`\n\nSend the new URL:`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backBtn('adm:links')] }
    });
  }

  // ID management
  const idActions = {
    'adm:ids:add_admin': { action: 'add_admin', text: '➕ Send the Telegram user ID to add as *admin*:' },
    'adm:ids:rm_admin':  { action: 'rm_admin',  text: '➖ Send the Telegram user ID to *remove* from admins:' },
    'adm:ids:add_wl':    { action: 'add_wl',    text: '➕ Send the Telegram user ID to add to *whitelist*:' },
    'adm:ids:rm_wl':     { action: 'rm_wl',     text: '➖ Send the Telegram user ID to *remove* from whitelist:' }
  };
  if (idActions[data]) {
    pending.set(chatId, { action: idActions[data].action, msgId });
    return api('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text: idActions[data].text,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backBtn('adm:ids')] }
    });
  }
}

// ── Pending text input handler ────────────────────────────────────────────────

async function handlePending(chatId, text, p) {
  pending.delete(chatId);
  const cfg = loadConfig();

  if (p.action === 'edit_welcome') {
    cfg.welcomeMessage = text; saveConfig(cfg);
    return api('editMessageText', { chat_id: chatId, message_id: p.msgId, text: '✅ Welcome message updated!', reply_markup: { inline_keyboard: [backBtn()] } });
  }

  if (p.action === 'edit_closed') {
    cfg.closedMessage = text; saveConfig(cfg);
    return api('editMessageText', { chat_id: chatId, message_id: p.msgId, text: '✅ Closed message updated!', reply_markup: { inline_keyboard: [backBtn('adm:cfg')] } });
  }

  if (p.action === 'edit_link') {
    cfg.links[p.key] = text; saveConfig(cfg);
    return api('editMessageText', {
      chat_id: chatId, message_id: p.msgId,
      text: `✅ Link updated!\n\`${text}\``,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backBtn('adm:links')] }
    });
  }

  if (p.action === 'broadcast') {
    const users = loadJSON(USERS_FILE, []);
    pending.set(chatId, { action: 'broadcast_confirm', text, msgId: p.msgId });
    return api('editMessageText', {
      chat_id: chatId, message_id: p.msgId,
      text: `📣 *Preview:*\n\n${text}\n\n──────────\nSend to *${users.length}* users?`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Send now', callback_data: 'adm:broadcast:confirm' }],
        [{ text: '❌ Cancel',   callback_data: 'adm:broadcast:cancel'  }]
      ]}
    });
  }

  if (p.action === 'add_admin') {
    const id = parseInt(text);
    if (isNaN(id)) return api('sendMessage', { chat_id: chatId, text: '⚠️ Invalid ID — must be a number.' });
    if (!cfg.admins.includes(id)) { cfg.admins.push(id); saveConfig(cfg); }
    return api('editMessageText', { chat_id: chatId, message_id: p.msgId, text: `✅ \`${id}\` added as admin.`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backBtn('adm:ids')] } });
  }

  if (p.action === 'rm_admin') {
    const id = parseInt(text);
    cfg.admins = cfg.admins.filter(a => a !== id); saveConfig(cfg);
    return api('editMessageText', { chat_id: chatId, message_id: p.msgId, text: `✅ \`${id}\` removed from admins.`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backBtn('adm:ids')] } });
  }

  if (p.action === 'add_wl') {
    const id = parseInt(text);
    if (isNaN(id)) return api('sendMessage', { chat_id: chatId, text: '⚠️ Invalid ID — must be a number.' });
    if (!cfg.whitelist.includes(id)) { cfg.whitelist.push(id); saveConfig(cfg); }
    return api('editMessageText', { chat_id: chatId, message_id: p.msgId, text: `✅ \`${id}\` added to whitelist.`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backBtn('adm:ids')] } });
  }

  if (p.action === 'rm_wl') {
    const id = parseInt(text);
    cfg.whitelist = cfg.whitelist.filter(w => w !== id); saveConfig(cfg);
    return api('editMessageText', { chat_id: chatId, message_id: p.msgId, text: `✅ \`${id}\` removed from whitelist.`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backBtn('adm:ids')] } });
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const text   = msg.text || '';
  const chatId = msg.chat.id;
  const name   = msg.from?.first_name || 'friend';
  const uname  = msg.from?.username   || '';
  const admin  = isAdmin(chatId);
  const cfg    = loadConfig();

  trackUser(chatId, name, uname);
  logReport('message');

  // Pending admin input
  if (admin && pending.has(chatId)) {
    return handlePending(chatId, text, pending.get(chatId));
  }

  // /myid — available to everyone
  if (text === '/myid') {
    return api('sendMessage', { chat_id: chatId, text: `Your Telegram ID: \`${chatId}\``, parse_mode: 'Markdown' });
  }

  // /admin — open panel
  if (admin && text === '/admin') {
    return showAdminMenu(chatId);
  }

  // /start getlink_HANDLE — generate unique channel invite link for referrer
  if (text.startsWith('/start getlink_')) {
    const handle = text.slice('/start getlink_'.length).trim();
    await sendReferralLink(chatId, handle);
    return;
  }

  // /start or /menu
  if (text === '/start' || text.startsWith('/start') || text === '/menu') {
    if (!cfg.shopOpen) {
      return api('sendMessage', { chat_id: chatId, text: cfg.closedMessage, parse_mode: 'Markdown' });
    }
    return api('sendMessage', { chat_id: chatId, text: cfg.welcomeMessage, parse_mode: 'Markdown', reply_markup: userKeyboard(cfg) });
  }

  // Auto-reply for everything else
  if (cfg.autoReply) {
    await api('sendMessage', { chat_id: chatId, text: `Hey ${name}! Use the menu below to navigate 👇`, reply_markup: userKeyboard(cfg) });
  }
}

// ── Referral link generation ──────────────────────────────────────────────────

async function sendReferralLink(chatId, handle) {
  try {
    const refDoc = await fsGet('referrers', handle);
    if (!refDoc.fields) {
      return api('sendMessage', { chat_id: chatId, text: '❌ Handle not found. Claim it first in the Earn tab.' });
    }
    const storedChatId = parseInt(refDoc.fields.chatId?.integerValue || 0);
    if (storedChatId !== chatId) {
      return api('sendMessage', { chat_id: chatId, text: '❌ That handle belongs to someone else.' });
    }

    // Already generated — just resend it
    if (refDoc.fields.inviteLink?.stringValue) {
      return api('sendMessage', {
        chat_id: chatId,
        text: `🔗 *Your referral link:*\n\n${refDoc.fields.inviteLink.stringValue}\n\nShare this link\\. Every person who joins the channel counts as 1 referral\\.`,
        parse_mode: 'MarkdownV2'
      });
    }

    // Create a unique invite link named after the handle so we can identify it on join
    const res = await api('createChatInviteLink', {
      chat_id: CHANNEL_ID,
      name:    handle,
      creates_join_request: true
    });

    if (!res.ok) {
      console.error('createChatInviteLink failed:', res);
      return api('sendMessage', { chat_id: chatId, text: '❌ Could not generate link. Make sure the bot is admin in the channel.' });
    }

    const inviteLink = res.result.invite_link;
    await fsPatch('referrers', handle, { inviteLink });

    return api('sendMessage', {
      chat_id: chatId,
      text: `🔗 *Your referral link:*\n\n${inviteLink}\n\nShare this link\\. Every person who joins the channel counts as 1 referral\\.`,
      parse_mode: 'MarkdownV2'
    });
  } catch(e) {
    console.error('sendReferralLink error:', e.message);
    return api('sendMessage', { chat_id: chatId, text: '❌ Error generating link. Try again.' });
  }
}

// ── Channel join tracking ─────────────────────────────────────────────────────

async function handleChatMember(cm) {
  if (cm.chat?.id !== CHANNEL_ID) return;
  if (cm.new_chat_member?.status !== 'member') return;

  const inviteLink = cm.invite_link;
  if (!inviteLink) return;

  const handle = inviteLink.name; // we set name = handle when creating
  if (!handle) return;

  const newUser   = cm.new_chat_member.user;
  const newId     = newUser?.id;
  const newName   = newUser?.first_name || 'Someone';
  const newUname  = newUser?.username   || '';

  const referrerChatId = await recordReferral(handle, newId, newName, newUname);
  if (referrerChatId && referrerChatId !== newId) {
    await api('sendMessage', {
      chat_id: referrerChatId,
      text: `🎉 Someone joined the channel via your link!\n\n👤 ${newName}${newUname ? ' (@' + newUname + ')' : ''}\n\nCheck your stats in the Earn tab.`
    });
  }
}

// ── Post Queue ────────────────────────────────────────────────────────────────

let lastQueueCheck = 0;

async function processPostQueue() {
  const now = Date.now();
  if (now - lastQueueCheck < 15000) return; // check every 15s
  lastQueueCheck = now;
  try {
    const url = `${FS_PATH}/post_queue?key=${FB_KEY}`;
    const res = await fsGet(url);
    if (!res.documents) return;
    for (const doc of res.documents) {
      const f = doc.fields || {};
      if (f.status?.stringValue !== 'pending') continue;
      const docId = doc.name.split('/').pop();
      // vendorData stored as a Firestore map — extract fields
      const vf = f.vendorData?.mapValue?.fields || {};
      const readStr = x => x?.stringValue || '';
      const readArr = x => (x?.arrayValue?.values || []).map(v => {
        const mf = v.mapValue?.fields || {};
        return { type: readStr(mf.type), label: readStr(mf.label), val: readStr(mf.val) };
      });
      const d = { name: readStr(vf.name), loc: readStr(vf.loc), svc: readStr(vf.svc), lang: readStr(vf.lang), logoURL: readStr(vf.logoURL), contact: readArr(vf.contact) };

      const typeIcons = { telegram:'📱', signal:'🔒', simplex:'💬', threema:'🛡', xmpp:'⚙️', link:'🔗', email:'📧' };
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const contacts = (d.contact || []).map(c => `${typeIcons[c.type]||'•'} ${esc(c.label)}: ${esc(c.val)}`).join('\n');
      const text = `🏪 <b>${esc(d.name)}</b>\n📍 ${esc(d.loc)}\n🛍 ${esc(d.svc)}${d.lang ? ' · ' + esc(d.lang) : ''}\n\n${contacts ? '📬 <b>Contacts:</b>\n' + contacts + '\n\n' : ''}🔎 Find more vendors @premiumhoodiesbot`;

      const postFileId = readStr(vf.postFileId);
      const r = postFileId
        ? await api('sendPhoto',   { chat_id: CHANNEL_ID, photo: postFileId, caption: text, parse_mode: 'HTML' })
        : await api('sendMessage', { chat_id: CHANNEL_ID, text, parse_mode: 'HTML' });

      if (r.ok) {
        await fsPatch('post_queue', docId, { status: 'sent' });
        console.log(`✅ Posted vendor card: ${d.name}`);
      } else {
        await fsPatch('post_queue', docId, { status: 'failed', error: r.description || 'unknown' });
        console.error(`❌ Channel post failed: ${r.description}`);
      }
    }
  } catch(e) {}
}

async function fsGet(url) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: FS_BASE, path: url.replace('https://' + FS_BASE, ''), method: 'GET' };
    const req = https.request(opts, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await api('getUpdates', { offset, timeout: 30, limit: 100, allowed_updates: ['message', 'callback_query', 'chat_member'] });
    if (res.ok && res.result.length) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        try {
          if (update.callback_query) {
            console.log('🔘 Button pressed:', update.callback_query.data, '| from:', update.callback_query.from?.id);
            await handleCallback(update.callback_query);
          } else if (update.chat_member) {
            await handleChatMember(update.chat_member);
          } else if (update.message) {
            await handleMessage(update.message);
          }
        } catch(e) {
          console.error('❌ Update error:', e.message, e.stack);
        }
      }
    }
  } catch(e) {
    console.error('Poll error:', e.message);
  }
  processPostQueue();
  setTimeout(poll, 1000);
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  // Recover users from Firestore if local file is missing or empty
  const localUsers = loadJSON(USERS_FILE, []);
  if (!localUsers.length) await recoverUsersFromFirestore();

  await api('deleteWebhook', { drop_pending_updates: true });
  console.log('✅ Webhook cleared');
  const me = await api('getMe', {});
  console.log(`✅ Bot started: @${me.result.username}`);

  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Open Premium Hoodies' },
      { command: 'menu',  description: 'Show menu' },
      { command: 'myid',  description: 'Get your Telegram ID' }
    ]
  });

  await api('setChatMenuButton', {
    menu_button: { type: 'web_app', text: '🏪 Vendor Portal', web_app: { url: loadConfig().links.shopUrl } }
  });

  console.log('✅ Ready');
  poll();
}

start();
