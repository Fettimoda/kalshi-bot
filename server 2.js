const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const API = "https://external-api.kalshi.com/trade-api/v2";
const BINANCE_API = "https://api.binance.com/api/v3/ticker/price";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const SETTINGS = {
  startingBalance: 5,
  tradeAmount: 1,
  regularMaxTradeAmount: 1.5,
  maxOpenPositions: 2,
  scanInterval: 10000,
  signalCooldown: 60000,
  takeProfit: 0.15,
  stopLoss: 0.12,
  trailingActivation: 0.10,
  trailingGiveback: 0.08,

  // This can be switched on/off from the app through /api/settings.
  highConfidenceEndTrade: true,
  endTradeWindowSeconds: 60,
  endTradeMinContractPrice: 0.90,
  endTradeMaxSpread: 0.05,
  endTradeMinDistanceBps: 8,

  // Do not let the learned model control entries until it has some history.
  learningMinTrades: 10
};

const assets = {
  BTC: { name: "Bitcoin", series: "KXBTC15M", binanceSymbol: "BTCUSDT" },
  ETH: { name: "Ethereum", series: "KXETH15M", binanceSymbol: "ETHUSDT" }
};

const FEATURE_KEYS = [
  "spot20Bps",
  "spot60Bps",
  "contract20Cents",
  "contract60Cents",
  "spreadCents",
  "timeRemaining",
  "strikeDistanceBps"
];

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
let spotHistory = { BTC: [], ETH: [] };
let spotPrices = { BTC: null, ETH: null };
let lastAutoTrade = {};

let autoTrading = {
  enabled: true,
  tradesOpened: 0,
  tradesClosed: 0,
  lastAction: "Waiting for signal"
};

let learningModel = {
  closedTrades: 0,
  wins: 0,
  losses: 0,
  weights: {
    bias: 0,
    spot20Bps: 0,
    spot60Bps: 0,
    contract20Cents: 0,
    contract60Cents: 0,
    spreadCents: 0,
    timeRemaining: 0,
    strikeDistanceBps: 0
  },
  lastUpdated: null
};

let lastSupabaseSave = null;
let supabaseError = null;
let saveTimer = null;

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function logistic(value) {
  const safe = clamp(value, -30, 30);
  return 1 / (1 + Math.exp(-safe));
}

async function apiGet(path) {
  const response = await fetch(API + path);
  if (!response.ok) {
    throw new Error(`Kalshi API HTTP ${response.status}`);
  }
  return response.json();
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase environment variables are missing");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase HTTP ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

function supabaseReady() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

async function loadPersistentState() {
  if (!supabaseReady()) {
    console.log("Supabase is not configured; state will not survive restarts.");
    return;
  }

  try {
    const rows = await supabaseRequest(
      "bot_state?id=eq.main&select=data"
    );

    if (!rows || !rows.length || !rows[0].data) {
      console.log("No saved bot state yet. Starting with a new $5 paper wallet.");
      return;
    }

    const saved = rows[0].data;

    if (saved.wallet) {
      wallet = {
        startingBalance: number(saved.wallet.startingBalance) ?? SETTINGS.startingBalance,
        cash: number(saved.wallet.cash) ?? SETTINGS.startingBalance,
        realizedPnL: number(saved.wallet.realizedPnL) ?? 0,
        positions: Array.isArray(saved.wallet.positions) ? saved.wallet.positions : [],
        history: Array.isArray(saved.wallet.history) ? saved.wallet.history : []
      };
    }

    if (saved.settings) {
      for (const key of Object.keys(SETTINGS)) {
        if (typeof saved.settings[key] === "boolean") {
          SETTINGS[key] = saved.settings[key];
        } else if (number(saved.settings[key]) !== null) {
          SETTINGS[key] = number(saved.settings[key]);
        }
      }
    }

    if (saved.autoTrading) {
      autoTrading = { ...autoTrading, ...saved.autoTrading };
    }

    if (saved.lastAutoTrade && typeof saved.lastAutoTrade === "object") {
      lastAutoTrade = saved.lastAutoTrade;
    }

    if (saved.learningModel && saved.learningModel.weights) {
      learningModel = {
        ...learningModel,
        ...saved.learningModel,
        weights: { ...learningModel.weights, ...saved.learningModel.weights }
      };
    }

    console.log(
      `Restored Supabase state: ${wallet.history.length} closed trades, ` +
      `${wallet.positions.length} open positions, ` +
      `${learningModel.closedTrades} learning samples.`
    );
  } catch (error) {
    supabaseError = error.message;
    console.error("Could not restore Supabase state:", error.message);
  }
}

async function persistState() {
  if (!supabaseReady()) return;

  const data = {
    wallet,
    settings: SETTINGS,
    autoTrading,
    lastAutoTrade,
    learningModel
  };

  try {
    await supabaseRequest("bot_state?on_conflict=id", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        id: "main",
        data,
        updated_at: new Date().toISOString()
      })
    });

    lastSupabaseSave = new Date().toISOString();
    supabaseError = null;
  } catch (error) {
    supabaseError = error.message;
    console.error("Supabase save failed:", error.message);
  }
}

function scheduleStateSave() {
  if (!supabaseReady()) return;
  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    persistState().catch(error => {
      supabaseError = error.message;
      console.error("Scheduled state save failed:", error.message);
    });
  }, 400);
}

async function saveTradeLearning(position, pnl, outcome, closedAt) {
  if (!supabaseReady()) return;

  const row = {
    trade_id: position.id,
    symbol: position.symbol,
    side: position.side,
    features: position.features || {},
    pnl,
    outcome,
    created_at: closedAt
  };

  try {
    await supabaseRequest("trade_learning", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(row)
    });
  } catch (error) {
    // A duplicate trade_id can happen if a close/save is retried.
    console.error("Trade learning save failed:", error.message);
  }
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

async function scanSpotPrice(symbol) {
  try {
    const response = await fetch(
      `${BINANCE_API}?symbol=${assets[symbol].binanceSymbol}`
    );

    if (!response.ok) {
      throw new Error(`Spot feed HTTP ${response.status}`);
    }

    const data = await response.json();
    const price = number(data.price);

    if (price === null) throw new Error("Spot feed returned no price");

    const now = Date.now();
    spotPrices[symbol] = price;
    spotHistory[symbol].push({ time: now, price });

    spotHistory[symbol] = spotHistory[symbol].filter(
      item => now - item.time <= 180000
    );

    delete errors[`${symbol}_SPOT`];
  } catch (error) {
    errors[`${symbol}_SPOT`] = error.message;
  }
}

function findOldSample(history, ageMs) {
  const now = Date.now();
  return history.find(item => now - item.time >= ageMs) || null;
}

function getSignal(symbol, market, quotes) {
  if (!market || quotes.yesMid === null) {
    return { action: "WAIT", reason: "Waiting for market prices" };
  }

  const now = Date.now();

  priceHistory[symbol].push({ time: now, price: quotes.yesMid });
  priceHistory[symbol] = priceHistory[symbol].filter(
    item => now - item.time <= 120000
  );

  const old = findOldSample(priceHistory[symbol], 20000);

  if (!old) {
    return { action: "WAIT", reason: "Collecting contract price history" };
  }

  const move = quotes.yesMid - old.price;
  const spread =
    quotes.yesAsk !== null && quotes.yesBid !== null
      ? quotes.yesAsk - quotes.yesBid
      : null;

  if (spread !== null && spread > 0.10) {
    return { action: "WAIT", reason: "Market spread is too wide", move };
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

  return { action: "WAIT", reason: "No qualifying price movement", move };
}

function makeFeatures(symbol, side, market) {
  const sign = side === "YES" ? 1 : -1;
  const contractHistory = priceHistory[symbol] || [];
  const underlyingHistory = spotHistory[symbol] || [];
  const now = Date.now();

  const contractNow = market?.yesMid ?? null;
  const contract20 = findOldSample(contractHistory, 20000);
  const contract60 = findOldSample(contractHistory, 60000);
  const spotNow = spotPrices[symbol];
  const spot20 = findOldSample(underlyingHistory, 20000);
  const spot60 = findOldSample(underlyingHistory, 60000);

  const contract20Cents =
    contractNow !== null && contract20
      ? (contractNow - contract20.price) * 100 * sign
      : 0;

  const contract60Cents =
    contractNow !== null && contract60
      ? (contractNow - contract60.price) * 100 * sign
      : 0;

  const spot20Bps =
    spotNow !== null && spot20 && spot20.price > 0
      ? ((spotNow - spot20.price) / spot20.price) * 10000 * sign
      : 0;

  const spot60Bps =
    spotNow !== null && spot60 && spot60.price > 0
      ? ((spotNow - spot60.price) / spot60.price) * 10000 * sign
      : 0;

  const yesSpread =
    market?.yesAsk !== null && market?.yesBid !== null
      ? market.yesAsk - market.yesBid
      : 0;

  const closeAt = Date.parse(market?.closeTime || "");
  const secondsRemaining = Number.isFinite(closeAt)
    ? Math.max(0, (closeAt - now) / 1000)
    : 900;

  const strike = number(market?.floorStrike);
  const strikeDistanceBps =
    spotNow !== null && strike !== null && strike > 0
      ? ((spotNow - strike) / strike) * 10000 * sign
      : 0;

  return {
    spot20Bps: clamp(spot20Bps, -50, 50),
    spot60Bps: clamp(spot60Bps, -100, 100),
    contract20Cents: clamp(contract20Cents, -20, 20),
    contract60Cents: clamp(contract60Cents, -30, 30),
    spreadCents: clamp(yesSpread * 100, 0, 20),
    timeRemaining: clamp(secondsRemaining / 900, 0, 1),
    strikeDistanceBps: clamp(strikeDistanceBps, -100, 100)
  };
}

function normalizedFeature(features, key) {
  const scales = {
    spot20Bps: 10,
    spot60Bps: 20,
    contract20Cents: 5,
    contract60Cents: 10,
    spreadCents: 10,
    timeRemaining: 1,
    strikeDistanceBps: 20
  };

  return clamp(
    (number(features[key]) ?? 0) / (scales[key] || 1),
    -3,
    3
  );
}

function predictWinProbability(features) {
  const weights = learningModel.weights;
  let score = number(weights.bias) ?? 0;

  for (const key of FEATURE_KEYS) {
    score += (number(weights[key]) ?? 0) * normalizedFeature(features, key);
  }

  return logistic(score);
}

function updateLearningModel(position, pnl) {
  const features = position.features || {};
  const target = pnl > 0 ? 1 : 0;
  const probability = predictWinProbability(features);
  const error = target - probability;
  const learningRate = 0.035;
  const regularization = 0.002;

  learningModel.weights.bias = clamp(
    learningModel.weights.bias + learningRate * error,
    -5,
    5
  );

  for (const key of FEATURE_KEYS) {
    const x = normalizedFeature(features, key);
    const oldWeight = number(learningModel.weights[key]) ?? 0;
    const updated =
      oldWeight + learningRate * (error * x - regularization * oldWeight);

    learningModel.weights[key] = clamp(updated, -2, 2);
  }

  learningModel.closedTrades++;
  if (target === 1) learningModel.wins++;
  else learningModel.losses++;

  learningModel.lastUpdated = new Date().toISOString();
}

function getPositionPrice(position) {
  const market = markets[position.symbol];

  if (
    market &&
    market.available &&
    market.ticker === position.ticker
  ) {
    return position.side === "YES" ? market.yesBid : market.noBid;
  }

  return position.lastPrice ?? position.entryPrice;
}

function getPositionValue(position) {
  const price = getPositionPrice(position);
  return price === null || price === undefined
    ? 0
    : position.contracts * price;
}

function buyPosition(symbol, side, amount, automatic = false, tradeType = "normal") {
  const market = markets[symbol];

  if (!market || !market.available) {
    return { success: false, error: "No active market" };
  }

  if (wallet.positions.length >= SETTINGS.maxOpenPositions) {
    return { success: false, error: "Maximum open positions reached" };
  }

  const price = side === "YES" ? market.yesAsk : market.noAsk;

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
      error: "Amount is too small for one contract at this price"
    };
  }

  const cost = Number((contracts * price).toFixed(2));
  const features = makeFeatures(symbol, side, market);

  const position = {
    id: crypto.randomUUID(),
    symbol,
    side,
    ticker: market.ticker,
    contracts,
    entryPrice: price,
    cost,
    lastPrice: side === "YES" ? market.yesBid : market.noBid,
    peakValue: cost,
    openedAt: new Date().toISOString(),
    automatic,
    tradeType,
    features
  };

  wallet.cash = Number((wallet.cash - cost).toFixed(2));
  wallet.positions.push(position);

  if (automatic) {
    autoTrading.tradesOpened++;
    autoTrading.lastAction = `AUTO BUY ${side} ${symbol} (${tradeType})`;
  }

  scheduleStateSave();
  return { success: true, position };
}

function closePosition(position, reason, settlementPrice = null) {
  const index = wallet.positions.findIndex(item => item.id === position.id);
  if (index === -1) return;

  let proceeds;

  if (settlementPrice !== null) {
    proceeds = position.contracts * settlementPrice;
  } else {
    proceeds = getPositionValue(position);
  }

  proceeds = Number(proceeds.toFixed(2));
  const pnl = Number((proceeds - position.cost).toFixed(2));
  const closedAt = new Date().toISOString();

  wallet.cash = Number((wallet.cash + proceeds).toFixed(2));
  wallet.realizedPnL = Number((wallet.realizedPnL + pnl).toFixed(2));

  const closedTrade = {
    ...position,
    exitValue: proceeds,
    pnl,
    closeReason: reason,
    closedAt
  };

  wallet.history.unshift(closedTrade);
  wallet.history = wallet.history.slice(0, 500);
  wallet.positions.splice(index, 1);

  updateLearningModel(position, pnl);
  saveTradeLearning(position, pnl, pnl > 0 ? "win" : "loss", closedAt)
    .catch(error => console.error("Learning record error:", error.message));

  if (position.automatic) {
    autoTrading.tradesClosed++;
    autoTrading.lastAction = `AUTO SELL ${position.symbol}: ${reason}`;
  }

  scheduleStateSave();
}

async function checkSettledPosition(position) {
  const now = Date.now();

  if (position.lastSettlementCheck && now - position.lastSettlementCheck < 10000) {
    return false;
  }

  position.lastSettlementCheck = now;

  try {
    const data = await apiGet(`/markets/${encodeURIComponent(position.ticker)}`);
    const market = data.market || data;
    const result = String(market.result || "").toLowerCase();

    if (result === "yes" || result === "no") {
      const won = result === position.side.toLowerCase();
      closePosition(
        position,
        `Market settled ${result.toUpperCase()}`,
        won ? 1 : 0
      );
      return true;
    }

    return false;
  } catch (error) {
    console.error(`Settlement check failed for ${position.ticker}:`, error.message);
    return false;
  }
}

async function manageAutomaticTrades() {
  for (const position of [...wallet.positions]) {
    const market = markets[position.symbol];

    if (!market || market.ticker !== position.ticker) {
      // Do not pretend the last quote is the settlement result.
      // Keep the position open until Kalshi publishes YES/NO settlement.
      await checkSettledPosition(position);
      continue;
    }

    const bid = position.side === "YES" ? market.yesBid : market.noBid;

    if (bid !== null && bid !== undefined) {
      position.lastPrice = bid;
    }

    const value = getPositionValue(position);
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

function getMarketOutcomeFromSpot(market, spot) {
  const strikeType = String(market.strike_type || "").toLowerCase();
  const floor = number(market.floor_strike);
  const cap = number(market.cap_strike);

  if (spot === null || spot === undefined) return null;

  if (strikeType === "greater" || strikeType === "greater_or_equal") {
    if (floor === null) return null;
    return {
      side: spot >= floor ? "YES" : "NO",
      distanceBps: Math.abs(spot - floor) / floor * 10000
    };
  }

  if (strikeType === "less" || strikeType === "less_or_equal") {
    const threshold = cap !== null ? cap : floor;
    if (threshold === null) return null;
    return {
      side: spot <= threshold ? "YES" : "NO",
      distanceBps: Math.abs(spot - threshold) / threshold * 10000
    };
  }

  if (strikeType === "between" && floor !== null && cap !== null) {
    const inside = spot >= floor && spot <= cap;
    const distance = inside
      ? Math.min(spot - floor, cap - spot)
      : Math.min(Math.abs(spot - floor), Math.abs(spot - cap));

    return {
      side: inside ? "YES" : "NO",
      distanceBps: distance / spot * 10000
    };
  }

  // Do not guess the settlement rule for custom/structured markets.
  return null;
}

function tryHighConfidenceEndTrade(symbol) {
  if (!SETTINGS.highConfidenceEndTrade || !autoTrading.enabled) return false;
  if (wallet.positions.length >= SETTINGS.maxOpenPositions) return false;
  if (wallet.cash <= 0) return false;

  const market = markets[symbol];
  if (!market || !market.available) return false;

  const closeTime = Date.parse(market.closeTime || "");
  const secondsRemaining = (closeTime - Date.now()) / 1000;

  if (
    !Number.isFinite(secondsRemaining) ||
    secondsRemaining <= 0 ||
    secondsRemaining > SETTINGS.endTradeWindowSeconds
  ) {
    return false;
  }

  const outcome = getMarketOutcomeFromSpot(market.rawMarket || {}, spotPrices[symbol]);
  if (!outcome) return false;

  if (outcome.distanceBps < SETTINGS.endTradeMinDistanceBps) return false;

  const side = outcome.side;
  const ask = side === "YES" ? market.yesAsk : market.noAsk;
  const bid = side === "YES" ? market.yesBid : market.noBid;

  if (ask === null || ask === undefined || bid === null || bid === undefined) {
    return false;
  }

  const spread = ask - bid;

  if (ask < SETTINGS.endTradeMinContractPrice) return false;
  if (spread < 0 || spread > SETTINGS.endTradeMaxSpread) return false;

  const key = `${symbol}:${market.ticker}:END:${side}`;
  const now = Date.now();

  if (lastAutoTrade[key] && now - lastAutoTrade[key] < SETTINGS.signalCooldown) {
    return false;
  }

  // Special end-of-market setting: may use all remaining virtual cash.
  // Contract rounding can leave a small cash remainder.
  const amount = wallet.cash;
  const result = buyPosition(symbol, side, amount, true, "high-confidence-end");

  if (result.success) {
    lastAutoTrade[key] = now;
    autoTrading.lastAction =
      `HIGH-CONFIDENCE END TRADE ${side} ${symbol} (${Math.floor(secondsRemaining)}s left)`;
    scheduleStateSave();
    return true;
  }

  return false;
}

function getAdaptiveTradeAmount(symbol, side, market) {
  const features = makeFeatures(symbol, side, market);

  if (learningModel.closedTrades < SETTINGS.learningMinTrades) {
    return {
      amount: market.signal?.confidence === "MEDIUM" ? 1 : 0.5,
      probability: null,
      features
    };
  }

  const probability = predictWinProbability(features);

  if (probability < 0.52) {
    return { amount: 0, probability, features };
  }

  let amount = 0.5;
  if (probability >= 0.75) amount = 1.5;
  else if (probability >= 0.62) amount = 1.0;

  return {
    amount: Math.min(amount, SETTINGS.regularMaxTradeAmount),
    probability,
    features
  };
}

function automaticBuy(symbol) {
  if (!autoTrading.enabled) return;
  if (wallet.positions.length >= SETTINGS.maxOpenPositions) return;

  // Check the special final-minute strategy before ordinary signal entries.
  if (tryHighConfidenceEndTrade(symbol)) return;

  const market = markets[symbol];
  if (!market || !market.available) return;

  const signal = market.signal;
  if (!signal || !["BUY YES", "BUY NO"].includes(signal.action)) return;

  const closeTime = Date.parse(market.closeTime || "");
  if (!Number.isFinite(closeTime) || closeTime - Date.now() < 30000) return;

  const side = signal.action === "BUY YES" ? "YES" : "NO";
  const key = `${symbol}:${market.ticker}:${side}`;
  const now = Date.now();

  if (
    lastAutoTrade[key] &&
    now - lastAutoTrade[key] < SETTINGS.signalCooldown
  ) {
    return;
  }

  const adaptive = getAdaptiveTradeAmount(symbol, side, market);

  if (adaptive.amount <= 0) {
    market.signal.learning = {
      probability: adaptive.probability,
      decision: "Filtered by learning model"
    };
    return;
  }

  const amount = Math.min(adaptive.amount, wallet.cash);
  if (amount <= 0) return;

  const result = buyPosition(symbol, side, amount, true, "adaptive");

  if (result.success) {
    lastAutoTrade[key] = now;
    market.signal.learning = {
      probability: adaptive.probability,
      decision: "Trade accepted",
      amount: result.position.cost
    };
    scheduleStateSave();
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
        spotPrice: spotPrices[symbol],
        signal: { action: "WAIT", reason: "No active market found" }
      };
      return;
    }

    const market = availableMarkets[0];
    const quotes = getQuotes(market);
    const signal = getSignal(symbol, market, quotes);
    const closeTime = Date.parse(market.close_time);

    markets[symbol] = {
      asset: config.name,
      series: config.series,
      available: true,
      count: availableMarkets.length,
      ticker: market.ticker,
      title: market.title,
      status: market.status,
      closeTime: market.close_time,
      expirationTime: market.expected_expiration_time || market.expiration_time,
      yesBid: quotes.yesBid,
      yesAsk: quotes.yesAsk,
      noBid: quotes.noBid,
      noAsk: quotes.noAsk,
      yesMid: quotes.yesMid,
      floorStrike: number(market.floor_strike),
      capStrike: number(market.cap_strike),
      strikeType: market.strike_type || null,
      spotPrice: spotPrices[symbol],
      secondsRemaining: Number.isFinite(closeTime)
        ? Math.max(0, (closeTime - now) / 1000)
        : null,
      signal,
      rawMarket: market
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
      scanSpotPrice("BTC"),
      scanSpotPrice("ETH")
    ]);

    await Promise.all([
      scanAsset("BTC"),
      scanAsset("ETH")
    ]);

    await manageAutomaticTrades();

    automaticBuy("BTC");
    automaticBuy("ETH");

    lastScan = new Date().toISOString();
    scheduleStateSave();
  } finally {
    scanning = false;
  }
}

function getLearningStatus() {
  const total = learningModel.closedTrades;
  const winRate = total > 0
    ? Number((learningModel.wins / total * 100).toFixed(1))
    : 0;

  return {
    enabled: true,
    mode: "adaptive",
    closedTrades: total,
    wins: learningModel.wins,
    losses: learningModel.losses,
    winRate,
    modelActive: total >= SETTINGS.learningMinTrades,
    minimumTradesForAdaptiveSizing: SETTINGS.learningMinTrades,
    lastUpdated: learningModel.lastUpdated,
    storage: {
      connected: supabaseReady(),
      lastSaved: lastSupabaseSave,
      error: supabaseError
    }
  };
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
    settings: SETTINGS,
    learning: getLearningStatus(),
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
      totalPnL: Number((wallet.realizedPnL + unrealizedPnL).toFixed(2)),
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

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

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

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/" || url.pathname === "/health") {
    return send(res, 200, {
      status: "online",
      bot: "Kalshi Adaptive Paper Trading Bot",
      storageConnected: supabaseReady()
    });
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    return send(res, 200, getStatus());
  }

  if (url.pathname === "/api/markets" && req.method === "GET") {
    return send(res, 200, {
      lastScan,
      markets,
      errors
    });
  }

  if (url.pathname === "/api/performance" && req.method === "GET") {
    return send(res, 200, {
      wallet: getStatus().wallet,
      positions: wallet.positions,
      history: wallet.history,
      autoTrading,
      learning: getLearningStatus()
    });
  }

  if (url.pathname === "/api/learning" && req.method === "GET") {
    return send(res, 200, {
      learning: getLearningStatus(),
      weights: learningModel.weights
    });
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    return send(res, 200, { settings: SETTINGS });
  }

  if (url.pathname === "/api/settings" && req.method === "POST") {
    try {
      const body = await readBody(req);

      if (typeof body.highConfidenceEndTrade === "boolean") {
        SETTINGS.highConfidenceEndTrade = body.highConfidenceEndTrade;
      }

      scheduleStateSave();

      return send(res, 200, {
        success: true,
        settings: SETTINGS
      });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (url.pathname === "/api/paper/buy" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const symbol = String(body.symbol || "").toUpperCase();
      const side = String(body.side || "").toUpperCase();
      const amount = number(body.amount);

      if (!assets[symbol] || !["YES", "NO"].includes(side)) {
        return send(res, 400, { error: "Invalid symbol or side" });
      }

      if (amount === null || amount <= 0) {
        return send(res, 400, { error: "Invalid amount" });
      }

      const result = buyPosition(symbol, side, amount, false, "manual");

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

  if (url.pathname === "/api/paper/sell" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const position = wallet.positions.find(item => item.id === body.id);

      if (!position) {
        return send(res, 404, { error: "Position not found" });
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

  if (url.pathname === "/api/auto/pause" && req.method === "POST") {
    autoTrading.enabled = false;
    scheduleStateSave();
    return send(res, 200, { success: true, autoTrading });
  }

  if (url.pathname === "/api/auto/resume" && req.method === "POST") {
    autoTrading.enabled = true;
    scheduleStateSave();
    return send(res, 200, { success: true, autoTrading });
  }

  return send(res, 404, { error: "Not found" });
});

server.listen(PORT, async () => {
  console.log("Kalshi Adaptive Paper Trading Bot running");
  console.log("Supabase persistence:", supabaseReady() ? "configured" : "NOT CONFIGURED");

  await loadPersistentState();
  await scanMarkets();

  setInterval(scanMarkets, SETTINGS.scanInterval);

  // A periodic backup in addition to saves after important changes.
  setInterval(persistState, 30000);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received; saving bot state...");
  await persistState();
  server.close(() => process.exit(0));
});
