# SourcePay

SourcePay is a payment router for AI citations on Arc. Creators register wallet-signed source material such as articles, social posts, transcripts, and notes. Buyers route research requests across those registered sources, generate a receipt, and pay creators in USDC through Circle x402 batching on Arc.

## What It Does

- Registers creator-owned sources with payout wallets, citation pricing, content fingerprints, and wallet-signed ownership proof.
- Routes buyer requests to relevant registered sources within a selected USDC budget.
- Generates receipt pages with selected sources, fingerprints, payout amounts, payment status, and shareable proof.
- Uses browser wallet signing for payment approvals.
- Guards wallet connection and payment signing against the Arc Testnet chain.
- Tracks creator citation activity and quoted earnings by payout wallet.

## Tech Stack

- React, TypeScript, Vite, Tailwind CSS
- Node HTTP server
- SQLite
- Circle x402 batching
- Arc Testnet
- viem

## Local Setup

```bash
npm install
cp .env.example .env
npm run server
npm run dev
```

Frontend: `http://127.0.0.1:5173`

Backend: `http://127.0.0.1:8787`

## Environment

```env
PORT=8787
SOURCEPAY_DB_PATH=./data/sourcepay.sqlite
SOURCEPAY_NETWORK=Arc
ARC_RPC_URL=
CIRCLE_GATEWAY_URL=
```

`ARC_RPC_URL` should point to the Arc RPC endpoint used for the event. `CIRCLE_GATEWAY_URL` is optional; the app defaults to Circle Gateway testnet behavior.

## Main Flow

1. A creator opens the creator portal, connects their wallet, imports or pastes source material, sets a citation price, and signs the source registration.
2. A buyer enters a research request, chooses source classes, and sets a max spend.
3. SourcePay selects relevant wallet-signed sources and creates a receipt.
4. The buyer connects a wallet, switches to Arc Testnet if needed, signs the payment authorization, and pays creators.
5. The receipt shows selected sources, fingerprints, payout rows, payment status, and proof actions.

## Validation

```bash
npm run build
npm test
```
