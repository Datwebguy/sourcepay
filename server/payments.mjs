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

export function isEvmAddress(value) {
  return isAddress(String(value));
}

export function getPaymentReadiness(walletConfig) {
  const network = getNetwork();
  const hasAgentWallet = Boolean(walletConfig?.agentWallet);
  const hasRpcUrl = Boolean(process.env.ARC_RPC_URL || process.env.RPC);

  return {
    ready: hasAgentWallet && hasRpcUrl,
    network,
    rail: 'x402',
    status: hasAgentWallet ? 'configured' : 'needs_wallet',
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
    requirements: {
      agentWallet: hasAgentWallet,
      rpcUrl: hasRpcUrl,
    },
  };
}

export function getArcWalletNetwork() {
  const chain = CHAIN_CONFIGS.arcTestnet.chain;

  return {
    chainId: chain.id,
    chainIdHex: `0x${chain.id.toString(16)}`,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: chain.rpcUrls.default.http,
    blockExplorerUrls: [chain.blockExplorers.default.url],
  };
}

export function createPaymentQuote({ receipt, walletConfig }) {
  const readiness = getPaymentReadiness(walletConfig);

  return {
    paymentStatus: 'quoted',
    rail: readiness.rail,
    network: readiness.network,
    readyForSettlement: readiness.ready,
    agentWallet: walletConfig?.agentWallet ?? null,
    totalSpend: receipt.totalSpend,
  };
}

export function createReceiptSigningRequests(receipt, walletConfig) {
  const payer = walletConfig?.agentWallet;

  return receipt.sources.map((source) => {
    const requirements = createSourcePaymentRequirements(source);

    return {
      sourceId: source.id,
      title: source.title,
      kind: source.kind,
      price: source.price,
      wallet: source.wallet,
      requirements,
      typedData: payer ? createSigningTypedData({ payer, requirements }) : null,
    };
  });
}

export async function createPaymentExecution({ receipt, walletConfig, payments }) {
  const readiness = getPaymentReadiness(walletConfig);

  if (!readiness.ready) {
    return {
      ok: false,
      status: 'settlement_setup',
      reason: 'Payment setup is not complete yet. Add the paying wallet and connect Arc before paying creators.',
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

  const paymentBySource = new Map(
    payments
      .filter((payment) => payment && typeof payment === 'object')
      .map((payment) => [
        String(payment.sourceId ?? ''),
        normalizeSubmittedPaymentPayload(payment),
      ]),
  );
  const facilitator = createGatewayFacilitator();
  const settlements = [];

  for (const source of receipt.sources) {
    const paymentPayload = paymentBySource.get(source.id);
    if (!paymentPayload) {
      return {
        ok: false,
        status: 'payment_required',
        reason: 'A selected source still needs payment approval.',
        readiness,
      };
    }

    const requirements = createSourcePaymentRequirements(source);
    const verification = await facilitator.verify(paymentPayload, requirements);
    if (!verification.isValid) {
      return {
        ok: false,
        status: 'payment_rejected',
        reason: verification.invalidReason ?? 'Circle Gateway rejected the signed payment.',
        readiness,
        settlements,
      };
    }

    const settlement = await facilitator.settle(paymentPayload, requirements);
    if (!settlement.success) {
      return {
        ok: false,
        status: 'payment_rejected',
        reason: settlement.errorReason ?? 'Circle Gateway settlement failed.',
        readiness,
        settlements,
      };
    }

    settlements.push({
      sourceId: source.id,
      payer: settlement.payer ?? verification.payer ?? '',
      transaction: settlement.transaction,
      network: settlement.network,
      amount: requirements.amount,
    });
  }

  return {
    ok: true,
    status: 'paid',
    reason: 'Creator source payments settled through Circle Gateway.',
    readiness,
    settlements,
  };
}

function getNetwork() {
  return process.env.SOURCEPAY_NETWORK || 'Arc';
}

function createGatewayFacilitator() {
  const url = process.env.CIRCLE_GATEWAY_URL || defaultGatewayUrl();
  return new BatchFacilitatorClient({
    url,
  });
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

function createSigningTypedData({ payer, requirements }) {
  const chainId = Number(requirements.network.split(':')[1]);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = '0';
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
      payload: {
        authorization,
        signature: '<signature>',
      },
    },
  };
}

function normalizeSubmittedPaymentPayload(payment) {
  if (payment.paymentPayload) return payment.paymentPayload;
  if (payment.authorization && payment.signature) {
    return {
      x402Version,
      payload: {
        authorization: payment.authorization,
        signature: payment.signature,
      },
    };
  }

  return null;
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
