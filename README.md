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

## Brand Assets

SourcePay includes a small professional logo set in `public/`:

- `sourcepay-mark.svg`: app header mark and favicon source.
- `sourcepay-logo.svg`: horizontal wordmark for presentations or docs.
- `sourcepay-x-avatar.png`: square profile image for X and other social accounts.
- `sourcepay-social.png`: social preview/banner image.
- `sourcepay-social.svg`: editable source for the social preview image.

## Local Setup

```bash
npm install
cp .env.example .env
npm run server
npm run dev
```

Frontend: `http://127.0.0.1:5173`

Backend: `http://127.0.0.1:8787`

## How To Use SourcePay

Open the frontend at `http://127.0.0.1:5173`.

### 1. Register Creator Sources

1. Click `Launch SourcePay`.
2. Open `Creator portal`.
3. Connect the creator payout wallet.
4. Enter a source URL or title.
5. Choose the source class: `Article`, `Social post`, or `Transcript`.
6. Set the USDC citation price.
7. Paste the source material, or enter a URL and click `Prepare source` to import readable text.
8. Click `Register source`.
9. Sign the wallet message. This proves the payout wallet owns the source registration.

Registered sources receive a fingerprint and show `Wallet signed` once ownership is verified.

### 2. Route A Buyer Request

1. Go back to the SourcePay dashboard.
2. Open the `Requests` tab.
3. Enter the research objective the buyer or AI agent needs answered.
4. Set the maximum USDC spend.
5. Choose eligible source types.
6. Click `Route request`.

SourcePay selects matching wallet-signed creator sources within the budget and creates a payable receipt.

### 3. Pay The Receipt

1. Click `Pay receipt` from the request outcome.
2. Connect the buyer wallet.
3. If the wallet is on the wrong network, SourcePay asks it to switch to Arc Testnet.
4. Review the selected creator sources and total USDC amount.
5. Click `Pay creators`.
6. Approve the wallet signature.

After payment, the receipt updates to the paid state and records the payment attempt.

### 4. Review Receipts And Proof

On each receipt page, users can:

- See selected sources, ranks, fingerprints, and payout amounts.
- Copy/share the public receipt URL.
- Download receipt proof.
- Verify the receipt proof against stored SourcePay data.
- Review payment status and payment history.

### 5. Track Creator Earnings

In the creator portal, enter or connect a payout wallet to see:

- Quoted creator earnings.
- Number of citations.
- Sources cited.
- Receipts that selected the creator's sources.

## Environment

```env
PORT=8787
SOURCEPAY_DB_PATH=./data/sourcepay.sqlite
SOURCEPAY_NETWORK=Arc
ARC_RPC_URL=
SOURCEPAY_ARC_FAUCET_URL=
SOURCEPAY_USDC_FAUCET_URL=
```

`ARC_RPC_URL` should point to the Arc RPC endpoint used for the event.
Set the faucet URLs to the official Arc testnet and USDC claim pages for the event.

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

## Deploy On Fly.io

SourcePay can run as one Fly app: the Node server serves the API and the built Vite frontend from `dist/`.

1. Install and sign in with `flyctl`.
2. Create the app, or change the `app` name in `fly.toml` if `sourcepay` is taken:

```bash
fly apps create sourcepay
```

3. Create the persistent SQLite volume in the same region as `primary_region`:

```bash
fly volumes create sourcepay_data --size 1 --region iad
```

4. Set the Arc RPC endpoint:

```bash
fly secrets set ARC_RPC_URL="https://..."
fly secrets set SOURCEPAY_ARC_FAUCET_URL="https://..."
fly secrets set SOURCEPAY_USDC_FAUCET_URL="https://..."
```

5. Deploy:

```bash
fly deploy
```

6. Check the deployed service:

```bash
fly status
fly logs
```

The Fly config mounts `/data` and stores SQLite at `/data/sourcepay.sqlite`, so source registrations, receipts, and payment attempts survive deploys and restarts.
