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
const minUsdcAmount = 1;

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
    status TEXT NOT NULL DEFAULT 'quoted',
    payment_status TEXT NOT NULL DEFAULT 'quoted',
    rail TEXT NOT NULL DEFAULT 'x402',
    network TEXT NOT NULL DEFAULT 'Arc',
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
    network TEXT NOT NULL DEFAULT 'Arc',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wallet_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    agent_wallet TEXT,
    network TEXT NOT NULL DEFAULT 'Arc',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO wallet_config (id, network)
  VALUES (1, 'Arc');
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
  db.exec("ALTER TABLE research_runs ADD COLUMN network TEXT NOT NULL DEFAULT 'Arc'");
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
    ORDER BY datetime(created_at) ASC
  `),
  insertRun: db.prepare(`
    INSERT INTO research_runs (id, question, budget, total_spend)
    VALUES (?, ?, ?, ?)
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
      created_at AS createdAt
    FROM research_runs
    WHERE id = ?
  `),
  getRunSources: db.prepare(`
    SELECT
      COALESCE(s.id, ss.source_id) AS id,
      COALESCE(NULLIF(ss.title, ''), s.title) AS title,
      COALESCE(NULLIF(ss.kind, ''), s.kind) AS kind,
      COALESCE(NULLIF(ss.wallet, ''), s.wallet) AS wallet,
      COALESCE(NULLIF(ss.content, ''), s.content) AS content,
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
  updateRunPaymentStatus: db.prepare(`
    UPDATE research_runs
    SET payment_status = ?
    WHERE id = ?
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
      created_at AS createdAt
    FROM research_runs
    ORDER BY datetime(created_at) DESC
    LIMIT 50
  `),
  listCreatorCitations: db.prepare(`
    SELECT
      rr.id AS receiptId,
      rr.question,
      rr.payment_status AS paymentStatus,
      rr.rail,
      rr.network,
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
  getWalletConfig: db.prepare(`
    SELECT agent_wallet AS agentWallet, network, updated_at AS updatedAt
    FROM wallet_config
    WHERE id = 1
  `),
  updateWalletConfig: db.prepare(`
    UPDATE wallet_config
    SET agent_wallet = ?, network = ?, updated_at = datetime('now')
    WHERE id = 1
  `),
  clearWalletConfig: db.prepare(`
    UPDATE wallet_config
    SET agent_wallet = NULL, updated_at = datetime('now')
    WHERE id = 1
  `),
};

statements.deleteEmptyRuns.run();

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(body);
}

async function sendFile(response, status, filePath) {
  response.writeHead(status, {
    'Content-Type': contentTypeForPath(filePath),
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
  const walletState = wallet.ready ? 'Ready' : 'Needs wallet';
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
      <div class="card"><span class="label">Paying wallet</span><span class="value">${walletState}</span></div>
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
  const source = {
    id: row.id,
    title: row.title,
    kind: row.kind,
    wallet: row.wallet,
    price: row.price,
    content: row.content,
    ownerWallet: row.ownerWallet ?? null,
    ownershipVerified: Boolean(row.ownershipSignature),
    status: row.status,
    createdAt: row.createdAt,
  };

  return {
    ...source,
    fingerprint: sourceFingerprint(source),
  };
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
  const cleanTitle = cleanXTitle(title, url);
  const cleanContent = cleanXContent(content);

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
  value = value.replace(
    /^.*?\bPost\s+([A-Z][\s\S]*?)(?:\s+Read\s+\d+\s+replies|\s+New to X\?|\s+Relevant people|\s+Trending now|\s+Don'?t miss what'?s happening|\s+Terms of Service\b|$)/iu,
    '$1',
  );
  value = value
    .replace(/\s+Log in\s+Sign up\s+/giu, ' ')
    .replace(/\s+Sign up with Google[\s\S]*$/iu, ' ')
    .replace(/\s+By signing up,[\s\S]*$/iu, ' ')
    .replace(/\s+Terms of Service[\s\S]*$/iu, ' ')
    .replace(/\s+Relevant people[\s\S]*$/iu, ' ')
    .replace(/\s+Trending now[\s\S]*$/iu, ' ')
    .replace(/\s+New to X\?[\s\S]*$/iu, ' ')
    .replace(/\s+©\s+20\d{2}\s+X Corp\.[\s\S]*$/iu, ' ');

  return normalizeSourceText(value).slice(0, 5000);
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

function normalizeWalletConfig(row) {
  return {
    agentWallet: row.agentWallet,
    network: row.network,
    ready: Boolean(row.agentWallet),
    updatedAt: row.updatedAt,
  };
}

function maskAddress(value) {
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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
    network: row.network ?? 'Arc',
    createdAt: row.createdAt,
  };
}

function validateWalletConfig(input) {
  const agentWallet = String(input.agentWallet ?? '').trim();
  const network = String(input.network ?? 'Arc').trim() || 'Arc';

  if (!agentWallet) return { error: 'Connect a wallet first.' };
  if (!isEvmAddress(agentWallet)) {
    return { error: 'Connect a valid wallet address.' };
  }

  return { value: { agentWallet, network } };
}

function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2),
  );
}

function scoreSource(source, questionTokens) {
  const sourceTokens = tokenize(`${source.title} ${source.content}`);
  let overlap = 0;

  for (const token of questionTokens) {
    if (sourceTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(questionTokens.size, 1);
}

function buildReceipt(runId) {
  const run = statements.getRun.get(runId);
  if (!run) return null;
  const normalizedRun = normalizeRun(run);

  return {
    ...normalizedRun,
    sources: statements.getRunSources.all(runId).map(normalizeSource),
    paymentAttempts: statements.listPaymentAttempts.all(runId),
  };
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
      wallet: maskAddress(source.wallet),
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
    };

    current.citations += 1;
    current.quotedAmount += citation.quotedAmount;
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
      sources: sourceTotals.size,
    },
    sources: [...sourceTotals.values()],
    receipts: citations,
  };
}

function buildSourceDetail(sourceId) {
  const source = statements.getSource.get(sourceId);
  if (!source || source.status !== 'registered') return null;

  const citations = statements.listSourceCitations.all(sourceId).map((row) => ({
    receiptId: row.receiptId,
    question: row.question,
    paymentStatus: row.paymentStatus,
    rail: row.rail,
    network: row.network,
    createdAt: row.createdAt,
    rank: row.rank,
    quotedAmount: row.price,
  }));

  return {
    source: normalizeSource(source),
    totals: {
      citations: citations.length,
      quotedAmount: citations.reduce(
        (total, citation) => total + citation.quotedAmount,
        0,
      ),
      receipts: new Set(citations.map((citation) => citation.receiptId)).size,
    },
    citations,
  };
}

function verifyReceiptProof(proof) {
  const receiptId = String(proof?.receiptId ?? '').trim();
  if (!receiptId) return { valid: false, reason: 'Receipt ID is missing.' };

  const receipt = buildReceipt(receiptId);
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
  ];

  for (const [label, passed] of checks) {
    if (!passed) return { valid: false, reason: `${label} does not match.` };
  }

  if (expected.sources.length !== proof.sources.length) {
    return { valid: false, reason: 'Source count does not match.' };
  }

  for (const expectedSource of expected.sources) {
    const proofSource = proof.sources.find(
      (source) => source.sourceId === expectedSource.sourceId,
    );
    if (!proofSource) {
      return { valid: false, reason: 'Source proof is missing.' };
    }
    if (proofSource.fingerprint !== expectedSource.fingerprint) {
      return { valid: false, reason: 'Source fingerprint does not match.' };
    }
    if (proofSource.price !== expectedSource.price) {
      return { valid: false, reason: 'Source price does not match.' };
    }
    if (proofSource.rank !== expectedSource.rank) {
      return { valid: false, reason: 'Source rank does not match.' };
    }
  }

  return {
    valid: true,
    reason: 'Receipt proof matches the stored route.',
    receiptId,
    sources: expected.sources.length,
  };
}

function routeSources({ question, budget, kinds }) {
  const normalizedQuestion = String(question ?? '').trim();
  const normalizedBudget = Number(budget);
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

  let totalSpend = 0;
  const selected = [];
  const questionTokens = tokenize(normalizedQuestion);
  const eligible = statements.eligibleSources
    .all(JSON.stringify(normalizedKinds))
    .map((source) => ({
      ...source,
      relevance: scoreSource(source, questionTokens),
    }))
    .filter((source) => source.relevance > 0)
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
  db.exec('BEGIN');
  try {
    statements.insertRun.run(runId, normalizedQuestion, normalizedBudget, totalSpend);
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
    throw error;
  }

  const receipt = buildReceipt(runId);
  const walletConfig = normalizeWalletConfig(statements.getWalletConfig.get());
  const quote = createPaymentQuote({ receipt, walletConfig });

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

  statements.insertPaymentAttempt.run(
    attemptId,
    receiptId,
    execution.status,
    execution.settlements?.length
      ? `${execution.reason} ${JSON.stringify({ settlements: execution.settlements })}`
      : execution.reason,
    execution.readiness.rail,
    execution.readiness.network,
  );
  statements.updateRunPaymentStatus.run(execution.status, receiptId);

  return attemptId;
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
      const wallet = normalizeWalletConfig(statements.getWalletConfig.get());
      const payment = getPaymentReadiness(wallet);
      sendHtml(
        response,
        200,
        renderBackendHome({
          sourceCount: statements.listSources.all().length,
          wallet,
          payment,
        }),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const wallet = normalizeWalletConfig(statements.getWalletConfig.get());
      const payment = getPaymentReadiness(wallet);
      sendJson(response, 200, {
        ok: true,
        service: 'sourcepay-api',
        sources: statements.listSources.all().length,
        walletReady: wallet.ready,
        paymentReady: payment.ready,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      const wallet = normalizeWalletConfig(statements.getWalletConfig.get());
      const payment = getPaymentReadiness(wallet);
      sendJson(response, 200, {
        ok: true,
        database: 'sqlite',
        sources: statements.listSources.all().length,
        walletReady: wallet.ready,
        paymentReady: payment.ready,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/payment-readiness') {
      const wallet = normalizeWalletConfig(statements.getWalletConfig.get());
      sendJson(response, 200, {
        payment: getPaymentReadiness(wallet),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      sendJson(response, 200, {
        config: {
          network: process.env.SOURCEPAY_NETWORK || 'Arc',
          arcRpcUrl: Boolean(process.env.ARC_RPC_URL || process.env.RPC),
          faucetUrls: {
            arc:
              process.env.SOURCEPAY_ARC_FAUCET_URL ||
              process.env.SOURCEPAY_USDC_FAUCET_URL ||
              'https://faucet.circle.com',
            usdc: process.env.SOURCEPAY_USDC_FAUCET_URL || 'https://faucet.circle.com',
          },
          walletNetwork: getArcWalletNetwork(),
        },
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/wallet') {
      sendJson(response, 200, {
        wallet: normalizeWalletConfig(statements.getWalletConfig.get()),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/wallet') {
      const parsed = validateWalletConfig(await readBody(request));
      if (parsed.error) {
        sendJson(response, 400, { error: parsed.error });
        return;
      }

      statements.updateWalletConfig.run(
        parsed.value.agentWallet,
        parsed.value.network,
      );
      sendJson(response, 200, {
        wallet: normalizeWalletConfig(statements.getWalletConfig.get()),
      });
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/api/wallet') {
      statements.clearWalletConfig.run();
      sendJson(response, 200, {
        wallet: normalizeWalletConfig(statements.getWalletConfig.get()),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/sources') {
      sendJson(response, 200, {
        sources: statements.listSources.all().map(normalizeSource),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/source-preview') {
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
            totals: { citations: 0, quotedAmount: 0, sources: 0 },
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

      sendJson(response, 200, {
        earnings: buildCreatorEarnings(wallet),
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

    if (request.method === 'POST' && url.pathname === '/api/sources') {
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

      sendJson(response, 201, {
        source: normalizeSource(
          statements.listSources.all().find((source) => source.id === id),
        ),
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
      sendJson(response, 200, {
        source: normalizeSource(statements.getSource.get(sourceId)),
      });
      return;
    }

    if (sourceMatch && request.method === 'DELETE') {
      const sourceId = sourceMatch[1];
      const result = statements.deleteSource.run(sourceId);
      if (result.changes === 0) {
        sendJson(response, 404, { error: 'Source not found.' });
        return;
      }

      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/route') {
      const result = routeSources(await readBody(request));
      if (result.error) {
        sendJson(response, 400, { error: result.error });
        return;
      }

      sendJson(response, 201, { receipt: result.value });
      return;
    }

    const receiptMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)$/);
    if (request.method === 'GET' && receiptMatch) {
      const receipt = buildReceipt(receiptMatch[1]);
      if (!receipt) {
        sendJson(response, 404, { error: 'Receipt not found.' });
        return;
      }

      sendJson(response, 200, { receipt });
      return;
    }

    const receiptProofMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)\/proof$/);
    if (request.method === 'GET' && receiptProofMatch) {
      const receipt = buildReceipt(receiptProofMatch[1]);
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
      const receipt = buildReceipt(paymentRequirementsMatch[1]);
      if (!receipt) {
        sendJson(response, 404, { error: 'Receipt not found.' });
        return;
      }
      const wallet = normalizeWalletConfig(statements.getWalletConfig.get());

      sendJson(response, 200, {
        receiptId: receipt.id,
        totalSpend: receipt.totalSpend,
        payer: wallet.agentWallet,
        requirements: createReceiptSigningRequests(receipt, wallet),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/proofs/verify') {
      const body = await readBody(request);
      sendJson(response, 200, {
        verification: verifyReceiptProof(body.proof),
      });
      return;
    }

    const payMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)\/pay$/);
    if (request.method === 'POST' && payMatch) {
      const receipt = buildReceipt(payMatch[1]);
      if (!receipt) {
        sendJson(response, 404, { error: 'Receipt not found.' });
        return;
      }
      if (receipt.sources.length === 0) {
        sendJson(response, 400, { error: 'Receipt has no selected sources.' });
        return;
      }

      const walletConfig = normalizeWalletConfig(statements.getWalletConfig.get());
      const body = await readBody(request);
      const execution = await createPaymentExecution({
        receipt,
        walletConfig,
        payments: body.payments,
      });
      const attemptId = recordPaymentAttempt(receipt.id, execution);

      const updatedReceipt = buildReceipt(receipt.id);
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
    console.error(error);
    if (error instanceof ClientRequestError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }

    sendJson(response, 500, { error: 'Something went wrong. Please try again.' });
  }
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
createServer(handleRequest).listen(port, host, () => {
  process.stdout.write(`SourcePay service listening on http://${host}:${port}\n`);
});
