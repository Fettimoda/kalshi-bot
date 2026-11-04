const http = require("http");

const PORT = process.env.PORT || 3000;
const API = "https://external-api.kalshi.com/trade-api/v2";

const assets = {
  BTC: { name: "Bitcoin", series: "KXBTC15M" },
  ETH: { name: "Ethereum", series: "KXETH15M" }
};

let markets = { BTC: null, ETH: null };
let errors = {};
let lastScan = null;

let wallet = {
  startingBalance: 5,
  cash: 5,
  realizedPnL: 0,
  positions: [],
  history: []
};

let priceHistory = { BTC: [], ETH: [] };

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

  if (yesAsk === null && noBid !== null) yesAsk = 1 - noBid;
  if (noAsk === null && yesBid !== null) noAsk = 1 - yesBid;

  const yesMid =
    yesBid !== null && yesAsk !== null
      ? (yesBid + yesAsk) / 2
      : null;

  return { yesBid, yesAsk, noBid, noAsk, yesMid };
}

function getSignal(symbol, market, quotes) {
  if (!market || quotes.yesMid === null) {
    return { action: "WAIT", reason: "Waiting for market prices" };
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

  const yesSpread =
    quotes.yesAsk !== null && quotes.yesBid !== null
      ? quotes.yesAsk - quotes.yesBid
      : null;

  if (yesSpread !== null && yesSpread > 0.10) {
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
  await Promise.all([
    scanAsset("BTC"),
    scanAsset("ETH")
  ]);

  lastScan = new Date().toISOString();
}

function getPositionValue(position) {
  const market = markets[position.symbol];

  if (!market || !market.available) return 0;

  const price =
    position.side === "YES"
      ? market.yesBid
      : market.noBid;

  return price === null || price === undefined
    ? 0
    : position.contracts * price;
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
    markets,
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
      bot: "Kalshi Paper Trading Bot"
    });
  }

  if (req.url.startsWith("/api/markets")) {
    return send(res, 200, {
      lastScan,
      markets,
      errors
    });
  }

  if (req.url === "/api/status") {
    return send(res, 200, getStatus());
  }

  if (req.url === "/api/performance") {
    return send(res, 200, {
      wallet: getStatus().wallet,
      positions: wallet.positions,
      history: wallet.history
    });
  }

  if (req.url === "/api/paper/buy" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const symbol = String(body.symbol || "").toUpperCase();
      const side = String(body.side || "").toUpperCase();
      const amount = number(body.amount);

      if (!assets[symbol] || !["YES", "NO"].includes(side)) {
        return send(res, 400, { error: "Invalid symbol or side" });
      }

      const market = markets[symbol];

      if (!market || !market.available) {
        return send(res, 400, { error: "No active market" });
      }

      const price = side === "YES"
        ? market.yesAsk
        : market.noAsk;

      if (
        price === null ||
        price === undefined ||
        price <= 0 ||
        amount === null ||
        amount <= 0 ||
        amount > wallet.cash
      ) {
        return send(res, 400, { error: "Invalid amount or price" });
      }

      const contracts = Math.floor(amount / price);

      if (contracts < 1) {
        return send(res, 400, {
          error: "Amount is too small for one contract"
        });
      }

      const cost = Number((contracts * price).toFixed(2));

      const position = {
        id: require("crypto").randomUUID(),
        symbol,
        side,
        ticker: market.ticker,
        contracts,
        entryPrice: price,
        cost,
        openedAt: new Date().toISOString()
      };

      wallet.cash = Number((wallet.cash - cost).toFixed(2));
      wallet.positions.push(position);

      return send(res, 200, {
        success: true,
        position,
        status: getStatus()
      });

    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.url === "/api/paper/sell" && req.method === "POST") {
    try {
      const body = await readBody(req);

      const index = wallet.positions.findIndex(
        position => position.id === body.id
      );

      if (index === -1) {
        return send(res, 404, { error: "Position not found" });
      }

      const position = wallet.positions[index];
      const proceeds = getPositionValue(position);

      wallet.cash = Number((wallet.cash + proceeds).toFixed(2));

      const pnl = Number((proceeds - position.cost).toFixed(2));

      wallet.realizedPnL += pnl;

      wallet.history.unshift({
        ...position,
        exitValue: proceeds,
        pnl,
        closedAt: new Date().toISOString()
      });

      wallet.positions.splice(index, 1);

      return send(res, 200, {
        success: true,
        pnl,
        status: getStatus()
      });

    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, async () => {
  console.log(`Kalshi bot running on port ${PORT}`);

  await scanMarkets();

  setInterval(scanMarkets, 10000);
});