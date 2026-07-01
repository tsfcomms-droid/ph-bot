const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');

const TOKEN      = '8723109846:AAGgik2d-BW3pkFnIxArFG6rIYnN_XNWSYY';
const ADMIN_ID   = 7031425680;
const CHANNEL_ID = -1002289726091;

const NP_API_KEY   = 'WAAS44Q-JM4M53W-GWWNRAM-WN2Z52W';
const NP_IPN_SECRET = 'mlfbYRDxSdoRQIjpeONfo1AGtlv965/Z';
const PUBLIC_URL   = 'https://ph-bot-production.up.railway.app';

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
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { stringValue: String(v) };
}

async function fsGetDoc(col, doc) {
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

async function fsQuery(structuredQuery) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ structuredQuery });
    const req = https.request({
      hostname: FS_BASE,
      path: `${FS_PATH}:runQuery?key=${FB_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
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
    const joinDoc = await fsGetDoc('referral_joins', String(newChatId));
    if (joinDoc.fields) return null; // already counted

    // Get referrer info
    const refDoc = await fsGetDoc('referrers', handle);
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

  // Membership verification — any user can press this
  if (data.startsWith('verify:')) {
    const userId = parseInt(data.slice(7));
    if (userId !== chatId) return; // can't verify for someone else
    try {
      await fsPatch('channel_verifications', String(userId), { verified: true, verifiedAt: String(Date.now()) });
    } catch(e) {}
    try {
      await api('editMessageText', { chat_id: chatId, message_id: msgId,
        text: `✅ <b>You're verified!</b>\n\nWelcome to Premium Hoodies. Browse verified vendors here 👇`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🛍️ Browse Vendors', url: `https://t.me/premiumhoodiesbot` }]] }
      });
    } catch(e) {}
    return;
  }

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

  // /start vref_DOCID — vendor referral tracking
  if (text.startsWith('/start vref_')) {
    const referrerDocId = text.slice('/start vref_'.length).trim();
    if (referrerDocId) {
      try { await fsPatch('vendor_referral_pending', String(chatId), { referrerDocId, pendingUserId: chatId, createdAt: String(Date.now()) }); } catch(e) {}
      return api('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
        text: `👋 <b>Welcome!</b>\n\nYou were referred to Premium Hoodies.\n\nTap <b>Listed</b> in the menu to apply as a vendor — your referrer gets a bonus when you go live! 🎁`,
        reply_markup: userKeyboard(cfg) });
    }
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
    const refDoc = await fsGetDoc('referrers', handle);
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
        text: `🔗 <b>Your referral link:</b>\n\n${refDoc.fields.inviteLink.stringValue}\n\nShare this link. Every person who joins the channel counts as 1 referral.`,
        parse_mode: 'HTML'
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
      text: `🔗 <b>Your referral link:</b>\n\n${inviteLink}\n\nShare this link. Every person who joins the channel counts as 1 referral.`,
      parse_mode: 'HTML'
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

  const newUser  = cm.new_chat_member.user;
  const newId    = newUser?.id;
  const newName  = newUser?.first_name || 'there';
  const newUname = newUser?.username   || '';

  // Store pending verification
  try {
    await fsPatch('channel_verifications', String(newId), {
      userId: newId, firstName: newName, username: newUname,
      verified: false, createdAt: String(Date.now())
    });
  } catch(e) {}

  // Send verification DM
  try {
    await api('sendMessage', { chat_id: newId, parse_mode: 'HTML',
      text: `👋 <b>Hey ${newName}!</b>\n\nYou just joined <b>Premium Hoodies</b>.\n\nTap the button below to confirm you're a real member. If you don't confirm within 4 hours, you'll be removed from the channel.`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Confirm Membership', callback_data: `verify:${newId}` }]] }
    });
  } catch(e) {}

  // Referral tracking
  const inviteLink = cm.invite_link;
  if (!inviteLink) return;
  const handle = inviteLink.name;
  if (!handle) return;

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

      const typeIcons = { telegram:'📱', signal:'🔒', simplex:'💬', threema:'🛡', xmpp:'⚙️', link:'🔗', email:'📧', whatsapp:'💬', viber:'📞' };
      const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const channels = (vf.channels?.arrayValue?.values || []).slice(0,3).map(v => esc(v.stringValue||''));
      const contacts = (d.contact || []).slice(0,3).map(c => `${typeIcons[c.type]||'•'} ${esc(c.val)}`);
      const parts = [];
      if (channels.length) parts.push('📢 <b>Channels:</b>\n' + channels.join('\n\n'));
      if (contacts.length) parts.push('📬 <b>Contacts:</b>\n' + contacts.join('\n\n'));
      parts.push('🔎 Find more vendors @premiumhoodiesbot');
      const text = parts.join('\n\n');

      // Always fetch fresh postFileId from vendor doc — stored value may be stale/truncated
      let postFileId = readStr(vf.postFileId);
      const vendorId = readStr(f.vendorId);
      if (vendorId) {
        try {
          const vendorDoc = await fsGetDoc('vendors', vendorId);
          const freshId = vendorDoc?.fields?.postFileId?.stringValue;
          if (freshId) postFileId = freshId;
        } catch(e) { /* use stored postFileId as fallback */ }
      }

      let r = postFileId
        ? await api('sendPhoto', { chat_id: CHANNEL_ID, photo: postFileId, caption: text, parse_mode: 'HTML' })
        : await api('sendMessage', { chat_id: CHANNEL_ID, text, parse_mode: 'HTML' });

      // If photo fails, fall back to text-only
      if (!r.ok && postFileId) {
        console.error(`❌ sendPhoto failed (${r.description}), retrying as text`);
        r = await api('sendMessage', { chat_id: CHANNEL_ID, text, parse_mode: 'HTML' });
      }

      if (r.ok) {
        await fsPatch('post_queue', docId, { status: 'sent' });
        console.log(`✅ Posted vendor card: ${d.name}`);
      } else {
        await fsPatch('post_queue', docId, { status: 'failed', error: r.description || 'unknown' });
        console.error(`❌ Channel post failed: ${r.description}`);
      }
    }
  } catch(e) { console.error('processPostQueue error:', e.message); }
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
  processPaymentRequests();
  checkSubscriptionExpiry();
  checkPostCooldownReminders();
  checkBotNotifications();
  checkPendingVerifications();
  setTimeout(poll, 1000);
}

let lastVerifCheck = 0;
async function checkPendingVerifications() {
  const now = Date.now();
  if (now - lastVerifCheck < 60000) return; // check every minute
  lastVerifCheck = now;
  try {
    const rows = await fsQuery({
      from: [{ collectionId: 'channel_verifications' }],
      where: { fieldFilter: { field: { fieldPath: 'verified' }, op: 'EQUAL', value: { booleanValue: false } } }
    });
    for (const row of rows) {
      if (!row.document) continue;
      const f = row.document.fields || {};
      const createdAt = parseInt(f.createdAt?.stringValue || '0');
      if (now - createdAt < 4 * 60 * 60 * 1000) continue; // not expired yet (4 hours)
      const userId = f.userId?.integerValue ? parseInt(f.userId.integerValue) : null;
      if (!userId) continue;
      const docId = row.document.name.split('/').pop();
      try { await api('banChatMember', { chat_id: CHANNEL_ID, user_id: userId }); } catch(e) {}
      try { await api('unbanChatMember', { chat_id: CHANNEL_ID, user_id: userId }); } catch(e) {} // unban so they can rejoin if they want
      try {
        const delUrl = `https://${FS_BASE}${FS_PATH}/channel_verifications/${docId}?key=${FB_KEY}`;
        await new Promise((res, rej) => {
          const req = https.request({ hostname: FS_BASE, path: `${FS_PATH}/channel_verifications/${docId}?key=${FB_KEY}`, method: 'DELETE' }, r => { r.on('data',()=>{}); r.on('end', res); });
          req.on('error', rej); req.end();
        });
      } catch(e) {}
      console.log(`🚫 Kicked unverified user ${userId} from channel`);
    }
  } catch(e) { console.error('checkPendingVerifications error:', e.message); }
}

const _sentNotifIds = new Set();
let lastNotifCheck = 0;
async function checkBotNotifications() {
  const now = Date.now();
  if (now - lastNotifCheck < 15000) return;
  lastNotifCheck = now;
  try {
    const rows = await fsQuery({
      from: [{ collectionId: 'bot_notifications' }],
      where: { fieldFilter: { field: { fieldPath: 'processed' }, op: 'EQUAL', value: { booleanValue: false } } }
    });
    const docs = rows.filter(r => r.document).map(r => r.document);
    for (const doc of docs) {
      const f = doc.fields || {};
      const docId = doc.name.split('/').pop();
      if (_sentNotifIds.has(docId)) continue;
      // Respect sendAfter for scheduled messages
      const sendAfterTs = f.sendAfter?.timestampValue;
      if (sendAfterTs && new Date(sendAfterTs).getTime() > Date.now()) continue;
      _sentNotifIds.add(docId);
      const type = f.type?.stringValue;
      const tgUserId = f.tgUserId?.integerValue || f.tgUserId?.stringValue;
      if (!tgUserId) { await fsPatch('bot_notifications', docId, { processed: true }); continue; }
      if (type === 'new_application') {
        const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const vendorName   = esc(f.vendorName?.stringValue || 'Unknown');
        const vendorLoc    = esc(f.vendorLoc?.stringValue || '—');
        const vendorPlan   = esc(f.vendorPlan?.stringValue || '—');
        const vendorCrypto = esc(f.vendorCrypto?.stringValue || '—');
        const tgHandle     = f.tgUsername?.stringValue ? `@${esc(f.tgUsername.stringValue)}` : esc(f.tgUserId?.integerValue || f.tgUserId?.stringValue || 'Unknown');
        const text = `🆕 <b>New Vendor Application</b>\n\n🏪 <b>${vendorName}</b>\n📍 ${vendorLoc}\n👤 ${tgHandle}\n\n📦 Plan: <b>${vendorPlan}</b>\n💳 Paying with: ${vendorCrypto}\n\n<i>Review in the admin panel and approve or reject.</i>`;
        try { await api('sendMessage', { chat_id: ADMIN_ID, text, parse_mode: 'HTML' }); console.log(`📩 New application from ${vendorName} notified to admin`); }
        catch(e) { console.error(`❌ Failed to notify admin of ${vendorName}:`, e.message); }
      } else if (type === 'payment_link') {
        const vendorName = f.vendorName?.stringValue || 'Vendor';
        const text = `🎉 <b>Your application to Premium Hoodies has been accepted!</b>\n\nHi ${vendorName}, your listing is approved — you just need to activate it with a subscription.\n\n<b>To get started:</b>\n1. Open @premiumhoodiesbot\n2. Tap <b>Listed</b> in the menu\n3. Choose your plan and pay with crypto\n4. Tap "I've Sent Payment" — we'll activate you within 24h 🚀\n\n💳 <b>Plans:</b>\n• 1 Month — €250\n• 3 Months — €650 <i>(Save €100)</i>\n• 6 Months — €1,200 <i>(Save €300)</i>\n\nOnce activated you'll appear in the directory and can post to the channel. 🏪`;
        try { await api('sendMessage', { chat_id: Number(tgUserId), text, parse_mode: 'HTML' }); console.log(`📩 Payment link sent to ${vendorName} (${tgUserId})`); }
        catch(e) { console.error(`❌ Failed to send acceptance to ${vendorName}:`, e.message); }
      } else if (type === 'rejected') {
        const vendorName = f.vendorName?.stringValue || 'there';
        const text = `❌ <b>Application Not Approved</b>\n\nHi ${vendorName}, unfortunately your application to Premium Hoodies was not approved at this time.\n\nYou're welcome to <b>reapply</b> with updated details — open @premiumhoodiesbot and go to the <b>Listed</b> tab to submit a new application. 🔄`;
        try { await api('sendMessage', { chat_id: Number(tgUserId), text, parse_mode: 'HTML' }); console.log(`📩 Rejection sent to ${vendorName} (${tgUserId})`); }
        catch(e) { console.error(`❌ Failed to send rejection to ${vendorName}:`, e.message); }
      } else if (type === 'application_received') {
        const vendorName = f.vendorName?.stringValue || 'there';
        const text = `✅ <b>Application Received!</b>\n\nHi ${vendorName}, we've got your application to join Premium Hoodies! 🎉\n\nOur team will review it within 24–48 hours and you'll get a message here once it's approved.\n\nBrowse the vendor directory in the channel while you wait. 🏪`;
        try { await api('sendMessage', { chat_id: Number(tgUserId), text, parse_mode: 'HTML' }); console.log(`📩 App received sent to ${vendorName}`); }
        catch(e) { console.error(`❌ Failed to send app received:`, e.message); }
      } else if (type === 'welcome_day2') {
        const vendorName = f.vendorName?.stringValue || 'there';
        const text = `📣 <b>Time to Post to the Channel!</b>\n\nHi ${vendorName}! You've been live for 24 hours — now let people know you're here.\n\n<b>How to post:</b>\n1. Open @premiumhoodiesbot\n2. Tap <b>Listed</b>\n3. Scroll to <b>Post to Channel</b>\n4. Tap <b>Preview &amp; Post →</b>\n\nYour vendor card reaches everyone in the channel. You can post once every 7 days. 🚀`;
        try { await api('sendMessage', { chat_id: Number(tgUserId), text, parse_mode: 'HTML' }); console.log(`📩 Day 2 welcome sent to ${vendorName}`); }
        catch(e) { console.error(`❌ Failed to send day 2 welcome:`, e.message); }
      } else if (type === 'welcome_day3') {
        const vendorName = f.vendorName?.stringValue || 'there';
        const text = `💡 <b>Pro Tip — Complete Your Listing</b>\n\nHi ${vendorName}! Make sure your listing is fully set up.\n\n<b>Open @premiumhoodiesbot → Listed → Edit:</b>\n• Add all your channel links\n• Add contact links (Telegram, WhatsApp, Signal...)\n• Your contacts show when people tap your card\n\nThe more info you add, the more customers you get. ✏️`;
        try { await api('sendMessage', { chat_id: Number(tgUserId), text, parse_mode: 'HTML' }); console.log(`📩 Day 3 welcome sent to ${vendorName}`); }
        catch(e) { console.error(`❌ Failed to send day 3 welcome:`, e.message); }
      } else if (type === 'referral_reward') {
        const referrerDocId = f.referrerDocId?.stringValue;
        const referredName = f.referredVendorName?.stringValue || 'a vendor';
        const bonusDays = parseInt(f.bonusDays?.integerValue || 14);
        if (referrerDocId) {
          try {
            const refVendor = await fsGetDoc('vendors', referrerDocId);
            if (refVendor.fields) {
              const refTgId = refVendor.fields.tgUserId?.integerValue || refVendor.fields.tgUserId?.stringValue;
              const expTs = refVendor.fields.subscriptionExpiry?.timestampValue;
              const currentExp = expTs ? new Date(expTs).getTime() : Date.now();
              const base = currentExp > Date.now() ? currentExp : Date.now();
              await fsPatch('vendors', referrerDocId, { subscriptionExpiry: new Date(base + bonusDays * 86400000), warningSentD7: false, warningSentD3: false });
              if (refTgId) {
                await api('sendMessage', { chat_id: parseInt(refTgId), parse_mode: 'HTML',
                  text: `🎁 <b>Referral Bonus!</b>\n\n${referredName} just went live as a Premium Hoodies vendor — thanks to your referral!\n\nWe've added <b>${bonusDays} days</b> to your subscription. 🙌` });
              }
            }
          } catch(e) { console.error(`❌ Failed to process referral reward:`, e.message); }
        }
      } else if (type === 'subscription_activated') {
        const vendorName = f.vendorName?.stringValue || 'there';
        const months = parseInt(f.months?.integerValue || f.months?.doubleValue || 0) || '?';
        const expiryDate = f.expiryDate?.stringValue || '';
        const text = `✅ <b>Your Subscription is Now Active!</b>\n\nHi ${vendorName}, your listing on Premium Hoodies is <b>live</b>! 🎉\n\n📦 Plan: <b>${months} month${months > 1 ? 's' : ''}</b>${expiryDate ? `\n📅 Active until: <b>${expiryDate}</b>` : ''}\n\nYou can now:\n• Appear in the vendor directory\n• Post to the channel every 7 days\n\nOpen @premiumhoodiesbot → <b>Listed</b> to manage your listing. 🏪`;
        try { await api('sendMessage', { chat_id: Number(tgUserId), text, parse_mode: 'HTML' }); console.log(`📩 Activation confirmed to ${vendorName} (${tgUserId})`); }
        catch(e) { console.error(`❌ Failed to send activation to ${vendorName}:`, e.message); }
      }
      await fsPatch('bot_notifications', docId, { processed: true });
    }
  } catch(e) { console.error('checkBotNotifications error:', e.message); }
}

let lastExpiryCheck = 0;
async function checkSubscriptionExpiry() {
  const now = Date.now();
  if (now - lastExpiryCheck < 60 * 60 * 1000) return; // check every hour
  lastExpiryCheck = now;
  try {
    const res = await fsGet(`${FS_PATH}/vendors?key=${FB_KEY}`);
    if (!res.documents) return;
    for (const doc of res.documents) {
      const f = doc.fields || {};
      const tgUserId = f.tgUserId?.integerValue || f.tgUserId?.stringValue;
      if (!tgUserId) continue;
      const expiryRaw = f.subscriptionExpiry?.timestampValue || f.subscriptionExpiry?.integerValue || f.subscriptionExpiry?.stringValue;
      if (!expiryRaw) continue;
      const expiry = typeof expiryRaw === 'number' ? expiryRaw : new Date(expiryRaw).getTime();
      const daysLeft = Math.ceil((expiry - now) / 86400000);
      if (daysLeft <= 0 || daysLeft > 7) continue;
      const docId = doc.name.split('/').pop();
      const vendorName = f.name?.stringValue || 'Your listing';
      const expiryDate = new Date(expiryRaw).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
      const sentD7 = f.warningSentD7?.booleanValue;
      const sentD3 = f.warningSentD3?.booleanValue;
      if (daysLeft <= 7 && daysLeft > 3 && !sentD7) {
        await api('sendMessage', { chat_id: parseInt(tgUserId), parse_mode: 'HTML',
          text: `⏰ <b>Subscription Expiring in ${daysLeft} Days</b>\n\n🏪 ${vendorName} expires on <b>${expiryDate}</b>.\n\nRenew now to stay listed 👇\nOpen @premiumhoodiesbot → Listed tab` });
        await fsPatch('vendors', docId, { warningSentD7: true });
        console.log(`⏰ 7-day warning sent to ${vendorName}`);
      } else if (daysLeft <= 3 && !sentD3) {
        await api('sendMessage', { chat_id: parseInt(tgUserId), parse_mode: 'HTML',
          text: `🚨 <b>Subscription Expiring in ${daysLeft} Day${daysLeft!==1?'s':''}!</b>\n\n🏪 ${vendorName} expires on <b>${expiryDate}</b>. Act now to avoid being removed 👇\nOpen @premiumhoodiesbot → Listed tab` });
        await fsPatch('vendors', docId, { warningSentD3: true });
        console.log(`🚨 3-day warning sent to ${vendorName}`);
      }
    }
  } catch(e) { console.error('Expiry check error:', e.message); }
}

let lastCooldownCheck = 0;
async function checkPostCooldownReminders() {
  const now = Date.now();
  if (now - lastCooldownCheck < 60 * 60 * 1000) return; // check every hour
  lastCooldownCheck = now;
  const COOLDOWN = 7 * 24 * 60 * 60 * 1000;
  try {
    const res = await fsGet(`${FS_PATH}/vendors?key=${FB_KEY}`);
    if (!res.documents) return;
    for (const doc of res.documents) {
      const f = doc.fields || {};
      const tgUserId = f.tgUserId?.integerValue || f.tgUserId?.stringValue;
      if (!tgUserId) continue;
      const lastPostedRaw = f.lastPostedAt?.timestampValue;
      if (!lastPostedRaw) continue;
      const lastPosted = new Date(lastPostedRaw).getTime();
      if (now - lastPosted < COOLDOWN) continue; // still on cooldown
      const reminderSentFor = f.postReminderSentFor?.timestampValue;
      if (reminderSentFor && new Date(reminderSentFor).getTime() === lastPosted) continue; // already reminded for this cycle
      const docId = doc.name.split('/').pop();
      const vendorName = f.name?.stringValue || 'You';
      await api('sendMessage', { chat_id: parseInt(tgUserId), parse_mode: 'HTML',
        text: `📣 <b>You Can Post Again!</b>\n\n🏪 ${vendorName} — your 1-week cooldown is over.\nPost your vendor card to the Premium Hoodies channel now 👇\n\nOpen @premiumhoodiesbot → Listed tab` });
      await fsPatch('vendors', docId, { postReminderSentFor: lastPostedRaw });
      console.log(`📣 Post reminder sent to ${vendorName}`);
    }
  } catch(e) { console.error('Cooldown reminder error:', e.message); }
}

let lastPaymentCheck = 0;
const _sentPaymentReqIds = new Set();
async function processPaymentRequests() {
  const now = Date.now();
  if (now - lastPaymentCheck < 30000) return; // check every 30s
  lastPaymentCheck = now;
  try {
    const rows = await fsQuery({
      from: [{ collectionId: 'payment_requests' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } } },
            { fieldFilter: { field: { fieldPath: 'notified' }, op: 'EQUAL', value: { booleanValue: false } } }
          ]
        }
      }
    });
    const docs = rows.filter(r => r.document).map(r => r.document);
    for (const doc of docs) {
      const f = doc.fields || {};
      const docId = doc.name.split('/').pop();
      if (_sentPaymentReqIds.has(docId)) continue;
      _sentPaymentReqIds.add(docId);
      const vendorName = f.vendorName?.stringValue || 'Unknown';
      const plan       = f.plan?.stringValue || '?';
      const price      = f.price?.integerValue || f.price?.doubleValue || '?';
      const crypto     = f.crypto?.stringValue || '?';
      const cryptoLabels = { USDT_TRON:'USDT (TRX)', USDT_ETH:'USDT (ETH)', BTC:'Bitcoin', ETH:'Ethereum', SOL:'Solana' };
      const cryptoLabel = cryptoLabels[crypto] || crypto;
      const text = `💳 <b>New Payment Request</b>\n\n🏪 <b>${vendorName}</b>\n📦 Plan: ${plan}\n💶 Amount: €${price}\n💱 Via: ${cryptoLabel}\n\n<i>Activate in the admin panel once payment is confirmed.</i>`;
      try { await api('sendMessage', { chat_id: ADMIN_ID, text, parse_mode: 'HTML' }); console.log(`💳 Payment request notification sent: ${vendorName} – ${plan}`); }
      catch(e) { console.error(`❌ Failed to send payment request notification:`, e.message); }
      await fsPatch('payment_requests', docId, { notified: true });
    }
  } catch(e) { console.error('processPaymentRequests error:', e.message); }
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

// ── NOWPayments ───────────────────────────────────────────────────────────────

function npRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.nowpayments.io',
      path: `/v1${path}`,
      method,
      headers: {
        'x-api-key': NP_API_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
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

async function createNPInvoice(vendorId, vendorName, months, priceUsd) {
  return npRequest('POST', '/invoice', {
    price_amount: priceUsd,
    price_currency: 'usd',
    order_id: `ph_${vendorId}_${months}mo_${Date.now()}`,
    order_description: `Premium Hoodies — ${vendorName} — ${months} month${months > 1 ? 's' : ''}`,
    ipn_callback_url: `${PUBLIC_URL}/nowpayments-webhook`,
    success_url: 'https://t.me/premiumhoodiesbot',
    cancel_url: 'https://t.me/premiumhoodiesbot',
    is_fixed_rate: false,
    is_fee_paid_by_user: false
  });
}

async function handleNPWebhook(body, signature) {
  // Verify signature
  const hmac = crypto.createHmac('sha512', NP_IPN_SECRET)
    .update(JSON.stringify(JSON.parse(JSON.stringify(body), (k, v) => v), Object.keys(body).sort()))
    .digest('hex');
  if (hmac !== signature) {
    console.error('NP webhook: invalid signature');
    return false;
  }

  const { payment_status, order_id } = body;
  console.log(`NP webhook: ${order_id} → ${payment_status}`);

  if (payment_status !== 'finished' && payment_status !== 'confirmed') return true;

  // order_id format: ph_VENDORID_Xmo_TIMESTAMP
  const match = order_id.match(/^ph_(.+)_(\d+)mo_\d+$/);
  if (!match) return true;
  const vendorId = match[1];
  const months   = parseInt(match[2]);

  try {
    const vendorSnap = await fsGetDoc('vendors', vendorId);
    const vendorData = vendorSnap.fields || {};
    const vendorName = vendorData.name?.stringValue || vendorId;
    const now = Date.now();
    const existing = vendorData.subscriptionExpiry;
    const rawExpiry = existing?.timestampValue ? new Date(existing.timestampValue).getTime() : null;
    const base = rawExpiry && rawExpiry > now ? rawExpiry : now;
    const newExpiry = base + months * 30 * 24 * 60 * 60 * 1000;

    await fsPatch('vendors', vendorId, {
      subscriptionExpiry: new Date(newExpiry),
      warningSentD7: false,
      warningSentD3: false,
    });

    const expiryDate = new Date(newExpiry).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

    // Notify vendor via bot
    const tgUserId = parseInt(vendorData.tgUserId?.integerValue || vendorData.tgUserId?.stringValue || 0);
    if (tgUserId) {
      const now3 = Date.now();
      try {
        await fsPatch('bot_notifications', `np_${vendorId}_${now3}`, { type: 'subscription_activated', tgUserId, vendorName, months, expiryDate, processed: false, createdAt: String(now3) });
        await fsPatch('bot_notifications', `np_d2_${vendorId}_${now3}`, { type: 'welcome_day2', tgUserId, vendorName, processed: false, sendAfter: String(now3 + 86400000), createdAt: String(now3) });
        await fsPatch('bot_notifications', `np_d3_${vendorId}_${now3}`, { type: 'welcome_day3', tgUserId, vendorName, processed: false, sendAfter: String(now3 + 172800000), createdAt: String(now3) });
        if (vendorData.referredBy?.stringValue) {
          await fsPatch('bot_notifications', `np_ref_${vendorId}_${now3}`, { type: 'referral_reward', referrerDocId: vendorData.referredBy.stringValue, referredVendorName: vendorName, bonusDays: 14, processed: false, createdAt: String(now3) });
        }
      } catch(ne) { console.error('NP notify error:', ne.message); }
    }

    // Notify admin
    try {
      await api('sendMessage', { chat_id: ADMIN_ID, text: `💰 Payment confirmed!\n\n${vendorName} paid for ${months} month${months > 1 ? 's' : ''}.\nSubscription active until ${expiryDate}.` });
    } catch(e) {}

    console.log(`✅ Subscription activated: ${vendorName} (${vendorId}) +${months} months`);
  } catch(e) {
    console.error('NP webhook activation error:', e.message);
  }
  return true;
}

// ── Daily Channel Post (8 PM UTC) ────────────────────────────────────────────
const DAILY_ADS = [
  'https://d8j0ntlcm91z4.cloudfront.net/user_3DtfzDNQcdHAxCu2vu9Vs4uR21C/hf_20260625_114226_85e903c0-52df-4516-a687-c0684fff5ec8.png',
  'https://d8j0ntlcm91z4.cloudfront.net/user_3DtfzDNQcdHAxCu2vu9Vs4uR21C/hf_20260624_164325_098bc028-46b8-4e9a-bf9e-f818756e2881.png',
  'https://d8j0ntlcm91z4.cloudfront.net/user_3DtfzDNQcdHAxCu2vu9Vs4uR21C/hf_20260623_130514_ba436f42-a9b2-4918-9761-dd345a29602d.png',
  'https://d8j0ntlcm91z4.cloudfront.net/user_3DtfzDNQcdHAxCu2vu9Vs4uR21C/hf_20260618_205024_6a0851da-f0af-4521-b690-f4bda8fc4aa1.png',
  'https://d8j0ntlcm91z4.cloudfront.net/user_3DtfzDNQcdHAxCu2vu9Vs4uR21C/hf_20260618_205012_061866f8-2426-44a5-a2c7-9b37dc3998ad.png',
  'https://d8j0ntlcm91z4.cloudfront.net/user_3DtfzDNQcdHAxCu2vu9Vs4uR21C/hf_20260618_205020_80d7ad11-1f41-4ab8-a7e2-676df3e01d99.png',
];
let dailyAdIndex = 0;

async function sendDailyPost() {
  const url = DAILY_ADS[dailyAdIndex % DAILY_ADS.length];
  dailyAdIndex++;
  const res = await api('sendPhoto', { chat_id: CHANNEL_ID, photo: url, caption: '<b>www.premiumhoodies.io</b>', parse_mode: 'HTML' });
  if (res.ok) {
    console.log('✅ Daily post sent:', url);
  } else {
    console.error('❌ Daily post failed, trying next ad');
    const fallback = DAILY_ADS[dailyAdIndex % DAILY_ADS.length];
    dailyAdIndex++;
    await api('sendPhoto', { chat_id: CHANNEL_ID, photo: fallback, caption: '<b>www.premiumhoodies.io</b>', parse_mode: 'HTML' });
  }
}

function scheduleDailyPost() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(20, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  console.log(`📅 Daily post scheduled in ${Math.round(ms / 60000)} min (8 PM UTC)`);
  setTimeout(() => {
    sendDailyPost();
    setInterval(sendDailyPost, 24 * 60 * 60 * 1000);
  }, ms);
}

scheduleDailyPost();

// ── HTTP Server (webhook + invoice creation) ──────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // CORS for mini app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url === '/nowpayments-webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const sig = req.headers['x-nowpayments-sig'] || '';
        await handleNPWebhook(parsed, sig);
        res.writeHead(200); res.end('ok');
      } catch(e) {
        console.error('Webhook parse error:', e.message);
        res.writeHead(400); res.end('error');
      }
    });
    return;
  }

  if (url === '/create-invoice' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { vendorId, vendorName, months, priceUsd } = JSON.parse(body);
        if (!vendorId || !months || !priceUsd) { res.writeHead(400); res.end('missing fields'); return; }
        const invoice = await createNPInvoice(vendorId, vendorName, months, priceUsd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ invoiceUrl: invoice.invoice_url, id: invoice.id }));
      } catch(e) {
        console.error('Create invoice error:', e.message);
        res.writeHead(500); res.end('error');
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

httpServer.listen(3000, () => console.log('🌐 HTTP server listening on port 3000'));

start();
