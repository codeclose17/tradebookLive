// MUST run before anything parses a date. The Kite SDK converts the API's
// naive IST timestamps ("2026-07-13 10:29:57") with new Date(), which resolves
// against the host's local timezone. On a UTC host (Render) that silently
// shifts every trade time by -5:30, so the timezone is pinned here instead.
process.env.TZ = 'Asia/Kolkata';

require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const KiteConnect = require('kiteconnect').KiteConnect;
const KiteTicker = require('kiteconnect').KiteTicker;

const app = express();
app.use(cors());

// Serve static built Angular files
const path = require('path');
app.use(express.static(path.join(__dirname, '../dist/tradebook-app/browser')));
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // For development, allow all
    methods: ['GET', 'POST']
  }
});

const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;
const port = process.env.PORT || 3000;

if (!apiKey || !apiSecret) {
  console.warn('WARNING: KITE_API_KEY or KITE_API_SECRET is not set in .env');
}

const kc = new KiteConnect({ api_key: apiKey });

// In-memory storage for the access token (for single-user local app)
let currentAccessToken = null;
let ticker = null;
let isTickerConnected = false;

// Instrument tokens currently streamed for open positions
let subscribedTokens = [];
// Latest LTP per token, flushed to clients on an interval (ticks arrive far
// faster than any UI needs, and socket.io does no coalescing of its own).
let pendingTicks = new Map();
let tickFlushId = null;
const TICK_FLUSH_MS = 500;

// ---- Timestamp normalisation -------------------------------------------
// Everything leaving this server carries an explicit +05:30 offset, so the
// frontend never has to infer a timezone from a bare wall-clock string.
const IST_OFFSET = '+05:30';
const IST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23'
});

function toIstIso(value) {
  if (!value) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return value;
  const p = {};
  for (const part of IST_PARTS.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${IST_OFFSET}`;
}

const TIMESTAMP_FIELDS = ['fill_timestamp', 'exchange_timestamp', 'order_timestamp'];

function normalizeTrade(trade) {
  const out = { ...trade };
  for (const field of TIMESTAMP_FIELDS) {
    if (out[field]) out[field] = toIstIso(out[field]);
  }
  return out;
}

function initTicker(token) {
  if (ticker) {
    try {
      ticker.disconnect();
    } catch (e) {
      console.error('Error disconnecting old ticker:', e);
    }
  }

  ticker = new KiteTicker({
    api_key: apiKey,
    access_token: token
  });

  // Configure auto-reconnect: enable, max 5 tries, 5 seconds delay
  ticker.autoReconnect(true, 5, 5);

  ticker.on('connect', () => {
    console.log('KiteTicker connected successfully');
    isTickerConnected = true;
    io.emit('ticker_status', { connected: true });
    // Re-subscribe: a reconnect drops all prior subscriptions
    subscribedTokens = [];
    syncPositionSubscriptions();
  });

  ticker.on('ticks', (ticks) => {
    for (const t of ticks) {
      if (t && t.instrument_token != null && t.last_price != null) {
        pendingTicks.set(t.instrument_token, t.last_price);
      }
    }
    scheduleTickFlush();
  });

  ticker.on('disconnect', () => {
    console.log('KiteTicker disconnected');
    isTickerConnected = false;
    io.emit('ticker_status', { connected: false });
  });

  ticker.on('error', (err) => {
    console.error('KiteTicker error:', err);
    const errMsg = err && (err.message || String(err));
    if (errMsg && errMsg.includes('403')) {
      console.log('KiteTicker: 403 Forbidden error detected. Disabling auto-reconnect.');
      ticker.autoReconnect(false);
      ticker.disconnect();
      isTickerConnected = false;
      io.emit('ticker_status', { connected: false });
    }
  });

  ticker.on('noreconnect', () => {
    console.log('KiteTicker: Maximum reconnection attempts reached.');
    isTickerConnected = false;
    io.emit('ticker_status', { connected: false });
  });

  ticker.on('order_update', (order) => {
    console.log('Order update received from KiteTicker:', order.order_id, order.status);
    if (order.status === 'COMPLETE') {
      io.emit('trade_update', normalizeTrade(order));
      // A fill opens or closes a position — restream against the new book
      syncPositionSubscriptions();
    }
  });

  ticker.connect();
}

function scheduleTickFlush() {
  if (tickFlushId) return;
  tickFlushId = setTimeout(() => {
    tickFlushId = null;
    if (pendingTicks.size === 0) return;
    const payload = Array.from(pendingTicks, ([instrument_token, last_price]) => ({
      instrument_token,
      last_price
    }));
    pendingTicks.clear();
    io.emit('ticks', payload);
  }, TICK_FLUSH_MS);
}

function sameTokens(a, b) {
  return a.length === b.length && a.every(t => b.includes(t));
}

/** Streams live LTP for every open position, and only those. */
async function syncPositionSubscriptions() {
  if (!currentAccessToken || !ticker || !isTickerConnected) return;

  try {
    const positions = await kc.getPositions();
    const open = (positions.net || []).filter(p => p.quantity !== 0);
    const tokens = open.map(p => p.instrument_token).filter(t => t != null);

    io.emit('positions_update', { positions: open.map(normalizeTrade) });

    if (sameTokens(tokens, subscribedTokens)) return;

    const stale = subscribedTokens.filter(t => !tokens.includes(t));
    if (stale.length > 0) ticker.unsubscribe(stale);

    if (tokens.length > 0) {
      ticker.subscribe(tokens);
      ticker.setMode(ticker.modeLTP, tokens);
    }
    subscribedTokens = tokens;
    console.log(`Streaming LTP for ${tokens.length} open position(s):`, tokens);
  } catch (e) {
    console.error('Error syncing position subscriptions:', e && e.message);
  }
}

app.get('/api/auth/url', (req, res) => {
  res.json({ loginUrl: kc.getLoginURL() });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ loggedIn: !!currentAccessToken });
});

app.get('/api/callback', async (req, res) => {
  const requestToken = req.query.request_token;
  if (!requestToken) {
    return res.status(400).send('No request token provided');
  }

  try {
    const response = await kc.generateSession(requestToken, apiSecret);
    currentAccessToken = response.access_token;
    kc.setAccessToken(currentAccessToken);
    
    console.log('Zerodha login successful. Access token acquired.');
    initTicker(currentAccessToken);
    
    res.send(`
      <html>
        <body>
          <h2>Login Successful</h2>
          <p>You can close this window and return to the app.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage('zerodha_login_success', '*');
              window.close();
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error generating session:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/api/trades', async (req, res) => {
  if (!currentAccessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    const rawTrades = await kc.getTrades();
    const trades = rawTrades.map(normalizeTrade);
    console.log(`Fetched ${trades.length} today's trades from Kite API`);

    // Local JSON database to persist trades across runs and build history
    const fs = require('fs');
    const path = require('path');
    const dbPath = path.join(__dirname, 'trades_db.json');
    let allTrades = [];
    
    if (fs.existsSync(dbPath)) {
      try {
        // Older rows were stored as bare UTC instants; normalise on read so
        // the whole history goes out in one canonical IST format.
        allTrades = JSON.parse(fs.readFileSync(dbPath, 'utf8')).map(normalizeTrade);
      } catch (e) {
        console.error('Error reading/parsing trades_db.json:', e);
      }
    }

    // Merge today's trades with history based on trade_id
    const tradeMap = new Map(allTrades.map(t => [t.trade_id, t]));
    trades.forEach(t => {
      tradeMap.set(t.trade_id, t);
    });
    allTrades = Array.from(tradeMap.values());

    // Write back to database
    try {
      fs.writeFileSync(dbPath, JSON.stringify(allTrades, null, 2), 'utf8');
    } catch (e) {
      console.error('Error writing trades_db.json:', e);
    }

    // Filter by given period/day if requested
    const { startDate, endDate } = req.query;
    let filteredTrades = allTrades;
    if (startDate || endDate) {
      filteredTrades = allTrades.filter(t => {
        const timestamp = t.fill_timestamp || t.exchange_timestamp;
        if (!timestamp) return false;

        // Timestamps are canonical IST ISO, so the date is the leading
        // YYYY-MM-DD — going through toISOString() here would compare
        // against the UTC calendar day instead of the trading day.
        const tDate = String(timestamp).slice(0, 10);

        if (startDate && tDate < startDate) return false;
        if (endDate && tDate > endDate) return false;
        return true;
      });
    }

    res.json(filteredTrades);
  } catch (error) {
    console.error('Error fetching trades:', error);
    res.status(500).json({ error: error.message });
  }
});

// Open positions, with the ticker streaming their LTP as a side effect
app.get('/api/positions', async (req, res) => {
  if (!currentAccessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const positions = await kc.getPositions();
    const open = (positions.net || []).filter(p => p.quantity !== 0);
    syncPositionSubscriptions();
    res.json(open.map(normalizeTrade));
  } catch (error) {
    console.error('Error fetching positions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Wake-up endpoint for the frontend
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: toIstIso(new Date()) });
});

// Self-ping workaround to prevent Render sleeping on free tier (toglable)
let keepAliveIntervalId = null;
let isKeepAliveEnabled = false;
const externalUrl = process.env.RENDER_EXTERNAL_URL;

if (externalUrl) {
  console.log(`[Keepalive] Render external URL detected: ${externalUrl}. Keep-alive toggle enabled.`);
} else {
  console.log('[Keepalive] RENDER_EXTERNAL_URL environment variable is not set. Keep-alive toggle will be disabled.');
}

function startKeepAliveLoop() {
  if (keepAliveIntervalId) return; // already running
  if (!externalUrl) {
    console.log('[Keepalive] Cannot start: RENDER_EXTERNAL_URL is not set.');
    return;
  }
  
  console.log(`[Keepalive] Starting self-ping loop for: ${externalUrl}`);
  isKeepAliveEnabled = true;
  const https = require('https');
  const http = require('http');
  const client = externalUrl.startsWith('https') ? https : http;
  
  // Run first ping immediately to confirm connection
  client.get(`${externalUrl}/api/ping`, (res) => {
    console.log(`[Keepalive] Initial self-ping check successful: Code ${res.statusCode}`);
  }).on('error', (err) => {
    console.error('[Keepalive] Initial self-ping check failed:', err.message);
  });
  
  keepAliveIntervalId = setInterval(() => {
    client.get(`${externalUrl}/api/ping`, (res) => {
      console.log(`[Keepalive] Self-ping check successful: Code ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('[Keepalive] Self-ping check failed:', err.message);
    });
  }, 10 * 60 * 1000); // 10 minutes
}

function stopKeepAliveLoop() {
  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
    console.log('[Keepalive] Self-ping loop stopped.');
  }
  isKeepAliveEnabled = false;
}

app.get('/api/keepalive/status', (req, res) => {
  res.json({ enabled: isKeepAliveEnabled, supported: !!externalUrl });
});

app.post('/api/keepalive/start', (req, res) => {
  startKeepAliveLoop();
  res.json({ enabled: isKeepAliveEnabled, supported: !!externalUrl });
});

app.post('/api/keepalive/stop', (req, res) => {
  stopKeepAliveLoop();
  res.json({ enabled: isKeepAliveEnabled, supported: !!externalUrl });
});



io.on('connection', (socket) => {
  console.log('A client connected');
  socket.emit('ticker_status', { connected: isTickerConnected });
  // A fresh client has no prices until the next tick, which on an illiquid
  // strike can be a while — push the current book straight away.
  syncPositionSubscriptions();

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Catch-all route to serve Angular's index.html for non-API routes
app.get('*splat', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../dist/tradebook-app/browser/index.html'));
});

server.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
