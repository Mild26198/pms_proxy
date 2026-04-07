/**
 * Micros POS Interface - TCP Proxy Mode
 * =======================================
 * แทรกกลางระหว่าง SmartConnector (EBO) กับ Micros POS
 * 
 * ┌─────────────┐         ┌──────────────┐         ┌─────────────┐
 * │ SmartConnect │ ──5016──▶│  THIS PROXY  │──5016──▶│  Micros POS │
 * │   (EBO)     │◀─────── │              │ ◀────── │ (10.242.x)  │
 * └─────────────┘         │  ├─ Log      │         └─────────────┘
 *                         │  ├─ SQLite   │
 *                         │  └─ Webhook  │
 *                         └──────────────┘
 * 
 * วิธีทำงาน:
 *   1. Proxy ฟังที่ port (เช่น 5016) แทน Micros POS
 *   2. SmartConnector เชื่อมมาที่ proxy
 *   3. Proxy เชื่อมต่อไปหา Micros POS จริง
 *   4. ข้อมูลทุก byte ถูก forward ไป-กลับโดยไม่แก้ไข
 *   5. Proxy แค่ "อ่าน" ข้อมูลที่ผ่าน แล้ว parse เก็บ/ส่ง webhook
 * 
 * Usage:
 *   node index.js
 */

const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
const axios = require('axios');
const fs = require('fs');

// ─── Configuration ───────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const defaultConfig = {
  // Proxy listens here (SmartConnector connects to this)
  proxyPort: 5016,
  proxyHost: '0.0.0.0',

  // Micros POS real address (proxy connects to this)
  micros: {
    host: '10.242.28.4',
    port: 5016
  },

  // Database
  dbPath: path.join(__dirname, 'micros_guests.db'),

  // Webhook
  webhook: {
    url: null,
    headers: { 'Content-Type': 'application/json' },
    timeout: 5000,
    retries: 3
  },

  // Auto-reconnect to Micros if connection drops
  reconnect: {
    enabled: true,
    delay: 5000,
    maxAttempts: 0
  },

  logLevel: 'info',
  logFile: path.join(__dirname, 'micros-proxy.log')
};

let config = { ...defaultConfig };
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    config = { ...defaultConfig, ...userConfig };
    if (userConfig.webhook) config.webhook = { ...defaultConfig.webhook, ...userConfig.webhook };
    if (userConfig.micros) config.micros = { ...defaultConfig.micros, ...userConfig.micros };
    if (userConfig.reconnect) config.reconnect = { ...defaultConfig.reconnect, ...userConfig.reconnect };
  } catch (e) {
    console.error('Warning: Failed to parse config.json:', e.message);
  }
}

// ─── Logger ──────────────────────────────────────────────────────
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[config.logLevel] || 1;
const logStream = fs.createWriteStream(config.logFile, { flags: 'a' });

function log(level, ...args) {
  if (LOG_LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const msg = `${prefix} ${args.join(' ')}`;
  const colors = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
  console.log(`${colors[level] || ''}${msg}\x1b[0m`);
  logStream.write(msg + '\n');
}

// ─── Database ────────────────────────────────────────────────────
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS guest_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type   TEXT NOT NULL,
    direction    TEXT,
    guest_id     TEXT,
    room_number  TEXT,
    first_name   TEXT,
    last_name    TEXT,
    guest_name   TEXT,
    title        TEXT,
    arrival      TEXT,
    departure    TEXT,
    share        TEXT,
    raw_message  TEXT,
    event_date   TEXT,
    event_time   TEXT,
    created_at   DATETIME DEFAULT (datetime('now','localtime')),
    webhook_sent INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_events_type ON guest_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_room ON guest_events(room_number);
  CREATE INDEX IF NOT EXISTS idx_events_guest ON guest_events(guest_id);
  CREATE INDEX IF NOT EXISTS idx_events_created ON guest_events(created_at);
`);

const insertEvent = db.prepare(`
  INSERT INTO guest_events 
    (event_type, direction, guest_id, room_number, first_name, last_name, 
     guest_name, title, arrival, departure, share, raw_message, event_date, event_time)
  VALUES 
    (@event_type, @direction, @guest_id, @room_number, @first_name, @last_name,
     @guest_name, @title, @arrival, @departure, @share, @raw_message, @event_date, @event_time)
`);

const updateWebhookStatus = db.prepare(`UPDATE guest_events SET webhook_sent = ? WHERE id = ?`);

// ─── FIAS Protocol Parser ────────────────────────────────────────
const STX = 0x02;
const ETX = 0x03;

const FIELD_MAP = {
  'DA': 'date', 'TI': 'time', 'G#': 'guest_id', 'RN': 'room_number',
  'GF': 'first_name', 'GL': 'last_name', 'GN': 'guest_name', 'GT': 'title',
  'GA': 'arrival', 'GD': 'departure', 'GS': 'share', 'GV': 'vip',
  'GG': 'group', 'V#': 'version', 'IF': 'interface', 'RI': 'record_indicator',
  'FL': 'field_list', 'SF': 'suite_from'
};

const EVENT_NAMES = {
  'GI': 'GUEST CHECK-IN',  'GO': 'GUEST CHECK-OUT', 'GC': 'GUEST CHANGE',
  'LA': 'HEARTBEAT',       'LS': 'LINK START',      'LE': 'LINK END',
  'LD': 'LINK DEF',        'LR': 'LINK REG',        'DR': 'DATA REQ',
  'DS': 'DATA SEND',       'DE': 'DATA END'
};

const EVENT_ICONS = {
  'GI': '\x1b[42m\x1b[30m CHECK-IN  \x1b[0m',
  'GO': '\x1b[41m\x1b[37m CHECK-OUT \x1b[0m',
  'GC': '\x1b[43m\x1b[30m CHANGE   \x1b[0m'
};

function parseMessage(raw) {
  const fields = raw.split('|').filter(f => f.length > 0);
  if (fields.length === 0) return null;
  const msgType = fields[0];
  const parsed = { type: msgType, fields: {} };
  for (let i = 1; i < fields.length; i++) {
    const field = fields[i];
    let matched = false;
    for (const [prefix, name] of Object.entries(FIELD_MAP)) {
      if (field.startsWith(prefix)) {
        parsed.fields[name] = field.substring(prefix.length);
        matched = true;
        break;
      }
    }
    if (!matched && field.length > 0) parsed.fields[`_raw_${i}`] = field;
  }
  return parsed;
}

function fmtDate(d) {
  return (d && d.length === 6) ? `20${d.substring(0,2)}-${d.substring(2,4)}-${d.substring(4,6)}` : d;
}

function fmtTime(t) {
  return (t && t.length >= 6) ? `${t.substring(0,2)}:${t.substring(2,4)}:${t.substring(4,6)}` : t;
}

// ─── Frame Buffer ────────────────────────────────────────────────
class FrameBuffer {
  constructor() { this.buffer = Buffer.alloc(0); }
  
  append(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const messages = [];
    while (true) {
      const stx = this.buffer.indexOf(STX);
      if (stx === -1) { this.buffer = Buffer.alloc(0); break; }
      const etx = this.buffer.indexOf(ETX, stx + 1);
      if (etx === -1) { this.buffer = this.buffer.subarray(stx); break; }
      messages.push(this.buffer.subarray(stx + 1, etx).toString('ascii'));
      this.buffer = this.buffer.subarray(etx + 1);
    }
    return messages;
  }
}

// ─── Event Processing ────────────────────────────────────────────
function logGuestEvent(parsed, direction) {
  const f = parsed.fields;
  const arrow = direction === 'micros>ebo' ? '<--' : '-->';
  const icon = EVENT_ICONS[parsed.type] || parsed.type;

  log('info', '');
  log('info', `${'='.repeat(55)}`);
  log('info', `  ${arrow} ${icon}  ${EVENT_NAMES[parsed.type]}  (${direction})`);
  log('info', `${'-'.repeat(55)}`);
  if (f.guest_id)    log('info', `  Guest#:     ${f.guest_id}`);
  if (f.room_number) log('info', `  Room:       ${f.room_number}`);
  if (f.title)       log('info', `  Title:      ${f.title}`);
  if (f.first_name)  log('info', `  First Name: ${f.first_name}`);
  if (f.last_name)   log('info', `  Last Name:  ${f.last_name}`);
  if (f.guest_name)  log('info', `  VIP Level:  ${f.guest_name}`);
  if (f.arrival)     log('info', `  Arrival:    ${fmtDate(f.arrival)}`);
  if (f.departure)   log('info', `  Departure:  ${fmtDate(f.departure)}`);
  if (f.share)       log('info', `  Share:      ${f.share === 'Y' ? 'Yes' : 'No'}`);
  if (f.date)        log('info', `  Date:       ${fmtDate(f.date)}`);
  if (f.time)        log('info', `  Time:       ${fmtTime(f.time)}`);
  log('info', `${'='.repeat(55)}`);
}

function saveToDatabase(parsed, rawMessage, direction) {
  const f = parsed.fields;
  try {
    const result = insertEvent.run({
      event_type: parsed.type,
      direction,
      guest_id: f.guest_id || null,
      room_number: f.room_number || null,
      first_name: f.first_name || null,
      last_name: f.last_name || null,
      guest_name: f.guest_name || null,
      title: f.title || null,
      arrival: f.arrival ? fmtDate(f.arrival) : null,
      departure: f.departure ? fmtDate(f.departure) : null,
      share: f.share || null,
      raw_message: rawMessage,
      event_date: f.date ? fmtDate(f.date) : null,
      event_time: f.time ? fmtTime(f.time) : null
    });
    log('debug', `  -> DB saved (id: ${result.lastInsertRowid})`);
    return result.lastInsertRowid;
  } catch (err) {
    log('error', `  -> DB error: ${err.message}`);
    return null;
  }
}

async function sendWebhook(parsed, rawMessage, dbId) {
  if (!config.webhook.url) return;
  const payload = {
    event_type: parsed.type,
    event_name: EVENT_NAMES[parsed.type] || parsed.type,
    timestamp: new Date().toISOString(),
    data: parsed.fields,
    raw: rawMessage
  };

  for (let attempt = 1; attempt <= config.webhook.retries; attempt++) {
    try {
      const res = await axios.post(config.webhook.url, payload, {
        headers: config.webhook.headers,
        timeout: config.webhook.timeout
      });
      log('info', `  -> Webhook OK (${res.status})`);
      if (dbId) updateWebhookStatus.run(1, dbId);
      return;
    } catch (err) {
      log('warn', `  -> Webhook fail ${attempt}/${config.webhook.retries}: ${err.message}`);
      if (attempt < config.webhook.retries) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  log('error', `  -> Webhook failed after ${config.webhook.retries} attempts`);
  if (dbId) updateWebhookStatus.run(-1, dbId);
}

async function processMessage(parsed, rawMessage, direction) {
  const isGuestEvent = ['GI', 'GO', 'GC'].includes(parsed.type);
  if (isGuestEvent) {
    logGuestEvent(parsed, direction);
    const dbId = saveToDatabase(parsed, rawMessage, direction);
    await sendWebhook(parsed, rawMessage, dbId);
  } else {
    const label = EVENT_NAMES[parsed.type] || parsed.type;
    const arrow = direction === 'micros>ebo' ? '<--' : '-->';
    log('debug', `${arrow} ${label} (${direction})`);
  }
}

// ─── Statistics ──────────────────────────────────────────────────
const stats = {
  started: new Date(),
  connections: 0,
  bytesFromEbo: 0,
  bytesFromMicros: 0,
  guestEvents: 0,
  heartbeats: 0,
  errors: 0
};

// ─── TCP Proxy Server ────────────────────────────────────────────
const proxyServer = net.createServer((eboSocket) => {
  stats.connections++;
  const eboAddr = `${eboSocket.remoteAddress}:${eboSocket.remotePort}`;
  log('info', `SmartConnector connected: ${eboAddr}`);

  const eboFrameBuffer = new FrameBuffer();
  const microsFrameBuffer = new FrameBuffer();
  const microsSocket = new net.Socket();
  let microsConnected = false;
  let reconnectAttempts = 0;

  function connectToMicros() {
    log('info', `Connecting to Micros POS ${config.micros.host}:${config.micros.port}...`);
    
    microsSocket.connect(config.micros.port, config.micros.host, () => {
      microsConnected = true;
      reconnectAttempts = 0;
      log('info', `Connected to Micros POS`);
      log('info', `Proxy active: SmartConnector <-> Micros POS`);
    });
  }

  connectToMicros();

  // ── EBO -> Proxy -> Micros ──
  eboSocket.on('data', (data) => {
    stats.bytesFromEbo += data.length;

    // 1. Forward ทุก byte ไปให้ Micros (ไม่แก้ไข)
    if (microsConnected) {
      microsSocket.write(data);
    }

    // 2. อ่าน parse เก็บข้อมูล (ไม่กระทบ traffic)
    const messages = eboFrameBuffer.append(data);
    for (const raw of messages) {
      const parsed = parseMessage(raw);
      if (parsed) {
        if (parsed.type === 'LA') stats.heartbeats++;
        processMessage(parsed, raw, 'ebo>micros');
      }
    }
  });

  // ── Micros -> Proxy -> EBO ──
  microsSocket.on('data', (data) => {
    stats.bytesFromMicros += data.length;

    // 1. Forward ทุก byte กลับไปให้ SmartConnector
    eboSocket.write(data);

    // 2. อ่าน parse เก็บข้อมูล
    const messages = microsFrameBuffer.append(data);
    for (const raw of messages) {
      const parsed = parseMessage(raw);
      if (parsed) {
        if (['GI', 'GO', 'GC'].includes(parsed.type)) stats.guestEvents++;
        if (parsed.type === 'LA') stats.heartbeats++;
        processMessage(parsed, raw, 'micros>ebo');
      }
    }
  });

  // ── Error Handling ──
  eboSocket.on('close', () => {
    log('warn', `SmartConnector disconnected: ${eboAddr}`);
    microsSocket.destroy();
  });

  eboSocket.on('error', (err) => {
    stats.errors++;
    log('error', `SmartConnector error: ${err.message}`);
    microsSocket.destroy();
  });

  microsSocket.on('close', () => {
    microsConnected = false;
    log('warn', `Micros POS disconnected`);
    
    if (config.reconnect.enabled && !eboSocket.destroyed) {
      const max = config.reconnect.maxAttempts;
      if (max === 0 || reconnectAttempts < max) {
        reconnectAttempts++;
        log('info', `Reconnecting to Micros in ${config.reconnect.delay}ms (attempt ${reconnectAttempts})...`);
        setTimeout(() => {
          if (!eboSocket.destroyed) connectToMicros();
        }, config.reconnect.delay);
      } else {
        log('error', `Max reconnect attempts (${max}) reached`);
        eboSocket.destroy();
      }
    } else {
      eboSocket.destroy();
    }
  });

  microsSocket.on('error', (err) => {
    stats.errors++;
    log('error', `Micros POS error: ${err.message}`);
  });
});

// ─── Stats ───────────────────────────────────────────────────────
function printStats() {
  const uptime = Math.floor((Date.now() - stats.started.getTime()) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  
  log('info', '');
  log('info', '--- Proxy Statistics ---');
  log('info', `  Uptime:        ${h}h ${m}m ${s}s`);
  log('info', `  Connections:   ${stats.connections}`);
  log('info', `  Guest Events:  ${stats.guestEvents}`);
  log('info', `  Heartbeats:    ${stats.heartbeats}`);
  log('info', `  Bytes EBO->:   ${(stats.bytesFromEbo / 1024).toFixed(1)} KB`);
  log('info', `  Bytes Micros->:${(stats.bytesFromMicros / 1024).toFixed(1)} KB`);
  log('info', `  Errors:        ${stats.errors}`);
  log('info', '------------------------');
}

const statsTimer = setInterval(printStats, 5 * 60 * 1000);

// ─── Graceful Shutdown ───────────────────────────────────────────
function shutdown() {
  log('info', 'Shutting down proxy...');
  printStats();
  clearInterval(statsTimer);
  proxyServer.close(() => {
    db.close();
    logStream.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start ───────────────────────────────────────────────────────
proxyServer.listen(config.proxyPort, config.proxyHost, () => {
  log('info', '');
  log('info', '========================================================');
  log('info', '  Micros POS Interface - TCP PROXY MODE');
  log('info', '  FIAS Protocol - Transparent Proxy');
  log('info', '========================================================');
  log('info', '');
  log('info', `  SmartConnector --> :${config.proxyPort} --> ${config.micros.host}:${config.micros.port}`);
  log('info', `      (EBO)          PROXY          (Micros POS)`);
  log('info', '');
  log('info', `  Proxy Port:   ${config.proxyPort}`);
  log('info', `  Micros Host:  ${config.micros.host}`);
  log('info', `  Micros Port:  ${config.micros.port}`);
  log('info', `  Database:     ${path.basename(config.dbPath)}`);
  log('info', `  Webhook:      ${config.webhook.url || 'disabled'}`);
  log('info', `  Reconnect:    ${config.reconnect.enabled ? 'enabled' : 'disabled'}`);
  log('info', '');
  log('info', '  Capturing: GI (Check-in) GO (Check-out) GC (Change)');
  log('info', '  Waiting for SmartConnector connection...');
  log('info', '========================================================');
  log('info', '');
});
