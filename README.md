# SourcePay

SourcePay is a payment router for AI citations on Arc. Creators register wallet-signed source material, buyers route research requests across registered sources, SourcePay generates payable receipts, and creators are paid in USDC through Circle x402 batching on Arc.

Live app: `https://sourcepay.fly.dev/`

## Current Build Status

SourcePay now separates public marketplace data from private wallet-owned workspace data.

- Public buyer marketplace: registered creator sources that can be routed.
- Private creator workspace: sources and earnings scoped to the connected payout wallet.
- Private buyer receipts: unpaid receipts recoverable only by the buyer wallet that created them, or by the private access-token receipt URL.
- Public receipts: only paid or settled receipts are listed publicly.
- Receipt proof: receipt proof can be downloaded and verified against stored route data.
- Payments: payment requirements are generated for Arc Testnet USDC using Circle x402 batching.

## What It Does

- Registers creator-owned sources with payout wallets, citation pricing, content fingerprints, and wallet-signed ownership proof.
- Routes buyer requests to relevant registered sources within a selected USDC budget.
- Stores the connected buyer wallet on newly routed receipts so buyers can recover their own unpaid receipts later.
- Generates receipt pages with selected sources, fingerprints, payout amounts, payment status, and proof actions.
- Protects private unpaid receipts with access tokens.
- Protects creator earnings and buyer receipt recovery with nonce-based wallet challenges.
- Guards wallet connection and payment signing against the Arc Testnet chain.
- Tracks creator citation activity and quoted/paid earnings by payout wallet.
- Adds rate limits and structured JSON logs for operational safety.

## Tech Stack

- React, TypeScript, Vite, Tailwind CSS
- Node HTTP server
- SQLite
- Circle x402 batching
- Arc Testnet
- viem
- Fly.io

## Security And Privacy Model

- Creator source registration requires a payout-wallet signature.
- Creator source editing and archiving require the payout wallet.
- Creator Portal loads sources using `/api/sources?wallet=...`, not the global marketplace list.
- Creator earnings require a fresh signed wallet challenge.
- Buyer receipt recovery requires a fresh signed wallet challenge.
- Auth challenges include purpose, nonce, expiry, and one-time consumption.
- Unpaid receipts are not publicly listed.
- Public source detail only shows paid or settled citation history.
- Sensitive endpoints are rate limited.
- Logs mask wallet addresses and identifiers and do not log signatures, access tokens, or full source content.

## Brand Assets

SourcePay includes a small logo set in `public/`:

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

## Environment

```env
PORT=8787
SOURCEPAY_DB_PATH=./data/sourcepay.sqlite
SOURCEPAY_NETWORK="Arc Testnet"
ARC_RPC_URL=
SOURCEPAY_ARC_FAUCET_URL=
SOURCEPAY_USDC_FAUCET_URL=
```

Optional rate-limit overrides:

```env
SOURCEPAY_AUTH_LIMIT=30
SOURCEPAY_PREVIEW_LIMIT=12
SOURCEPAY_SOURCE_WRITE_LIMIT=20
SOURCEPAY_ROUTE_LIMIT=20
SOURCEPAY_PRIVATE_READ_LIMIT=60
SOURCEPAY_PAYMENT_REQUIREMENTS_LIMIT=60
SOURCEPAY_PAYMENT_SUBMIT_LIMIT=20
SOURCEPAY_PROOF_VERIFY_LIMIT=30
```

`ARC_RPC_URL` should point to the Arc RPC endpoint used for the event. Faucet URLs should point to the official Arc testnet and USDC claim pages for the event. If faucet URLs are not configured, SourcePay falls back to Circle's faucet.

## Main User Flows

### 1. Creator Source Registration

1. Open SourcePay.
2. Open `Creator portal`.
3. Connect the creator payout wallet.
4. Enter a source URL or paste source material.
5. Choose the source class: `Article`, `Social post`, or `Transcript`.
6. Set the USDC citation price.
7. Click `Prepare source` if importing from a URL.
8. Click `Register source`.
9. Sign the wallet message.

The source is registered only if the signature matches the payout wallet and the source fingerprint.

### 2. Buyer Request Routing

1. Open the `Requests` tab.
2. Connect the buyer wallet if the buyer wants receipt recovery.
3. Enter the research objective.
4. Set max spend.
5. Choose eligible source types.
6. Click `Route request`.

SourcePay selects matching wallet-signed creator sources within budget and creates a private payable receipt.

### 3. Buyer Receipt Recovery

1. Open the `Payments` tab.
2. Click `My receipts`.
3. Connect the buyer wallet.
4. Sign the buyer receipt challenge.

Only receipts created by that buyer wallet are returned. Private unpaid receipts include their access token so the buyer can reopen and pay them.

### 4. Pay The Receipt

1. Open a receipt.
2. Connect the buyer wallet.
3. Switch to Arc Testnet if prompted.
4. Review selected sources and total USDC amount.
5. Click `Connect and pay` / payment action.
6. Approve the wallet signature.

After payment, the receipt updates to paid or records the failed payment attempt with a reason.

### 5. Creator Earnings

1. Open `Creator portal`.
2. Connect the payout wallet.
3. Click `View earnings`.
4. Sign the creator earnings challenge.

Only the signed payout wallet can view its private earnings.

### 6. Receipt Proof And Verification

On a receipt page, users can:

- See selected sources, ranks, fingerprints, and payout amounts.
- Copy or share the receipt URL.
- Download receipt proof.
- Verify receipt proof against stored SourcePay data.
- Review payment status and payment history.

## Validation

```bash
npm test
npm run build
npm audit --omit=dev
```

## Deploy On Fly.io

SourcePay runs as one Fly app. The Node server serves the API and the built Vite frontend from `dist/`.

1. Install and sign in with `flyctl`.
2. Create the app, or change the `app` name in `fly.toml` if `sourcepay` is taken:

```bash
fly apps create sourcepay
```

3. Create the persistent SQLite volume in the same region as `primary_region`:

```bash
fly volumes create sourcepay_data --size 1 --region iad
```

4. Set Arc/Circle configuration:

```bash
fly secrets set ARC_RPC_URL="https://..."
fly secrets set SOURCEPAY_ARC_FAUCET_URL="https://..."
fly secrets set SOURCEPAY_USDC_FAUCET_URL="https://..."
```

5. Deploy:

```bash
npm run deploy:fly
```

The deploy script uses `flyctl deploy --smoke-checks=false` because Fly's deploy-time socket smoke scan can report a false listener warning even while the configured HTTP health check passes. The real Fly health check remains enabled in `fly.toml`.

6. Check the deployed service:

```bash
fly status
fly checks list
fly logs
```

The Fly config mounts `/data` and stores SQLite at `/data/sourcepay.sqlite`, so source registrations, receipts, auth challenges, and payment attempts survive deploys and restarts.

## Manual Test Checklist

Run these checks on `https://sourcepay.fly.dev/` after each production deploy:

1. Open the app in a clean browser or incognito window.
2. Confirm no old wallet appears connected.
3. Open Creator Portal without connecting a wallet.
4. Confirm it does not show another user's creator inventory.
5. Connect Wallet A as creator.
6. Register one source and sign the source registration.
7. Disconnect Wallet A.
8. Connect Wallet B in Creator Portal.
9. Confirm Wallet B does not see Wallet A's creator source.
10. Return to Requests.
11. Connect buyer wallet.
12. Route a request that should match the registered source.
13. Confirm a private receipt is created.
14. Open Payments and click `My receipts`.
15. Sign with the buyer wallet.
16. Confirm the private receipt appears.
17. Try `View earnings` in Creator Portal with the wrong wallet.
18. Confirm it is rejected.
19. Connect the creator payout wallet and click `View earnings`.
20. Confirm earnings load only after signing.
21. Open the receipt page.
22. Confirm receipt proof downloads and verifies.
23. Try the full x402 payment with funded Arc Testnet USDC.
24. Confirm payment status updates and payment history is recorded.
25. Confirm Fly logs show structured events without raw signatures or access tokens.

## Known Manual Verification Still Required

- Real funded-wallet x402 payment on Arc Testnet.
- Circle testnet USDC faucet availability for the buyer wallet.
- Wallet popup behavior across the wallet extension used in the demo.
- Two-browser, two-wallet isolation test.
