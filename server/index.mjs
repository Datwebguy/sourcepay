import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { verifyMessage } from 'viem';
import { loadEnv } from './env.mjs';
import {
  createPaymentQuote,
  createPaymentExecution,
  createReceiptSigningRequests,
  getArcWalletNetwork,
  getPaymentReadiness,
  getPaymentReadinessDetails,
  isEvmAddress,
} from './payments.mjs';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const distDir = join(__dirname, '..', 'dist');
const distIndexPath = join(distDir, 'index.html');
mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.SOURCEPAY_DB_PATH ?? join(dataDir, 'sourcepay.sqlite');
const db = new DatabaseSync(dbPath);
const sourceKinds = new Set(['Article', 'Social post', 'Transcript']);
const maxSourcePreviewBytes = 500_000;
const maxSourcePreviewRedirects = 3;
const maxPublicSourceContentLength = 360;
const minUsdcAmount = 1;
const defaultNetwork = 'Arc Testnet';
const walletAuthChallengeTtlSeconds = 5 * 60;
const walletAuthPurposes = new Set(['creator-earnings', 'buyer-receipts']);
const rateLimitBuckets = new Map();
const rateLimitExpiryQueue = [];
let rateLimitExpiryIndex = 0;
const rateLimitConfig = {
  authChallenge: { windowMs: 60_000, max: Number(process.env.SOURCEPAY_AUTH_LIMIT ?? 30) },
  sourcePreview: { windowMs: 60_000, max: Number(process.env.SOURCEPAY_PREVIEW_LIMIT ?? 12) },
  sourceWrite: { windowMs: 60_000, max: Number(process.env.SOURCEPAY_SOURCE_WRITE_LIMIT ?? 20) },
  route: { windowMs: 60_000, max: Number(process.env.SOURCEPAY_ROUTE_LIMIT ?? 20) },
  privateRead: { windowMs: 60_000, max: Number(process.env.SOURCEPAY_PRIVATE_READ_LIMIT ?? 60) },
  paymentRequirements: {
    windowMs: 60_000,
    max: Number(process.env.SOURCEPAY_PAYMENT_REQUIREMENTS_LIMIT ?? 60),
  },
  paymentSubmit: {
    windowMs: 60_000,
    max: Number(process.env.SOURCEPAY_PAYMENT_SUBMIT_LIMIT ?? 20),
  },
  proofVerify: { windowMs: 60_000, max: Number(process.env.SOURCEPAY_PROOF_VERIFY_LIMIT ?? 30) },
};

class ClientRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('Article', 'Social post', 'Transcript')),
    wallet TEXT NOT NULL,
    price REAL NOT NULL CHECK (price > 0),
    content TEXT NOT NULL DEFAULT '',
    owner_wallet TEXT,
    ownership_signature TEXT,
    ownership_message TEXT,
    status TEXT NOT NULL DEFAULT 'registered',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS research_runs (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    budget REAL NOT NULL CHECK (budget > 0),
    total_spend REAL NOT NULL DEFAULT 0,
    buyer_wallet TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'quoted',
    payment_status TEXT NOT NULL DEFAULT 'quoted',
    rail TEXT NOT NULL DEFAULT 'x402',
    network TEXT NOT NULL DEFAULT 'Arc Testnet',
    access_token TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS selected_sources (
    run_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    price REAL NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    wallet TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, source_id),
    FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payment_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    rail TEXT NOT NULL DEFAULT 'x402',
    network TEXT NOT NULL DEFAULT 'Arc Testnet',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payment_settlements (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    payer TEXT NOT NULL DEFAULT '',
    pay_to TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL DEFAULT '',
    transaction_id TEXT NOT NULL DEFAULT '',
    network TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wallet_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    agent_wallet TEXT,
    network TEXT NOT NULL DEFAULT 'Arc Testnet',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    purpose TEXT NOT NULL,
    nonce TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  INSERT OR IGNORE INTO wallet_config (id, network)
  VALUES (1, 'Arc Testnet');
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sources_wallet ON sources(wallet COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_sources_kind_status_created_at ON sources(kind, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_sources_owner_signed ON sources(owner_wallet, ownership_signature);
  CREATE INDEX IF NOT EXISTS idx_selected_sources_run_id ON selected_sources(run_id);
  CREATE INDEX IF NOT EXISTS idx_selected_sources_source_id ON selected_sources(source_id);
  CREATE INDEX IF NOT EXISTS idx_research_runs_access_token ON research_runs(access_token);
`);

const sourceColumns = db
  .prepare("PRAGMA table_info('sources')")
  .all()
  .map((column) => column.name);

if (!sourceColumns.includes('content')) {
  db.exec("ALTER TABLE sources ADD COLUMN content TEXT NOT NULL DEFAULT ''");
}
if (!sourceColumns.includes('owner_wallet')) {
  db.exec("ALTER TABLE sources ADD COLUMN owner_wallet TEXT");
}
if (!sourceColumns.includes('ownership_signature')) {
  db.exec("ALTER TABLE sources ADD COLUMN ownership_signature TEXT");
}
if (!sourceColumns.includes('ownership_message')) {
  db.exec("ALTER TABLE sources ADD COLUMN ownership_message TEXT");
}

const runColumns = db
  .prepare("PRAGMA table_info('research_runs')")
  .all()
  .map((column) => column.name);

if (!runColumns.includes('payment_status')) {
  db.exec("ALTER TABLE research_runs ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'quoted'");
}
if (!runColumns.includes('rail')) {
  db.exec("ALTER TABLE research_runs ADD COLUMN rail TEXT NOT NULL DEFAULT 'x402'");
}
if (!runColumns.includes('network')) {
  db.exec("ALTER TABLE research_runs ADD COLUMN network TEXT NOT NULL DEFAULT 'Arc Testnet'");
}
if (!runColumns.includes('access_token')) {
  db.exec("ALTER TABLE research_runs ADD COLUMN access_token TEXT");
}
if (!runColumns.includes('buyer_wallet')) {
  db.exec("ALTER TABLE research_runs ADD COLUMN buyer_wallet TEXT NOT NULL DEFAULT ''");
}

const selectedSourceColumns = db
  .prepare("PRAGMA table_info('selected_sources')")
  .all()
  .map((column) => column.name);

for (const [column, definition] of [
  ['title', "TEXT NOT NULL DEFAULT ''"],
  ['kind', "TEXT NOT NULL DEFAULT ''"],
  ['wallet', "TEXT NOT NULL DEFAULT ''"],
  ['content', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (!selectedSourceColumns.includes(column)) {
    db.exec(`ALTER TABLE selected_sources ADD COLUMN ${column} ${definition}`);
  }
}

const statements = {
  listSources: db.prepare(`
    SELECT
      id,
      title,
      kind,
      wallet,
      price,
      content,
      owner_wallet AS ownerWallet,
      ownership_signature AS ownershipSignature,
      ownership_message AS ownershipMessage,
      status,
      created_at AS createdAt
    FROM sources
    WHERE status = 'registered'
    ORDER BY datetime(created_at) DESC
  `),
  listSourcesByWallet: db.prepare(`
    SELECT
      id,
      title,
      kind,
      wallet,
      price,
      content,
      owner_wallet AS ownerWallet,
      ownership_signature AS ownershipSignature,
      ownership_message AS ownershipMessage,
      status,
      created_at AS createdAt
    FROM sources
    WHERE status = 'registered'
      AND lower(wallet) = lower(?)
    ORDER BY datetime(created_at) DESC
  `),
  insertSource: db.prepare(`
    INSERT INTO sources (
      id,
      title,
      kind,
      wallet,
      price,
      content,
      owner_wallet,
      ownership_signature,
      ownership_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getSource: db.prepare(`
    SELECT
      id,
      title,
      kind,
      wallet,
      price,
      content,
      owner_wallet AS ownerWallet,
      ownership_signature AS ownershipSignature,
      ownership_message AS ownershipMessage,
      status,
      created_at AS createdAt
    FROM sources
    WHERE id = ?
  `),
  updateSource: db.prepare(`
    UPDATE sources
    SET
      title = ?,
      kind = ?,
      wallet = ?,
      price = ?,
      content = ?,
      owner_wallet = ?,
      ownership_signature = ?,
      ownership_message = ?
    WHERE id = ?
  `),
  deleteSource: db.prepare(`
    UPDATE sources
    SET status = 'archived'
    WHERE id = ?
  `),
  eligibleSources: db.prepare(`
    SELECT
      id,
      title,
      kind,
      wallet,
      price,
      content,
      owner_wallet AS ownerWallet,
      ownership_signature AS ownershipSignature,
      ownership_message AS ownershipMessage,
      status,
      created_at AS createdAt
    FROM sources
    WHERE kind IN (SELECT value FROM json_each(?))
      AND status = 'registered'
      AND NULLIF(TRIM(owner_wallet), '') IS NOT NULL
      AND NULLIF(TRIM(ownership_signature), '') IS NOT NULL
    ORDER BY datetime(created_at) ASC
  `),
  insertRun: db.prepare(`
    INSERT INTO research_runs (id, question, budget, total_spend, access_token, buyer_wallet)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  insertSelectedSource: db.prepare(`
    INSERT INTO selected_sources (
      run_id,
      source_id,
      rank,
      price,
      title,
      kind,
      wallet,
      content
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getRun: db.prepare(`
    SELECT
      id,
      question,
      budget,
      total_spend AS totalSpend,
      status,
      payment_status AS paymentStatus,
      rail,
      network,
      access_token AS accessToken,
      buyer_wallet AS buyerWallet,
      created_at AS createdAt
    FROM research_runs
    WHERE id = ?
  `),
  getRunByPrefix: db.prepare(`
    SELECT
      id,
      question,
      budget,
      total_spend AS totalSpend,
      status,
      payment_status AS paymentStatus,
      rail,
      network,
      access_token AS accessToken,
      buyer_wallet AS buyerWallet,
      created_at AS createdAt
    FROM research_runs
    WHERE id LIKE ? || '%'
    ORDER BY datetime(created_at) DESC
  `),
  getRunSources: db.prepare(`
    SELECT
      COALESCE(s.id, ss.source_id) AS id,
      COALESCE(NULLIF(ss.title, ''), s.title) AS title,
      COALESCE(NULLIF(ss.kind, ''), s.kind) AS kind,
      COALESCE(NULLIF(ss.wallet, ''), s.wallet) AS wallet,
      COALESCE(NULLIF(ss.content, ''), s.content) AS content,
      s.owner_wallet AS ownerWallet,
      s.ownership_signature AS ownershipSignature,
      s.ownership_message AS ownershipMessage,
      ss.price,
      COALESCE(s.status, 'archived') AS status,
      ss.rank
    FROM selected_sources ss
    LEFT JOIN sources s ON s.id = ss.source_id
    WHERE ss.run_id = ?
    ORDER BY ss.rank ASC
  `),
  listPaymentAttempts: db.prepare(`
    SELECT
      id,
      run_id AS runId,
      status,
      reason,
      rail,
      network,
      created_at AS createdAt
    FROM payment_attempts
    WHERE run_id = ?
    ORDER BY datetime(created_at) DESC
  `),
  insertPaymentAttempt: db.prepare(`
    INSERT INTO payment_attempts (id, run_id, status, reason, rail, network)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listPaymentSettlements: db.prepare(`
    SELECT
      id,
      attempt_id AS attemptId,
      run_id AS runId,
      source_id AS sourceId,
      payer,
      pay_to AS payTo,
      amount,
      transaction_id AS transactionId,
      network,
      created_at AS createdAt
    FROM payment_settlements
    WHERE run_id = ?
    ORDER BY datetime(created_at) DESC
  `),
  insertPaymentSettlement: db.prepare(`
    INSERT INTO payment_settlements (
      id,
      attempt_id,
      run_id,
      source_id,
      payer,
      pay_to,
      amount,
      transaction_id,
      network
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateRunPaymentStatus: db.prepare(`
    UPDATE research_runs
    SET payment_status = ?
    WHERE id = ?
  `),
  insertAuthChallenge: db.prepare(`
    INSERT INTO auth_challenges (
      id,
      wallet,
      purpose,
      nonce,
      message,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getAuthChallenge: db.prepare(`
    SELECT
      id,
      wallet,
      purpose,
      nonce,
      message,
      expires_at AS expiresAt,
      consumed_at AS consumedAt,
      created_at AS createdAt
    FROM auth_challenges
    WHERE id = ?
  `),
  consumeAuthChallenge: db.prepare(`
    UPDATE auth_challenges
    SET consumed_at = unixepoch()
    WHERE id = ?
      AND consumed_at IS NULL
  `),
  deleteExpiredAuthChallenges: db.prepare(`
    DELETE FROM auth_challenges
    WHERE expires_at < unixepoch() - 3600
       OR consumed_at < unixepoch() - 3600
  `),
  listRuns: db.prepare(`
    SELECT
      id,
      question,
      budget,
      total_spend AS totalSpend,
      status,
      payment_status AS paymentStatus,
      rail,
      network,
      buyer_wallet AS buyerWallet,
      created_at AS createdAt
    FROM research_runs
    WHERE payment_status IN ('paid', 'settled')
    ORDER BY datetime(created_at) DESC
    LIMIT 50
  `),
  listRunsByBuyer: db.prepare(`
    SELECT
      id,
      question,
      budget,
      total_spend AS totalSpend,
      status,
      payment_status AS paymentStatus,
      rail,
      network,
      access_token AS accessToken,
      buyer_wallet AS buyerWallet,
      created_at AS createdAt
    FROM research_runs
    WHERE lower(buyer_wallet) = lower(?)
    ORDER BY datetime(created_at) DESC
    LIMIT 100
  `),
  listCreatorCitations: db.prepare(`
    SELECT
      rr.id AS receiptId,
      rr.question,
      rr.payment_status AS paymentStatus,
      rr.rail,
      rr.network,
      rr.buyer_wallet AS buyerWallet,
      rr.created_at AS createdAt,
      ss.source_id AS sourceId,
      ss.rank,
      ss.price,
      ss.title,
      ss.kind,
      ss.wallet,
      ss.content
    FROM selected_sources ss
    JOIN research_runs rr ON rr.id = ss.run_id
    WHERE lower(ss.wallet) = lower(?)
    ORDER BY datetime(rr.created_at) DESC, ss.rank ASC
  `),
  listSourceCitations: db.prepare(`
    SELECT
      rr.id AS receiptId,
      rr.question,
      rr.payment_status AS paymentStatus,
      rr.rail,
      rr.network,
      rr.buyer_wallet AS buyerWallet,
      rr.created_at AS createdAt,
      ss.rank,
      ss.price
    FROM selected_sources ss
    JOIN research_runs rr ON rr.id = ss.run_id
    WHERE ss.source_id = ?
    ORDER BY datetime(rr.created_at) DESC, ss.rank ASC
  `),
  deleteEmptyRuns: db.prepare(`
    DELETE FROM research_runs
    WHERE NOT EXISTS (
      SELECT 1
      FROM selected_sources
      WHERE selected_sources.run_id = research_runs.id
    )
  `),
};

statements.deleteEmptyRuns.run();

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  response.end(JSON.stringify(body));
}

function sendRateLimited(response, result) {
  response.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Retry-After': String(result.retryAfter),
  });
  response.end(
    JSON.stringify({
      error: 'Too many requests. Please wait and try again.',
      retryAfter: result.retryAfter,
    }),
  );
}

function getClientIp(request) {
  const forwarded = String(request.headers['fly-client-ip'] ?? request.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim();
  return forwarded || request.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(request, group, options = {}) {
  const config = rateLimitConfig[group];
  if (!config || config.max <= 0) return { limited: false };

  const keySuffix = options.key ? `:${options.key}` : '';
  const key = `${group}:${getClientIp(request)}${keySuffix}`;
  const now = Date.now();
  const current = rateLimitBuckets.get(key);

  if (!current || current.resetAt <= now) {
    const resetAt = now + config.windowMs;
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt,
    });
    rateLimitExpiryQueue.push({ key, resetAt });
    cleanupRateLimitBuckets(now);
    return { limited: false };
  }

  current.count += 1;
  if (current.count > config.max) {
    return {
      limited: true,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  return { limited: false };
}

function cleanupRateLimitBuckets(now) {
  while (rateLimitExpiryIndex < rateLimitExpiryQueue.length) {
    const entry = rateLimitExpiryQueue[rateLimitExpiryIndex];
    if (entry.resetAt > now) break;

    rateLimitExpiryIndex += 1;
    const bucket = rateLimitBuckets.get(entry.key);
    if (bucket?.resetAt <= now) rateLimitBuckets.delete(entry.key);
  }

  if (rateLimitExpiryIndex > 1000 && rateLimitExpiryIndex * 2 > rateLimitExpiryQueue.length) {
    rateLimitExpiryQueue.splice(0, rateLimitExpiryIndex);
    rateLimitExpiryIndex = 0;
  }
}

function applyRateLimit(request, response, group, options = {}) {
  const result = checkRateLimit(request, group, options);
  if (result.limited) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    logEvent('warn', 'rate_limit.hit', {
      ...requestLogFields(request, url),
      group,
      key: options.key ? maskIdentifier(options.key) : '',
      retryAfter: result.retryAfter,
    });
    sendRateLimited(response, result);
    return true;
  }
  return false;
}

function sendHtml(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(body);
}

async function sendFile(response, status, filePath) {
  const isAppShell = filePath === distIndexPath || filePath.endsWith(`${pathSeparator()}index.html`);
  response.writeHead(status, {
    'Content-Type': contentTypeForPath(filePath),
    'Cache-Control': isAppShell ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  response.end(await readFile(filePath));
}

function contentTypeForPath(filePath) {
  const extension = extname(filePath).toLowerCase();
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  return types[extension] ?? 'application/octet-stream';
}

async function serveFrontend(url, response) {
  if (!existsSync(distIndexPath)) return false;
  if (url.pathname === '/health' || url.pathname.startsWith('/api/')) return false;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    await sendFile(response, 200, distIndexPath);
    return true;
  }

  const filePath = resolve(distDir, `.${pathname}`);
  const isInsideDist = filePath === distDir || filePath.startsWith(`${distDir}${pathSeparator()}`);
  if (isInsideDist && existsSync(filePath) && statSync(filePath).isFile()) {
    await sendFile(response, 200, filePath);
    return true;
  }

  await sendFile(response, 200, distIndexPath);
  return true;
}

function pathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

function renderBackendHome({ sourceCount, wallet, payment }) {
  const walletState = wallet.ready ? 'Connected in browser' : 'Browser only';
  const paymentState = payment.ready ? 'Ready' : 'Action needed';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SourcePay</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #071018;
      color: #fff;
    }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 12% 10%, rgba(95,169,255,.24), transparent 32%),
        radial-gradient(circle at 88% 12%, rgba(244,132,95,.18), transparent 28%),
        linear-gradient(135deg, #071018 0%, #0d0f12 48%, #17100e 100%);
    }
    main {
      width: min(920px, calc(100vw - 32px));
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      background: rgba(11,14,17,.88);
      box-shadow: 0 24px 80px rgba(0,0,0,.4);
      overflow: hidden;
    }
    header, section {
      padding: 24px;
      border-bottom: 1px solid rgba(255,255,255,.1);
    }
    section:last-child {
      border-bottom: 0;
    }
    h1 {
      margin: 0;
      font-size: clamp(32px, 5vw, 64px);
      line-height: .95;
      letter-spacing: 0;
    }
    p {
      margin: 10px 0 0;
      color: rgba(255,255,255,.58);
      line-height: 1.6;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .card {
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 8px;
      padding: 16px;
      background: rgba(255,255,255,.035);
    }
    .label {
      display: block;
      color: rgba(255,255,255,.42);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .14em;
      text-transform: uppercase;
    }
    .value {
      display: block;
      margin-top: 10px;
      font-size: 20px;
      font-weight: 800;
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    a {
      color: #fff;
      text-decoration: none;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 800;
      font-size: 14px;
    }
    a:hover {
      border-color: rgba(255,255,255,.42);
    }
    @media (max-width: 720px) {
      .grid {
        grid-template-columns: 1fr;
      }
      header, section {
        padding: 18px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>SourcePay</h1>
      <p>Creator source payments are online. Open the app to register sources, route requests, and settle receipts.</p>
    </header>
    <section class="grid">
      <div class="card"><span class="label">Sources</span><span class="value">${sourceCount}</span></div>
      <div class="card"><span class="label">Payer wallet</span><span class="value">${walletState}</span></div>
      <div class="card"><span class="label">Settlement</span><span class="value">${paymentState}</span></div>
    </section>
    <section class="links">
      <a href="http://127.0.0.1:5173">Open SourcePay</a>
    </section>
  </main>
</body>
</html>`;
}

function normalizeSource(row) {
  const fullContent = row.content ?? '';
  const source = {
    id: row.id,
    title: row.title,
    kind: row.kind,
    wallet: row.wallet,
    price: row.price,
    content: fullContent,
    ownerWallet: row.ownerWallet ?? null,
    ownershipVerified: Boolean(row.ownershipSignature),
    status: row.status,
    createdAt: row.createdAt,
  };

  return {
    ...source,
    content: publicSourceContentPreview(fullContent),
    fingerprint: sourceFingerprint(source),
  };
}

function publicSourceContentPreview(value) {
  const normalized = normalizeSourceText(value);
  if (normalized.length <= maxPublicSourceContentLength) return normalized;
  return `${normalized.slice(0, maxPublicSourceContentLength).trimEnd()}...`;
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ClientRequestError('Request body must be valid JSON.');
  }
}

async function validateSource(input, existingSource = null) {
  const title = String(input.title ?? '').trim();
  const kind = String(input.kind ?? '').trim();
  const wallet = String(input.wallet ?? '').trim();
  const content = String(input.content ?? '').trim();
  const price = Number(input.price);
  const ownershipSignature = String(input.ownershipSignature ?? '').trim();
  const ownerWallet = String(input.ownerWallet ?? wallet).trim();

  if (!title) return { error: 'Source title is required.' };
  if (!sourceKinds.has(kind)) return { error: 'Unsupported source class.' };
  if (!wallet) return { error: 'Creator wallet is required.' };
  if (!isEvmAddress(wallet)) return { error: 'Creator wallet must be a valid EVM address.' };
  if (!content) return { error: 'Source content or description is required.' };
  if (!Number.isFinite(price) || price < minUsdcAmount) {
    return { error: 'Citation price must be at least 1 USDC.' };
  }

  const candidate = { title, kind, wallet, price, content };
  const message = buildSourceOwnershipMessage(candidate);
  const isUnchangedExistingProof =
    existingSource?.ownershipSignature &&
    existingSource.ownerWallet?.toLowerCase() === wallet.toLowerCase() &&
    existingSource.wallet?.toLowerCase() === wallet.toLowerCase() &&
    existingSource.title === title &&
    existingSource.kind === kind &&
    Number(existingSource.price) === price &&
    existingSource.content === content;

  if (isUnchangedExistingProof && !ownershipSignature) {
    return {
      value: {
        ...candidate,
        ownerWallet: existingSource.ownerWallet,
        ownershipSignature: existingSource.ownershipSignature,
        ownershipMessage: existingSource.ownershipMessage,
      },
    };
  }

  if (!ownershipSignature) {
    return { error: 'Sign with the payout wallet before registering this source.' };
  }
  if (!ownerWallet || ownerWallet.toLowerCase() !== wallet.toLowerCase()) {
    return { error: 'The signing wallet must match the payout wallet.' };
  }

  const verified = await verifyMessage({
    address: wallet,
    message,
    signature: ownershipSignature,
  }).catch(() => false);

  if (!verified) {
    return { error: 'Wallet signature did not match this source registration.' };
  }

  return {
    value: {
      ...candidate,
      ownerWallet: wallet,
      ownershipSignature,
      ownershipMessage: message,
    },
  };
}

function buildSourceOwnershipMessage(source) {
  const normalized = {
    title: String(source.title ?? '').trim(),
    kind: String(source.kind ?? '').trim(),
    wallet: String(source.wallet ?? '').trim(),
    price: Number(source.price),
    content: String(source.content ?? '').trim(),
  };

  return [
    'SourcePay source registration',
    `Payout wallet: ${normalized.wallet}`,
    `Title: ${normalized.title}`,
    `Class: ${normalized.kind}`,
    `Citation price USDC: ${normalized.price}`,
    `Source fingerprint: ${sourceFingerprint(normalized)}`,
  ].join('\n');
}

function buildSourceArchiveMessage(source) {
  const normalized = normalizeSource(source);

  return [
    'SourcePay source archive',
    `Source ID: ${normalized.id}`,
    `Payout wallet: ${normalized.wallet}`,
    `Title: ${normalized.title}`,
    `Source fingerprint: ${normalized.fingerprint}`,
  ].join('\n');
}

function formatAuthPurpose(purpose) {
  if (purpose === 'creator-earnings') return 'Creator earnings';
  if (purpose === 'buyer-receipts') return 'Buyer receipts';
  return String(purpose ?? '').trim();
}

function buildWalletAuthMessage({ wallet, purpose, nonce, expiresAt }) {
  return [
    'SourcePay wallet authorization',
    `Purpose: ${formatAuthPurpose(purpose)}`,
    `Payout wallet: ${String(wallet ?? '').trim()}`,
    `Network: ${getArcWalletNetwork().chainName}`,
    `Nonce: ${nonce}`,
    `Expires at: ${new Date(expiresAt * 1000).toISOString()}`,
  ].join('\n');
}

function createWalletAuthChallenge(input) {
  const wallet = String(input.wallet ?? '').trim();
  const purpose = String(input.purpose ?? '').trim();

  if (!wallet) return { status: 400, error: 'Wallet is required.' };
  if (!isEvmAddress(wallet)) return { status: 400, error: 'Wallet must be a valid EVM address.' };
  if (!walletAuthPurposes.has(purpose)) {
    return { status: 400, error: 'Unsupported wallet authorization purpose.' };
  }

  statements.deleteExpiredAuthChallenges.run();

  const id = randomUUID();
  const nonce = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + walletAuthChallengeTtlSeconds;
  const message = buildWalletAuthMessage({ wallet, purpose, nonce, expiresAt });

  statements.insertAuthChallenge.run(id, wallet, purpose, nonce, message, expiresAt);

  return {
    value: {
      id,
      wallet,
      purpose,
      message,
      expiresAt,
    },
  };
}

async function validateCreatorEarningsAccess(input) {
  const parsed = await validateWalletChallengeAccess(input, {
    purpose: 'creator-earnings',
    walletLabel: 'Payout wallet',
    missingWalletError: 'Payout wallet is required.',
    missingChallengeError: 'Request a fresh wallet challenge before viewing earnings.',
    missingSignatureError: 'Sign with the payout wallet before viewing earnings.',
    mismatchError: 'The signing wallet must match the payout wallet.',
    invalidSignatureError: 'Wallet signature did not authorize earnings access.',
  });
  if (parsed.error) return parsed;

  return { value: { wallet: parsed.value.wallet } };
}

async function validateBuyerReceiptsAccess(input) {
  const parsed = await validateWalletChallengeAccess(input, {
    purpose: 'buyer-receipts',
    walletLabel: 'Buyer wallet',
    missingWalletError: 'Buyer wallet is required.',
    missingChallengeError: 'Request a fresh wallet challenge before viewing buyer receipts.',
    missingSignatureError: 'Sign with the buyer wallet before viewing receipts.',
    mismatchError: 'The signing wallet must match the buyer wallet.',
    invalidSignatureError: 'Wallet signature did not authorize receipt access.',
  });
  if (parsed.error) return parsed;

  return { value: { wallet: parsed.value.wallet } };
}

async function validateWalletChallengeAccess(input, options) {
  const wallet = String(input.wallet ?? '').trim();
  const ownerWallet = String(input.ownerWallet ?? '').trim();
  const authSignature = String(input.authSignature ?? '').trim();
  const challengeId = String(input.challengeId ?? '').trim();

  if (!wallet) return { status: 400, error: options.missingWalletError };
  if (!isEvmAddress(wallet)) {
    return { status: 400, error: `${options.walletLabel} must be a valid EVM address.` };
  }
  if (!challengeId) {
    return { status: 401, error: options.missingChallengeError };
  }
  if (!ownerWallet || !authSignature) {
    return { status: 401, error: options.missingSignatureError };
  }
  if (ownerWallet.toLowerCase() !== wallet.toLowerCase()) {
    return { status: 403, error: options.mismatchError };
  }

  const challenge = statements.getAuthChallenge.get(challengeId);
  const now = Math.floor(Date.now() / 1000);
  if (!challenge) {
    return { status: 401, error: 'Wallet challenge was not found. Request a new one.' };
  }
  if (challenge.purpose !== options.purpose) {
    return { status: 403, error: 'Wallet challenge purpose does not match this action.' };
  }
  if (challenge.wallet.toLowerCase() !== wallet.toLowerCase()) {
    return { status: 403, error: 'Wallet challenge does not belong to this payout wallet.' };
  }
  if (challenge.consumedAt) {
    return { status: 401, error: 'Wallet challenge has already been used. Request a new one.' };
  }
  if (Number(challenge.expiresAt) < now) {
    return { status: 401, error: 'Wallet challenge expired. Request a new one.' };
  }

  const verified = await verifyMessage({
    address: wallet,
    message: challenge.message,
    signature: authSignature,
  }).catch(() => false);

  if (!verified) {
    return { status: 403, error: options.invalidSignatureError };
  }

  const consumed = statements.consumeAuthChallenge.run(challenge.id);
  if (consumed.changes !== 1) {
    return { status: 401, error: 'Wallet challenge has already been used. Request a new one.' };
  }

  return { value: { wallet } };
}

async function validateSourceArchive(input, source) {
  const ownerWallet = String(input.ownerWallet ?? '').trim();
  const archiveSignature = String(input.archiveSignature ?? '').trim();
  const normalized = normalizeSource(source);

  if (!ownerWallet || !archiveSignature) {
    return { error: 'Sign with the payout wallet before archiving this source.' };
  }
  if (ownerWallet.toLowerCase() !== normalized.wallet.toLowerCase()) {
    return { error: 'Only the payout wallet can archive this source.' };
  }

  const verified = await verifyMessage({
    address: normalized.wallet,
    message: buildSourceArchiveMessage(source),
    signature: archiveSignature,
  }).catch(() => false);

  if (!verified) {
    return { error: 'Wallet signature did not authorize this archive.' };
  }

  return { value: true };
}

async function buildSourcePreview(input) {
  const material = String(input.material ?? '').trim();
  if (!material) return { error: 'Source material is required.' };

  if (isHttpUrl(material)) {
    return sourcePreviewFromUrl(material);
  }

  const content = normalizeSourceText(material);
  if (content.length < 20) {
    return { error: 'Source material is too short to register.' };
  }

  return {
    value: {
      title: inferSourceTitle(content),
      content,
      sourceType: 'text',
    },
  };
}

async function sourcePreviewFromUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: 'Source URL is invalid.' };
  }

  try {
    const response = await fetchPublicSourceUrl(parsedUrl);

    if (!response.ok) {
      return { error: `Source URL returned HTTP ${response.status}.` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text') && !contentType.includes('json')) {
      return { error: 'Source URL did not return readable text.' };
    }

    const body = await readLimitedResponseText(response, maxSourcePreviewBytes);
    const isHtml = contentType.includes('html') || /<html|<body|<article/iu.test(body);
    const rawTitle = isHtml
      ? extractHtmlTitle(body) || readableUrlTitle(parsedUrl)
      : readableUrlTitle(parsedUrl);
    const rawContent = normalizeSourceText(isHtml ? htmlToText(body) : body);
    const preview = isXPostUrl(parsedUrl)
      ? buildXPostPreview({ url: parsedUrl, title: rawTitle, content: rawContent })
      : {
          title: rawTitle,
          content: rawContent,
          url: parsedUrl.toString(),
        };

    if (preview.content.length < 20) {
      return { error: 'Source URL did not contain enough readable text.' };
    }

    return {
      value: {
        title: preview.title,
        content: preview.content,
        sourceType: 'url',
        url: preview.url,
      },
    };
  } catch (error) {
    if (error instanceof ClientRequestError) {
      return { error: error.message };
    }
    if (error?.name === 'TimeoutError') {
      return { error: 'Source URL timed out.' };
    }

    return { error: 'Source URL could not be read.' };
  }
}

async function fetchPublicSourceUrl(url, redirects = 0) {
  await assertPublicSourceUrl(url);

  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
      'User-Agent': 'SourcePay/0.1 source-preview',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  });

  if (isRedirectStatus(response.status)) {
    if (redirects >= maxSourcePreviewRedirects) {
      throw new ClientRequestError('Source URL redirected too many times.');
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new ClientRequestError('Source URL redirect was missing a destination.');
    }

    return fetchPublicSourceUrl(new URL(location, url), redirects + 1);
  }

  return response;
}

async function assertPublicSourceUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ClientRequestError('Source URL must use http or https.');
  }
  if (url.username || url.password) {
    throw new ClientRequestError('Source URL cannot include credentials.');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new ClientRequestError('Source URL must point to a public website.');
  }

  const addresses = await resolveHostnameAddresses(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => isBlockedIpAddress(address))) {
    throw new ClientRequestError('Source URL must point to a public website.');
  }
}

async function resolveHostnameAddresses(hostname) {
  if (isIP(hostname)) return [hostname];

  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map(
      (entry) => entry.address,
    );
  } catch {
    throw new ClientRequestError('Source URL host could not be resolved.');
  }
}

function isBlockedHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '0' ||
    normalized === '0.0.0.0'
  );
}

function isBlockedIpAddress(address) {
  if (address.includes('%')) return true;

  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function isBlockedIpv4(address) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [first, second] = parts;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase();

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff')
  );
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readLimitedResponseText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new ClientRequestError('Source URL returned too much text.');
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isXPostUrl(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./u, '');
  return (host === 'x.com' || host === 'twitter.com') && /\/status\/\d+/u.test(url.pathname);
}

function buildXPostPreview({ url, title, content }) {
  const cleanContent = cleanXContent(content);
  const cleanTitle = inferXTitleFromContent(cleanContent) || cleanXTitle(title, url);

  return {
    title: cleanTitle,
    content: cleanContent,
    url: canonicalXUrl(url),
  };
}

function cleanXTitle(title, url) {
  const normalized = normalizeSourceText(
    decodeHtml(title)
      .replace(/\s*\/\s*X$/iu, '')
      .replace(/\s+on\s+X:\s*".*$/iu, ' on X'),
  );
  if (normalized && !normalized.includes('Log in')) return normalized.slice(0, 160);

  const handle = url.pathname.split('/').filter(Boolean)[0];
  return handle ? `${handle} on X` : readableUrlTitle(url);
}

function cleanXContent(content) {
  let value = normalizeSourceText(decodeHtml(content));
  value = value.replace(/:host\{[\s\S]*$/iu, ' ');
  value = value.replace(/\bnumber-flow-react\b[\s\S]*$/iu, ' ');
  value = value.replace(/^.*?\bPost\s+/iu, '');
  value = value.replace(/^[^@]{1,80}\s+@[A-Za-z0-9_]{1,20}\s+/u, '');
  value = value.replace(/^(Article|Thread|Post)\s+/iu, '');
  value = value
    .replace(/^Log in\s+Sign up\s+/iu, '')
    .replace(/\s+Log in\s+Sign up\s+/giu, ' ')
    .replace(/\s+\d{1,2}:\d{2}\s+[AP]M\s+·\s+\w+\s+\d{1,2},\s+20\d{2}\s+\d+(?:\.\d+)?[KM]?\s+Views[\s\S]*$/iu, ' ')
    .replace(/\s+\d+(?:\.\d+)?[KM]?\s+Views[\s\S]*$/iu, ' ')
    .replace(/\s+Read\s+\d+\s+replies[\s\S]*$/iu, ' ')
    .replace(/\s+Sign up with Google[\s\S]*$/iu, ' ')
    .replace(/\s+By signing up,[\s\S]*$/iu, ' ')
    .replace(/\s+Terms of Service[\s\S]*$/iu, ' ')
    .replace(/\s+Relevant people[\s\S]*$/iu, ' ')
    .replace(/\s+Trending now[\s\S]*$/iu, ' ')
    .replace(/\s+New to X\?[\s\S]*$/iu, ' ')
    .replace(/\s+©\s+20\d{2}\s+X Corp\.[\s\S]*$/iu, ' ');

  return normalizeSourceText(value).slice(0, 5000);
}

function inferXTitleFromContent(content) {
  const normalized = normalizeSourceText(content);
  if (!normalized) return '';

  const sentenceTitle = normalized.match(/^(.{12,120}?)\.\s+[A-Z0-9]/u)?.[1];
  if (sentenceTitle) return sentenceTitle.slice(0, 120);

  const articleLead = normalized.match(/^(.{12,90}?)\s+(When|Why|How|What|If|The|A|An|Everyone|I)\s/u)?.[1];
  if (articleLead) return articleLead.slice(0, 120);

  return normalized.slice(0, 120);
}

function canonicalXUrl(url) {
  const [handle, status, id] = url.pathname.split('/').filter(Boolean);
  if (handle && status === 'status' && id) {
    return `https://x.com/${handle}/status/${id}`;
  }

  return url.toString();
}

function extractHtmlTitle(html) {
  const ogTitle =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/iu)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/iu)?.[1];
  const title = ogTitle ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1];
  return title ? normalizeSourceText(decodeHtml(title)).slice(0, 160) : '';
}

function htmlToText(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style[\s\S]*?<\/style>/giu, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
      .replace(/<[^>]+>/gu, ' '),
  );
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>');
}

function normalizeSourceText(value) {
  return String(value)
    .replace(/\s+/gu, ' ')
    .trim();
}

function inferSourceTitle(content) {
  const firstLine = content.split(/[.!?\n]/u).find((line) => line.trim()) ?? content;
  return firstLine.trim().slice(0, 120) || 'Untitled source';
}

function readableUrlTitle(url) {
  const lastPath = url.pathname.split('/').filter(Boolean).pop();
  if (!lastPath) return url.hostname;

  return decodeURIComponent(lastPath)
    .replace(/\.[a-z0-9]+$/iu, '')
    .replace(/[-_]+/gu, ' ')
    .trim()
    .slice(0, 120) || url.hostname;
}

function normalizeNetworkName(value) {
  const network = String(value ?? '').trim();
  if (!network || network.toLowerCase() === 'arc') return defaultNetwork;
  return network;
}

function maskAddress(value) {
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function maskIdentifier(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 12) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function logEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function logError(event, error, fields = {}) {
  logEvent('error', event, {
    ...fields,
    errorName: error?.name ?? 'Error',
    errorMessage: error?.message ?? String(error),
  });
}

function requestLogFields(request, url) {
  return {
    method: request.method,
    path: url.pathname,
    ip: getClientIp(request),
  };
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

function normalizeRun(row) {
  return {
    id: row.id,
    question: row.question,
    budget: row.budget,
    totalSpend: row.totalSpend,
    status: row.status ?? 'quoted',
    paymentStatus: row.paymentStatus ?? 'quoted',
    rail: row.rail ?? 'x402',
    network: normalizeNetworkName(row.network),
    accessToken: row.accessToken ?? null,
    buyerWallet: row.buyerWallet ?? '',
    createdAt: row.createdAt,
  };
}

function findRun(identifier) {
  const id = String(identifier ?? '').trim();
  if (!id) return null;

  const exact = statements.getRun.get(id);
  if (exact) return exact;

  if (/^[a-f0-9]{8,35}$/iu.test(id)) {
    const matches = statements.getRunByPrefix.all(id);
    if (matches.length === 1) return matches[0];
  }

  return null;
}

const routeStopWords = new Set([
  'the',
  'and',
  'for',
  'from',
  'with',
  'about',
  'into',
  'that',
  'this',
  'they',
  'what',
  'when',
  'where',
  'which',
  'why',
  'how',
  'find',
  'tell',
  'give',
  'show',
  'explain',
  'summarize',
  'summary',
  'source',
  'sources',
  'creator',
  'creators',
  'post',
  'posts',
  'article',
  'articles',
  'transcript',
  'transcripts',
  'research',
  'request',
  'answer',
  'matters',
  'thing',
  'things',
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2 && !routeStopWords.has(token));
}

function scoreSource(source, questionTokens, questionPhrases) {
  const sourceText = `${source.title} ${source.content}`.toLowerCase();
  const sourceTokens = new Set(tokenize(sourceText));
  let overlap = 0;
  let strongOverlap = 0;

  for (const token of questionTokens) {
    if (sourceTokens.has(token)) {
      overlap += 1;
      if (token.length >= 5) strongOverlap += 1;
    }
  }

  const tokenScore = overlap / Math.max(questionTokens.length, 1);
  const phraseScore = questionPhrases.some((phrase) => sourceText.includes(phrase))
    ? 0.35
    : 0;

  if (overlap === 0) return 0;
  if (questionTokens.length > 1 && strongOverlap === 0 && phraseScore === 0) return 0;

  return tokenScore + phraseScore;
}

function buildSearchPhrases(tokens) {
  const phrases = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return phrases;
}

function isPublicReceiptStatus(status) {
  return status === 'paid' || status === 'settled';
}

function buildReceipt(runId, options = {}) {
  const run = findRun(runId);
  if (!run) return null;
  const normalizedRun = normalizeRun(run);
  const hasAccess =
    options.allowPrivate ||
    isPublicReceiptStatus(normalizedRun.paymentStatus) ||
    (normalizedRun.accessToken &&
      options.accessToken &&
      normalizedRun.accessToken === options.accessToken);

  if (!hasAccess) return null;

  const receipt = {
    ...normalizedRun,
    sources: statements.getRunSources.all(normalizedRun.id).map(normalizeSource),
    paymentAttempts: statements.listPaymentAttempts.all(normalizedRun.id),
    paymentSettlements: statements.listPaymentSettlements.all(normalizedRun.id),
  };

  if (!options.includeAccessToken) {
    delete receipt.accessToken;
  }

  return receipt;
}

function buildReceiptProof(receipt) {
  return {
    proofType: 'SourcePay citation receipt',
    receiptId: receipt.id,
    createdAt: receipt.createdAt,
    question: receipt.question,
    budget: receipt.budget,
    totalSpend: receipt.totalSpend,
    rail: receipt.rail,
    network: receipt.network,
    status: receipt.paymentStatus,
    sources: receipt.sources.map((source) => ({
      sourceId: source.id,
      rank: source.rank,
      title: source.title,
      kind: source.kind,
      wallet: source.wallet,
      displayWallet: maskAddress(source.wallet),
      price: source.price,
      fingerprint: source.fingerprint,
    })),
    payments: receipt.paymentAttempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      reason: attempt.reason,
      rail: attempt.rail,
      network: attempt.network,
      createdAt: attempt.createdAt,
    })),
    settlements: receipt.paymentSettlements.map((settlement) => ({
      id: settlement.id,
      attemptId: settlement.attemptId,
      sourceId: settlement.sourceId,
      payer: settlement.payer,
      payTo: settlement.payTo,
      amount: settlement.amount,
      transactionId: settlement.transactionId,
      network: settlement.network,
      createdAt: settlement.createdAt,
    })),
  };
}

function buildCreatorEarnings(wallet) {
  const citations = statements.listCreatorCitations.all(wallet).map((row) => {
    const source = normalizeSource({
      id: row.sourceId,
      title: row.title,
      kind: row.kind,
      wallet: row.wallet,
      price: row.price,
      content: row.content,
      status: 'registered',
      createdAt: row.createdAt,
      rank: row.rank,
    });

    return {
      receiptId: row.receiptId,
      question: row.question,
      paymentStatus: row.paymentStatus,
      rail: row.rail,
      network: row.network,
      createdAt: row.createdAt,
      source: {
        id: source.id,
        title: source.title,
        kind: source.kind,
        price: source.price,
        fingerprint: source.fingerprint,
      },
      rank: row.rank,
      quotedAmount: row.price,
      paidAmount: isPaidStatus(row.paymentStatus) ? row.price : 0,
    };
  });
  const sourceTotals = new Map();

  for (const citation of citations) {
    const current = sourceTotals.get(citation.source.id) ?? {
      id: citation.source.id,
      title: citation.source.title,
      kind: citation.source.kind,
      fingerprint: citation.source.fingerprint,
      citations: 0,
      quotedAmount: 0,
      paidAmount: 0,
    };

    current.citations += 1;
    current.quotedAmount += citation.quotedAmount;
    current.paidAmount += citation.paidAmount;
    sourceTotals.set(citation.source.id, current);
  }

  return {
    wallet: maskAddress(wallet),
    totals: {
      citations: citations.length,
      quotedAmount: citations.reduce(
        (total, citation) => total + citation.quotedAmount,
        0,
      ),
      paidAmount: citations.reduce(
        (total, citation) => total + citation.paidAmount,
        0,
      ),
      paidCitations: citations.filter((citation) =>
        isPaidStatus(citation.paymentStatus),
      ).length,
      sources: sourceTotals.size,
    },
    sources: [...sourceTotals.values()],
    receipts: citations,
  };
}

function buildSourceDetail(sourceId) {
  const source = statements.getSource.get(sourceId);
  if (!source || source.status !== 'registered') return null;

  const citations = statements.listSourceCitations
    .all(sourceId)
    .filter((row) => isPublicReceiptStatus(row.paymentStatus))
    .map((row) => ({
      receiptId: row.receiptId,
      question: row.question,
      paymentStatus: row.paymentStatus,
      rail: row.rail,
      network: row.network,
      createdAt: row.createdAt,
      rank: row.rank,
      quotedAmount: row.price,
      paidAmount: isPaidStatus(row.paymentStatus) ? row.price : 0,
    }));

  return {
    source: normalizeSource(source),
    totals: {
      citations: citations.length,
      quotedAmount: citations.reduce(
        (total, citation) => total + citation.quotedAmount,
        0,
      ),
      paidAmount: citations.reduce(
        (total, citation) => total + citation.paidAmount,
        0,
      ),
      paidCitations: citations.filter((citation) =>
        isPaidStatus(citation.paymentStatus),
      ).length,
      receipts: new Set(citations.map((citation) => citation.receiptId)).size,
    },
    citations,
  };
}

function isPaidStatus(status) {
  return status === 'paid' || status === 'settled';
}

function verifyReceiptProof(proof) {
  const receiptId = String(proof?.receiptId ?? '').trim();
  if (!receiptId) return { valid: false, reason: 'Receipt ID is missing.' };

  const receipt = buildReceipt(receiptId, { allowPrivate: true });
  if (!receipt) return { valid: false, reason: 'Receipt was not found.' };

  const expected = buildReceiptProof(receipt);
  const checks = [
    ['createdAt', expected.createdAt === proof.createdAt],
    ['question', expected.question === proof.question],
    ['budget', expected.budget === proof.budget],
    ['totalSpend', expected.totalSpend === proof.totalSpend],
    ['rail', expected.rail === proof.rail],
    ['network', expected.network === proof.network],
    ['status', expected.status === proof.status],
    ['sources', Array.isArray(proof.sources)],
    ['payments', Array.isArray(proof.payments)],
    ['settlements', Array.isArray(proof.settlements)],
  ];

  for (const [label, passed] of checks) {
    if (!passed) return { valid: false, reason: `${label} does not match.` };
  }

  const proofSourcesById = new Map(
    proof.sources.map((source) => [String(source.sourceId), source]),
  );
  const proofSettlementsById = new Map(
    proof.settlements.map((settlement) => [String(settlement.id), settlement]),
  );

  if (expected.sources.length !== proofSourcesById.size) {
    return { valid: false, reason: 'Source count does not match.' };
  }

  for (const expectedSource of expected.sources) {
    const proofSource = proofSourcesById.get(expectedSource.sourceId);
    if (!proofSource) {
      return { valid: false, reason: 'Source proof is missing.' };
    }
    if (proofSource.fingerprint !== expectedSource.fingerprint) {
      return { valid: false, reason: 'Source fingerprint does not match.' };
    }
    if (proofSource.wallet !== expectedSource.wallet) {
      return { valid: false, reason: 'Source payout wallet does not match.' };
    }
    if (proofSource.price !== expectedSource.price) {
      return { valid: false, reason: 'Source price does not match.' };
    }
    if (proofSource.rank !== expectedSource.rank) {
      return { valid: false, reason: 'Source rank does not match.' };
    }
  }

  if (expected.settlements.length !== proofSettlementsById.size) {
    return { valid: false, reason: 'Settlement count does not match.' };
  }

  for (const expectedSettlement of expected.settlements) {
    const proofSettlement = proofSettlementsById.get(expectedSettlement.id);
    if (!proofSettlement) {
      return { valid: false, reason: 'Settlement proof is missing.' };
    }
    for (const key of [
      'attemptId',
      'sourceId',
      'payer',
      'payTo',
      'amount',
      'transactionId',
      'network',
      'createdAt',
    ]) {
      if (proofSettlement[key] !== expectedSettlement[key]) {
        return { valid: false, reason: `Settlement ${key} does not match.` };
      }
    }
  }

  return {
    valid: true,
    reason: 'Receipt proof matches the stored route.',
    receiptId,
    sources: expected.sources.length,
  };
}

function routeSources({ question, budget, kinds, buyerWallet }) {
  const normalizedQuestion = String(question ?? '').trim();
  const normalizedBudget = Number(budget);
  const normalizedBuyerWallet = String(buyerWallet ?? '').trim();
  const normalizedKinds = Array.isArray(kinds)
    ? kinds.filter((kind) => sourceKinds.has(kind))
    : [...sourceKinds];

  if (!normalizedQuestion) return { error: 'Research objective is required.' };
  if (!Number.isFinite(normalizedBudget) || normalizedBudget < minUsdcAmount) {
    return { error: 'Budget must be at least 1 USDC.' };
  }
  if (normalizedKinds.length === 0) {
    return { error: 'At least one source class is required.' };
  }
  if (normalizedBuyerWallet && !isEvmAddress(normalizedBuyerWallet)) {
    return { error: 'Buyer wallet must be a valid EVM address.' };
  }

  let totalSpend = 0;
  const selected = [];
  const questionTokens = tokenize(normalizedQuestion);
  if (questionTokens.length === 0) {
    return {
      error:
        'Add specific names, topics, or keywords so SourcePay can match the request to creator sources.',
    };
  }
  const uniqueQuestionTokens = [...new Set(questionTokens)];
  const questionPhrases = buildSearchPhrases(uniqueQuestionTokens);

  const eligible = statements.eligibleSources
    .all(JSON.stringify(normalizedKinds))
    .map((source) => ({
      ...source,
      relevance: scoreSource(source, uniqueQuestionTokens, questionPhrases),
    }))
    .filter((source) => source.relevance >= 0.25)
    .sort((left, right) => {
      if (right.relevance !== left.relevance) return right.relevance - left.relevance;
      return left.price - right.price;
    });

  for (const source of eligible) {
    if (totalSpend + source.price > normalizedBudget) continue;
    totalSpend += source.price;
    selected.push(source);
  }

  if (selected.length === 0) {
    return {
      error:
        'No eligible creator source matched this request. Register matching sources before creating a receipt.',
    };
  }

  const runId = randomUUID();
  const accessToken = randomUUID();
  db.exec('BEGIN');
  try {
    statements.insertRun.run(
      runId,
      normalizedQuestion,
      normalizedBudget,
      totalSpend,
      accessToken,
      normalizedBuyerWallet,
    );
    selected.forEach((source, index) => {
      statements.insertSelectedSource.run(
        runId,
        source.id,
        index + 1,
        source.price,
        source.title,
        source.kind,
        source.wallet,
        source.content,
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    logError('payment_attempt.persist_failed', error, {
      receiptId: maskIdentifier(receiptId),
      status: execution.status,
    });
    throw error;
  }

  const receipt = buildReceipt(runId, {
    accessToken,
    includeAccessToken: true,
  });
  const quote = createPaymentQuote({ receipt });

  return {
    value: {
      ...receipt,
      paymentStatus: quote.paymentStatus,
      rail: quote.rail,
      network: quote.network,
      readyForSettlement: quote.readyForSettlement,
    },
  };
}

function recordPaymentAttempt(receiptId, execution) {
  const attemptId = randomUUID();

  db.exec('BEGIN');
  try {
  statements.insertPaymentAttempt.run(
    attemptId,
    receiptId,
    execution.status,
    execution.reason,
    execution.readiness.rail,
    execution.readiness.network,
  );
    for (const settlement of execution.settlements ?? []) {
      statements.insertPaymentSettlement.run(
        randomUUID(),
        attemptId,
        receiptId,
        stringifySettlementValue(settlement.sourceId),
        stringifySettlementValue(settlement.payer),
        stringifySettlementValue(settlement.payTo),
        stringifySettlementValue(settlement.amount),
        stringifySettlementValue(settlement.transactionId),
        stringifySettlementValue(settlement.network),
      );
    }
  statements.updateRunPaymentStatus.run(execution.status, receiptId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    logError('route.persist_failed', error, {
      buyerWallet: maskAddress(normalizedBuyerWallet),
      selectedSources: selected.length,
      totalSpend,
    });
    throw error;
  }

  return attemptId;
}

function stringifySettlementValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function accessTokenFromUrl(url) {
  return String(url.searchParams.get('access') ?? '').trim();
}

function accessTokenFromBody(body) {
  return String(body?.accessToken ?? '').trim();
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  try {
    if (request.method === 'GET' && (await serveFrontend(url, response))) {
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const payment = getPaymentReadiness();
      sendHtml(
        response,
        200,
        renderBackendHome({
          sourceCount: statements.listSources.all().length,
          wallet: { ready: false },
          payment,
        }),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const payment = getPaymentReadiness();
      sendJson(response, 200, {
        ok: true,
        service: 'sourcepay-api',
        sources: statements.listSources.all().length,
        walletReady: false,
        paymentReady: payment.ready,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      const payment = getPaymentReadiness();
      sendJson(response, 200, {
        ok: true,
        database: 'sqlite',
        sources: statements.listSources.all().length,
        walletReady: false,
        paymentReady: payment.ready,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/payment-readiness') {
      sendJson(response, 200, {
        payment: await getPaymentReadinessDetails({
          checkGateway: url.searchParams.get('check') === 'gateway',
        }),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      sendJson(response, 200, {
        config: {
          network: normalizeNetworkName(process.env.SOURCEPAY_NETWORK),
          arcRpcUrl: Boolean(process.env.ARC_RPC_URL || process.env.RPC),
          faucetUrls: {
            arc:
              process.env.SOURCEPAY_ARC_FAUCET_URL ||
              process.env.SOURCEPAY_USDC_FAUCET_URL ||
              'https://faucet.circle.com',
            usdc: process.env.SOURCEPAY_USDC_FAUCET_URL || 'https://faucet.circle.com',
          },
          walletNetwork: getArcWalletNetwork(),
          walletConnectProjectId: process.env.SOURCEPAY_WALLETCONNECT_PROJECT_ID || '',
        },
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/challenge') {
      if (applyRateLimit(request, response, 'authChallenge')) return;
      const result = createWalletAuthChallenge(await readBody(request));
      if (result.error) {
        logEvent('warn', 'auth.challenge.rejected', {
          ...requestLogFields(request, url),
          status: result.status,
          reason: result.error,
        });
        sendJson(response, result.status, { error: result.error });
        return;
      }

      logEvent('info', 'auth.challenge.created', {
        ...requestLogFields(request, url),
        challengeId: maskIdentifier(result.value.id),
        wallet: maskAddress(result.value.wallet),
        purpose: result.value.purpose,
        expiresAt: result.value.expiresAt,
      });
      sendJson(response, 201, { challenge: result.value });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/sources') {
      const wallet = String(url.searchParams.get('wallet') ?? '').trim();
      if (wallet) {
        if (!isEvmAddress(wallet)) {
          sendJson(response, 400, { error: 'Source wallet must be a valid EVM address.' });
          return;
        }

        sendJson(response, 200, {
          sources: statements.listSourcesByWallet.all(wallet).map(normalizeSource),
        });
        return;
      }

      sendJson(response, 200, {
        sources: statements.listSources.all().map(normalizeSource),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/source-preview') {
      if (applyRateLimit(request, response, 'sourcePreview')) return;
      const result = await buildSourcePreview(await readBody(request));
      if (result.error) {
        sendJson(response, 400, { error: result.error });
        return;
      }

      sendJson(response, 200, { preview: result.value });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/creator-earnings') {
      const wallet = String(url.searchParams.get('wallet') ?? '').trim();
      if (!wallet) {
        sendJson(response, 200, {
          earnings: {
            wallet: '',
            totals: {
              citations: 0,
              quotedAmount: 0,
              paidAmount: 0,
              paidCitations: 0,
              sources: 0,
            },
            sources: [],
            receipts: [],
          },
        });
        return;
      }
      if (!isEvmAddress(wallet)) {
        sendJson(response, 400, { error: 'Payout wallet must be a valid EVM address.' });
        return;
      }

      sendJson(response, 401, {
        error: 'Sign with the payout wallet before viewing earnings.',
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/creator-earnings') {
      if (applyRateLimit(request, response, 'privateRead')) return;
      const parsed = await validateCreatorEarningsAccess(await readBody(request));
      if (parsed.error) {
        logEvent('warn', 'creator_earnings.auth_failed', {
          ...requestLogFields(request, url),
          status: parsed.status,
          reason: parsed.error,
        });
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }

      logEvent('info', 'creator_earnings.viewed', {
        ...requestLogFields(request, url),
        wallet: maskAddress(parsed.value.wallet),
      });
      sendJson(response, 200, {
        earnings: buildCreatorEarnings(parsed.value.wallet),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/receipts') {
      sendJson(response, 200, {
        receipts: statements.listRuns.all().map((run) => ({
          ...normalizeRun(run),
          sources: statements.getRunSources.all(run.id).map(normalizeSource),
        })),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/buyer/receipts') {
      if (applyRateLimit(request, response, 'privateRead')) return;
      const parsed = await validateBuyerReceiptsAccess(await readBody(request));
      if (parsed.error) {
        logEvent('warn', 'buyer_receipts.auth_failed', {
          ...requestLogFields(request, url),
          status: parsed.status,
          reason: parsed.error,
        });
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }

      logEvent('info', 'buyer_receipts.viewed', {
        ...requestLogFields(request, url),
        wallet: maskAddress(parsed.value.wallet),
      });
      sendJson(response, 200, {
        receipts: statements.listRunsByBuyer.all(parsed.value.wallet).map((run) => ({
          ...normalizeRun(run),
          sources: statements.getRunSources.all(run.id).map(normalizeSource),
        })),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/sources') {
      if (applyRateLimit(request, response, 'sourceWrite')) return;
      const parsed = await validateSource(await readBody(request));
      if (parsed.error) {
        sendJson(response, 400, { error: parsed.error });
        return;
      }

      const id = randomUUID();
      const {
        title,
        kind,
        wallet,
        price,
        content,
        ownerWallet,
        ownershipSignature,
        ownershipMessage,
      } = parsed.value;
      statements.insertSource.run(
        id,
        title,
        kind,
        wallet,
        price,
        content,
        ownerWallet,
        ownershipSignature,
        ownershipMessage,
      );
      const createdSource = normalizeSource(
        statements.listSources.all().find((source) => source.id === id),
      );

      logEvent('info', 'source.registered', {
        ...requestLogFields(request, url),
        sourceId: maskIdentifier(id),
        wallet: maskAddress(wallet),
        kind,
        price,
        fingerprint: maskIdentifier(createdSource.fingerprint),
      });
      sendJson(response, 201, {
        source: createdSource,
      });
      return;
    }

    const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
    if (sourceMatch && request.method === 'GET') {
      const source = buildSourceDetail(sourceMatch[1]);
      if (!source) {
        sendJson(response, 404, { error: 'Source not found.' });
        return;
      }

      sendJson(response, 200, source);
      return;
    }

    if (sourceMatch && request.method === 'PATCH') {
      if (applyRateLimit(request, response, 'sourceWrite')) return;
      const sourceId = sourceMatch[1];
      const existing = statements.getSource.get(sourceId);
      if (!existing) {
        sendJson(response, 404, { error: 'Source not found.' });
        return;
      }

      const parsed = await validateSource(await readBody(request), existing);
      if (parsed.error) {
        sendJson(response, 400, { error: parsed.error });
        return;
      }

      const {
        title,
        kind,
        wallet,
        price,
        content,
        ownerWallet,
        ownershipSignature,
        ownershipMessage,
      } = parsed.value;
      statements.updateSource.run(
        title,
        kind,
        wallet,
        price,
        content,
        ownerWallet,
        ownershipSignature,
        ownershipMessage,
        sourceId,
      );
      const updatedSource = normalizeSource(statements.getSource.get(sourceId));
      logEvent('info', 'source.updated', {
        ...requestLogFields(request, url),
        sourceId: maskIdentifier(sourceId),
        wallet: maskAddress(wallet),
        kind,
        price,
        fingerprint: maskIdentifier(updatedSource.fingerprint),
      });
      sendJson(response, 200, {
        source: updatedSource,
      });
      return;
    }

    if (sourceMatch && request.method === 'DELETE') {
      if (applyRateLimit(request, response, 'sourceWrite')) return;
      const sourceId = sourceMatch[1];
      const existing = statements.getSource.get(sourceId);

      if (!existing) {
        sendJson(response, 404, { error: 'Source not found.' });
        return;
      }

      const parsed = await validateSourceArchive(await readBody(request), existing);
      if (parsed.error) {
        sendJson(response, 403, { error: parsed.error });
        return;
      }

      statements.deleteSource.run(sourceId);
      logEvent('info', 'source.archived', {
        ...requestLogFields(request, url),
        sourceId: maskIdentifier(sourceId),
        wallet: maskAddress(existing.wallet),
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/route') {
      if (applyRateLimit(request, response, 'route')) return;
      const body = await readBody(request);
      const result = routeSources(body);
      if (result.error) {
        logEvent('warn', 'route.rejected', {
          ...requestLogFields(request, url),
          reason: result.error,
          buyerWallet: maskAddress(body.buyerWallet),
        });
        sendJson(response, 400, { error: result.error });
        return;
      }

      logEvent('info', 'route.created', {
        ...requestLogFields(request, url),
        receiptId: maskIdentifier(result.value.id),
        buyerWallet: maskAddress(result.value.buyerWallet),
        sourceCount: result.value.sources.length,
        totalSpend: result.value.totalSpend,
        paymentStatus: result.value.paymentStatus,
      });
      sendJson(response, 201, { receipt: result.value });
      return;
    }

    const receiptMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)$/);
    if (request.method === 'GET' && receiptMatch) {
      const accessToken = accessTokenFromUrl(url);
      const receipt = buildReceipt(receiptMatch[1], {
        accessToken,
        includeAccessToken: Boolean(accessToken),
      });
      if (!receipt) {
        sendJson(response, 404, { error: 'Receipt not found.' });
        return;
      }

      sendJson(response, 200, { receipt });
      return;
    }

    const receiptProofMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)\/proof$/);
    if (request.method === 'GET' && receiptProofMatch) {
      const receipt = buildReceipt(receiptProofMatch[1], {
        accessToken: accessTokenFromUrl(url),
      });
      if (!receipt) {
        sendJson(response, 404, { error: 'Receipt not found.' });
        return;
      }

      sendJson(response, 200, { proof: buildReceiptProof(receipt) });
      return;
    }

    const paymentRequirementsMatch = url.pathname.match(
      /^\/api\/receipts\/([^/]+)\/payment-requirements$/,
    );
    if (request.method === 'GET' && paymentRequirementsMatch) {
      if (
        applyRateLimit(request, response, 'paymentRequirements', {
          key: paymentRequirementsMatch[1],
        })
      ) {
        return;
      }
      const receipt = buildReceipt(paymentRequirementsMatch[1], {
        accessToken: accessTokenFromUrl(url),
      });
      if (!receipt) {
        sendJson(response, 404, { error: 'Receipt not found.' });
        return;
      }
      const payer = String(url.searchParams.get('payer') ?? '').trim();
      if (payer && !isEvmAddress(payer)) {
        logEvent('warn', 'payment_requirements.rejected', {
          ...requestLogFields(request, url),
          receiptId: maskIdentifier(receipt.id),
          reason: 'Payer wallet must be a valid EVM address.',
        });
        sendJson(response, 400, { error: 'Payer wallet must be a valid EVM address.' });
        return;
      }

      logEvent('info', 'payment_requirements.generated', {
        ...requestLogFields(request, url),
        receiptId: maskIdentifier(receipt.id),
        payer: maskAddress(payer),
        sourceCount: receipt.sources.length,
      });
      sendJson(response, 200, {
        receiptId: receipt.id,
        totalSpend: receipt.totalSpend,
        payer: payer || null,
        requirements: createReceiptSigningRequests(receipt, payer || null),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/proofs/verify') {
      if (applyRateLimit(request, response, 'proofVerify')) return;
      const body = await readBody(request);
      const verification = verifyReceiptProof(body.proof);
      logEvent(verification.valid ? 'info' : 'warn', 'proof.verified', {
        ...requestLogFields(request, url),
        valid: verification.valid,
        receiptId: maskIdentifier(verification.receiptId),
        reason: verification.reason,
      });
      sendJson(response, 200, {
        verification,
      });
      return;
    }

    const payMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)\/pay$/);
    if (request.method === 'POST' && payMatch) {
      if (applyRateLimit(request, response, 'paymentSubmit', { key: payMatch[1] })) return;
      const body = await readBody(request);
      const receipt = buildReceipt(payMatch[1], {
        accessToken: accessTokenFromBody(body),
        includeAccessToken: true,
      });
      if (!receipt) {
        sendJson(response, 404, { error: 'Receipt not found.' });
        return;
      }
      if (receipt.sources.length === 0) {
        sendJson(response, 400, { error: 'Receipt has no selected sources.' });
        return;
      }
      if (isPaidStatus(receipt.paymentStatus)) {
        sendJson(response, 409, {
          payment: {
            id: null,
            ok: false,
            status: receipt.paymentStatus,
            reason: 'Receipt has already been paid.',
          },
          receipt,
        });
        return;
      }

      const execution = await createPaymentExecution({
        receipt,
        payments: body.payments,
      });
      const attemptId = recordPaymentAttempt(receipt.id, execution);
      logEvent(execution.ok ? 'info' : 'warn', 'payment.attempt_recorded', {
        ...requestLogFields(request, url),
        receiptId: maskIdentifier(receipt.id),
        attemptId: maskIdentifier(attemptId),
        status: execution.status,
        ok: execution.ok,
        reason: execution.reason,
        settlementCount: execution.settlements?.length ?? 0,
      });

      const updatedReceipt = buildReceipt(receipt.id, {
        accessToken: body.accessToken,
        allowPrivate: true,
        includeAccessToken: true,
      });
      const status = execution.ok ? 200 : 409;
      sendJson(response, status, {
        payment: {
          id: attemptId,
          ...execution,
        },
        receipt: updatedReceipt,
      });
      return;
    }

    sendJson(response, 404, { error: 'This page is not available.' });
  } catch (error) {
    if (error instanceof ClientRequestError) {
      logEvent('warn', 'request.client_error', {
        ...requestLogFields(request, url),
        status: error.status,
        reason: error.message,
      });
      sendJson(response, error.status, { error: error.message });
      return;
    }

    logError('request.unhandled_error', error, requestLogFields(request, url));
    sendJson(response, 500, { error: 'Something went wrong. Please try again.' });
  }
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
if (process.env.SOURCEPAY_NO_LISTEN !== '1') {
  createServer(handleRequest).listen(port, host, () => {
    process.stdout.write(`SourcePay service listening on http://${host}:${port}\n`);
  });
}
