require("dotenv").config();
const readline  = require("readline");
const NeoClient = require("./neo-client");
const Trader    = require("./trader");

// ─── Runtime state ────────────────────────────────────────────────────────────

const state = {
  symbols:            (process.env.SYMBOL           || "").split(",").map(s => s.trim()).filter(Boolean),
  instrumentTokens:   (process.env.INSTRUMENT_TOKEN || "").split(",").map(t => t.trim()),
  exchangeSegment:    process.env.EXCHANGE_SEGMENT   || "mcx_fo",
  product:            process.env.PRODUCT            || "NRML",
  orderType:          process.env.ORDER_TYPE         || "L",
  transactionType:    process.env.TRANSACTION_TYPE   || "B",
  quantity:           parseInt(process.env.QUANTITY  || "1", 10),
  priceDiffThreshold: parseFloat(process.env.PRICE_DIFF_THRESHOLD || "200"),
  pollIntervalMs:     parseInt(process.env.POLL_INTERVAL_MS       || "5000", 10),
};

const cfg = {
  apiKey:       process.env.API_KEY,
  mobileNumber: process.env.MOBILE_NUMBER,
  ucc:          process.env.UCC,
  sessionSid:   process.env.SESSION_SID,
  sessionAuth:  process.env.SESSION_AUTH,
};

// ─── Prompts ──────────────────────────────────────────────────────────────────

function rawPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// Dynamic import of ESM @inquirer/select
async function selectPrompt(message, choices) {
  const { default: select } = await import("@inquirer/select");
  return select({ message, choices });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate(client) {
  if (cfg.sessionSid && cfg.sessionAuth) {
    client.setSession({ sid: cfg.sessionSid, auth: cfg.sessionAuth });
    process.stdout.write("[Auth] Using saved session from .env\n");
    return;
  }

  process.stdout.write("\n=== Kotak Neo Login ===\n");
  const totp = await rawPrompt("Enter TOTP: ");
  process.stdout.write("[Auth] Step 1 — tradeApiLogin ... ");
  await client.login(totp);
  process.stdout.write("done\n");

  const mpin = await rawPrompt("Enter MPIN: ");
  process.stdout.write("[Auth] Step 2 — tradeApiValidate ... ");
  await client.validate(mpin);
  process.stdout.write("done\n[Auth] Login complete.\n\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTraders(client) {
  return state.symbols.map((symbol, i) => {
    const instrumentToken = state.instrumentTokens[i] ?? state.instrumentTokens[0] ?? "";
    return new Trader({ client, symbol, instrumentToken, exchangeSegment: state.exchangeSegment, product: state.product, orderType: state.orderType, transactionType: state.transactionType, quantity: state.quantity, priceDiffThreshold: state.priceDiffThreshold });
  });
}

function printState() {
  console.log("─── Current Settings ────────────────────────────────");
  console.log(`  Symbols:    ${state.symbols.join(", ") || "(none)"}`);
  console.log(`  Segment:    ${state.exchangeSegment}`);
  console.log(`  Side:       ${state.transactionType === "B" ? "BUY" : "SELL"}`);
  console.log(`  Order type: ${state.orderType}  Product: ${state.product}  Qty: ${state.quantity}`);
  console.log(`  Threshold:  ${state.priceDiffThreshold} pts`);
  console.log(`  Interval:   ${state.pollIntervalMs} ms`);
  console.log("─────────────────────────────────────────────────────");
}

async function runOnce(traders) {
  await Promise.allSettled(
    traders.map(t => t.tick().catch(err => console.error(`[${t.symbol}] Tick error: ${err.message}`)))
  );
}

// ─── /set command ─────────────────────────────────────────────────────────────

async function runSetCommand(client, intervalRef, tradersRef) {
  clearInterval(intervalRef.id);
  intervalRef.id = null;

  process.stdout.write("\n[/set] Polling paused. Configure settings:\n\n");

  const field = await selectPrompt("What do you want to change?", [
    { name: "Symbol & Instrument Token",   value: "symbol" },
    { name: "Exchange Segment",            value: "segment" },
    { name: "Transaction Type (Buy/Sell)", value: "transactionType" },
    { name: "Order Type",                  value: "orderType" },
    { name: "Quantity",                    value: "quantity" },
    { name: "Price Diff Threshold",        value: "threshold" },
    { name: "Poll Interval",               value: "interval" },
    { name: "Done — resume polling",       value: "done" },
  ]);

  if (field !== "done") {
    switch (field) {
      case "symbol": {
        const sym = await rawPrompt("  Symbol (e.g. CRUDEOIL26MAYFUT): ");
        const tok = await rawPrompt("  Instrument Token: ");
        if (sym) { state.symbols = [sym.trim()]; state.instrumentTokens = [tok.trim()]; }
        break;
      }
      case "segment":
        state.exchangeSegment = await selectPrompt("Exchange segment", [
          { name: "NSE F&O  (nse_fo)", value: "nse_fo" },
          { name: "MCX F&O  (mcx_fo)", value: "mcx_fo" },
        ]);
        break;
      case "transactionType":
        state.transactionType = await selectPrompt("Transaction type", [
          { name: "BUY  (B)", value: "B" },
          { name: "SELL (S)", value: "S" },
        ]);
        break;
      case "orderType":
        state.orderType = await selectPrompt("Order type", [
          { name: "Limit (L)",        value: "L" },
          { name: "Market (MKT)",     value: "MKT" },
          { name: "Stop Loss (SL)",   value: "SL" },
          { name: "SL-Market (SL-M)", value: "SL-M" },
        ]);
        break;
      case "quantity": {
        const v = parseInt(await rawPrompt("  Quantity: "), 10);
        if (!isNaN(v) && v > 0) state.quantity = v;
        break;
      }
      case "threshold": {
        const v = parseFloat(await rawPrompt("  Price diff threshold (pts): "));
        if (!isNaN(v) && v > 0) state.priceDiffThreshold = v;
        break;
      }
      case "interval": {
        const v = parseInt(await rawPrompt("  Poll interval (ms): "), 10);
        if (!isNaN(v) && v >= 1000) state.pollIntervalMs = v;
        break;
      }
    }
  }

  printState();
  console.log("[/set] Polling resumed.");

  tradersRef.traders = buildTraders(client);
  intervalRef.id = setInterval(() => runOnce(tradersRef.traders), state.pollIntervalMs);

  startInputLoop(client, intervalRef, tradersRef);
}

// ─── Input loop ───────────────────────────────────────────────────────────────

function startInputLoop(client, intervalRef, tradersRef) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();

  rl.on("line", async (line) => {
    const cmd = line.trim();
    rl.pause();

    if (cmd === "/set") {
      rl.close();
      await runSetCommand(client, intervalRef, tradersRef);
    } else if (cmd === "/status") {
      printState();
      rl.prompt();
      rl.resume();
    } else if (cmd) {
      console.log(`Unknown command "${cmd}". Available: /set  /status`);
      rl.prompt();
      rl.resume();
    } else {
      rl.prompt();
      rl.resume();
    }
  });

  rl.on("close", () => {
    if (intervalRef.id !== null) {
      clearInterval(intervalRef.id);
    }
    process.exit(0);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!cfg.apiKey) { process.stderr.write("ERROR: API_KEY must be set in .env\n"); process.exit(1); }
  if (!cfg.mobileNumber || !cfg.ucc) { process.stderr.write("ERROR: MOBILE_NUMBER and UCC must be set in .env\n"); process.exit(1); }

  const client = new NeoClient({ apiKey: cfg.apiKey, mobileNumber: cfg.mobileNumber, ucc: cfg.ucc });

  await authenticate(client);

  state.exchangeSegment = await selectPrompt("Select exchange segment to trade", [
    { name: "NSE F&O  (nse_fo)", value: "nse_fo" },
    { name: "MCX F&O  (mcx_fo)", value: "mcx_fo" },
  ]);
  process.stdout.write(`  → Selected: ${state.exchangeSegment}\n\n`);

  if (state.symbols.length === 0) { process.stderr.write("ERROR: No SYMBOL configured in .env\n"); process.exit(1); }

  const tradersRef  = { traders: [] };
  const intervalRef = { id: null };

  tradersRef.traders = buildTraders(client);

  // First tick immediately
  await runOnce(tradersRef.traders);

  printState();
  console.log("Ready. Type /set to change settings, /status to view config.");

  // Start polling
  intervalRef.id = setInterval(() => runOnce(tradersRef.traders), state.pollIntervalMs);

  // Start reading commands
  startInputLoop(client, intervalRef, tradersRef);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
