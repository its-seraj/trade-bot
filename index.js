require("dotenv").config();
const readline = require("readline");
const NeoClient = require("./neo-client");
const Trader = require("./trader");
const { stat } = require("fs");

// ─── Sticky Input Overrides ───────────────────────────────────────────────────

let currentRl = null;
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function printWithSticky(logger, args) {
  if (currentRl) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  logger(...args);
  if (currentRl) {
    currentRl.prompt(true);
  }
}

console.log = (...args) => printWithSticky(origLog, args);
console.warn = (...args) => printWithSticky(origWarn, args);
console.error = (...args) => printWithSticky(origError, args);

// ─── Runtime state ────────────────────────────────────────────────────────────

const state = {
  symbol: process.env.SYMBOL,
  instrumentTokens: process.env.INSTRUMENT_TOKEN,
  exchangeSegment: process.env.EXCHANGE_SEGMENT,
  product: process.env.PRODUCT || "NRML",
  orderType: process.env.ORDER_TYPE || "L",
  transactionType: process.env.TRANSACTION_TYPE || "B",
  quantity: parseInt(process.env.QUANTITY || "1", 10),
  priceDiffThreshold: parseFloat(process.env.PRICE_DIFF_THRESHOLD || "200"),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
};

const cfg = {
  apiKey: process.env.API_KEY,
  mobileNumber: process.env.MOBILE_NUMBER,
  ucc: process.env.UCC,
  sessionSid: process.env.SESSION_SID,
  sessionAuth: process.env.SESSION_AUTH,
};

// ─── Prompts ──────────────────────────────────────────────────────────────────

function rawPrompt(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const onData = (buf) => {
      if (buf.toString() === "\x1b") {
        // Detect Escape key
        process.stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
        reject(new Error("ExitPromptError"));
      }
    };
    process.stdin.on("data", onData);
    rl.question(question, (ans) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      resolve(ans ? ans.trim() : "");
    });
  });
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

function buildTrader(client) {
  return new Trader({
    client,
    symbol: state.symbol,
    exchangeSegment: state.exchangeSegment,
    product: state.product,
    orderType: state.orderType,
    transactionType: state.transactionType,
    quantity: state.quantity,
    priceDiffThreshold: state.priceDiffThreshold,
  });
}

function printState() {
  console.log("─── Current Settings ────────────────────────────────");
  console.log(`  Symbol:     ${state.symbol}`);
  console.log(`  Segment:    ${state.exchangeSegment}`);
  console.log(`  Side:       ${state.transactionType === "B" ? "BUY" : "SELL"}`);
  console.log(`  Order type: ${state.orderType}  Product: ${state.product}  Qty: ${state.quantity}`);
  console.log(`  Threshold:  ${state.priceDiffThreshold} pts`);
  console.log(`  Interval:   ${state.pollIntervalMs} ms`);
  console.log("─────────────────────────────────────────────────────");
}

async function runOnce(trader) {
  await trader.tick();
}

// ─── /set command ─────────────────────────────────────────────────────────────

async function runSetCommand(client, intervalRef, traderRef) {
  clearInterval(intervalRef.id);
  intervalRef.id = null;

  let field;
  while (field !== "done") {
    printState();
    try {
      field = await selectPrompt("\n[/set] Polling paused. Configure settings:\n\nWhat do you want to change?", [
        { name: "Symbol & Instrument Token", value: "symbol" },
        { name: "Exchange Segment", value: "segment" },
        { name: "Transaction Type (Buy/Sell)", value: "transactionType" },
        { name: "Order Type", value: "orderType" },
        { name: "Quantity", value: "quantity" },
        { name: "Price Diff Threshold", value: "threshold" },
        { name: "Poll Interval", value: "interval" },
        { name: "Done — resume polling", value: "done" },
      ]);

      if (field !== "done") {
        switch (field) {
          case "symbol": {
            const sym = await rawPrompt("\n  Current Symbol: " + state.symbol + "\n  Enter New Symbol: ");
            if (sym) {
              state.symbol = [sym.trim()];
            }
            break;
          }
          case "segment":
            state.exchangeSegment = await selectPrompt("Exchange segment", [
              { name: "MCX F&O  (mcx_fo)", value: "mcx_fo" },
              { name: "NSE F&O  (nse_fo)", value: "nse_fo" },
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
              { name: "Limit (L)", value: "L" },
              { name: "Market (MKT)", value: "MKT" },
              { name: "Stop Loss (SL)", value: "SL" },
              { name: "SL-Market (SL-M)", value: "SL-M" },
            ]);
            break;
          case "quantity": {
            const v = parseInt(await rawPrompt("\n  Current Quantity: " + state.quantity + "\n  Enter New Quantity: "), 10);
            if (!isNaN(v) && v > 0) state.quantity = v;
            break;
          }
          case "threshold": {
            const v = parseFloat(await rawPrompt("\n  Current threshold: " + state.priceDiffThreshold + "\n  Price diff threshold (pts): "));
            if (!isNaN(v) && v > 0) state.priceDiffThreshold = v;
            break;
          }
          case "interval": {
            const v = parseInt(await rawPrompt("\n  Current Poll interval: " + state.pollIntervalMs + "\n  Enter New Poll interval (ms): "), 10);
            if (!isNaN(v) && v >= 1000) state.pollIntervalMs = v;
            break;
          }
        }
      }
    } catch (err) {
      // Inquirer and custom rawPrompt throw when cancelled (e.g., via ESC or Ctrl+C)
      field = "done";
      console.log("\n[Canceled] Returning to terminal...");
    }
  }

  printState();
  console.log("[/set] Polling resumed.");

  traderRef.trader = buildTrader(client);
  intervalRef.id = setInterval(() => runOnce(traderRef.trader), state.pollIntervalMs);
}

// ─── Input loop ───────────────────────────────────────────────────────────────

function startInputLoop(client, intervalRef, traderRef) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  currentRl = rl;
  rl.resume(); // Ensure the input stream is unpaused
  rl.prompt();
  let isAppClosing = true;

  rl.on("line", async (line) => {
    const cmd = line.trim();
    currentRl = null; // Disable sticky during command processing

    if (cmd === "/set") {
      isAppClosing = false;
      rl.close(); // Close BEFORE running prompts so Inquirer doesn't conflict
      await runSetCommand(client, intervalRef, traderRef);
      startInputLoop(client, intervalRef, traderRef);
    } else if (cmd === "/status") {
      printState();
      currentRl = rl;
      rl.prompt();
    } else if (cmd) {
      console.log(`Unknown command "${cmd}". Available: /set  /status`);
      currentRl = rl;
      rl.prompt();
    } else {
      currentRl = rl;
      rl.prompt();
    }
  });

  rl.on("close", () => {
    if (currentRl === rl) {
      currentRl = null;
    }
    if (isAppClosing) {
      if (intervalRef.id !== null) {
        clearInterval(intervalRef.id);
      }
      process.exit(0);
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!cfg.apiKey) {
    process.stderr.write("ERROR: API_KEY must be set in .env\n");
    process.exit(1);
  }
  if (!cfg.mobileNumber || !cfg.ucc) {
    process.stderr.write("ERROR: MOBILE_NUMBER and UCC must be set in .env\n");
    process.exit(1);
  }

  const client = new NeoClient({ apiKey: cfg.apiKey, mobileNumber: cfg.mobileNumber, ucc: cfg.ucc });

  await authenticate(client);

  state.exchangeSegment = await selectPrompt("Select exchange segment to trade", [
    { name: "MCX F&O  (mcx_fo)", value: "mcx_fo" },
    { name: "NSE F&O  (nse_fo)", value: "nse_fo" },
  ]);
  process.stdout.write(`  → Selected: ${state.exchangeSegment}\n\n`);

  if (state.symbol.length === 0) {
    process.stderr.write("ERROR: No SYMBOL configured in .env\n");
    process.exit(1);
  }

  const traderRef = { trader: [] };
  const intervalRef = { id: null };

  traderRef.trader = buildTrader(client);

  // First tick immediately
  // await runOnce(traderRef.trader);

  printState();
  console.log("Ready. Type /set to change settings, /status to view config.");

  // Start polling
  intervalRef.id = setInterval(() => runOnce(traderRef.trader), state.pollIntervalMs);

  // Start reading commands
  startInputLoop(client, intervalRef, traderRef);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
