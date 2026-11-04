const http = require("http");

const PORT = process.env.PORT || 3000;
const API = "https://external-api.kalshi.com/trade-api/v2";

const ASSETS = [
  { name: "Bitcoin", symbol: "BTC", series: "KXBTC15M" },
  { name: "Ethereum", symbol: "ETH", series: "KXETH15M" }
];

// VIRTUAL WALLET
const INITIAL_BALANCE = 5;

let wallet = {
  balance: INITIAL_BALANCE,
  positions: [],
  history: [],
  nextId: 1
};

// MARKET DATA
let marketData = {};
let priceHistory = {
  BTC: [],
  ETH: []
};

let lastScan = null;
let scanErrors = {};

// HELPERS
function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(JSON.stringify(data));
}

function priceValue(market, dollarsField, centsField) {
  if (market[dollarsField] != null) {
    return Number(market[dollarsField]);
  }

  if (market[centsField] != null) {
    return Number(market[centsField]) / 100;
  }

  return null;
}

function getQuotes(m) {
  let yesBid = priceValue(m, "yes_bid_dollars", "yes_bid");
  let yesAsk = priceValue(m, "yes_ask_dollars", "yes_ask");

  let noBid = priceValue(m, "no_bid_dollars", "no_bid");
  let noAsk = priceValue(m, "no_ask_dollars", "no_ask");

  if (yesAsk == null && noBid != null) {
    yesAsk = 1 - noBid;
  }

  if (noAsk == null && yesBid != null) {
    noAsk = 1 - yesBid;
  }

  const last = priceValue(
    m,
    "last_price_dollars",
    "last_price"
  );

  let mid = null;

  if (yesBid != null && yesAsk != null) {
    mid = (yesBid + yesAsk) / 2;
  } else if (last != null) {
    mid = last;
  }

  return {
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    last,
    mid
  };
}

async function kalshi(path) {
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(API + path, {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error("Kalshi HTTP " + response.status);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// FIND CURRENT MARKET
async function getActiveMarket(asset) {
  const path =
    "/markets?series_ticker=" +
    encodeURIComponent(asset.series) +
    "&status=open&limit=100";

  const data = await kalshi(path);

  const markets = (data.markets || []).filter(m => {
    return (
      m.ticker &&
      m.ticker.startsWith(asset.series + "-")
    );
  });

  const now = Date.now();

  const active = markets.filter(m => {
    if (m.status && m.status !== "open") return false;

    const close = m.close_time
      ? new Date(m.close_time).getTime()
      : null;

    return close == null || close > now;
  });

  active.sort((a, b) => {
    const aTime = a.close_time
      ? new Date(a.close_time).getTime()
      : Infinity;

    const bTime = b.close_time
      ? new Date(b.close_time).getTime()
      : Infinity;

    return aTime - bTime;
  });

  return {
    count: markets.length,
    market: active[0] || null
  };
}

// SIGNAL ENGINE
function makeSignal(asset, market, quotes) {
  const key = asset.symbol;
  const now = Date.now();

  const history = priceHistory[key];

  if (quotes.mid != null) {
    history.push({
      time: now,
      price: quotes.mid
    });
  }

  // Keep the last two minutes.
  priceHistory[key] = history.filter(
    item => now - item.time <= 120000
  );

  const samples = priceHistory[key];

  if (samples.length < 3) {
    return {
      action: "WAIT",
      confidence: "BUILDING DATA",
      reason: "Collecting market prices",
      entryPrice: null,
      movement: null
    };
  }

  const reference = samples.find(
    item => now - item.time >= 20000
  );

  if (!reference || quotes.mid == null) {
    return {
      action: "WAIT",
      confidence: "BUILDING DATA",
      reason: "Waiting for more price history",
      entryPrice: null,
      movement: null
    };
  }

  const movement = quotes.mid - reference.price;

  const spread =
    quotes.yesBid != null && quotes.yesAsk != null
      ? quotes.yesAsk - quotes.yesBid
      : null;

  if (spread != null && spread > 0.10) {
    return {
      action: "WAIT",
      confidence: "LOW",
      reason: "Market spread is too wide",
      entryPrice: null,
      movement
    };
  }

  let action = "WAIT";
  let entryPrice = null;
  let confidence = "LOW";
  let reason = "No clear momentum";

  if (movement >= 0.02 && quotes.yesAsk != null) {
    action = "BUY YES";
    entryPrice = quotes.yesAsk;
    confidence = movement >= 0.05 ? "MEDIUM" : "LOW";
    reason = "YES contract price is rising";
  } else if (
    movement <= -0.02 &&
    quotes.noAsk != null
  ) {
    action = "BUY NO";
    entryPrice = quotes.noAsk;
    confidence = movement <= -0.05 ? "MEDIUM" : "LOW";
    reason = "YES contract price is falling";
  }

  return {
    action,
    confidence,
    reason,
    entryPrice,
    movement,
    spread
  };
}

// SCAN MARKETS
async function scanMarkets() {
  for (const asset of ASSETS) {
    try {
      const result = await getActiveMarket(asset);

      if (!result.market) {
        marketData[asset.symbol] = {
          asset: asset.name,
          series: asset.series,
          count: result.count,
          available: false,
          signal: {
            action: "WAIT",
            reason: "No active market found"
          }
        };

        continue;
      }

      const market = result.market;
      const quotes = getQuotes(market);
      const signal = makeSignal(asset, market, quotes);

      marketData[asset.symbol] = {
        asset: asset.name,
        symbol: asset.symbol,
        series: asset.series,
        available: true,
        count: result.count,
        ticker: market.ticker,
        title: market.title,
        closeTime: market.close_time,
        status: market.status,
        prices: quotes,
        signal,
        updatedAt: new Date().toISOString()
      };

      scanErrors[asset.symbol] = null;

    } catch (error) {
      scanErrors[asset.symbol] = error.message;

      marketData[asset.symbol] = {
        asset: asset.name,
        series: asset.series,
        available: false,
        error: error.message
      };
    }
  }

  lastScan = new Date().toISOString();
}

// WALLET
function getPositionValue(position) {
  const current = marketData[position.symbol];

  if (!current || !current.prices) return null;

  const exitPrice = position.side === "YES"
    ? current.prices.yesBid
    : current.prices.noBid;

  if (exitPrice == null) return null;

  return exitPrice * position.contracts;
}

function getPerformance() {
  let unrealized = 0;
  let openValue = 0;

  for (const position of wallet.positions) {
    const value = getPositionValue(position);

    if (value != null) {
      openValue += value;
      unrealized += value - position.cost;
    }
  }

  const realized = wallet.history.reduce(
    (total, trade) => total + trade.pnl,
    0
  );

  return {
    startingBalance: INITIAL_BALANCE,
    cash: wallet.balance,
    openPositions: wallet.positions.length,
    openValue,
    realizedPnL: realized,
    unrealizedPnL: unrealized,
    totalEquity: wallet.balance + openValue,
    totalPnL: realized + unrealized,
    tradesClosed: wallet.history.length
  };
}

// MANUAL PAPER BUY
function paperBuy(body) {
  const symbol = String(body.symbol || "").toUpperCase();
  const side = String(body.side || "").toUpperCase();
  const amount = Number(body.amount);

  if (!["BTC", "ETH"].includes(symbol)) {
    throw new Error("Choose BTC or ETH");
  }

  if (!["YES", "NO"].includes(side)) {
    throw new Error("Choose YES or NO");
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter a valid amount");
  }

  const market = marketData[symbol];

  if (!market || !market.available) {
    throw new Error("Market is unavailable");
  }

  const entryPrice = side === "YES"
    ? market.prices.yesAsk
    : market.prices.noAsk;

  if (entryPrice == null || entryPrice <= 0 || entryPrice > 1) {
    throw new Error("Entry price unavailable");
  }

  const contracts = Math.floor(amount / entryPrice);

  if (contracts < 1) {
    throw new Error(
      "Amount is too small for one contract"
    );
  }

  const cost = contracts * entryPrice;

  if (cost > wallet.balance) {
    throw new Error("Not enough virtual cash");
  }

  wallet.balance -= cost;

  const position = {
    id: wallet.nextId++,
    symbol,
    asset: market.asset,
    ticker: market.ticker,
    side,
    contracts,
    entryPrice,
    cost,
    openedAt: new Date().toISOString()
  };

  wallet.positions.push(position);

  return {
    success: true,
    position,
    wallet: getPerformance()
  };
}

// MANUAL PAPER SELL
function paperSell(id) {
  const index = wallet.positions.findIndex(
    p => p.id === Number(id)
  );

  if (index === -1) {
    throw new Error("Position not found");
  }

  const position = wallet.positions[index];
  const value = getPositionValue(position);

  if (value == null) {
    throw new Error("Current exit price unavailable");
  }

  const current = marketData[position.symbol];

  const exitPrice = position.side === "YES"
    ? current.prices.yesBid
    : current.prices.noBid;

  const pnl = value - position.cost;

  wallet.balance += value;

  const closed = {
    ...position,
    exitPrice,
    exitValue: value,
    pnl,
    closedAt: new Date().toISOString()
  };

  wallet.history.unshift(closed);
  wallet.positions.splice(index, 1);

  return {
    success: true,
    trade: closed,
    wallet: getPerformance()
  };
}

// HTTP SERVER
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 200, {});
    return;
  }

  const url = new URL(req.url, "http://localhost");

  try {
    if (url.pathname === "/" || url.pathname === "/health") {
      send(res, 200, {
        status: "online",
        bot: "Kalshi Recommendation Bot",
        version: "2.0"
      });
      return;
    }

    if (url.pathname === "/api/markets") {
      send(res, 200, {
        lastScan,
        markets: marketData,
        errors: scanErrors
      });
      return;
    }

    if (url.pathname === "/api/status") {
      send(res, 200, {
        status: "online",
        lastScan,
        markets: marketData,
        wallet: getPerformance(),
        positions: wallet.positions,
        history: wallet.history
      });
      return;
    }

    if (url.pathname === "/api/paper/buy" && req.method === "POST") {
      let body = "";

      req.on("data", chunk => body += chunk);

      req.on("end", () => {
        try {
          const result = paperBuy(JSON.parse(body || "{}"));
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { error: error.message });
        }
      });

      return;
    }

    if (url.pathname === "/api/paper/sell" && req.method === "POST") {
      let body = "";

      req.on("data", chunk => body += chunk);

      req.on("end", () => {
        try {
          const result = paperSell(JSON.parse(body || "{}"));
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { error: error.message });
        }
      });

      return;
    }

    if (url.pathname === "/api/performance") {
      send(res, 200, {
        wallet: getPerformance(),
        positions: wallet.positions,
        history: wallet.history
      });
      return;
    }

    send(res, 404, { error: "Not found" });

  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

// START
server.listen(PORT, "0.0.0.0", () => {
  console.log("Kalshi recommendation server running on " + PORT);

  scanMarkets();

  setInterval(scanMarkets, 10000);
});

server.on("error", error => {
  console.error("SERVER ERROR:", error);
});