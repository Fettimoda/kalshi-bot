const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const API = "https://external-api.kalshi.com/trade-api/v2";
const KRAKEN_API = "https://api.kraken.com/0/public/Ticker";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const SETTINGS = {
  startingBalance: 5,
  tradeAmount: 1,
  regularMaxTradeAmount: 1.5,

  maxOpenPositions: 4,
  maxOpenPositionsPerMarket: 2,

  scanInterval: 2000,
  signalCooldown: 10000,
  predictionWindowSeconds: 10,

  minimumPredictedMoveCents: 1,
  minimumSpotMovePercent: 0.005,

  takeProfit: 0.15,
  stopLoss: 0.12,
  trailingActivation: 0.10,
  trailingGiveback: 0.08,

  highConfidenceEndTrade: true,
  endTradeWindowSeconds: 10,
  endTradeMinContractPrice: 0.90,
  endTradeMaxSpread: 0.05,
  endTradeMinDistanceBps: 8,

  learningMinTrades: 5
};

const assets = {
  BTC: {
    name: "Bitcoin",
    series: "KXBTC15M",
    binanceSymbol: "BTCUSDT"
  },

  ETH: {
    name: "Ethereum",
    series: "KXETH15M",
    binanceSymbol: "ETHUSDT"
  }
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

let markets = {
  BTC: null,
  ETH: null
};

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

let priceHistory = {
  BTC: [],
  ETH: []
};

let spotHistory = {
  BTC: [],
  ETH: []
};

let spotPrices = {
  BTC: null,
  ETH: null
};

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

// ------------------------------
// BASIC HELPERS
// ------------------------------

function number(value) {
  const result = Number(value);

  return Number.isFinite(result)
    ? result
    : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-clamp(value, -30, 30)));
}

function makePositionId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

// ------------------------------
// KALSHI API
// ------------------------------

async function apiGet(path) {
  const response = await fetch(API + path);

  if (!response.ok) {
    throw new Error(`Kalshi API HTTP ${response.status}`);
  }

  return response.json();
}

// ------------------------------
// SUPABASE STORAGE
// ------------------------------

function supabaseReady() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

async function supabaseRequest(path, options = {}) {
  if (!supabaseReady()) {
    throw new Error("Supabase environment variables are missing");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : null;
}

async function loadPersistentState() {
  if (!supabaseReady()) {
    console.log("Supabase is not configured.");
    return;
  }

  try {
    const rows = await supabaseRequest(
      "bot_state?id=eq.main&select=data"
    );

    if (!rows || !rows.length || !rows[0].data) {
      console.log("Starting new $5 paper wallet.");
      return;
    }

    const saved = rows[0].data;

    if (saved.wallet) {
      wallet = {
        startingBalance:
          number(saved.wallet.startingBalance) ?? 5,

        cash:
          number(saved.wallet.cash) ?? 5,

        realizedPnL:
          number(saved.wallet.realizedPnL) ?? 0,

        positions:
          Array.isArray(saved.wallet.positions)
            ? saved.wallet.positions
            : [],

        history:
          Array.isArray(saved.wallet.history)
            ? saved.wallet.history
            : []
      };
    }

    if (saved.settings) {
      for (const key of Object.keys(SETTINGS)) {
        if (
          typeof SETTINGS[key] === "boolean" &&
          typeof saved.settings[key] === "boolean"
        ) {
          SETTINGS[key] = saved.settings[key];
        }

        if (
          typeof SETTINGS[key] === "number" &&
          number(saved.settings[key]) !== null
        ) {
          SETTINGS[key] = number(saved.settings[key]);
        }
      }
    }

    if (saved.autoTrading) {
      autoTrading = {
        ...autoTrading,
        ...saved.autoTrading
      };
    }

    if (saved.lastAutoTrade) {
      lastAutoTrade = saved.lastAutoTrade;
    }

    if (saved.learningModel?.weights) {
      learningModel = {
        ...learningModel,
        ...saved.learningModel,

        weights: {
          ...learningModel.weights,
          ...saved.learningModel.weights
        }
      };
    }

    console.log("Previous bot state restored.");

  } catch (error) {
    supabaseError = error.message;

    console.error(
      "Restore error:",
      error.message
    );
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
    await supabaseRequest(
      "bot_state?on_conflict=id",
      {
        method: "POST",

        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal"
        },

        body: JSON.stringify({
          id: "main",
          data,
          updated_at: new Date().toISOString()
        })
      }
    );

    lastSupabaseSave = new Date().toISOString();
    supabaseError = null;

  } catch (error) {
    supabaseError = error.message;

    console.error(
      "Supabase save failed:",
      error.message
    );
  }
}

function scheduleStateSave() {
  if (!supabaseReady()) return;

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    persistState().catch(error => {
      supabaseError = error.message;
    });
  }, 400);
}

// ------------------------------
// PRICE DATA
// ------------------------------

async function fetchSpotPrice(symbol) {
  const pairMap = {
    BTCUSDT: "XBTUSD",
    ETHUSDT: "ETHUSD"
  };

  const pair = pairMap[symbol];

  if (!pair) {
    throw new Error(`Unsupported Kraken symbol: ${symbol}`);
  }

  const response = await fetch(
    `${KRAKEN_API}?pair=${pair}`
  );

  if (!response.ok) {
    throw new Error(`Kraken HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.error && data.error.length > 0) {
    throw new Error(`Kraken error: ${data.error.join(", ")}`);
  }

  const result = data.result;
  const marketData = Object.values(result)[0];

  if (!marketData || !marketData.c) {
    throw new Error("Kraken price unavailable");
  }

  return number(marketData.c[0]);
}

function recordSpotPrice(symbol, price) {
  const now = Date.now();

  spotHistory[symbol].push({
    time: now,
    price
  });

  spotHistory[symbol] =
    spotHistory[symbol].filter(
      item => now - item.time <= 180000
    );
}

function recordContractPrice(symbol, price) {
  if (price === null) return;

  const now = Date.now();

  priceHistory[symbol].push({
    time: now,
    price
  });

  priceHistory[symbol] =
    priceHistory[symbol].filter(
      item => now - item.time <= 180000
    );
}

function getHistoricalValue(history, secondsAgo) {
  if (!history || history.length < 2) {
    return null;
  }

  const target = Date.now() - secondsAgo * 1000;

  let closest = null;
  let difference = Infinity;

  for (const item of history) {
    const currentDifference =
      Math.abs(item.time - target);

    if (currentDifference < difference) {
      difference = currentDifference;
      closest = item;
    }
  }

  if (!closest || difference > 12000) {
    return null;
  }

  return number(closest.price);
}

function calculateBps(current, previous) {
  if (
    current === null ||
    previous === null ||
    previous === 0
  ) {
    return null;
  }

  return (
    (current - previous) / previous
  ) * 10000;
}

// ------------------------------
// MARKET INFORMATION
// ------------------------------

function getPrice(market, field) {
  const dollars = number(
    market[field + "_dollars"]
  );

  if (dollars !== null) {
    return dollars;
  }

  const cents = number(market[field]);

  return cents !== null
    ? cents / 100
    : null;
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

  return {
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    yesMid
  };
}

function getMarketTicker(market) {
  return market?.ticker ||
    market?.market_ticker ||
    null;
}

function getMarketCloseTime(market) {
  const value =
    market?.close_time ||
    market?.expiration_time ||
    market?.expected_expiration_time;

  if (!value) return null;

  const timestamp = new Date(value).getTime();

  return Number.isFinite(timestamp)
    ? timestamp
    : null;
}

function getSecondsRemaining(market) {
  const closeTime = getMarketCloseTime(market);

  if (!closeTime) return null;

  return Math.max(
    0,
    Math.floor((closeTime - Date.now()) / 1000)
  );
}

function getStrikePrice(market) {
  const candidates = [
    market?.floor_strike,
    market?.strike_price,
    market?.cap_strike,
    market?.subtitle
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) {
      continue;
    }

    const match = String(candidate).match(/[\d,.]+/);

    if (!match) continue;

    const value = Number(
      match[0].replace(/,/g, "")
    );

    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
}
// ------------------------------
// MARKET DISCOVERY
// ------------------------------

async function findActiveMarket(symbol) {
  const series = assets[symbol].series;

  const data = await apiGet(
    `/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=100`
  );

  const list = Array.isArray(data.markets)
    ? data.markets
    : [];

  const now = Date.now();

  const active = list
    .filter(market => {
      const closeTime = getMarketCloseTime(market);

      return closeTime && closeTime > now;
    })
    .sort((a, b) =>
      getMarketCloseTime(a) - getMarketCloseTime(b)
    );

  return active[0] || null;
}

async function refreshMarket(symbol) {
  try {
    const current = markets[symbol];

    const ticker = getMarketTicker(current);
    const closeTime = getMarketCloseTime(current);

    if (
      ticker &&
      closeTime &&
      closeTime > Date.now()
    ) {
      return current;
    }

    const market = await findActiveMarket(symbol);

    if (!market) {
      markets[symbol] = null;
      errors[symbol] = "No active 15-minute market found";
      return null;
    }

    markets[symbol] = market;
    errors[symbol] = null;

    return market;

  } catch (error) {
    errors[symbol] = error.message;

    return markets[symbol] || null;
  }
}

async function scanSpotPrice(symbol) {
  try {
    const price = await fetchSpotPrice(
      assets[symbol].binanceSymbol
    );

    spotPrices[symbol] = price;

    recordSpotPrice(symbol, price);

    return price;

  } catch (error) {
    errors[symbol] = error.message;
    return null;
  }
}

// ------------------------------
// SIGNAL CALCULATIONS
// ------------------------------

function getMarketSpread(quotes) {
  if (
    quotes.yesBid === null ||
    quotes.yesAsk === null
  ) {
    return null;
  }

  return quotes.yesAsk - quotes.yesBid;
}

function getSignalFeatures(symbol, market, quotes) {
  const spot = spotPrices[symbol];

  const oldSpot20 = getHistoricalValue(
    spotHistory[symbol],
    20
  );

  const oldSpot60 = getHistoricalValue(
    spotHistory[symbol],
    60
  );

  const oldContract20 = getHistoricalValue(
    priceHistory[symbol],
    20
  );

  const oldContract60 = getHistoricalValue(
    priceHistory[symbol],
    60
  );

  const spot20Bps = calculateBps(
    spot,
    oldSpot20
  );

  const spot60Bps = calculateBps(
    spot,
    oldSpot60
  );

  const contract20Cents =
    quotes.yesMid !== null &&
    oldContract20 !== null
      ? (quotes.yesMid - oldContract20) * 100
      : null;

  const contract60Cents =
    quotes.yesMid !== null &&
    oldContract60 !== null
      ? (quotes.yesMid - oldContract60) * 100
      : null;

  const spread = getMarketSpread(quotes);

  const secondsRemaining =
    getSecondsRemaining(market);

  const strike = getStrikePrice(market);

  const strikeDistanceBps =
    strike && spot
      ? ((spot - strike) / strike) * 10000
      : null;

  return {
    spot20Bps,
    spot60Bps,
    contract20Cents,
    contract60Cents,

    spreadCents:
      spread === null
        ? null
        : spread * 100,

    timeRemaining: secondsRemaining,
    strikeDistanceBps
  };
}

function hasEnoughSignalData(features) {
  return (
    features.spot20Bps !== null &&
    features.contract20Cents !== null &&
    features.spreadCents !== null
  );
}

// ------------------------------
// ADAPTIVE PREDICTION
// ------------------------------

function predictMarketMove(features) {
  const weights = learningModel.weights;

  const contractMove =
    number(features.contract20Cents) || 0;

  const spotMove =
    number(features.spot20Bps) || 0;

  let score =
    (contractMove / 5) +
    (spotMove / 30);

  if (
    learningModel.closedTrades >=
    SETTINGS.learningMinTrades
  ) {
    for (const key of FEATURE_KEYS) {
      const value = number(features[key]);

      if (value === null) continue;

      const scale =
        key.includes("Cents") ? 10 :
        key === "timeRemaining" ? 900 :
        100;

      score +=
        (number(weights[key]) || 0) *
        (value / scale);
    }
  }

  const probability = logistic(score);

  return {
    score,

    yesProbability: probability,

    noProbability: 1 - probability,

    predictedSide:
      probability >= 0.5
        ? "YES"
        : "NO",

    confidence:
      Math.max(probability, 1 - probability)
  };
}

function getSignal(symbol, market) {
  if (!market) {
    return {
      action: "WAIT",
      reason: "Waiting for an active market"
    };
  }

  const quotes = getQuotes(market);

  if (
    quotes.yesBid === null ||
    quotes.yesAsk === null ||
    quotes.noAsk === null
  ) {
    return {
      action: "WAIT",
      reason: "Waiting for market quotes"
    };
  }

  const features = getSignalFeatures(
    symbol,
    market,
    quotes
  );

  if (quotes.yesMid !== null) {
    recordContractPrice(
      symbol,
      quotes.yesMid
    );
  }

  if (!hasEnoughSignalData(features)) {
    return {
      action: "WAIT",
      reason: "Collecting price history",
      features
    };
  }

  const spread = getMarketSpread(quotes);

  if (spread === null || spread > 0.10) {
    return {
      action: "WAIT",
      reason: "Market spread is too wide",
      features
    };
  }

  const prediction = predictMarketMove(features);

  const contractMove =
    Math.abs(features.contract20Cents);

  const spotMove =
    Math.abs(features.spot20Bps || 0) / 100;

  const contractOpportunity =
    contractMove >=
    SETTINGS.minimumPredictedMoveCents;

  const spotOpportunity =
    spotMove >=
    SETTINGS.minimumSpotMovePercent;

  if (!contractOpportunity && !spotOpportunity) {
    return {
      action: "WAIT",
      reason: "No qualifying price movement",
      features,
      prediction
    };
  }

  if (prediction.confidence < 0.51) {
    return {
      action: "WAIT",
      reason: "Prediction confidence is too low",
      features,
      prediction
    };
  }

  return {
    action:
      prediction.predictedSide === "YES"
        ? "BUY_YES"
        : "BUY_NO",

    reason: contractOpportunity
      ? "Contract movement detected"
      : "Spot price movement detected",

    confidence: prediction.confidence,

    features,
    prediction,
    quotes
  };
}

// ------------------------------
// WALLET MANAGEMENT
// ------------------------------

function countOpenPositions(symbol) {
  return wallet.positions.filter(
    position => position.symbol === symbol
  ).length;
}

function getAvailableBalance() {
  return Math.max(
    0,
    number(wallet.cash) || 0
  );
}

function calculateTradeSize(confidence) {
  const cash = getAvailableBalance();

  if (cash <= 0) return 0;

  let amount = SETTINGS.tradeAmount;

  if (confidence >= 0.75) {
    amount = SETTINGS.regularMaxTradeAmount;
  } else if (confidence >= 0.65) {
    amount = 1;
  } else {
    amount = 0.50;
  }

  return Math.min(
    cash,
    amount,
    SETTINGS.regularMaxTradeAmount
  );
}

// ------------------------------
// OPEN PAPER TRADE
// ------------------------------

function buyPosition(
  symbol,
  side,
  amount,
  market,
  signal
) {
  if (!market) {
    return {
      success: false,
      error: "No active market"
    };
  }

  if (!assets[symbol]) {
    return {
      success: false,
      error: "Invalid crypto symbol"
    };
  }

  if (!["YES", "NO"].includes(side)) {
    return {
      success: false,
      error: "Invalid trade side"
    };
  }

  const ticker = getMarketTicker(market);

  if (!ticker) {
    return {
      success: false,
      error: "Market ticker unavailable"
    };
  }

  // Prevent duplicate positions on the same market
  const duplicate = wallet.positions.some(
    position => position.ticker === ticker
  );

  if (duplicate) {
    return {
      success: false,
      error: "Already holding this market"
    };
  }

  if (
    wallet.positions.length >=
    SETTINGS.maxOpenPositions
  ) {
    return {
      success: false,
      error: "Maximum open positions reached"
    };
  }

  if (
    countOpenPositions(symbol) >=
    SETTINGS.maxOpenPositionsPerMarket
  ) {
    return {
      success: false,
      error: "Maximum positions for this crypto reached"
    };
  }

  const quotes = getQuotes(market);

  const entryPrice =
    side === "YES"
      ? quotes.yesAsk
      : quotes.noAsk;

  if (
    entryPrice === null ||
    entryPrice <= 0 ||
    entryPrice >= 1
  ) {
    return {
      success: false,
      error: "Invalid contract price"
    };
  }

  const cash = getAvailableBalance();

  // Keep $0.50 in the virtual wallet as a reserve
  const reserve = 0.50;
  const spendableCash = Math.max(
    0,
    cash - reserve
  );

  const requestedAmount = number(amount);

  if (
    requestedAmount === null ||
    requestedAmount <= 0
  ) {
    return {
      success: false,
      error: "Invalid trade amount"
    };
  }

  // Maximum $1 per position
  amount = Math.min(
    requestedAmount,
    1,
    spendableCash
  );

  if (amount < 0.25) {
    return {
      success: false,
      error: "Insufficient available cash"
    };
  }

  const contracts = amount / entryPrice;

  const position = {
    id: makePositionId(),

    symbol,
    asset: assets[symbol].name,

    side,
    ticker,

    amount,
    contracts,

    entryPrice,
    currentPrice: entryPrice,

    unrealizedPnL: 0,
    highestPnLPercent: 0,

    openedAt: new Date().toISOString(),

    features: signal?.features || {},

    confidence: signal?.confidence || 0.5,

    reason: signal?.reason || "Paper trade"
  };

  wallet.cash -= amount;

  wallet.positions.push(position);

  autoTrading.tradesOpened++;

  autoTrading.lastAction =
    `Bought ${side} ${symbol} for $${amount.toFixed(2)}`;

  scheduleStateSave();

  return {
    success: true,
    position
  };
}
// ------------------------------
// POSITION VALUE
// ------------------------------

function getPositionMark(position, market) {
  if (!market) return null;

  const quotes = getQuotes(market);

  return position.side === "YES"
    ? quotes.yesBid
    : quotes.noBid;
}

function getPositionValue(position) {
  return position.contracts * position.currentPrice;
}

function updatePositionPrices() {
  for (const position of wallet.positions) {
    const market = markets[position.symbol];

    if (!market) continue;

    const currentPrice = getPositionMark(
      position,
      market
    );

    if (
      currentPrice === null ||
      currentPrice < 0
    ) {
      continue;
    }

    position.currentPrice = currentPrice;

    const currentValue =
      position.contracts * currentPrice;

    position.unrealizedPnL =
      currentValue - position.amount;

    const pnlPercent =
      position.amount > 0
        ? position.unrealizedPnL / position.amount
        : 0;

    position.highestPnLPercent = Math.max(
      position.highestPnLPercent || 0,
      pnlPercent
    );
  }
}

// ------------------------------
// CLOSE PAPER TRADE
// ------------------------------

async function saveTradeLearning(
  position,
  pnl,
  outcome,
  closedAt
) {
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
    await supabaseRequest(
      "trade_learning",
      {
        method: "POST",

        headers: {
          Prefer: "return=minimal"
        },

        body: JSON.stringify(row)
      }
    );

  } catch (error) {
    console.error(
      "Learning save failed:",
      error.message
    );
  }
}

function closePosition(
  positionId,
  reason = "Manual close"
) {
  const index = wallet.positions.findIndex(
    position => position.id === positionId
  );

  if (index === -1) {
    return {
      success: false,
      error: "Position not found"
    };
  }

  const position = wallet.positions[index];

  const market = markets[position.symbol];

  const exitPrice = getPositionMark(
    position,
    market
  );

  if (exitPrice === null) {
    return {
      success: false,
      error: "Current market price unavailable"
    };
  }

  const proceeds =
    position.contracts * exitPrice;

  const pnl =
    proceeds - position.amount;

  wallet.cash += proceeds;

  wallet.realizedPnL += pnl;

  const closedAt = new Date().toISOString();

  const trade = {
    ...position,

    exitPrice,
    proceeds,
    pnl,

    outcome:
      pnl >= 0
        ? "WIN"
        : "LOSS",

    reason,
    closedAt
  };

  wallet.history.unshift(trade);

  wallet.history =
    wallet.history.slice(0, 500);

  wallet.positions.splice(index, 1);

  autoTrading.tradesClosed++;

  autoTrading.lastAction =
    `Closed ${position.side} ${position.symbol}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;

  updateLearningModel(trade);

  saveTradeLearning(
    position,
    pnl,
    trade.outcome,
    closedAt
  );

  scheduleStateSave();

  return {
    success: true,
    trade
  };
}

// ------------------------------
// LEARNING ENGINE
// ------------------------------

function updateLearningModel(trade) {
  learningModel.closedTrades++;

  if (trade.pnl >= 0) {
    learningModel.wins++;
  } else {
    learningModel.losses++;
  }

  const features = trade.features || {};

  const direction =
    trade.side === "YES" ? 1 : -1;

  const result =
    trade.pnl >= 0 ? 1 : -1;

  const adjustment =
    0.02 * direction * result;

  for (const key of FEATURE_KEYS) {
    const value = number(features[key]);

    if (value === null) continue;

    const scale =
      key.includes("Cents") ? 10 :
      key === "timeRemaining" ? 900 :
      100;

    const normalized = clamp(
      value / scale,
      -2,
      2
    );

    learningModel.weights[key] = clamp(
      (learningModel.weights[key] || 0) +
      adjustment * normalized,
      -2,
      2
    );
  }

  learningModel.lastUpdated =
    new Date().toISOString();
}

// ------------------------------
// AUTOMATIC BUY ENGINE
// ------------------------------

function automaticBuy(symbol, market, signal) {
  if (!autoTrading.enabled) return;

  if (
    !signal ||
    !signal.action.startsWith("BUY_")
  ) {
    return;
  }

  const now = Date.now();

  const lastTrade =
    lastAutoTrade[symbol] || 0;

  if (
    now - lastTrade <
    SETTINGS.signalCooldown
  ) {
    return;
  }

  if (
    countOpenPositions(symbol) >=
    SETTINGS.maxOpenPositionsPerMarket
  ) {
    return;
  }

  if (
    wallet.positions.length >=
    SETTINGS.maxOpenPositions
  ) {
    return;
  }

  const secondsRemaining =
    getSecondsRemaining(market);

  if (
    secondsRemaining !== null &&
    secondsRemaining <= 0
  ) {
    return;
  }

  const side =
    signal.action === "BUY_YES"
      ? "YES"
      : "NO";

  const amount = calculateTradeSize(
    signal.confidence || 0.5
  );

  if (amount <= 0) return;

  const result = buyPosition(
    symbol,
    side,
    amount,
    market,
    signal
  );

  if (result.success) {
    lastAutoTrade[symbol] = now;

    scheduleStateSave();
  }
}

// ------------------------------
// AUTOMATIC EXIT ENGINE
// ------------------------------

function automaticExitChecks() {
  updatePositionPrices();

  for (const position of [...wallet.positions]) {
    const market = markets[position.symbol];

    if (!market) continue;

    const secondsRemaining =
      getSecondsRemaining(market);

    const pnlPercent =
      position.amount > 0
        ? position.unrealizedPnL / position.amount
        : 0;

    if (
      secondsRemaining !== null &&
      secondsRemaining <= 0
    ) {
      closePosition(
        position.id,
        "Market expired"
      );

      continue;
    }

    if (
      pnlPercent >= SETTINGS.takeProfit
    ) {
      closePosition(
        position.id,
        "Take profit reached"
      );

      continue;
    }

    if (
      pnlPercent <= -SETTINGS.stopLoss
    ) {
      closePosition(
        position.id,
        "Stop loss reached"
      );

      continue;
    }

    if (
      position.highestPnLPercent >=
        SETTINGS.trailingActivation &&
      pnlPercent <=
        position.highestPnLPercent -
        SETTINGS.trailingGiveback
    ) {
      closePosition(
        position.id,
        "Trailing profit exit"
      );
    }
  }
}

// ------------------------------
// ASSET SCANNER
// ------------------------------

async function scanAsset(symbol) {
  await scanSpotPrice(symbol);

  const market = await refreshMarket(symbol);

  if (!market) return;

  const quotes = getQuotes(market);

  if (quotes.yesMid !== null) {
    recordContractPrice(
      symbol,
      quotes.yesMid
    );
  }

  const signal = getSignal(
    symbol,
    market
  );

  markets[symbol] = {
    ...market,
    botSignal: signal
  };

  if (autoTrading.enabled) {
    automaticBuy(
      symbol,
      market,
      signal
    );
  }
}

async function scanAll() {
  if (scanning) return;

  scanning = true;

  try {
    await Promise.all([
      scanAsset("BTC"),
      scanAsset("ETH")
    ]);

    automaticExitChecks();

    lastScan = new Date().toISOString();

  } catch (error) {
    console.error(
      "Scan error:",
      error.message
    );

  } finally {
    scanning = false;
  }
}
// ------------------------------
// PUBLIC MARKET DATA
// ------------------------------

function getPublicMarket(symbol) {
  const market = markets[symbol];

  if (!market) {
    return {
      symbol,
      name: assets[symbol].name,
      available: false,
      error: errors[symbol] || "Searching for market"
    };
  }

  const quotes = getQuotes(market);
  const signal = market.botSignal || null;

  return {
    symbol,
    name: assets[symbol].name,
    available: true,

    ticker: getMarketTicker(market),

    title: market.title || market.subtitle || "",

    secondsRemaining:
      getSecondsRemaining(market),

    spotPrice: spotPrices[symbol],

    yesBid: quotes.yesBid,
    yesAsk: quotes.yesAsk,

    noBid: quotes.noBid,
    noAsk: quotes.noAsk,

    yesMid: quotes.yesMid,

    signal,

    openPositions:
      countOpenPositions(symbol),

    error: errors[symbol] || null
  };
}

// ------------------------------
// PERFORMANCE
// ------------------------------

function getPerformance() {
  const wins = wallet.history.filter(
    trade => trade.pnl > 0
  ).length;

  const losses = wallet.history.filter(
    trade => trade.pnl < 0
  ).length;

  const totalTrades = wallet.history.length;

  const winRate =
    totalTrades > 0
      ? (wins / totalTrades) * 100
      : 0;

  const unrealizedPnL =
    wallet.positions.reduce(
      (sum, position) =>
        sum + (position.unrealizedPnL || 0),
      0
    );

  const openValue =
    wallet.positions.reduce(
      (sum, position) =>
        sum + getPositionValue(position),
      0
    );

  return {
    startingBalance: wallet.startingBalance,

    cash: wallet.cash,

    openValue,

    equity: wallet.cash + openValue,

    realizedPnL: wallet.realizedPnL,

    unrealizedPnL,

    totalPnL:
      wallet.realizedPnL + unrealizedPnL,

    totalTrades,

    wins,
    losses,

    winRate,

    openPositions: wallet.positions.length
  };
}

// ------------------------------
// BOT STATUS
// ------------------------------

function getStatus() {
  return {
    status: "online",

    bot: "Kalshi Paper Trading Bot",

    mode: "PAPER TRADING",

    autoTrading,

    settings: SETTINGS,

    wallet: {
      ...wallet,
      performance: getPerformance()
    },

    markets: {
      BTC: getPublicMarket("BTC"),
      ETH: getPublicMarket("ETH")
    },

    learning: {
      ...learningModel,

      enabled: true,

      mode: "adaptive",

      minimumTrades: SETTINGS.learningMinTrades,

      ready:
        learningModel.closedTrades >=
        SETTINGS.learningMinTrades
    },

    storage: {
      configured: supabaseReady(),

      connected: Boolean(lastSupabaseSave),

      lastSaved: lastSupabaseSave,

      error: supabaseError
    },

    lastScan
  };
}

// ------------------------------
// HTTP HELPERS
// ------------------------------

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type"
  });

  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", chunk => {
      body += chunk;

      if (body.length > 1000000) {
        reject(new Error("Request body too large"));

        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });
}

// ------------------------------
// API SERVER
// ------------------------------

const server = http.createServer(
  async (request, response) => {

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type"
      });

      return response.end();
    }

    const url = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );

    try {

      // HOME

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return sendJson(response, 200, {
          status: "online",
          bot: "Kalshi Paper Trading Bot",
          mode: "PAPER TRADING",
          dashboard: "/api/status"
        });
      }

      // HEALTH

      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        return sendJson(response, 200, {
          status: "healthy",
          timestamp: new Date().toISOString()
        });
      }

      // FULL STATUS

      if (
        request.method === "GET" &&
        url.pathname === "/api/status"
      ) {
        return sendJson(
          response,
          200,
          getStatus()
        );
      }

      // MARKETS

      if (
        request.method === "GET" &&
        url.pathname === "/api/markets"
      ) {
        return sendJson(response, 200, {
          BTC: getPublicMarket("BTC"),
          ETH: getPublicMarket("ETH")
        });
      }

      // PERFORMANCE

      if (
        request.method === "GET" &&
        url.pathname === "/api/performance"
      ) {
        return sendJson(
          response,
          200,
          getPerformance()
        );
      }

      // LEARNING

      if (
        request.method === "GET" &&
        url.pathname === "/api/learning"
      ) {
        return sendJson(response, 200, {
          enabled: true,

          mode: "adaptive",

          minimumTrades:
            SETTINGS.learningMinTrades,

          ready:
            learningModel.closedTrades >=
            SETTINGS.learningMinTrades,

          ...learningModel
        });
      }

      // SETTINGS

      if (
        request.method === "GET" &&
        url.pathname === "/api/settings"
      ) {
        return sendJson(
          response,
          200,
          SETTINGS
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/settings"
      ) {
        const body = await readBody(request);

        for (const key of Object.keys(SETTINGS)) {
          if (!(key in body)) continue;

          if (
            typeof SETTINGS[key] === "boolean"
          ) {
            if (
              typeof body[key] === "boolean"
            ) {
              SETTINGS[key] = body[key];
            }
          } else {
            const value = number(body[key]);

            if (
              value !== null &&
              value >= 0
            ) {
              SETTINGS[key] = value;
            }
          }
        }

        scheduleStateSave();

        return sendJson(response, 200, {
          success: true,
          settings: SETTINGS
        });
      }

      // MANUAL PAPER BUY

      if (
        request.method === "POST" &&
        url.pathname === "/api/paper/buy"
      ) {
        const body = await readBody(request);

        const symbol =
          String(body.symbol || "").toUpperCase();

        const side =
          String(body.side || "").toUpperCase();

        if (!assets[symbol]) {
          return sendJson(response, 400, {
            success: false,
            error: "Symbol must be BTC or ETH"
          });
        }

        const amount = number(body.amount);

        const result = buyPosition(
          symbol,
          side,
          amount,
          markets[symbol],
          {
            reason: "Manual paper trade"
          }
        );

        return sendJson(
          response,
          result.success ? 200 : 400,
          result
        );
      }

      // MANUAL PAPER SELL

      if (
        request.method === "POST" &&
        url.pathname === "/api/paper/sell"
      ) {
        const body = await readBody(request);

        const result = closePosition(
          body.positionId,
          body.reason || "Manual close"
        );

        return sendJson(
          response,
          result.success ? 200 : 400,
          result
        );
      }

      // PAUSE AUTO TRADING

      if (
        request.method === "POST" &&
        url.pathname === "/api/auto/pause"
      ) {
        autoTrading.enabled = false;

        autoTrading.lastAction =
          "Automatic trading paused";

        scheduleStateSave();

        return sendJson(response, 200, {
          success: true,
          autoTrading
        });
      }

      // RESUME AUTO TRADING

      if (
        request.method === "POST" &&
        url.pathname === "/api/auto/resume"
      ) {
        autoTrading.enabled = true;

        autoTrading.lastAction =
          "Automatic trading resumed";

        scheduleStateSave();

        return sendJson(response, 200, {
          success: true,
          autoTrading
        });
      }

      // OPEN POSITIONS

      if (
        request.method === "GET" &&
        url.pathname === "/api/positions"
      ) {
        updatePositionPrices();

        return sendJson(response, 200, {
          positions: wallet.positions,

          cash: wallet.cash,

          performance: getPerformance()
        });
      }

      // TRADE HISTORY

      if (
        request.method === "GET" &&
        url.pathname === "/api/history"
      ) {
        return sendJson(response, 200, {
          history: wallet.history
        });
      }

      // UNKNOWN ROUTE

      return sendJson(response, 404, {
        success: false,
        error: "Route not found"
      });

    } catch (error) {
      console.error(
        "Server request error:",
        error.message
      );

      return sendJson(response, 500, {
        success: false,
        error: error.message
      });
    }
  }
);

// ------------------------------
// START BOT
// ------------------------------

async function startBot() {
  console.log(
    "Starting Kalshi Paper Trading Bot..."
  );

  await loadPersistentState();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(
      `Bot server listening on port ${PORT}`
    );

    console.log(
      "Paper wallet:",
      wallet.cash
    );

    console.log(
      "BTC and ETH enabled"
    );

    console.log(
      "Automatic trading:",
      autoTrading.enabled
    );

    console.log(
      "Scan interval:",
      SETTINGS.scanInterval
    );

    console.log(
      "Prediction window:",
      SETTINGS.predictionWindowSeconds
    );
  });

  // Start scanning

  await scanAll();

  setInterval(() => {
    scanAll().catch(error => {
      console.error(
        "Scheduled scan failed:",
        error.message
      );
    });
  }, SETTINGS.scanInterval);

  // Monitor exits

  setInterval(() => {
    automaticExitChecks();
  }, 1000);

  // Save state

  setInterval(() => {
    persistState().catch(error => {
      console.error(
        "Scheduled save failed:",
        error.message
      );
    });
  }, 15000);
}

// ------------------------------
// STARTUP ERROR HANDLING
// ------------------------------

startBot().catch(error => {
  console.error(
    "Bot startup failed:",
    error
  );

  process.exit(1);
});
