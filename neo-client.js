const axios = require("axios");
const qs = require("qs");

const LOGIN_BASE = "https://mis.kotaksecurities.com";
const DATA_BASE = "https://cis.kotaksecurities.com";
const NEO_FIN_KEY = "neotradeapi";

class NeoClient {
  constructor({ apiKey, mobileNumber, ucc }) {
    this.apiKey = apiKey;
    this.mobileNumber = mobileNumber;
    this.ucc = ucc;
    this._tempSid = null;
    this._tempAuth = null;
    this.sid = null;
    this.auth = null;
  }

  async login(totp) {
    const res = await axios.post(
      `${LOGIN_BASE}/login/1.0/tradeApiLogin`,
      { mobileNumber: this.mobileNumber, ucc: this.ucc, totp },
      { headers: { "Content-Type": "application/json", Authorization: this.apiKey, "neo-fin-key": NEO_FIN_KEY } },
    );
    const payload = res.data?.data || res.data;
    this._tempSid = payload?.sid || payload?.SID;
    this._tempAuth = payload?.token || payload?.auth || payload?.Auth;
    if (!this._tempSid || !this._tempAuth) throw new Error(`tradeApiLogin: could not extract sid/token: ${JSON.stringify(res.data)}`);
    return res.data;
  }

  async validate(mpin) {
    if (!this._tempSid || !this._tempAuth) throw new Error("Call login() before validate()");
    const res = await axios.post(
      `${LOGIN_BASE}/login/1.0/tradeApiValidate`,
      { mpin },
      { headers: { "Content-Type": "application/json", Authorization: this.apiKey, "neo-fin-key": NEO_FIN_KEY, sid: this._tempSid, Auth: this._tempAuth } },
    );
    const payload = res.data?.data || res.data;
    this.sid = payload?.sid || payload?.SID;
    this.auth = payload?.token || payload?.auth || payload?.Auth;
    if (!this.sid || !this.auth) throw new Error(`tradeApiValidate: could not extract final sid/token: ${JSON.stringify(res.data)}`);
    return res.data;
  }

  setSession({ sid, auth }) {
    this.sid = sid;
    this.auth = auth;
  }

  async getScripDetails(symbol) {
    try {
      const joined = Array.isArray(symbol) ? symbol.join(",") : symbol;
      const res = await axios.get(`${DATA_BASE}/script-details/1.0/quotes/neosymbol/${encodeURIComponent(joined)}/all`, { headers: this._dataHeaders() });
      return res.data;
    } catch (e) {
      console.error("Error occured while fetching scrip details:", e);
      return false;
    }
  }

  async getPositions() {
    const res = await axios.get(`${DATA_BASE}/quick/user/positions`, { headers: this._dataHeaders() });
    return res.data;
  }

  async getOrders() {
    const res = await axios.get(`${DATA_BASE}/quick/user/orders`, { headers: this._dataHeaders() });
    return res.data;
  }

  async placeOrder({ exchangeSegment, product, orderType, quantity, validity = "DAY", tradingSymbol, transactionType, price, triggerPrice = "0", amo = "NO" }) {
    const jData = JSON.stringify({
      am: amo,
      dq: "0",
      es: exchangeSegment,
      mp: "0",
      pc: product,
      pf: "N",
      pr: String(price),
      pt: orderType,
      qt: String(quantity),
      rt: validity,
      tp: String(triggerPrice),
      ts: tradingSymbol,
      tt: transactionType,
    });
    const res = await axios.post(`${DATA_BASE}/quick/order/rule/ms/place`, new URLSearchParams({ jData }), {
      headers: { ...this._dataHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    });
    return res.data;
  }

  async modifyOrder({ exchangeSegment, product, orderType, quantity, validity = "DAY", tradingSymbol, transactionType, price, triggerPrice = "0", amo = "NO", orderNo }) {
    const jData = JSON.stringify({
      am: amo,
      dq: "0",
      es: exchangeSegment,
      mp: "0",
      pc: product,
      pf: "N",
      pr: String(price),
      pt: orderType,
      qt: String(quantity),
      rt: validity,
      tp: String(triggerPrice),
      ts: tradingSymbol,
      tt: transactionType,
      no: orderNo
    });
    const res = await axios.post(`${DATA_BASE}/quick/order/vr/modify`, new URLSearchParams({ jData }), {
      headers: { ...this._dataHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    });
    return res.data;
  }

  async cancelOrder(orderId) {
    const jData = JSON.stringify({ no: orderId });
    const res = await axios.post(`${DATA_BASE}/quick/order/rule/ms/cancel`, new URLSearchParams({ jData }), {
      headers: { ...this._dataHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    });
    return res.data;
  }

  _dataHeaders() {
    if (!this.sid || !this.auth) throw new Error("Session not initialised — call login() + validate() first");
    return { Authorization: this.apiKey, "neo-fin-key": NEO_FIN_KEY, Sid: this.sid, Auth: this.auth, "Content-Type": "application/json" };
  }
}

module.exports = NeoClient;
