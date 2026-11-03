const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;

function getKalshiData(path) {
  return new Promise((resolve, reject) => {
    https.get(
      "https://external-api.kalshi.com/trade-api/v2" + path,
      (response) => {
        let data = "";

        response.on("data", chunk => data += chunk);

        response.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      }
    ).on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/" || req.url === "/health") {
    res.end(JSON.stringify({
      status: "online",
      bot: "Kalshi Paper Trading Bot"
    }));
    return;
  }

  if (req.url === "/api/markets") {
    try {
      const results = await Promise.all(
        ["KXBTC15M", "KXETH15M"].map(async series => {
          try {
            const data = await getKalshiData(
              "/markets?series_ticker=" + series + "&limit=100"
            );

            return {
              series,
              count: (data.markets || []).length,
              markets: data.markets || [],
              error: null
            };
          } catch (error) {
            return {
              series,
              count: 0,
              markets: [],
              error: error.message
            };
          }
        })
      );

      res.end(JSON.stringify({
        timestamp: new Date().toISOString(),
        results
      }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Kalshi bot server running on port " + PORT);
});

server.on("error", error => {
  console.error("SERVER ERROR:", error);
});
