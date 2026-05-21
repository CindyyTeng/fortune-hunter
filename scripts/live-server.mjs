import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const POLL_MS = Number(process.env.POLL_MS || 8000);
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS || 12);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const SYMBOLS = (process.env.SYMBOLS || '2330.TW,2317.TW,2454.TW,2308.TW,2882.TW,2891.TW,2303.TW,2382.TW,3711.TW,8299.TWO,3105.TWO,6274.TWO')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)
  .slice(0, MAX_SYMBOLS);

const clients = new Set();
let lastPayload = null;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': ALLOW_ORIGIN,
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function fetchQuotes() {
  const endpoint = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(SYMBOLS.join(','))}`;
  const response = await fetch(endpoint, {
    headers: { 'user-agent': 'fortune-hunter-live/1.0' }
  });
  if (!response.ok) throw new Error(`Yahoo quote HTTP ${response.status}`);
  const json = await response.json();
  const rows = json?.quoteResponse?.result || [];
  const quotes = rows.map(item => {
    const price = Number(item.regularMarketPrice);
    const prev = Number(item.regularMarketPreviousClose);
    const pct = prev ? ((price - prev) / prev) * 100 : 0;
    return {
      symbol: item.symbol,
      name: item.shortName || item.longName || item.symbol,
      price: Number.isFinite(price) ? Number(price.toFixed(2)) : null,
      changePercent: Number.isFinite(pct) ? Number(pct.toFixed(2)) : null,
      ts: item.regularMarketTime ? item.regularMarketTime * 1000 : Date.now()
    };
  }).filter(item => item.price !== null);
  return {
    type: 'quotes',
    asOf: new Date().toISOString(),
    source: 'Yahoo quote API',
    quotes
  };
}

function broadcast(payload) {
  const chunk = `event: quotes\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(chunk);
}

async function pollAndBroadcast() {
  try {
    lastPayload = await fetchQuotes();
    broadcast(lastPayload);
  } catch (error) {
    const payload = {
      type: 'error',
      asOf: new Date().toISOString(),
      message: error.message
    };
    broadcast(payload);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': ALLOW_ORIGIN,
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    send(res, 200, JSON.stringify({ ok: true, clients: clients.size, symbols: SYMBOLS.length }));
    return;
  }

  if (url.pathname === '/quotes') {
    if (lastPayload) send(res, 200, JSON.stringify(lastPayload));
    else send(res, 200, JSON.stringify({ type: 'quotes', asOf: new Date().toISOString(), source: 'warming-up', quotes: [] }));
    return;
  }

  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': ALLOW_ORIGIN
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, pollMs: POLL_MS })}\n\n`);
    if (lastPayload) res.write(`event: quotes\ndata: ${JSON.stringify(lastPayload)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  send(res, 404, JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`fortune-hunter live server http://localhost:${PORT}`);
  pollAndBroadcast();
  setInterval(pollAndBroadcast, POLL_MS);
});
