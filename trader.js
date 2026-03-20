const axios = require("axios");

class Trader {
  constructor(config) {
    this.client = config.client;
    this.symbol = config.symbol;
    this.instrumentToken = config.instrumentToken;
    this.exchangeSegment = config.exchangeSegment;
    this.product = config.product || "NRML";
    this.orderType = config.orderType || "L";
    this.transactionType = config.transactionType || "B";
    this.quantity = config.quantity || 1;
    this.priceDiffThreshold = config.priceDiffThreshold || 200;
    this._pendingOrder = null;
  }

  async tick() {
    const tag = `[${this.symbol}]`;
    if (!this.instrumentToken) {
      const fetchedInstrumentToken = await this._getInstrumentToken();
      console.log(`${tag} Instrument token: ${fetchedInstrumentToken}`);
      this.instrumentToken = fetchedInstrumentToken;
    }
    const scripData = await this.client.getScripDetails(`${this.exchangeSegment}|${this.instrumentToken}`);
    console.log(scripData[0].depth);
    const { ltp, bestBid, bestAsk} = this._parseScripDetails(scripData);

    if (!ltp) {
      console.warn(`${tag} Could not parse LTP`, JSON.stringify(scripData));
      return;
    }

    const bidDiff = bestBid !== null ? Math.abs(ltp - bestBid) : null;
    const askDiff = bestAsk !== null ? Math.abs(ltp - bestAsk) : null;
    console.log(`${tag} LTP: ${ltp}` + (bestBid !== null ? ` | Bid: ${bestBid} (diff: ${bidDiff?.toFixed(2)})` : "") + (bestAsk !== null ? ` | Ask: ${bestAsk} (diff: ${askDiff?.toFixed(2)})` : ""));

    const trigger = this._evaluateTrigger(ltp, bestBid, bestAsk);
    if (!trigger.triggered) {
      console.log(`${tag} Diff below threshold (${this.priceDiffThreshold}). No action.`);
      return;
    }

    console.log(`${tag} *** TRIGGERED — side: ${trigger.side} | diff: ${trigger.diff.toFixed(2)} | target: ${trigger.orderPrice} ***`);

    /* check for open position */
    const positions = this._parsePositions(await this.client.getPositions());
    const openPosition = positions.find((p) => (p.trdSym || "").includes(this.symbol));
    if (openPosition) {
      console.log(`${tag} Open position already exists — qty: ${openPosition.qty || "?"}. No action.`);
      return;
    }

    /* check for pending orders */
    const orders  = this._parsePositions(await this.client.getOrders());
    const pendingOrders = orders.find((p) => (p.trdSym || "").includes(this.symbol) && (p.stat === "pending"));
    if (pendingOrders) {
      console.log(`${tag} Pending order already exists - qty: ${pendingOrders.brdLtQty || "?"}. No action.`);
      return;
    }

    console.log(`${tag} No pending order. Placing ${this.transactionType === "B" ? "BUY" : "SELL"} ${this.orderType} @ ${trigger.orderPrice + 0.1}...`);
    await this._placeOrder(trigger.orderPrice + 0.1);
  }

  _getInstrumentToken = async () => {
    const fileMapper = {
      mcx_fo: "mcx_fo",
      cde_fo: "cde_fo",
      nse_fo: "nse_fo",
      bse_fo: "bse_fo",
      nse_com: "nse_com",
      bse_cm: "bse_cm-v1",
      nse_cm: "nse_cm-v1",
    };
    process.stdout.write("Downloading Daily Scrip Master... 0%");
    const response = await axios.get("https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-03-20/transformed/" + fileMapper[this.exchangeSegment] + ".csv", {
      onDownloadProgress: (progressEvent) => {
        if (progressEvent.total) {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          process.stdout.write(`\rDownloading Daily Scrip Master... ${percentCompleted}%`);
        } else {
          process.stdout.write(`\rDownloading Daily Scrip Master... ${progressEvent.loaded} bytes`);
        }
      }
    });
    console.log("\nDownloaded Daily Scrip Master.");
    const rows = response.data.split("\n");

    const headers = rows[0].split(",");
    const pSymbolIndex = headers.indexOf("pSymbol");
    const pTrdSymbolIndex = headers.indexOf("pTrdSymbol");

    /* delete header row */
    rows.shift();
    for (const row of rows) {
      const cols = row.split(",");
      if (cols[pTrdSymbolIndex] === this.symbol) {
        return cols[pSymbolIndex];
      }
    }
  };

  _evaluateTrigger(ltp, bestBid, bestAsk) {
    const bidDiff = bestBid !== null ? Math.abs(ltp - bestBid) : 0;
    const askDiff = bestAsk !== null ? Math.abs(ltp - bestAsk) : 0;
    if (bidDiff > this.priceDiffThreshold) return { triggered: true, side: "BID", orderPrice: bestBid, diff: bidDiff };
    /* enable in future */
    // if (askDiff > this.priceDiffThreshold) return { triggered: true, side: "ASK", orderPrice: bestAsk, diff: askDiff };
    return { triggered: false, side: null, orderPrice: null, diff: 0 };
  }

  async _placeOrder(price) {
    try {
      const res = await this.client.placeOrder({
        exchangeSegment: this.exchangeSegment,
        product: this.product,
        orderType: this.orderType,
        quantity: this.quantity,
        tradingSymbol: this.symbol,
        transactionType: this.transactionType,
        price,
        instrumentToken: this.instrumentToken,
      });
      const orderId = res?.data?.nOrdNo || res?.nOrdNo || res?.ordNo;
      console.log(`[${this.symbol}] Order placed — id: ${orderId}`);
      if (orderId) this._pendingOrder = { id: orderId, price };
    } catch (err) {
      console.error(`[${this.symbol}] Place order failed: ${err.response?.data || err.message}`);
    }
  }

  async _modifyOrder(pending, newPrice) {
    try {
      await this.client.modifyOrder({
        orderId: pending.id,
        exchangeSegment: this.exchangeSegment,
        product: this.product,
        orderType: this.orderType,
        quantity: this.quantity,
        tradingSymbol: this.symbol,
        transactionType: this.transactionType,
        price: newPrice,
        instrumentToken: this.instrumentToken,
      });
      console.log(`[${this.symbol}] Order modified to ${newPrice}`);
      this._pendingOrder.price = newPrice;
    } catch (err) {
      console.error(`[${this.symbol}] Modify order failed: ${err.response?.data || err.message}`);
    }
  }

  _parseScripDetails(raw) {
    try {
      const item = Array.isArray(raw?.data || raw) ? (raw?.data || raw)[0] : raw?.data || raw;
      const ltp = parseFloat(item?.ltp ?? item?.LTP ?? item?.lastPrice ?? NaN);
      const depth = item?.depth || item?.marketDepth || {};
      const buySide = depth?.buy || depth?.bids || [];
      const sellSide = depth?.sell || depth?.asks || [];
      const bestBid = buySide.length > 0 ? parseFloat(buySide[0].price ?? buySide[0].prc ?? NaN) : null;
      const bestAsk = sellSide.length > 0 ? parseFloat(sellSide[0].price ?? sellSide[0].prc ?? NaN) : null;
      return { ltp: isNaN(ltp) ? null : ltp, bestBid: isNaN(bestBid) ? null : bestBid, bestAsk: isNaN(bestAsk) ? null : bestAsk };
    } catch {
      return { ltp: null, bestBid: null, bestAsk: null };
    }
  }

  _parsePositions(raw) {
    try {
      const list = raw?.data || raw?.positions || raw;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
}

module.exports = Trader;
