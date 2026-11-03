const express = require(“express”);
const cors = require(“cors”);
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;
const API = “https://external-api.kalshi.com/trade-api/v2”;
const ASSETS = [
{ name: “Bitcoin”, series: “KXBTC15M” },
{ name: “Ethereum”, series: “KXETH15M” }
];
async function getMarkets(series) {
const url =
${API}/markets?series_ticker=${series}&status=open&limit=200;
const response = await fetch(url);
if (!response.ok) {
throw new Error(Kalshi API error: ${response.status});
}
const data = await response.json();
const now = Date.now();
return (data.markets || [])
.filter(m => {
if (m.status !== “open”) return false;
if (!m.close_time) return true;
return new Date(m.close_time).getTime() > now;
})
.sort((a, b) =>
new Date(a.close_time || 0) -
new Date(b.close_time || 0)
);
}
function formatMarket(market, asset) {
return {
asset: asset.name,
ticker: market.ticker,
title: market.title,
status: market.status,
closeTime: market.close_time,
yesBid: market.yes_bid_dollars ?? null,
yesAsk: market.yes_ask_dollars ?? null,
noBid: market.no_bid_dollars ?? null,
noAsk: market.no_ask_dollars ?? null,
lastPrice: market.last_price_dollars ?? null,
volume: market.volume_fp ?? null
};
}
app.get(”/”, (req, res) => {
res.json({
bot: “Kalshi Paper Trading Backend”,
status: “online”,
assets: [“BTC”, “ETH”]
});
});
app.get(”/health”, (req, res) => {
res.json({
status: “healthy”,
timestamp: new Date().toISOString()
});
});
app.get(”/api/markets”, async (req, res) => {
const results = await Promise.all(
ASSETS.map(async asset => {
try {
const markets = await getMarkets(asset.series);
    return {
      asset: asset.name,
      series: asset.series,
      count: markets.length,
      market: markets.length
        ? formatMarket(markets[0], asset)
        : null,
      error: null
    };
  } catch (error) {
    return {
      asset: asset.name,
      series: asset.series,
      count: 0,
      market: null,
      error: error.message
    };
  }
})
);
res.json({
timestamp: new Date().toISOString(),
markets: results
});
});
app.listen(PORT, “0.0.0.0”, () => {
console.log(Kalshi backend running on port ${PORT});
});
