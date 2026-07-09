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
import { getAddress, isAddress, recoverTypedDataAddress, createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

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
    usdcAddress: CHAIN_CONFIGS.arcTestnet.usdc,
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

      const signatureError = await validateLocalPaymentSignature(paymentPayload, requirements);
      if (signatureError) {
        errors.push(signatureError);
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
    asset: getAddress(chain.usdc),
    amount: usdcToAtomic(source.price),
    payTo: getAddress(source.wallet),
    maxTimeoutSeconds: 60,
    extra: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      verifyingContract: getAddress(chain.gatewayWallet),
    },
  };
}

function createSigningTypedData({ payer, requirements, source }) {
  if (!isEvmAddress(payer)) {
    throw new Error('Payment payer must be a valid Ethereum address.');
  }
  if (!isEvmAddress(requirements.payTo)) {
    throw new Error('Creator payout wallet on this source is not a valid Ethereum address.');
  }
  if (!isEvmAddress(requirements.extra?.verifyingContract)) {
    throw new Error('Gateway verifying contract is not configured correctly.');
  }

  const chainId = Number(requirements.network.split(':')[1]);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error('Payment network chain id is invalid.');
  }

  const now = Math.floor(Date.now() / 1000);
  const validAfter = String(now - 600);
  const validBefore = String(
    now + Math.max(requirements.maxTimeoutSeconds, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS),
  );
  const authorization = {
    from: getAddress(payer),
    to: getAddress(requirements.payTo),
    value: String(requirements.amount),
    validAfter,
    validBefore,
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };

  return {
    domain: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      chainId,
      verifyingContract: getAddress(requirements.extra.verifyingContract),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
    paymentPayloadTemplate: {
      x402Version,
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

async function validateLocalPaymentSignature(paymentPayload, requirements) {
  const authorization = paymentPayload?.payload?.authorization;
  const signature = String(paymentPayload?.payload?.signature ?? '').trim();

  try {
    const chainId = Number(requirements.network.split(':')[1]);
    const signingMessage = {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(String(authorization.value)),
      validAfter: BigInt(String(authorization.validAfter)),
      validBefore: BigInt(String(authorization.validBefore)),
      nonce: authorization.nonce,
    };

    const domain = {
        name: CIRCLE_BATCHING_NAME,
        version: CIRCLE_BATCHING_VERSION,
        chainId,
        verifyingContract: getAddress(requirements.extra.verifyingContract),
      };
    const recoveredAddress = await recoverTypedDataAddress({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: signingMessage,
      signature,
    });

    return sameAddress(recoveredAddress, signingMessage.from)
      ? ''
      : `Payment signature was produced by ${maskPaymentAddress(recoveredAddress)}, but this receipt was prepared for ${maskPaymentAddress(signingMessage.from)}. Select the paying wallet again and retry.`;
  } catch {
    return 'Payment signature could not be verified locally. Reconnect the paying wallet and try again.';
  }
}

function sameAddress(left, right) {
  return isEvmAddress(left) && isEvmAddress(right) && String(left).toLowerCase() === String(right).toLowerCase();
}

function maskPaymentAddress(value) {
  const address = String(value ?? '');
  return isEvmAddress(address) ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'another wallet';
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

export async function checkTransactionSettled(txHash) {
  if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
    return false;
  }
  const rpcUrl = process.env.ARC_RPC_URL || process.env.RPC || 'https://rpc.testnet.arc.network';
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    const receipt = data?.result;
    if (receipt && receipt.blockNumber && (receipt.status === '0x1' || Number(receipt.status) === 1)) {
      return true;
    }
  } catch (err) {
    console.error(`Error checking transaction ${txHash}:`, err);
  }
  return false;
}

const CONTENT_REGISTRY_ABI = [
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "bytes32", "name": "contentHash", "type": "bytes32" },
      { "indexed": true, "internalType": "address", "name": "creatorWallet", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "citationPrice", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "timestamp", "type": "uint256" }
    ],
    "name": "ContentRegistered",
    "type": "event"
  },
  {
    "inputs": [
      { "internalType": "bytes32", "name": "contentHash", "type": "bytes32" },
      { "internalType": "address", "name": "creatorWallet", "type": "address" },
      { "internalType": "uint256", "name": "citationPrice", "type": "uint256" }
    ],
    "name": "registerContent",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "bytes32", "name": "", "type": "bytes32" }
    ],
    "name": "registry",
    "outputs": [
      { "internalType": "bytes32", "name": "contentHash", "type": "bytes32" },
      { "internalType": "address", "name": "creatorWallet", "type": "address" },
      { "internalType": "uint256", "name": "citationPrice", "type": "uint256" },
      { "internalType": "uint256", "name": "timestamp", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

const CONTENT_REGISTRY_BYTECODE = "6080604052348015600e575f5ffd5b506104ac8061001c5f395ff3fe608060405234801561000f575f5ffd5b5060043610610034575f3560e01c80632bc54676146100385780637ef5029814610054575b5f5ffd5b610052600480360381019061004d91906102ec565b610087565b005b61006e6004803603810190610069919061033c565b6101de565b60405161007e9493929190610394565b60405180910390f35b5f5f5f8581526020019081526020015f2060030154146100dc576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016100d390610431565b60405180910390fd5b60405180608001604052808481526020018373ffffffffffffffffffffffffffffffffffffffff168152602001828152602001428152505f5f8581526020019081526020015f205f820151815f01556020820151816001015f6101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555060408201518160020155606082015181600301559050508173ffffffffffffffffffffffffffffffffffffffff16837f6470bc8ae9dba4734ee4ab805bf11730a218e9dfe4083303a308995781320e1383426040516101d192919061044f565b60405180910390a3505050565b5f602052805f5260405f205f91509050805f015490806001015f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff16908060020154908060030154905084565b5f5ffd5b5f819050919050565b61023e8161022c565b8114610248575f5ffd5b50565b5f8135905061025981610235565b92915050565b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6102888261025f565b9050919050565b6102988161027e565b81146102a2575f5ffd5b50565b5f813590506102b38161028f565b92915050565b5f819050919050565b6102cb816102b9565b81146102d5575f5ffd5b50565b5f813590506102e6816102c2565b92915050565b5f5f5f6060848603121561030357610302610228565b5b5f6103108682870161024b565b9350506020610321868287016102a5565b9250506040610332868287016102d8565b9150509250925092565b5f6020828403121561035157610350610228565b5b5f61035e8482850161024b565b91505092915050565b6103708161022c565b82525050565b61037f8161027e565b82525050565b61038e816102b9565b82525050565b5f6080820190506103a75f830187610367565b6103b46020830186610376565b6103c16040830185610385565b6103ce6060830184610385565b95945050505050565b5f82825260208201905092915050565b7f436f6e74656e7420616c726561647920726567697374657265640000000000005f82015250565b5f61041b601a836103d7565b9150610426826103e7565b602082019050919050565b5f6020820190508181035f8301526104488161040f565b9050919050565b5f6040820190506104625f830185610385565b61046f6020830184610385565b939250505056fea2646970667358221220acd5448b10a3f20f18cb8ada2bfed0ba6ab6aaa6fbc4210da077ec36b22409af64736f6c63430008230033";

const arcTestnetChain = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  network: 'arc-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'ARC',
    symbol: 'ARC',
  },
  rpcUrls: {
    default: {
      http: [process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network'],
    },
    public: {
      http: [process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network'],
    },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
});

function getClients() {
  const rpcUrl = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
  const publicClient = createPublicClient({
    chain: arcTestnetChain,
    transport: http(rpcUrl),
  });

  let walletClient = null;
  if (agentAccount) {
    walletClient = createWalletClient({
      account: agentAccount,
      chain: arcTestnetChain,
      transport: http(rpcUrl),
    });
  }

  return { publicClient, walletClient };
}

export async function deployContentRegistry() {
  const { publicClient, walletClient } = getClients();
  if (!walletClient) {
    throw new Error('Agent wallet private key not configured.');
  }

  const hash = await walletClient.deployContract({
    abi: CONTENT_REGISTRY_ABI,
    bytecode: `0x${CONTENT_REGISTRY_BYTECODE}`,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return {
    contractAddress: receipt.contractAddress,
    transactionHash: hash,
  };
}

export async function registerContentOnChain(contentHash, creatorWallet, citationPrice, registryAddress) {
  if (!registryAddress || registryAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error('On-chain content registry address is not configured.');
  }

  const { publicClient, walletClient } = getClients();
  if (!walletClient) {
    throw new Error('Agent wallet private key not configured.');
  }

  const cleanHash = contentHash.startsWith('0x') ? contentHash : `0x${contentHash}`;
  const priceAtomic = BigInt(Math.round(citationPrice * 1_000_000));

  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: CONTENT_REGISTRY_ABI,
    functionName: 'registerContent',
    args: [cleanHash, creatorWallet, priceAtomic],
  });

  return hash;
}


