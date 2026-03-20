# Kotak Neo Trader

Polls the Kotak Neo API for one or more option/futures symbols and automatically places or modifies limit orders when the current price diverges from the order-book price by more than a configurable threshold.

## Setup

```bash
cd kotak-neo-trader
npm install
cp .env.example .env
# fill in .env with your credentials and symbol details
node index.js
```

## .env fields

| Variable | Description | Example |
|---|---|---|
| `CONSUMER_KEY` | App consumer key | `abc123` |
| `CONSUMER_SECRET` | App consumer secret | `xyz789` |
| `MOBILE_NUMBER` | Registered mobile (with country code) | `+919999999999` |
| `PASSWORD` | Trading password | `mypassword` |
| `ENVIRONMENT` | `prod` or `uat` | `prod` |
| `SYMBOL` | Trading symbol(s), comma-separated | `CRUDEOIL26MAYFUT` |
| `INSTRUMENT_TOKEN` | Instrument wToken(s), comma-separated | `12345` |
| `EXCHANGE_SEGMENT` | Exchange segment(s), comma-separated | `mcx_fo` |
| `PRODUCT` | Product type | `NRML` |
| `ORDER_TYPE` | `L`, `MKT`, `SL`, `SL-M` | `L` |
| `TRANSACTION_TYPE` | `B` (Buy) or `S` (Sell) | `B` |
| `QUANTITY` | Lot size | `1` |
| `PRICE_DIFF_THRESHOLD` | Points diff to trigger action | `200` |
| `POLL_INTERVAL_MS` | How often to check (ms) | `5000` |
| `SESSION_TOKEN` | (Optional) Skip OTP re-login | — |
| `SID` | (Optional) Session ID | — |
| `SERVER_ID` | (Optional) Server ID | — |

## Multiple symbols

Comma-separate all symbol-related fields in the same order:

```env
SYMBOL=CRUDEOIL26MAYFUT,NATURALGAS26MAYFUT
INSTRUMENT_TOKEN=12345,67890
EXCHANGE_SEGMENT=mcx_fo,mcx_fo
```

## Logic flow

```
Every POLL_INTERVAL_MS:
  For each symbol:
    1. Fetch LTP (current price)
    2. Fetch market depth (best bid / best ask)
    3. If |LTP - bestBid| > threshold  OR  |LTP - bestAsk| > threshold:
       a. Check order report for this symbol
       b. Filled/open position exists?  → log, skip
       c. Pending order exists?
            price drifted > threshold?  → modify order to new price
            else                        → log, skip
       d. No orders?                    → place new order
    4. Else: log diff, no action
```
