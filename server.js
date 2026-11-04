const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const API = "https://external-api.kalshi.com/trade-api/v2";

const SETTINGS = {
  startingBalance: 5,
  tradeAmount: 1,
  maxOpenPositions: 2,
  scanInterval: 10000,
  signalCooldown: 60000,
  takeProfit: 0.15,
  stopLoss: 0.12,
  trailingActivation: 0.10,
  trailingGiveback: 0.08
};

const assets = {
  BTC: { name: "Bitcoin", series: "KXBTC15M" },
  ETH: { name: "Ethereum", series: "KXETH15M" }
};

let markets = { BTC: null, ETH: null };
let errors = {};
let lastScan = null;
let scanning = false;

let wallet = {
  startingBalance: 5,
  cash: 5,
  realizedPnL: 0,
  positions: [],
  history: []
};

let priceHistory = { BTC: [], ETH: [] };
let lastAutoTrade = {};

let autoTrading = {
  enabled: true,
  tradesOpened: 0,
  tradesClosed: 0,
  lastAction: "Waiting for signal"
};

async function apiGet(path) {
  const response = await fetch(API + path);

  if (!response.ok) {
    throw new Error(`Kalshi API HTTP ${response.status}`);
  }

  return response.json();
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function getPrice(market, field) {
  const dollars = number(market[field + "_dollars"]);

  if (dollars !== null) return dollars;

  const cents = number(market[field]);

  return cents !== null ? cents / 100 : null;
}

function getQuotes(market) {
  let yesBid = getPrice(market, "yes_bid");
  let yesAsk = getPrice(market, "yes_ask");
  let noBid = getPrice(market, "no_bid");
  let noAsk = getPrice(market, "no_ask");

  if (yesAsk === null && noBid !== null) {
    yesAsk = 1 - noBid;
  }

  if (noAsk === null && yesBid !== null) {
    noAsk = 1 - yesBid;
  }

  const yesMid =
    yesBid !== null && yesAsk !== null
      ? (yesBid + yesAsk) / 2
      : null;

  return { yesBid, yesAsk, noBid, noAsk, yesMid };
}

function getSignal(symbol, market, quotes) {
  if (!market || quotes.yesMid === null) {
    return {
      action: "WAIT",
      reason: "Waiting for market prices"
    };
  }

  const now = Date.now();

  priceHistory[symbol].push({
    time: now,
    price: quotes.yesMid
  });

  priceHistory[symbol] = priceHistory[symbol].filter(
    item => now - item.time <= 120000
  );

  const old = priceHistory[symbol].find(
    item => now - item.time >= 20000
  );

  if (!old) {
    return {
      action: "WAIT",
      reason: "Collecting price history"
    };
  }

  const move = quotes.yesMid - old.price;

  const spread =
    quotes.yesAsk !== null && quotes.yesBid !== null
      ? quotes.yesAsk - quotes.yesBid
      : null;

  if (spread !== null && spread > 0.10) {
    return {
      action: "WAIT",
      reason: "Market spread is too wide",
      move
    };
  }

  if (move >= 0.02) {
    return {
      action: "BUY YES",
      reason: "YES contract price is rising",
      confidence: move >= 0.04 ? "MEDIUM" : "LOW",
      move,
      entryPrice: quotes.yesAsk
    };
  }

  if (move <= -0.02) {
    return {
      action: "BUY NO",
      reason: "YES contract price is falling",
      confidence: move <= -0.04 ? "MEDIUM" : "LOW",
      move,
      entryPrice: quotes.noAsk
    };
  }

  return {
    action: "WAIT",
    reason: "No qualifying price movement",
    move
  };
}

function getPositionPrice(position) {
  const market = markets[position.symbol];

  if (
    market &&
    market.available &&
    market.ticker === position.ticker
  ) {
    return position.side === "YES"
      ? market.yesBid
      : market.noBid;
  }

  return position.lastPrice ?? position.entryPrice;
}

function getPositionValue(position) {
  const price = getPositionPrice(position);

  return price === null || price === undefined
    ? 0
    : position.contracts * price;
}

function buyPosition(symbol, side, amount, automatic = false) {
  const market = markets[symbol];

  if (!market || !market.available) {
    return { success: false, error: "No active market" };
  }

  if (wallet.positions.length >= SETTINGS.maxOpenPositions) {
    return { success: false, error: "Maximum open positions reached" };
  }

  const price = side === "YES"
    ? market.yesAsk
    : market.noAsk;

  if (
    price === null ||
    price === undefined ||
    price <= 0 ||
    amount <= 0 ||
    amount > wallet.cash
  ) {
    return { success: false, error: "Invalid amount or price" };
  }

  const contracts = Math.floor(amount / price);

  if (contracts < 1) {
    return {
      success: false,
      error: "Amount is too small for one contract"
    };
  }

  const cost = Number((contracts * price).toFixed(2));

  const position = {
    id: crypto.randomUUID(),
    symbol,
    side,
    ticker: market.ticker,
    contracts,
    entryPrice: price,
    cost,
    lastPrice: price === null ? null : (
      side === "YES" ? market.yesBid : market.noBid
    ),
    peakValue: cost,
    openedAt: new Date().toISOString(),
    automatic
  };

  wallet.cash = Number((wallet.cash - cost).toFixed(2));
  wallet.positions.push(position);

  if (automatic) {
    autoTrading.tradesOpened++;
    autoTrading.lastAction = `AUTO BUY ${side} ${symbol}`;
  }

  return { success: true, position };
}

function closePosition(position, reason) {
  const index = wallet.positions.findIndex(
    item => item.id === position.id
  );

  if (index === -1) return;

  const proceeds = Number(getPositionValue(position).toFixed(2));

  const pnl = Number((proceeds - position.cost).toFixed(2));

  wallet.cash = Number((wallet.cash + proceeds).toFixed(2));

  wallet.realizedPnL = Number(
    (wallet.realizedPnL + pnl).toFixed(2)
  );

  wallet.history.unshift({
    ...position,
    exitValue: proceeds,
    pnl,
    closeReason: reason,
    closedAt: new Date().toISOString()
  });

  wallet.positions.splice(index, 1);

  if (position.automatic) {
    autoTrading.tradesClosed++;
    autoTrading.lastAction = `AUTO SELL ${position.symbol}: ${reason}`;
  }
}

function manageAutomaticTrades() {
  for (const position of [...wallet.positions]) {
    const market = markets[position.symbol];

    // Keep the latest available bid for this exact contract.
    if (
      market &&
      market.available &&
      market.ticker === position.ticker
    ) {
      const bid = position.side === "YES"
        ? market.yesBid
        : market.noBid;

      if (bid !== null && bid !== undefined) {
        position.lastPrice = bid;
      }
    }

    const value = getPositionValue(position);

    if (position.ticker !== market?.ticker) {
      closePosition(position, "Market rotated - last available quote");
      continue;
    }

    const profitPercent = position.cost > 0
      ? (value - position.cost) / position.cost
      : 0;

    if (value > position.peakValue) {
      position.peakValue = value;
    }

    const peakProfit = position.cost > 0
      ? (position.peakValue - position.cost) / position.cost
      : 0;

    if (profitPercent >= SETTINGS.takeProfit) {
      closePosition(position, "Take profit");
      continue;
    }

    if (profitPercent <= -SETTINGS.stopLoss) {
      closePosition(position, "Stop loss");
      continue;
    }

    if (
      peakProfit >= SETTINGS.trailingActivation &&
      value <= position.peakValue * (1 - SETTINGS.trailingGiveback)
    ) {
      closePosition(position, "Trailing stop");
    }
  }
}

function automaticBuy(symbol) {
  if (!autoTrading.enabled) return;

  if (wallet.positions.length >= SETTINGS.maxOpenPositions) {
    return;
  }

  const market = markets[symbol];

  if (!market || !market.available) return;

  const signal = market.signal;

  if (!signal || !["BUY YES", "BUY NO"].includes(signal.action)) {
    return;
  }

  const closeTime = Date.parse(market.closeTime);

  // Avoid entering a market about to close.
  if (
    !Number.isFinite(closeTime) ||
    closeTime - Date.now() < 30000
  ) {
    return;
  }

  const side = signal.action === "BUY YES" ? "YES" : "NO";

  const key = `${symbol}:${market.ticker}:${side}`;
  const now = Date.now();

  if (
    lastAutoTrade[key] &&
    now - lastAutoTrade[key] < SETTINGS.signalCooldown
  ) {
    return;
  }

  const amount = Math.min(
    SETTINGS.tradeAmount,
    wallet.cash
  );

  if (amount <= 0) return;

  const result = buyPosition(symbol, side, amount, true);

  if (result.success) {
    lastAutoTrade[key] = now;
  }
}

async function scanAsset(symbol) {
  const config = assets[symbol];

  try {
    const data = await apiGet(
      `/markets?series_ticker=${config.series}&status=open&limit=100`
    );

    const now = Date.now();

    const availableMarkets = (data.markets || [])
      .filter(market => {
        const status = String(market.status || "").toLowerCase();
        const closeTime = Date.parse(market.close_time);

        return (
          ["active", "open"].includes(status) &&
          Number.isFinite(closeTime) &&
          closeTime > now
        );
      })
      .sort(
        (a, b) =>
          Date.parse(a.close_time) - Date.parse(b.close_time)
      );

    if (!availableMarkets.length) {
      markets[symbol] = {
        asset: config.name,
        series: config.series,
        count: (data.markets || []).length,
        available: false,
        signal: {
          action: "WAIT",
          reason: "No active market found"
        }
      };

      return;
    }

    const market = availableMarkets[0];
    const quotes = getQuotes(market);
    const signal = getSignal(symbol, market, quotes);

    markets[symbol] = {
      asset: config.name,
      series: config.series,
      available: true,
      count: availableMarkets.length,
      ticker: market.ticker,
      title: market.title,
      status: market.status,
      closeTime: market.close_time,
      expirationTime: market.expiration_time,
      yesBid: quotes.yesBid,
      yesAsk: quotes.yesAsk,
      noBid: quotes.noBid,
      noAsk: quotes.noAsk,
      yesMid: quotes.yesMid,
      signal
    };

    delete errors[symbol];

  } catch (error) {
    errors[symbol] = error.message;
  }
}

async function scanMarkets() {
  if (scanning) return;

  scanning = true;

  try {
    await Promise.all([
      scanAsset("BTC"),
      scanAsset("ETH")
    ]);

    // Manage existing positions before opening new ones.
    manageAutomaticTrades();

    // Automatically enter qualifying signals.
    automaticBuy("BTC");
    automaticBuy("ETH");

    lastScan = new Date().toISOString();

  } finally {
    scanning = false;
  }
}

function getStatus() {
  const openValue = wallet.positions.reduce(
    (total, position) => total + getPositionValue(position),
    0
  );

  const unrealizedPnL = wallet.positions.reduce(
    (total, position) =>
      total + getPositionValue(position) - position.cost,
    0
  );

  return {
    status: "online",
    lastScan,
    autoTrading: {
      ...autoTrading,
      settings: SETTINGS
    },
    markets,
    errors,
    wallet: {
      startingBalance: wallet.startingBalance,
      cash: Number(wallet.cash.toFixed(2)),
      openPositions: wallet.positions.length,
      openValue: Number(openValue.toFixed(2)),
      realizedPnL: Number(wallet.realizedPnL.toFixed(2)),
      unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
      totalEquity: Number((wallet.cash + openValue).toFixed(2)),
      totalPnL: Number(
        (wallet.realizedPnL + unrealizedPnL).toFixed(2)
      ),
      tradesClosed: wallet.history.length
    },
    positions: wallet.positions,
    history: wallet.history
  };
}

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => body += chunk);

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 200, { ok: true });
  }

  if (req.url === "/" || req.url === "/health") {
    return send(res, 200, {
      status: "online",
      bot: "Kalshi Automatic Paper Trading Bot"
    });
  }

  if (req.url === "/api/status") {
    return send(res, 200, getStatus());
  }

  if (req.url.startsWith("/api/markets")) {
    return send(res, 200, {
      lastScan,
      markets,
      errors
    });
  }

  if (req.url === "/api/performance") {
    return send(res, 200, {
      wallet: getStatus().wallet,
      positions: wallet.positions,
      history: wallet.history,
      autoTrading
    });
  }

  if (req.url === "/api/paper/buy" && req.method === "POST") {
    try {
      const body = await readBody(req);

      const symbol = String(body.symbol || "").toUpperCase();
      const side = String(body.side || "").toUpperCase();
      const amount = number(body.amount);

      if (!assets[symbol] || !["YES", "NO"].includes(side)) {
        return send(res, 400, {
          error: "Invalid symbol or side"
        });
      }

      if (amount === null || amount <= 0) {
        return send(res, 400, {
          error: "Invalid amount"
        });
      }

      const result = buyPosition(symbol, side, amount, false);

      if (!result.success) {
        return send(res, 400, { error: result.error });
      }

      return send(res, 200, {
        success: true,
        position: result.position,
        status: getStatus()
      });

    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.url === "/api/paper/sell" && req.method === "POST") {
    try {
      const body = await readBody(req);

      const position = wallet.positions.find(
        item => item.id === body.id
      );

      if (!position) {
        return send(res, 404, {
          error: "Position not found"
        });
      }

      closePosition(position, "Manual sale");

      return send(res, 200, {
        success: true,
        status: getStatus()
      });

    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.url === "/api/auto/pause" && req.method === "POST") {
    autoTrading.enabled = false;

    return send(res, 200, {
      success: true,
      autoTrading
    });
  }

  if (req.url === "/api/auto/resume" && req.method === "POST") {
    autoTrading.enabled = true;

    return send(res, 200, {
      success: true,
      autoTrading
    });
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, async () => {
  console.log("Kalshi Automatic Paper Trading Bot running");

  await scanMarkets();

  setInterval(scanMarkets, SETTINGS.scanInterval);
});