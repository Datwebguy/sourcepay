import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
  supportsBatching,
} from '@circle-fin/x402-batching';
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client';
import { x402Version } from '@x402/core';
import { BATCH_SETTLEMENT_SCHEME } from '@x402/evm';
import { isAddress } from 'viem';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

let agentAccount = null;
const agentKey = process.env.AGENT_PRIVATE_KEY || process.env.AGENT_KEY;
if (agentKey) {
  try {
    const cleanKey = agentKey.startsWith('0x') ? agentKey : `0x${agentKey}`;
    if (/^0x[0-9a-fA-F]{64}$/.test(cleanKey)) {
      agentAccount = privateKeyToAccount(cleanKey);
      console.log(`[Agent Wallet] Loaded autonomous payer: ${agentAccount.address}`);
    } else {
      console.error('[Agent Wallet] Invalid AGENT_PRIVATE_KEY format (must be 64 hex characters).');
    }
  } catch (err) {
    console.error('[Agent Wallet] Failed to initialize agent account:', err);
  }
}

export function getAgentWalletAddress() {
  return agentAccount ? agentAccount.address : null;
}

export function isEvmAddress(value) {
  return isAddress(String(value));
}

export function getPaymentReadiness() {
  const network = getNetwork();
  const hasRpcUrl = Boolean(process.env.ARC_RPC_URL || process.env.RPC);
  const gatewayUrl = gatewayUrlForNetwork();

  return {
    ready: hasRpcUrl,
    network,
    rail: 'x402',
    status: hasRpcUrl ? 'configured' : 'needs_rpc',
    batching: {
      name: CIRCLE_BATCHING_NAME,
      scheme: CIRCLE_BATCHING_SCHEME,
      version: CIRCLE_BATCHING_VERSION,
      settlementScheme: BATCH_SETTLEMENT_SCHEME,
      supported: supportsBatching({
        extra: {
          name: CIRCLE_BATCHING_NAME,
          version: CIRCLE_BATCHING_VERSION,
        },
      }),
    },
    x402Version,
    gateway: {
      url: gatewayUrl,
      checked: false,
      reachable: null,
      arcTestnetSupported: null,
      error: '',
    },
    requirements: {
      rpcUrl: hasRpcUrl,
      gateway: false,
    },
  };
}

export async function getPaymentReadinessDetails({ checkGateway = false } = {}) {
  const readiness = getPaymentReadiness();
  if (!checkGateway) return readiness;

  try {
    const support = await withTimeout(
      createGatewayFacilitator().getSupported(),
      4_000,
      'Circle Gateway support check timed out.',
    );
    const arcTestnetNetwork = `eip155:${CHAIN_CONFIGS.arcTestnet.chain.id}`;
    const arcTestnetSupported = Array.isArray(support.kinds)
      ? support.kinds.some(
          (kind) =>
            kind?.scheme === CIRCLE_BATCHING_SCHEME &&
            kind?.network === arcTestnetNetwork &&
            supportsBatching(kind),
        )
      : false;

    return {
      ...readiness,
      ready: readiness.ready && arcTestnetSupported,
      gateway: {
        ...readiness.gateway,
        checked: true,
        reachable: true,
        arcTestnetSupported,
        error: arcTestnetSupported
          ? ''
          : 'Circle Gateway does not currently advertise Arc Testnet batching support.',
      },
      requirements: {
        ...readiness.requirements,
        gateway: arcTestnetSupported,
      },
    };
  } catch (error) {
    return {
      ...readiness,
      ready: false,
      gateway: {
        ...readiness.gateway,
        checked: true,
        reachable: false,
        arcTestnetSupported: false,
        error: error instanceof Error ? error.message : 'Circle Gateway support check failed.',
      },
      requirements: {
        ...readiness.requirements,
        gateway: false,
      },
    };
  }
}

export function getArcWalletNetwork() {
  const chain = CHAIN_CONFIGS.arcTestnet.chain;
  const configuredRpcUrl = process.env.ARC_RPC_URL || process.env.RPC;
  const rpcUrls = configuredRpcUrl
    ? [configuredRpcUrl, ...chain.rpcUrls.default.http.filter((url) => url !== configuredRpcUrl)]
    : chain.rpcUrls.default.http;

  return {
    chainId: chain.id,
    chainIdHex: `0x${chain.id.toString(16)}`,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls,
    blockExplorerUrls: [chain.blockExplorers.default.url],
  };
}

export function createPaymentQuote({ receipt }) {
  const readiness = getPaymentReadiness();

  return {
    paymentStatus: 'quoted',
    rail: readiness.rail,
    network: readiness.network,
    readyForSettlement: readiness.ready,
    totalSpend: receipt.totalSpend,
  };
}

export function createReceiptSigningRequests(receipt, payer) {
  return receipt.sources.map((source) => {
    const requirements = createSourcePaymentRequirements(source);

    return {
      sourceId: source.id,
      title: source.title,
      kind: source.kind,
      price: source.price,
      wallet: source.wallet,
      requirements,
      typedData: payer ? createSigningTypedData({ payer, requirements, source }) : null,
    };
  });
}

export async function createPaymentExecution({ receipt, payments }) {
  const readiness = getPaymentReadiness();

  if (!readiness.ready) {
    return {
      ok: false,
      status: 'settlement_setup',
      reason: 'Payment setup is not complete yet. Configure the Arc Testnet RPC before paying creators.',
      readiness,
    };
  }

  if (!Array.isArray(payments) || payments.length === 0) {
    return {
      ok: false,
      status: 'settlement_setup',
      reason: 'No creator payout was submitted.',
      readiness,
    };
  }

  const paymentListError = validateSubmittedPaymentList(receipt, payments);
  if (paymentListError) {
    return {
      ok: false,
      status: 'payment_required',
      reason: paymentListError,
      readiness,
    };
  }

  const paymentBySource = new Map(
    payments
      .filter((payment) => payment && typeof payment === 'object')
      .map((payment) => [String(payment.sourceId ?? ''), payment]),
  );
  const facilitator = createGatewayFacilitator();
  const settlements = [];
  const errors = [];

  await Promise.all(
    receipt.sources.map(async (source) => {
      const submittedPayment = paymentBySource.get(source.id);
      const paymentPayload = normalizeSubmittedPaymentPayload(submittedPayment, source);
      if (!paymentPayload) {
        errors.push("A selected source still needs payment approval.");
        return;
      }

      const requirements = createSourcePaymentRequirements(source);
      const payloadError = validatePaymentPayload(paymentPayload, requirements);
      if (payloadError) {
        errors.push(payloadError);
        return;
      }

      try {
        const verification = await facilitator.verify(paymentPayload, requirements);
        if (!verification.isValid) {
          errors.push(verification.invalidReason ?? 'Circle Gateway rejected the signed payment.');
          return;
        }

        const settlement = await facilitator.settle(paymentPayload, requirements);
        if (!settlement.success) {
          errors.push(settlement.errorReason ?? 'Circle Gateway settlement failed.');
          return;
        }

        settlements.push({
          sourceId: source.id,
          payTo: requirements.payTo,
          payer: settlement.payer ?? verification.payer ?? '',
          transactionId: settlement.transaction,
          network: settlement.network,
          amount: requirements.amount,
        });
      } catch (error) {
        errors.push(gatewayErrorMessage('Circle Gateway execution failed', error));
      }
    })
  );

  if (errors.length > 0) {
    return {
      ok: false,
      status: 'payment_rejected',
      reason: errors.join(' | '),
      readiness,
      settlements,
    };
  }

  return {
    ok: true,
    status: 'paid',
    reason: 'Creator source payments settled through Circle Gateway.',
    readiness,
    settlements,
  };
}

export async function signPaymentForAgent(receipt, source, account) {
  const requirements = createSourcePaymentRequirements(source);
  const typedDataResult = createSigningTypedData({
    payer: account.address,
    requirements,
    source,
  });
  
  const { paymentPayloadTemplate, ...signableTypedData } = typedDataResult;
  
  const signature = await account.signTypedData({
    domain: signableTypedData.domain,
    types: signableTypedData.types,
    primaryType: signableTypedData.primaryType,
    message: signableTypedData.message,
  });
  
  return {
    sourceId: source.id,
    paymentPayload: {
      ...paymentPayloadTemplate,
      payload: {
        ...paymentPayloadTemplate.payload,
        authorization: signableTypedData.message,
        signature,
      },
    },
  };
}

export async function generateAgentWalletPayments(receipt) {
  if (!agentAccount) {
    throw new Error('Autonomous Agent Wallet is not configured on this server.');
  }
  
  const payments = [];
  for (const source of receipt.sources) {
    const payment = await signPaymentForAgent(receipt, source, agentAccount);
    payments.push(payment);
  }
  return payments;
}


function getNetwork() {
  return process.env.SOURCEPAY_NETWORK || 'Arc Testnet';
}

function createGatewayFacilitator() {
  return new BatchFacilitatorClient({
    url: gatewayUrlForNetwork(),
  });
}

function gatewayUrlForNetwork() {
  return process.env.CIRCLE_GATEWAY_URL || defaultGatewayUrl();
}

function createSourcePaymentRequirements(source) {
  const chain = CHAIN_CONFIGS.arcTestnet;

  return {
    scheme: CIRCLE_BATCHING_SCHEME,
    network: `eip155:${chain.chain.id}`,
    asset: chain.usdc,
    amount: usdcToAtomic(source.price),
    payTo: source.wallet,
    maxTimeoutSeconds: 60,
    extra: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      verifyingContract: chain.gatewayWallet,
    },
  };
}

function createSigningTypedData({ payer, requirements, source }) {
  const chainId = Number(requirements.network.split(':')[1]);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = String(now - 600);
  const validBefore = String(
    now + Math.max(requirements.maxTimeoutSeconds, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS),
  );
  const authorization = {
    from: payer,
    to: requirements.payTo,
    value: requirements.amount,
    validAfter,
    validBefore,
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };

  return {
    domain: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      chainId,
      verifyingContract: requirements.extra.verifyingContract,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
    paymentPayloadTemplate: {
      x402Version,
      scheme: requirements.scheme,
      network: requirements.network,
      resource: createPaymentResource(source),
      accepted: requirements,
      payload: {
        authorization,
        signature: '<signature>',
      },
    },
  };
}

function normalizeSubmittedPaymentPayload(payment, source) {
  if (!payment || typeof payment !== 'object') return null;
  if (payment.paymentPayload) return payment.paymentPayload;
  if (payment.authorization && payment.signature) {
    const requirements = createSourcePaymentRequirements(source);

    return {
      x402Version,
      scheme: requirements.scheme,
      network: requirements.network,
      resource: createPaymentResource(source),
      accepted: requirements,
      payload: {
        authorization: payment.authorization,
        signature: payment.signature,
      },
    };
  }

  return null;
}

function validateSubmittedPaymentList(receipt, payments) {
  const expectedSourceIds = new Set(receipt.sources.map((source) => source.id));
  const seenSourceIds = new Set();

  for (const payment of payments) {
    if (!payment || typeof payment !== 'object') {
      return 'Payment approval must be submitted for each selected source.';
    }

    const sourceId = String(payment.sourceId ?? '').trim();
    if (!sourceId) {
      return 'Payment approval is missing a source ID.';
    }
    if (!expectedSourceIds.has(sourceId)) {
      return 'Payment approval includes a source that is not on this receipt.';
    }
    if (seenSourceIds.has(sourceId)) {
      return 'Payment approval includes the same source more than once.';
    }
    seenSourceIds.add(sourceId);
  }

  if (seenSourceIds.size !== expectedSourceIds.size) {
    return 'A selected source still needs payment approval.';
  }

  return '';
}

function validatePaymentPayload(paymentPayload, requirements) {
  if (!paymentPayload || typeof paymentPayload !== 'object') {
    return 'Payment approval payload is missing.';
  }
  const payload = paymentPayload.payload;
  if (!payload || typeof payload !== 'object') {
    return 'Payment approval payload is malformed.';
  }
  if (paymentPayload.x402Version !== x402Version) {
    return 'Payment approval uses an unsupported x402 version.';
  }
  if (paymentPayload.scheme !== undefined && paymentPayload.scheme !== requirements.scheme) {
    return 'Payment approval uses the wrong payment scheme.';
  }
  if (paymentPayload.network !== undefined && paymentPayload.network !== requirements.network) {
    return 'Payment approval uses the wrong network.';
  }

  const authorization = payload.authorization;
  if (!authorization || typeof authorization !== 'object') {
    return 'Payment authorization is missing.';
  }

  const signature = String(payload.signature ?? '').trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return 'Payment signature is missing or malformed.';
  }
  if (!isEvmAddress(authorization.from)) {
    return 'Payment authorization payer is not a valid wallet.';
  }
  if (!sameAddress(authorization.to, requirements.payTo)) {
    return 'Payment authorization recipient does not match the creator wallet.';
  }
  if (String(authorization.value ?? '') !== requirements.amount) {
    return 'Payment authorization amount does not match the receipt.';
  }
  if (!/^\d+$/.test(String(authorization.validAfter ?? ''))) {
    return 'Payment authorization start time is invalid.';
  }
  if (!/^\d+$/.test(String(authorization.validBefore ?? ''))) {
    return 'Payment authorization expiration is invalid.';
  }
  if (BigInt(String(authorization.validBefore)) <= BigInt(Math.floor(Date.now() / 1000))) {
    return 'Payment authorization has expired. Refresh the receipt and try again.';
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorization.nonce ?? ''))) {
    return 'Payment authorization nonce is malformed.';
  }

  return '';
}

function sameAddress(left, right) {
  return isEvmAddress(left) && isEvmAddress(right) && String(left).toLowerCase() === String(right).toLowerCase();
}

function gatewayErrorMessage(prefix, error) {
  const message = error instanceof Error ? error.message : '';
  if (!message) return prefix;
  return `${prefix}: ${message.slice(0, 220)}`;
}

function createPaymentResource(source) {
  return {
    url: `sourcepay://sources/${source.id}`,
    description: `SourcePay creator source: ${source.title}`,
    mimeType: 'application/json',
    serviceName: 'SourcePay',
    tags: ['sourcepay', source.kind.toLowerCase()],
  };
}

function usdcToAtomic(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return '0';
  return String(Math.round(normalized * 1_000_000));
}

function defaultGatewayUrl() {
  return getNetwork().toLowerCase().includes('test')
    ? 'https://gateway-api-testnet.circle.com'
    : 'https://gateway-api-testnet.circle.com';
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}
