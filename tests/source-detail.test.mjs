import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';

let baseUrl = '';

test('source detail reflects real routed citation history', async () => {
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(process.cwd(), 'data', 'source-detail-test.sqlite');
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

    const routePayload = await postJson('/api/route', {
      question: 'How do Arc agents pay creators for citation licensing?',
      budget: 5000,
      kinds: ['Article'],
    });

    assert.equal(routePayload.receipt.sources.length, 1);
    assert.equal(routePayload.receipt.sources[0].id, sourcePayload.source.id);

    const detailAfter = await getJson(`/api/sources/${sourcePayload.source.id}`);
    assert.equal(detailAfter.totals.citations, 1);
    assert.equal(detailAfter.totals.receipts, 1);
    assert.equal(detailAfter.totals.quotedAmount, 1);
    assert.equal(detailAfter.citations.length, 1);
    assert.equal(detailAfter.citations[0].receiptId, routePayload.receipt.id);

    const requirementsPayload = await getJson(
      `/api/receipts/${routePayload.receipt.id}/payment-requirements`,
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

    await postJson('/api/wallet', {
      agentWallet: '0x2222222222222222222222222222222222222222',
      network: 'Arc',
    });

    const signingPayload = await getJson(
      `/api/receipts/${routePayload.receipt.id}/payment-requirements`,
    );
    assert.equal(
      signingPayload.requirements[0].typedData.message.from,
      '0x2222222222222222222222222222222222222222',
    );
    assert.equal(
      signingPayload.requirements[0].typedData.message.to,
      creatorAccount.address,
    );
    assert.match(signingPayload.requirements[0].typedData.message.nonce, /^0x[0-9a-f]{64}$/u);
    assert.equal(signingPayload.requirements[0].typedData.domain.chainId, 5042002);

    const paymentResponse = await fetch(
      `${baseUrl}/api/receipts/${routePayload.receipt.id}/pay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payments: [] }),
      },
    );
    const paymentPayload = await paymentResponse.json();
    assert.equal(paymentResponse.status, 409);
    assert.equal(paymentPayload.payment.ok, false);
    assert.equal(paymentPayload.payment.reason, 'No creator payout was submitted.');
    assert.equal(paymentPayload.receipt.paymentStatus, 'settlement_setup');

    const disconnectResponse = await fetch(`${baseUrl}/api/wallet`, {
      method: 'DELETE',
    });
    const disconnectPayload = await disconnectResponse.json();
    assert.equal(disconnectResponse.ok, true);
    assert.equal(disconnectPayload.wallet.agentWallet, null);
    assert.equal(disconnectPayload.wallet.ready, false);

    const disconnectedSigningPayload = await getJson(
      `/api/receipts/${routePayload.receipt.id}/payment-requirements`,
    );
    assert.equal(disconnectedSigningPayload.payer, null);
    assert.equal(disconnectedSigningPayload.requirements[0].typedData, null);

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
