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
      io.emit('trade_update', order);
    }
  });

  ticker.connect();
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
    const trades = await kc.getTrades();
    console.log(`Fetched ${trades.length} today's trades from Kite API`);

    // Local JSON database to persist trades across runs and build history
    const fs = require('fs');
    const path = require('path');
    const dbPath = path.join(__dirname, 'trades_db.json');
    let allTrades = [];
    
    if (fs.existsSync(dbPath)) {
      try {
        allTrades = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
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
        
        // Convert to YYYY-MM-DD
        const tDate = new Date(timestamp).toISOString().split('T')[0];
        
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

// Wake-up endpoint for the frontend
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Self-ping workaround to prevent Render sleeping on free tier
const externalUrl = process.env.RENDER_EXTERNAL_URL;
if (externalUrl) {
  console.log(`[Keepalive] Render external URL detected: ${externalUrl}. Starting keep-alive self-pings...`);
  const https = require('https');
  const http = require('http');
  const pingInterval = 10 * 60 * 1000; // 10 minutes

  setInterval(() => {
    const client = externalUrl.startsWith('https') ? https : http;
    client.get(`${externalUrl}/api/ping`, (res) => {
      console.log(`[Keepalive] Self-ping check successful: Code ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('[Keepalive] Self-ping check failed:', err.message);
    });
  }, pingInterval);
} else {
  console.log('[Keepalive] RENDER_EXTERNAL_URL environment variable is not set. Self-pings disabled.');
}



io.on('connection', (socket) => {
  console.log('A client connected');
  socket.emit('ticker_status', { connected: isTickerConnected });
  
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
