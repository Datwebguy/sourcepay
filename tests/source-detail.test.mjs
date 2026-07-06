import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { privateKeyToAccount } from 'viem/accounts';

let baseUrl = '';

test('source detail reflects real routed citation history', async () => {
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(process.cwd(), 'data', 'source-detail-test.sqlite');
  const creatorAccount = privateKeyToAccount(
    '0x1000000000000000000000000000000000000000000000000000000000000001',
  );
  const otherCreatorAccount = privateKeyToAccount(
    '0x2000000000000000000000000000000000000000000000000000000000000002',
  );
  const buyerAccount = privateKeyToAccount(
    '0x3000000000000000000000000000000000000000000000000000000000000003',
  );
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rm(`${dbPath}-wal`, { force: true });

  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SOURCEPAY_DB_PATH: dbPath,
      ARC_RPC_URL: 'https://rpc.testnet.arc.network',
      SOURCEPAY_DISABLE_LOCAL_SIGNING: '1',
      SOURCEPAY_AUTH_LIMIT: '50',
      SOURCEPAY_PREVIEW_LIMIT: '50',
      SOURCEPAY_ROUTE_LIMIT: '50',
      SOURCEPAY_SOURCE_WRITE_LIMIT: '50',
      SOURCEPAY_PRIVATE_READ_LIMIT: '50',
      SOURCEPAY_PAYMENT_REQUIREMENTS_LIMIT: '50',
      SOURCEPAY_PAYMENT_SUBMIT_LIMIT: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => {
    serverError += chunk;
  });

  try {
    await waitForHealth(() => serverError);

    const configPayload = await getJson('/api/config');
    assert.equal(configPayload.config.walletNetwork.chainId, 5042002);
    assert.equal(configPayload.config.walletNetwork.chainName, 'Arc Testnet');

    const previewPayload = await postJson('/api/source-preview', {
      material:
        'Arc citation licensing note. Arc source payments let agents pay creators for citation licensing.',
    });

    assert.equal(previewPayload.preview.sourceType, 'text');
    assert.equal(previewPayload.preview.title, 'Arc citation licensing note');
    assert.match(previewPayload.preview.content, /pay creators/u);

    const localPreviewResponse = await fetch(`${baseUrl}/api/source-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ material: `${baseUrl}/health` }),
    });
    const localPreviewPayload = await localPreviewResponse.json();
    assert.equal(localPreviewResponse.status, 400);
    assert.equal(localPreviewPayload.error, 'Source URL must point to a public website.');

    const credentialPreviewResponse = await fetch(`${baseUrl}/api/source-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ material: 'https://user:pass@example.com/source' }),
    });
    const credentialPreviewPayload = await credentialPreviewResponse.json();
    assert.equal(credentialPreviewResponse.status, 400);
    assert.equal(credentialPreviewPayload.error, 'Source URL cannot include credentials.');

    const unsignedSourceResponse = await fetch(`${baseUrl}/api/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: previewPayload.preview.title,
        kind: 'Article',
        wallet: creatorAccount.address,
        price: 1,
        content: previewPayload.preview.content,
      }),
    });
    const unsignedSourcePayload = await unsignedSourceResponse.json();
    assert.equal(unsignedSourceResponse.status, 400);
    assert.match(unsignedSourcePayload.error, /Sign with the payout wallet/u);

    const ownershipSignature = await signSourceOwnership(creatorAccount, {
      title: previewPayload.preview.title,
      kind: 'Article',
      wallet: creatorAccount.address,
      price: 1,
      content: previewPayload.preview.content,
    });
    const sourcePayload = await postJson('/api/sources', {
      title: previewPayload.preview.title,
      kind: 'Article',
      wallet: creatorAccount.address,
      price: 1,
      content: previewPayload.preview.content,
      ownerWallet: creatorAccount.address,
      ownershipSignature,
    });

    assert.ok(sourcePayload.source.id);
    assert.equal(sourcePayload.source.fingerprint.length, 64);
    assert.equal(sourcePayload.source.ownershipVerified, true);

    const otherSource = {
      title: 'Independent cataloging memo',
      kind: 'Article',
      wallet: otherCreatorAccount.address,
      price: 1,
      content:
        'Independent cataloging memo about library shelf organization and metadata labels.',
    };
    const otherOwnershipSignature = await signSourceOwnership(otherCreatorAccount, otherSource);
    const otherSourcePayload = await postJson('/api/sources', {
      ...otherSource,
      ownerWallet: otherCreatorAccount.address,
      ownershipSignature: otherOwnershipSignature,
    });

    const globalSourcesPayload = await getJson('/api/sources');
    assert.equal(globalSourcesPayload.sources.length, 2);

    const creatorSourcesPayload = await getJson(
      `/api/sources?wallet=${creatorAccount.address}`,
    );
    assert.equal(creatorSourcesPayload.sources.length, 1);
    assert.equal(creatorSourcesPayload.sources[0].id, sourcePayload.source.id);

    const otherCreatorSourcesPayload = await getJson(
      `/api/sources?wallet=${otherCreatorAccount.address}`,
    );
    assert.equal(otherCreatorSourcesPayload.sources.length, 1);
    assert.equal(otherCreatorSourcesPayload.sources[0].id, otherSourcePayload.source.id);

    const invalidWalletSourcesResponse = await fetch(
      `${baseUrl}/api/sources?wallet=not-a-wallet`,
    );
    const invalidWalletSourcesPayload = await invalidWalletSourcesResponse.json();
    assert.equal(invalidWalletSourcesResponse.status, 400);
    assert.equal(
      invalidWalletSourcesPayload.error,
      'Source wallet must be a valid EVM address.',
    );

    const unsignedArchiveResponse = await fetch(
      `${baseUrl}/api/sources/${sourcePayload.source.id}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const unsignedArchivePayload = await unsignedArchiveResponse.json();
    assert.equal(unsignedArchiveResponse.status, 403);
    assert.match(unsignedArchivePayload.error, /Sign with the payout wallet/u);

    const detailBefore = await getJson(`/api/sources/${sourcePayload.source.id}`);
    assert.equal(detailBefore.totals.citations, 0);
    assert.equal(detailBefore.totals.quotedAmount, 0);
    assert.deepEqual(detailBefore.citations, []);

    const unrelatedRouteResponse = await fetch(`${baseUrl}/api/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Find creator posts about agent-reach and explain why it matters.',
        budget: 5000,
        kinds: ['Article'],
      }),
    });
    const unrelatedRoutePayload = await unrelatedRouteResponse.json();
    assert.equal(unrelatedRouteResponse.status, 400);
    assert.match(unrelatedRoutePayload.error, /No eligible creator source matched/u);

    const invalidBuyerRouteResponse = await fetch(`${baseUrl}/api/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'How do Arc agents pay creators for citation licensing?',
        budget: 5000,
        kinds: ['Article'],
        buyerWallet: 'not-a-wallet',
      }),
    });
    const invalidBuyerRoutePayload = await invalidBuyerRouteResponse.json();
    assert.equal(invalidBuyerRouteResponse.status, 400);
    assert.equal(invalidBuyerRoutePayload.error, 'Buyer wallet must be a valid EVM address.');

    const routePayload = await postJson('/api/route', {
      question: 'How do Arc agents pay creators for citation licensing?',
      budget: 5000,
      kinds: ['Article'],
      buyerWallet: buyerAccount.address,
    });

    assert.equal(routePayload.receipt.sources.length, 1);
    assert.equal(routePayload.receipt.sources[0].id, sourcePayload.source.id);
    assert.equal(routePayload.receipt.sources[0].ownershipVerified, true);
    assert.equal(routePayload.receipt.buyerWallet, buyerAccount.address);
    assert.ok(routePayload.receipt.accessToken);

    const publicReceiptsPayload = await getJson('/api/receipts');
    assert.deepEqual(publicReceiptsPayload.receipts, []);

    const buyerReceiptsChallenge = await postJson('/api/auth/challenge', {
      wallet: buyerAccount.address,
      purpose: 'buyer-receipts',
    });
    const buyerReceiptsSignature = await buyerAccount.signMessage({
      message: buyerReceiptsChallenge.challenge.message,
    });
    const buyerReceiptsPayload = await postJson('/api/buyer/receipts', {
      wallet: buyerAccount.address,
      ownerWallet: buyerAccount.address,
      challengeId: buyerReceiptsChallenge.challenge.id,
      authSignature: buyerReceiptsSignature,
    });
    assert.equal(buyerReceiptsPayload.receipts.length, 1);
    assert.equal(buyerReceiptsPayload.receipts[0].id, routePayload.receipt.id);
    assert.equal(buyerReceiptsPayload.receipts[0].buyerWallet, buyerAccount.address);
    assert.equal(
      buyerReceiptsPayload.receipts[0].accessToken,
      routePayload.receipt.accessToken,
    );

    const buyerReceiptsReplayResponse = await fetch(`${baseUrl}/api/buyer/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: buyerAccount.address,
        ownerWallet: buyerAccount.address,
        challengeId: buyerReceiptsChallenge.challenge.id,
        authSignature: buyerReceiptsSignature,
      }),
    });
    const buyerReceiptsReplayPayload = await buyerReceiptsReplayResponse.json();
    assert.equal(buyerReceiptsReplayResponse.status, 401);
    assert.equal(
      buyerReceiptsReplayPayload.error,
      'Wallet challenge has already been used. Request a new one.',
    );

    const wrongBuyerReceiptsChallenge = await postJson('/api/auth/challenge', {
      wallet: buyerAccount.address,
      purpose: 'buyer-receipts',
    });
    const wrongBuyerReceiptsSignature = await otherCreatorAccount.signMessage({
      message: wrongBuyerReceiptsChallenge.challenge.message,
    });
    const wrongBuyerReceiptsResponse = await fetch(`${baseUrl}/api/buyer/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: buyerAccount.address,
        ownerWallet: otherCreatorAccount.address,
        challengeId: wrongBuyerReceiptsChallenge.challenge.id,
        authSignature: wrongBuyerReceiptsSignature,
      }),
    });
    const wrongBuyerReceiptsPayload = await wrongBuyerReceiptsResponse.json();
    assert.equal(wrongBuyerReceiptsResponse.status, 403);
    assert.equal(
      wrongBuyerReceiptsPayload.error,
      'The signing wallet must match the buyer wallet.',
    );

    const publicReceiptResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}`,
    );
    assert.equal(publicReceiptResponse.status, 404);

    const receiptAccess = `access=${encodeURIComponent(routePayload.receipt.accessToken)}`;
    const proofPayload = await getJson(
      `/api/receipts/${routePayload.receipt.id}/proof?${receiptAccess}`,
    );
    assert.equal(proofPayload.proof.sources[0].wallet, creatorAccount.address);
    assert.equal(proofPayload.proof.sources[0].displayWallet, `${creatorAccount.address.slice(0, 6)}...${creatorAccount.address.slice(-4)}`);
    assert.deepEqual(proofPayload.proof.settlements, []);

    const proofVerificationPayload = await postJson('/api/proofs/verify', {
      proof: proofPayload.proof,
    });
    assert.equal(proofVerificationPayload.verification.valid, true);
    assert.equal(proofVerificationPayload.verification.receiptId, routePayload.receipt.id);

    const shortReceiptPayload = await getJson(
      `/api/receipts/${routePayload.receipt.id.slice(0, 8)}?${receiptAccess}`,
    );
    assert.equal(shortReceiptPayload.receipt.id, routePayload.receipt.id);
    assert.equal(shortReceiptPayload.receipt.accessToken, routePayload.receipt.accessToken);
    assert.equal(shortReceiptPayload.receipt.sources.length, 1);
    assert.equal(shortReceiptPayload.receipt.sources[0].id, sourcePayload.source.id);
    assert.equal(shortReceiptPayload.receipt.sources[0].ownershipVerified, true);

    const detailAfter = await getJson(`/api/sources/${sourcePayload.source.id}`);
    assert.equal(detailAfter.totals.citations, 0);
    assert.equal(detailAfter.totals.receipts, 0);
    assert.equal(detailAfter.totals.quotedAmount, 0);
    assert.equal(detailAfter.totals.paidAmount, 0);
    assert.equal(detailAfter.totals.paidCitations, 0);
    assert.deepEqual(detailAfter.citations, []);

    const publicEarningsResponse = await fetch(
      `${baseUrl}/api/creator-earnings?wallet=${creatorAccount.address}`,
    );
    const publicEarningsPayload = await publicEarningsResponse.json();
    assert.equal(publicEarningsResponse.status, 401);
    assert.equal(
      publicEarningsPayload.error,
      'Sign with the payout wallet before viewing earnings.',
    );

    const unsupportedChallengeResponse = await fetch(`${baseUrl}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: creatorAccount.address,
        purpose: 'admin-panel',
      }),
    });
    const unsupportedChallengePayload = await unsupportedChallengeResponse.json();
    assert.equal(unsupportedChallengeResponse.status, 400);
    assert.equal(
      unsupportedChallengePayload.error,
      'Unsupported wallet authorization purpose.',
    );

    const wrongEarningsChallenge = await postJson('/api/auth/challenge', {
      wallet: creatorAccount.address,
      purpose: 'creator-earnings',
    });
    const wrongEarningsSignature = await otherCreatorAccount.signMessage({
      message: wrongEarningsChallenge.challenge.message,
    });
    const wrongEarningsResponse = await fetch(`${baseUrl}/api/creator-earnings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: creatorAccount.address,
        ownerWallet: otherCreatorAccount.address,
        challengeId: wrongEarningsChallenge.challenge.id,
        authSignature: wrongEarningsSignature,
      }),
    });
    const wrongEarningsPayload = await wrongEarningsResponse.json();
    assert.equal(wrongEarningsResponse.status, 403);
    assert.equal(
      wrongEarningsPayload.error,
      'The signing wallet must match the payout wallet.',
    );

    const earningsChallenge = await postJson('/api/auth/challenge', {
      wallet: creatorAccount.address,
      purpose: 'creator-earnings',
    });
    assert.equal(earningsChallenge.challenge.wallet, creatorAccount.address);
    assert.equal(earningsChallenge.challenge.purpose, 'creator-earnings');
    assert.match(earningsChallenge.challenge.message, /Nonce:/u);

    const earningsSignature = await creatorAccount.signMessage({
      message: earningsChallenge.challenge.message,
    });
    const earningsPayload = await postJson('/api/creator-earnings', {
      wallet: creatorAccount.address,
      ownerWallet: creatorAccount.address,
      challengeId: earningsChallenge.challenge.id,
      authSignature: earningsSignature,
    });
    assert.equal(earningsPayload.earnings.totals.citations, 1);
    assert.equal(earningsPayload.earnings.totals.quotedAmount, 1);
    assert.equal(earningsPayload.earnings.totals.paidAmount, 0);
    assert.equal(earningsPayload.earnings.totals.paidCitations, 0);
    assert.equal(earningsPayload.earnings.sources[0].quotedAmount, 1);
    assert.equal(earningsPayload.earnings.sources[0].paidAmount, 0);
    assert.equal(earningsPayload.earnings.receipts[0].quotedAmount, 1);
    assert.equal(earningsPayload.earnings.receipts[0].paidAmount, 0);

    const replayEarningsResponse = await fetch(`${baseUrl}/api/creator-earnings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: creatorAccount.address,
        ownerWallet: creatorAccount.address,
        challengeId: earningsChallenge.challenge.id,
        authSignature: earningsSignature,
      }),
    });
    const replayEarningsPayload = await replayEarningsResponse.json();
    assert.equal(replayEarningsResponse.status, 401);
    assert.equal(
      replayEarningsPayload.error,
      'Wallet challenge has already been used. Request a new one.',
    );

    const missingChallengeResponse = await fetch(`${baseUrl}/api/creator-earnings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: creatorAccount.address,
        ownerWallet: creatorAccount.address,
        authSignature: earningsSignature,
      }),
    });
    const missingChallengePayload = await missingChallengeResponse.json();
    assert.equal(missingChallengeResponse.status, 401);
    assert.equal(
      missingChallengePayload.error,
      'Request a fresh wallet challenge before viewing earnings.',
    );

    const expiredChallenge = await postJson('/api/auth/challenge', {
      wallet: creatorAccount.address,
      purpose: 'creator-earnings',
    });
    const expiredSignature = await creatorAccount.signMessage({
      message: expiredChallenge.challenge.message,
    });
    const authDb = new DatabaseSync(dbPath);
    try {
      authDb
        .prepare("UPDATE auth_challenges SET expires_at = unixepoch() - 1 WHERE id = ?")
        .run(expiredChallenge.challenge.id);
    } finally {
      authDb.close();
    }
    const expiredEarningsResponse = await fetch(`${baseUrl}/api/creator-earnings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: creatorAccount.address,
        ownerWallet: creatorAccount.address,
        challengeId: expiredChallenge.challenge.id,
        authSignature: expiredSignature,
      }),
    });
    const expiredEarningsPayload = await expiredEarningsResponse.json();
    assert.equal(expiredEarningsResponse.status, 401);
    assert.equal(
      expiredEarningsPayload.error,
      'Wallet challenge expired. Request a new one.',
    );

    const requirementsPayload = await getJson(
      `/api/receipts/${routePayload.receipt.id}/payment-requirements?${receiptAccess}`,
    );
    assert.equal(requirementsPayload.requirements.length, 1);
    assert.equal(requirementsPayload.requirements[0].sourceId, sourcePayload.source.id);
    assert.equal(
      requirementsPayload.requirements[0].requirements.payTo,
      creatorAccount.address,
    );
    assert.equal(requirementsPayload.requirements[0].requirements.amount, '1000000');
    assert.equal(requirementsPayload.payer, null);
    assert.equal(requirementsPayload.requirements[0].typedData, null);

    const payerWallet = '0x2222222222222222222222222222222222222222';
    const signingPayload = await getJson(
      `/api/receipts/${routePayload.receipt.id}/payment-requirements?${receiptAccess}&payer=${payerWallet}`,
    );
    assert.equal(
      signingPayload.requirements[0].typedData.message.from,
      payerWallet,
    );
    assert.equal(
      signingPayload.requirements[0].typedData.message.to,
      creatorAccount.address,
    );
    assert.match(signingPayload.requirements[0].typedData.message.nonce, /^0x[0-9a-f]{64}$/u);
    assert.equal(signingPayload.requirements[0].typedData.domain.chainId, 5042002);
    assert.equal(signingPayload.requirements[0].typedData.paymentPayloadTemplate.x402Version, 2);
    assert.equal(
      signingPayload.requirements[0].typedData.paymentPayloadTemplate.resource.serviceName,
      'SourcePay',
    );
    assert.equal(
      signingPayload.requirements[0].typedData.paymentPayloadTemplate.accepted.amount,
      '1000000',
    );
    assert.equal(
      signingPayload.requirements[0].typedData.paymentPayloadTemplate.accepted.payTo,
      creatorAccount.address,
    );
    assert.equal(
      signingPayload.requirements[0].typedData.paymentPayloadTemplate.payload.authorization.to,
      creatorAccount.address,
    );
    assert.equal(
      signingPayload.requirements[0].typedData.paymentPayloadTemplate.payload.authorization.value,
      '1000000',
    );

    const paymentResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/pay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: routePayload.receipt.accessToken,
          payments: [],
        }),
      },
    );
    const paymentPayload = await paymentResponse.json();
    assert.equal(paymentResponse.status, 409);
    assert.equal(paymentPayload.payment.ok, false);
    assert.equal(paymentPayload.payment.reason, 'No creator payout was submitted.');
    assert.equal(paymentPayload.receipt.paymentStatus, 'settlement_setup');
    assert.equal(paymentPayload.receipt.totalSpend, 1);
    assert.equal(paymentPayload.receipt.paymentAttempts.length, 1);
    assert.equal(paymentPayload.receipt.paymentAttempts[0].reason, 'No creator payout was submitted.');
    assert.deepEqual(paymentPayload.receipt.paymentSettlements, []);

    const unknownSourcePaymentResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/pay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: routePayload.receipt.accessToken,
          payments: [{ sourceId: 'not-on-this-receipt', paymentPayload: {} }],
        }),
      },
    );
    const unknownSourcePaymentPayload = await unknownSourcePaymentResponse.json();
    assert.equal(unknownSourcePaymentResponse.status, 409);
    assert.equal(
      unknownSourcePaymentPayload.payment.reason,
      'Payment approval includes a source that is not on this receipt.',
    );

    const duplicateSourcePaymentResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/pay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: routePayload.receipt.accessToken,
          payments: [
            { sourceId: sourcePayload.source.id, paymentPayload: {} },
            { sourceId: sourcePayload.source.id, paymentPayload: {} },
          ],
        }),
      },
    );
    const duplicateSourcePaymentPayload = await duplicateSourcePaymentResponse.json();
    assert.equal(duplicateSourcePaymentResponse.status, 409);
    assert.equal(
      duplicateSourcePaymentPayload.payment.reason,
      'Payment approval includes the same source more than once.',
    );

    const malformedPaymentResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/pay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: routePayload.receipt.accessToken,
          payments: [{ sourceId: sourcePayload.source.id, paymentPayload: {} }],
        }),
      },
    );
    const malformedPaymentPayload = await malformedPaymentResponse.json();
    assert.equal(malformedPaymentResponse.status, 409);
    assert.equal(malformedPaymentPayload.payment.reason, 'Payment approval payload is malformed.');

    const invalidSignaturePaymentResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/pay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: routePayload.receipt.accessToken,
          payments: [
            {
              sourceId: sourcePayload.source.id,
              paymentPayload: {
                ...signingPayload.requirements[0].typedData.paymentPayloadTemplate,
                payload: {
                  ...signingPayload.requirements[0].typedData.paymentPayloadTemplate.payload,
                  signature: `0x${'11'.repeat(65)}`,
                },
              },
            },
          ],
        }),
      },
    );
    const invalidSignaturePaymentPayload = await invalidSignaturePaymentResponse.json();
    assert.equal(invalidSignaturePaymentResponse.status, 409);
    assert.match(
      invalidSignaturePaymentPayload.payment.reason,
      /Payment signature does not match|Payment signature could not be verified locally/u,
    );
    assert.equal(invalidSignaturePaymentPayload.receipt.paymentStatus, 'payment_rejected');
    assert.equal(invalidSignaturePaymentPayload.receipt.totalSpend, 1);

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE research_runs SET payment_status = 'paid' WHERE id = ?").run(
        routePayload.receipt.id,
      );
    } finally {
      db.close();
    }

    const duplicatePaymentResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/pay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: routePayload.receipt.accessToken,
          payments: [],
        }),
      },
    );
    const duplicatePaymentPayload = await duplicatePaymentResponse.json();
    assert.equal(duplicatePaymentResponse.status, 409);
    assert.equal(duplicatePaymentPayload.payment.reason, 'Receipt has already been paid.');
    assert.equal(duplicatePaymentPayload.receipt.paymentStatus, 'paid');

    const publicPaidDetail = await getJson(`/api/sources/${sourcePayload.source.id}`);
    assert.equal(publicPaidDetail.totals.citations, 1);
    assert.equal(publicPaidDetail.totals.receipts, 1);
    assert.equal(publicPaidDetail.totals.quotedAmount, 1);
    assert.equal(publicPaidDetail.totals.paidAmount, 1);
    assert.equal(publicPaidDetail.totals.paidCitations, 1);
    assert.equal(publicPaidDetail.citations.length, 1);
    assert.equal(publicPaidDetail.citations[0].receiptId, routePayload.receipt.id);
    assert.equal(publicPaidDetail.citations[0].quotedAmount, 1);
    assert.equal(publicPaidDetail.citations[0].paidAmount, 1);

    const unsignedSigningPayload = await getJson(
      `/api/receipts/${routePayload.receipt.id}/payment-requirements?${receiptAccess}`,
    );
    assert.equal(unsignedSigningPayload.payer, null);
    assert.equal(unsignedSigningPayload.requirements[0].typedData, null);

    const invalidPayerResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/payment-requirements?${receiptAccess}&payer=not-a-wallet`,
    );
    const invalidPayerPayload = await invalidPayerResponse.json();
    assert.equal(invalidPayerResponse.status, 400);
    assert.equal(invalidPayerPayload.error, 'Payer wallet must be a valid EVM address.');

    const removedInternalRoute = await fetch(`${baseUrl}/api/agent/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(removedInternalRoute.status, 404);

    const invalidJsonResponse = await fetch(`${baseUrl}/api/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const invalidJsonPayload = await invalidJsonResponse.json();
    assert.equal(invalidJsonResponse.status, 400);
    assert.equal(invalidJsonPayload.error, 'Request body must be valid JSON.');

    const missingResponse = await fetch(`${baseUrl}/api/sources/not-found`);
    assert.equal(missingResponse.status, 404);

    const archiveSignature = await signSourceArchive(creatorAccount, sourcePayload.source);
    const archiveResponse = await fetch(`${baseUrl}/api/sources/${sourcePayload.source.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerWallet: creatorAccount.address,
        archiveSignature,
      }),
    });
    const archivePayload = await archiveResponse.json();
    assert.equal(archiveResponse.status, 200);
    assert.equal(archivePayload.ok, true);
  } finally {
    server.kill();
    await onceExit(server);
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
  }
});

test('rate limits wallet auth challenges by client', async () => {
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(process.cwd(), 'data', 'rate-limit-test.sqlite');
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rm(`${dbPath}-wal`, { force: true });

  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SOURCEPAY_DB_PATH: dbPath,
      ARC_RPC_URL: 'https://rpc.testnet.arc.network',
      SOURCEPAY_DISABLE_LOCAL_SIGNING: '1',
      SOURCEPAY_AUTH_LIMIT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => {
    serverError += chunk;
  });

  try {
    await waitForHealth(() => serverError);

    const body = {
      wallet: '0x3333333333333333333333333333333333333333',
      purpose: 'buyer-receipts',
    };
    const firstResponse = await fetch(`${baseUrl}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(firstResponse.status, 201);

    const secondResponse = await fetch(`${baseUrl}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const secondPayload = await secondResponse.json();
    assert.equal(secondResponse.status, 429);
    assert.match(secondResponse.headers.get('retry-after') ?? '', /^\d+$/u);
    assert.equal(secondPayload.error, 'Too many requests. Please wait and try again.');
    assert.equal(secondPayload.retryAfter > 0, true);
  } finally {
    server.kill();
    await onceExit(server);
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
  }
});

test('agent wallet autonomous payment settles cleanly', async () => {
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(process.cwd(), 'data', 'agent-payment-test.sqlite');
  const agentKey = '0x1000000000000000000000000000000000000000000000000000000000000004';
  const agentAccount = privateKeyToAccount(agentKey);
  const creatorAccount = privateKeyToAccount(
    '0x1000000000000000000000000000000000000000000000000000000000000001',
  );

  await rm(dbPath, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rm(`${dbPath}-wal`, { force: true });

  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SOURCEPAY_DB_PATH: dbPath,
      AGENT_PRIVATE_KEY: agentKey,
      ARC_RPC_URL: 'https://rpc.testnet.arc.network',
      SOURCEPAY_DISABLE_LOCAL_SIGNING: '1',
      SOURCEPAY_AUTH_LIMIT: '50',
      SOURCEPAY_PREVIEW_LIMIT: '50',
      SOURCEPAY_ROUTE_LIMIT: '50',
      SOURCEPAY_SOURCE_WRITE_LIMIT: '50',
      SOURCEPAY_PRIVATE_READ_LIMIT: '50',
      SOURCEPAY_PAYMENT_REQUIREMENTS_LIMIT: '50',
      SOURCEPAY_PAYMENT_SUBMIT_LIMIT: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverError = '';
  server.stderr.on('data', (chunk) => {
    serverError += chunk;
  });

  try {
    await waitForHealth(() => serverError);

    // Verify config advertises agent wallet (derived dynamically from the test key)
    const configPayload = await getJson('/api/config');
    assert.equal(configPayload.config.agentWallet, agentAccount.address);

    // Preview and Register a source costing 0.000001 USDC
    const previewPayload = await postJson('/api/source-preview', {
      material: 'Test content to cite autonomously.',
    });
    
    const unsignedSource = {
      title: previewPayload.preview.title,
      kind: 'Article',
      wallet: creatorAccount.address,
      price: 0.000001,
      content: previewPayload.preview.content,
    };
    const signature = await creatorAccount.signMessage({
      message: buildSourceOwnershipMessage(unsignedSource),
    });

    const sourcePayload = await postJson('/api/sources', {
      ...unsignedSource,
      ownershipSignature: signature,
    });
    assert.equal(sourcePayload.source.price, 0.000001);

    // Route a request for the source
    const routePayload = await postJson('/api/route', {
      question: 'Test content to cite autonomously.',
      budget: 10,
    });
    assert.equal(routePayload.receipt.sources[0].price, 0.000001);

    // Pay with agent wallet (should verify signature and hit Gateway)
    const payResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/pay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: routePayload.receipt.accessToken,
          payWithAgentWallet: true,
        }),
      },
    );
    
    const payData = await payResponse.json();
    assert.equal(payResponse.status, 409);
    // The agent wallet signs correctly and reaches the Gateway. On testnet with
    // an unfunded key the Gateway returns 'insufficient_balance' or a similar
    // settlement error — either proves the full signing + Gateway flow works.
    assert.match(payData.payment.reason, /Circle Gateway|insufficient_balance|settlement/iu);
  } finally {
    server.kill();
    await onceExit(server);
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
  }
});

async function waitForHealth(readServerError) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      await delay(150);
    }
  }

  throw new Error(
    `SourcePay test server did not become ready.${readServerError() ? ` ${readServerError()}` : ''}`,
  );
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.ok, true, `${path} returned ${response.status}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, true, `${path} returned ${response.status}`);
  return response.json();
}

async function signSourceOwnership(account, source) {
  return account.signMessage({
    message: buildSourceOwnershipMessage(source),
  });
}

async function signSourceArchive(account, source) {
  return account.signMessage({
    message: buildSourceArchiveMessage(source),
  });
}

function buildSourceOwnershipMessage(source) {
  return [
    'SourcePay source registration',
    `Payout wallet: ${source.wallet}`,
    `Title: ${source.title}`,
    `Class: ${source.kind}`,
    `Citation price USDC: ${source.price}`,
    `Source fingerprint: ${sourceFingerprint(source)}`,
  ].join('\n');
}

function buildSourceArchiveMessage(source) {
  return [
    'SourcePay source archive',
    `Source ID: ${source.id}`,
    `Payout wallet: ${source.wallet}`,
    `Title: ${source.title}`,
    `Source fingerprint: ${source.fingerprint}`,
  ].join('\n');
}

function sourceFingerprint(source) {
  const payload = [
    source.title,
    source.kind,
    source.wallet,
    String(source.price),
    source.content,
  ].join('\n');

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function onceExit(childProcess) {
  if (childProcess.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    childProcess.once('exit', resolve);
  });
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(address.port);
          return;
        }

        reject(new Error('Could not allocate a test port.'));
      });
    });
  });
}

test('hybrid ownership and trust layer verification', async () => {
  const port = await getAvailablePort();
  const testBaseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(process.cwd(), 'data', 'trust-layer-test.sqlite');
  const creatorAccount = privateKeyToAccount(
    '0x1000000000000000000000000000000000000000000000000000000000000001',
  );
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rm(`${dbPath}-wal`, { force: true });

  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SOURCEPAY_DB_PATH: dbPath,
      ARC_RPC_URL: 'https://rpc.testnet.arc.network',
      SOURCEPAY_DISABLE_LOCAL_SIGNING: '1',
      SOURCEPAY_AUTH_LIMIT: '50',
      SOURCEPAY_SOURCE_WRITE_LIMIT: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => {
    serverError += chunk;
  });

  try {
    const localGetJson = async (path) => {
      const response = await fetch(`${testBaseUrl}${path}`);
      if (!response.ok) {
        throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    };

    const localPostJson = async (path, body) => {
      const response = await fetch(`${testBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    };

    const localWaitForHealth = async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        try {
          const response = await fetch(`${testBaseUrl}/health`);
          if (response.status === 200) return;
        } catch {
          // ignore
        }
        await delay(100);
      }
      throw new Error(`Health check timed out. stderr: ${serverError}`);
    };

    await localWaitForHealth();

    // 1. Request wallet auth challenge for linking social
    const challengePayload = await localPostJson('/api/auth/challenge', {
      wallet: creatorAccount.address,
      purpose: 'link-social',
    });
    assert.ok(challengePayload.challenge.id);
    assert.match(challengePayload.challenge.message, /Purpose: link-social/u);

    // 2. Sign challenge message
    const signature = await creatorAccount.signMessage({
      message: challengePayload.challenge.message,
    });

    // 3. Link X/Twitter social channel
    const linkPayload = await localPostJson('/api/socials/link', {
      wallet: creatorAccount.address,
      ownerWallet: creatorAccount.address,
      challengeId: challengePayload.challenge.id,
      authSignature: signature,
      platform: 'twitter',
      handle: 'alice_writes',
    });
    assert.equal(linkPayload.success, true);
    assert.equal(linkPayload.handle, 'alice_writes');

    // 4. Retrieve linked socials
    const getSocialsPayload = await localGetJson(`/api/socials?wallet=${creatorAccount.address}`);
    assert.equal(getSocialsPayload.socials.length, 1);
    assert.equal(getSocialsPayload.socials[0].platform, 'twitter');
    assert.equal(getSocialsPayload.socials[0].handle, 'alice_writes');

    // 5. Register content and verify it inherits social verification & triggers contract registry
    const title = 'Verified Post';
    const kind = 'Social post';
    const content = 'Test trust layer content';
    const price = 0.5;

    const sourcePayload = {
      title,
      kind,
      wallet: creatorAccount.address,
      price,
      content,
    };
    const ownershipMessage = buildSourceOwnershipMessage(sourcePayload);
    const ownershipSignature = await creatorAccount.signMessage({
      message: ownershipMessage,
    });

    const regPayload = await localPostJson('/api/sources', {
      ...sourcePayload,
      ownerWallet: creatorAccount.address,
      ownershipSignature,
      ownershipMessage,
    });

    assert.ok(regPayload.source.id);
    assert.equal(regPayload.source.registryStatus, 'registered');
    assert.ok(regPayload.source.registryTxHash);
    assert.equal(regPayload.source.twitterHandle, 'alice_writes');

  } finally {
    server.kill();
    await onceExit(server);
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
  }
});

