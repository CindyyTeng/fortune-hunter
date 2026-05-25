import http from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.PORT || 8787);
const POLL_MS = Number(process.env.POLL_MS || 8000);
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS || 12);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const DATA_FILE = new URL('../data/recommendations.json', import.meta.url);
const SYMBOLS_OVERRIDE = process.env.SYMBOLS || '';

const clients = new Set();
let lastPayload = null;
let yahooCookie = '';
let yahooCrumb = '';
let lastSymbols = [];

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': ALLOW_ORIGIN,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function getSetCookieHeader(response) {
  const raw = response.headers.getSetCookie?.() || [];
  if (raw.length) return raw.map(v => v.split(';')[0]).join('; ');

  const single = response.headers.get('set-cookie');
  return single ? single.split(',').map(v => v.split(';')[0]).join('; ') : '';
}

async function refreshYahooSession() {
  console.log('[yahoo] refreshing session...');

  const pageRes = await fetch('https://finance.yahoo.com/quote/AAPL', {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  yahooCookie = getSetCookieHeader(pageRes);
  console.log('[yahoo] cookie length:', yahooCookie.length);

  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'accept': 'text/plain,*/*',
      'cookie': yahooCookie
    }
  });

  const crumbText = await crumbRes.text();

  if (!crumbRes.ok) {
    console.error('[yahoo] crumb status:', crumbRes.status);
    console.error('[yahoo] crumb response:', crumbText.slice(0, 300));
    throw new Error(`Yahoo crumb HTTP ${crumbRes.status}`);
  }

  yahooCrumb = crumbText.trim();
  console.log('[yahoo] crumb:', yahooCrumb ? 'OK' : 'EMPTY');

  if (!yahooCrumb) throw new Error('Yahoo crumb empty');
}

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/,/g, '').trim();
  if (!text || text === '-' || text === '--') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeSymbol(value) {
  const text = String(value || '').trim().toUpperCase();
  if (/^\d{4}\.TW(O)?$/.test(text)) return text;
  return null;
}

function marketToSuffix(market) {
  const text = String(market || '').toUpperCase();
  if (text === 'TWO' || text.includes('櫃')) return 'TWO';
  return 'TW';
}

async function resolveSymbols() {
  if (SYMBOLS_OVERRIDE.trim()) {
    const override = SYMBOLS_OVERRIDE
      .split(',')
      .map(normalizeSymbol)
      .filter(Boolean)
      .slice(0, MAX_SYMBOLS);
    if (override.length) return override;
  }

  const raw = await readFile(DATA_FILE, 'utf8');
  const json = JSON.parse(raw);
  const list = (json?.recommendations || [])
    .map(item => normalizeSymbol(`${item.code}.${marketToSuffix(item.market)}`))
    .filter(Boolean)
    .slice(0, MAX_SYMBOLS);

  if (!list.length) {
    throw new Error('No symbols found in data/recommendations.json');
  }
  return list;
}

function toTwseChannel(symbol) {
  const [code, market] = symbol.split('.');
  const exchange = market === 'TWO' ? 'otc' : 'tse';
  return `${exchange}_${code}.tw`;
}

function toYahooSymbol(row) {
  return `${row.c}.${row.ex === 'otc' ? 'TWO' : 'TW'}`;
}

function toTimestamp(row) {
  const tlong = Number(row.tlong);
  if (Number.isFinite(tlong) && tlong > 0) return tlong;

  if (/^\d{8}$/.test(row.d || '') && row.t) {
    const year = row.d.slice(0, 4);
    const month = row.d.slice(4, 6);
    const day = row.d.slice(6, 8);
    const parsed = Date.parse(`${year}-${month}-${day}T${row.t}+08:00`);
    if (Number.isFinite(parsed)) return parsed;
  }

  return Date.now();
}

async function fetchTwseQuotes(symbols) {
  const channels = symbols.map(toTwseChannel).join('|');
  const endpoint =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels)}&json=1&delay=0&_=${Date.now()}`;

  console.log('[live-server] twse endpoint:', endpoint);

  const response = await fetch(endpoint, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'accept': 'application/json,text/plain,*/*',
      'referer': 'https://mis.twse.com.tw/stock/fibest.jsp?lang=zh_tw'
    }
  });

  const text = await response.text();
  console.log('[live-server] twse status:', response.status);

  if (!response.ok) {
    console.error('[live-server] twse response:', text.slice(0, 500));
    throw new Error(`TWSE MIS HTTP ${response.status}`);
  }

  const json = JSON.parse(text);
  const rows = json?.msgArray || [];
  console.log('[live-server] twse rows:', rows.length);

  const quotes = rows.map(row => {
    const price = toNumber(row.z) ?? toNumber(row.pz) ?? toNumber(row.y);
    const prev = toNumber(row.y);
    const pct = price !== null && prev ? ((price - prev) / prev) * 100 : null;

    return {
      symbol: toYahooSymbol(row),
      name: row.n || row.nf || toYahooSymbol(row),
      price: price !== null ? Number(price.toFixed(2)) : null,
      changePercent: pct !== null && Number.isFinite(pct) ? Number(pct.toFixed(2)) : null,
      ts: toTimestamp(row)
    };
  }).filter(item => item.price !== null);

  if (!quotes.length) throw new Error('TWSE MIS returned no usable quotes');

  return {
    type: 'quotes',
    asOf: new Date().toISOString(),
    source: 'TWSE MIS realtime API',
    quotes
  };
}

async function fetchYahooQuotes(symbols) {
  if (!yahooCookie || !yahooCrumb) {
    await refreshYahooSession();
  }

  const endpoint =
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(yahooCrumb)}`;

  console.log('[live-server] yahoo endpoint:', endpoint);

  let response = await fetch(endpoint, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'accept': 'application/json',
      'cookie': yahooCookie
    }
  });

  let text = await response.text();

  if (response.status === 401) {
    console.warn('[yahoo] 401, refreshing session and retrying once...');
    yahooCookie = '';
    yahooCrumb = '';
    await refreshYahooSession();

    const retryEndpoint =
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(yahooCrumb)}`;

    response = await fetch(retryEndpoint, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept': 'application/json',
        'cookie': yahooCookie
      }
    });

    text = await response.text();
  }

  console.log('[live-server] yahoo status:', response.status);

  if (!response.ok) {
    console.error('[live-server] yahoo response:', text.slice(0, 500));
    throw new Error(`Yahoo quote HTTP ${response.status}`);
  }

  const json = JSON.parse(text);
  const rows = json?.quoteResponse?.result || [];

  console.log('[live-server] yahoo rows:', rows.length);

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

async function fetchQuotes(symbols) {
  try {
    return await fetchTwseQuotes(symbols);
  } catch (twseError) {
    console.warn('[live-server] twse failed, trying yahoo fallback:', twseError.message);
    return await fetchYahooQuotes(symbols);
  }
}
function broadcast(payload) {
  const chunk = `event: quotes\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(chunk);
}

async function pollAndBroadcast() {
  try {
    const symbols = await resolveSymbols();
    lastSymbols = symbols;
    lastPayload = await fetchQuotes(symbols);
    broadcast(lastPayload);
  } catch (error) {
    console.error('[live-server] poll failed:', error);

    lastPayload = {
      type: 'error',
      asOf: new Date().toISOString(),
      source: 'Yahoo quote API',
      message: error.message,
      quotes: []
    };

    broadcast(lastPayload);
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
    send(res, 200, JSON.stringify({ ok: true, clients: clients.size, symbols: lastSymbols.length || 0 }));
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
