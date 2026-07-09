import type {
  EthereumProvider,
  Receipt,
  ReceiptPaymentRequirements,
  ConnectedWallet,
  WalletConnector,
  SafeConfig,
  RegistrySource,
  SourceKind,
  HeroSource,
} from './types';

// Constants
export const SOURCE_KINDS: SourceKind[] = ['Article', 'Social post', 'Transcript'];
export const MIN_USDC_AMOUNT = 0.000001;
export const DEFAULT_SOURCE_PRICE = '0.000001';
export const DEFAULT_REQUEST_BUDGET = 5000;
export const MAX_REQUEST_BUDGET = 10000;
export const WALLETCONNECT_CONNECT_TIMEOUT_MS = 90_000;

// Globals
export let activeWalletProvider: EthereumProvider | null = null;
export let activeWalletProviderCleanup: (() => void) | null = null;
export let walletConnectProvider: EthereumProvider | null = null;

export function setActiveWalletProvider(provider: EthereumProvider | null) {
  activeWalletProvider = provider;
}

export function setWalletConnectProvider(provider: EthereumProvider | null) {
  walletConnectProvider = provider;
}

export function formatUsd(value: number, decimals = 6) {
  const formatted = value.toFixed(decimals);
  if (formatted.includes('.')) {
    const cleaned = formatted.replace(/0+$/u, '');
    if (cleaned.endsWith('.')) {
      return cleaned.slice(0, -1);
    }
    return cleaned;
  }
  return formatted;
}

export function maskAddress(value: string | null | undefined) {
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function encodeBalanceOf(address: string) {
  return `0x70a08231${address.toLowerCase().replace(/^0x/u, '').padStart(64, '0')}`;
}

/** ERC-20 transfer(address,uint256) calldata for Arc Testnet USDC (6 decimals). */
export function encodeUsdcTransfer(to: string, amountAtomic: bigint) {
  const toWord = to.toLowerCase().replace(/^0x/u, '').padStart(64, '0');
  const amountWord = amountAtomic.toString(16).padStart(64, '0');
  return `0xa9059cbb${toWord}${amountWord}`;
}

export function usdcToAtomicBigInt(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.round(value * 1_000_000));
}

/**
 * Buyer pays one creator with a real Arc Testnet USDC transfer from their wallet.
 * Returns the transaction hash.
 */
export async function sendUsdcTransfer(params: {
  provider: EthereumProvider;
  from: string;
  to: string;
  amountUsdc: number;
  usdcAddress: string;
}) {
  const from = await normalizeEvmAddress(params.from, 'Buyer wallet');
  const to = await normalizeEvmAddress(params.to, 'Creator wallet');
  const usdc = await normalizeEvmAddress(params.usdcAddress, 'USDC contract');
  const amount = usdcToAtomicBigInt(params.amountUsdc);
  if (amount <= 0n) {
    throw new Error('Citation amount must be greater than zero.');
  }

  const data = encodeUsdcTransfer(to, amount);
  const txHash = String(
    await params.provider.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from: from.toLowerCase(),
          to: usdc.toLowerCase(),
          data,
          value: '0x0',
        },
      ],
    }),
  );

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('Wallet did not return a valid transaction hash.');
  }
  return txHash;
}

/** Wait until a transaction is mined (success or failure). */
export async function waitForTransaction(provider: EthereumProvider, txHash: string, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = (await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    })) as { status?: string } | null;
    if (receipt?.status) {
      const ok = receipt.status === '0x1' || Number(receipt.status) === 1;
      if (!ok) {
        throw new Error(`Transaction ${txHash.slice(0, 10)}… failed on-chain.`);
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('Timed out waiting for USDC transfer confirmation.');
}

export function formatUsdcAtomic(value: bigint | null) {
  if (value === null) return '--';
  const units = value / 1_000_000n;
  const decimals = value % 1_000_000n;
  const decimalText = decimals.toString().padStart(6, '0').replace(/0+$/u, '');
  return decimalText ? `${units}.${decimalText}` : units.toString();
}

export async function readUsdcBalance({
  provider,
  receipt,
  wallet,
}: {
  provider: EthereumProvider;
  receipt: Receipt;
  wallet: string;
}) {
  const normalizedWallet = await normalizeEvmAddress(wallet, 'Balance wallet');
  const payload = await requestJson<ReceiptPaymentRequirements>(
    apiPath(`/api/receipts/${receipt.id}/payment-requirements`, {
      access: receipt.accessToken,
      payer: normalizedWallet,
    }),
  );
  const firstRequirement = payload.requirements[0]?.requirements;
  if (!firstRequirement?.asset) {
    throw new Error('No creator payment requirements were found for this receipt.');
  }
  if (!isEvmAddressString(firstRequirement.asset)) {
    throw new Error('USDC contract address on this receipt is invalid.');
  }

  const required = payload.requirements.reduce(
    (total, item) => total + BigInt(item.requirements.amount),
    0n,
  );
  const balanceHex = String(
    await provider.request({
      method: 'eth_call',
      params: [
        {
          to: firstRequirement.asset,
          data: encodeBalanceOf(normalizedWallet),
        },
        'latest',
      ],
    }),
  );
  const balance = BigInt(balanceHex);

  return {
    balance,
    required,
    enough: balance >= required,
  };
}

export function getInjectedProvider(): EthereumProvider | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.ethereum ?? window.okxwallet;
}

export function getEthereumProvider(): EthereumProvider | undefined {
  return activeWalletProvider ?? getInjectedProvider();
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Normalize + validate an EVM address. Throws a clear error if invalid. */
export async function normalizeEvmAddress(
  value: string | null | undefined,
  label = 'Wallet address',
): Promise<string> {
  const raw = String(value ?? '').trim();
  if (!EVM_ADDRESS_RE.test(raw)) {
    throw new Error(
      `${label} is missing or invalid (${raw ? raw.slice(0, 18) : 'empty'}). Reconnect your wallet and try again.`,
    );
  }
  try {
    const { getAddress } = await import('viem');
    return getAddress(raw);
  } catch {
    // Still return lowercase hex if checksum fails — MetaMask accepts it.
    return raw.toLowerCase();
  }
}

export function isEvmAddressString(value: string | null | undefined) {
  return EVM_ADDRESS_RE.test(String(value ?? '').trim());
}

export async function getActiveProviderAccount(provider: EthereumProvider) {
  const existingAccounts = await provider
    .request({
      method: 'eth_accounts',
    })
    .catch(() => []);
  const accounts =
    Array.isArray(existingAccounts) && existingAccounts.length > 0
      ? existingAccounts
      : await provider.request({
          method: 'eth_requestAccounts',
        });
  const account = Array.isArray(accounts) ? String(accounts[0] ?? '').trim() : '';
  if (!account) return null;
  try {
    return await normalizeEvmAddress(account, 'Connected wallet');
  } catch {
    return account;
  }
}

/**
 * List authorized provider accounts (normalized). Empty if none connected.
 */
export async function listProviderAccounts(provider: EthereumProvider): Promise<string[]> {
  let accounts: unknown = [];
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' });
  } catch {
    accounts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
  }

  const raw = Array.isArray(accounts)
    ? accounts.map((value) => String(value ?? '').trim()).filter(Boolean)
    : [];

  const normalized: string[] = [];
  for (const account of raw) {
    try {
      normalized.push(await normalizeEvmAddress(account, 'Wallet account'));
    } catch {
      // skip invalid entries from broken providers
    }
  }
  return normalized;
}

/**
 * Resolve the wallet account that will actually pay/sign.
 *
 * Prefer the app's connected wallet when it is still authorized in the provider.
 * Falling back to eth_accounts[0] alone is unsafe: MetaMask often returns a different
 * (stale/secondary) account first, which produces a signer the user "does not have selected".
 */
export async function resolvePayingAccount(
  provider: EthereumProvider,
  preferredAddress?: string | null,
): Promise<string> {
  const accounts = await listProviderAccounts(provider);
  if (accounts.length === 0) {
    throw new Error(
      'No wallet account is selected. Open your wallet, choose the paying account, and try again.',
    );
  }

  if (preferredAddress && isEvmAddressString(preferredAddress)) {
    const preferred = await normalizeEvmAddress(preferredAddress, 'Connected wallet');
    const match = accounts.find((account) => account.toLowerCase() === preferred.toLowerCase());
    if (match) return match;
  }

  return accounts[0];
}

export function sameWalletAddress(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function formatAddressList(addresses: string[], limit = 3) {
  if (addresses.length === 0) return 'none';
  return addresses
    .slice(0, limit)
    .map((address) => maskAddress(address))
    .join(', ');
}

export type PaymentTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** Keep only EIP-712 fields MetaMask accepts for eth_signTypedData_v4. */
export function sanitizePaymentTypedData(raw: Record<string, unknown>): PaymentTypedData {
  const domain = (raw.domain && typeof raw.domain === 'object' ? raw.domain : {}) as Record<
    string,
    unknown
  >;
  const types = (raw.types && typeof raw.types === 'object' ? raw.types : {}) as Record<
    string,
    unknown
  >;
  const message = (raw.message && typeof raw.message === 'object' ? raw.message : {}) as Record<
    string,
    unknown
  >;
  const primaryType = String(raw.primaryType ?? 'TransferWithAuthorization');

  // Drop EIP712Domain from types if present — MetaMask builds it from domain.
  const { EIP712Domain: _ignored, ...safeTypes } = types as Record<string, unknown> & {
    EIP712Domain?: unknown;
  };

  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId:
        typeof domain.chainId === 'string' || typeof domain.chainId === 'number'
          ? Number(domain.chainId)
          : domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: safeTypes,
    primaryType,
    message: {
      from: message.from,
      to: message.to,
      value: String(message.value ?? ''),
      validAfter: String(message.validAfter ?? ''),
      validBefore: String(message.validBefore ?? ''),
      nonce: message.nonce,
    },
  };
}

/**
 * Sign payment typed data. Uses lowercase address in the first param (MetaMask-safe)
 * and validates from/to before calling the wallet.
 *
 * `payer` is the source of truth for message.from (not whatever the server echoed).
 */
export async function signPaymentTypedData(
  provider: EthereumProvider,
  payer: string,
  rawTypedData: Record<string, unknown>,
): Promise<{ signature: string; typedData: PaymentTypedData; signAddress: string }> {
  const typedData = sanitizePaymentTypedData(rawTypedData);
  // Always sign as the resolved paying account — never invent a different "from".
  const signAddress = await normalizeEvmAddress(payer, 'Paying wallet');
  const payTo = await normalizeEvmAddress(String(typedData.message.to ?? ''), 'Creator payout wallet');
  const verifyingContract = await normalizeEvmAddress(
    String(typedData.domain.verifyingContract ?? ''),
    'Gateway verifying contract',
  );

  // Force authorization.from to the account we will actually request a signature from.
  typedData.message.from = signAddress;
  typedData.message.to = payTo;
  typedData.domain.verifyingContract = verifyingContract;

  // Refuse to call MetaMask with an account it does not have authorized.
  const authorized = await listProviderAccounts(provider);
  const isAuthorized = authorized.some(
    (account) => account.toLowerCase() === signAddress.toLowerCase(),
  );
  if (!isAuthorized) {
    throw new Error(
      `Paying account ${maskAddress(signAddress)} is not authorized in your wallet extension. ` +
        `Connected accounts: ${formatAddressList(authorized)}. ` +
        `In MetaMask/OKX, switch to the account that SourcePay shows as connected, then reconnect and try again.`,
    );
  }

  if (!typedData.message.nonce || !/^0x[0-9a-fA-F]{64}$/.test(String(typedData.message.nonce))) {
    throw new Error('Payment authorization nonce is missing. Refresh the receipt and try again.');
  }
  if (!typedData.message.value || !/^\d+$/.test(String(typedData.message.value))) {
    throw new Error('Payment amount is missing. Refresh the receipt and try again.');
  }

  // MetaMask validates the first param strictly; lowercase hex is always accepted.
  const accountParam = signAddress.toLowerCase();
  const payload = JSON.stringify(typedData);

  try {
    const signature = String(
      await provider.request({
        method: 'eth_signTypedData_v4',
        params: [accountParam, payload],
      }),
    );
    if (!signature || signature === 'undefined' || signature === 'null') {
      throw new Error('Wallet returned an empty payment signature.');
    }
    return { signature, typedData, signAddress };
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    // MetaMask uses this phrase for several invalid-address cases (signer OR message fields).
    // Do not claim the user must "select" an account that may not exist in their wallet.
    if (/must provide an Ethereum address/i.test(message)) {
      throw new Error(
        `Wallet could not sign this payment (invalid address parameter). ` +
          `Paying as ${maskAddress(signAddress)}, creator payTo ${maskAddress(payTo)}, ` +
          `authorized accounts: ${formatAddressList(authorized)}. ` +
          `Reconnect the same wallet SourcePay shows, then try Approve & Pay again. ` +
          `Details: ${message}`,
      );
    }
    if (/user rejected|denied|cancelled|canceled/i.test(message)) {
      throw new Error('Payment signature was rejected in the wallet.');
    }
    throw error instanceof Error ? error : new Error(message);
  }
}

/** Recover EIP-712 TransferWithAuthorization signer to catch wallet account mismatches early. */
export async function recoverPaymentSignatureAddress(params: {
  typedData: PaymentTypedData;
  signature: string;
}): Promise<string | null> {
  try {
    const { recoverTypedDataAddress, getAddress } = await import('viem');
    const message = params.typedData.message;
    const recovered = await recoverTypedDataAddress({
      domain: params.typedData.domain as any,
      types: params.typedData.types as any,
      primaryType: params.typedData.primaryType as any,
      message: {
        from: getAddress(String(message.from)),
        to: getAddress(String(message.to)),
        value: BigInt(String(message.value)),
        validAfter: BigInt(String(message.validAfter)),
        validBefore: BigInt(String(message.validBefore)),
        nonce: message.nonce as `0x${string}`,
      },
      signature: params.signature as `0x${string}`,
    });
    return getAddress(recovered);
  } catch {
    return null;
  }
}

export function clearWalletProviderEvents() {
  activeWalletProviderCleanup?.();
  activeWalletProviderCleanup = null;
}

export function bindWalletProviderEvents({
  provider,
  connector,
  onAccountsChanged,
  onDisconnected,
}: {
  provider: EthereumProvider;
  connector: WalletConnector;
  onAccountsChanged: (wallet: ConnectedWallet) => void;
  onDisconnected: () => void;
}) {
  clearWalletProviderEvents();

  if (!provider.on || !provider.removeListener) return;

  const handleAccountsChanged = (...args: unknown[]) => {
    const accounts = args[0];
    const address = Array.isArray(accounts) ? String(accounts[0] ?? '') : '';
    if (!address) {
      onDisconnected();
      return;
    }
    onAccountsChanged({ address, connector });
  };
  const handleDisconnect = () => {
    onDisconnected();
  };

  provider.on('accountsChanged', handleAccountsChanged);
  provider.on('disconnect', handleDisconnect);

  activeWalletProviderCleanup = () => {
    provider.removeListener?.('accountsChanged', handleAccountsChanged);
    provider.removeListener?.('disconnect', handleDisconnect);
  };
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export async function createWalletConnectProvider() {
  const payload = await requestJson<{ config: SafeConfig }>('/api/config');
  const { walletNetwork } = payload.config;
  const projectId = payload.config.walletConnectProjectId?.trim();
  if (!projectId) {
    throw new Error(
      'WalletConnect is not configured. Set SOURCEPAY_WALLETCONNECT_PROJECT_ID to your Reown project ID and redeploy.',
    );
  }

  if (walletConnectProvider) return walletConnectProvider;

  const { default: WalletConnectEthereumProvider } = await import(
    '@walletconnect/ethereum-provider'
  );
  const provider = await WalletConnectEthereumProvider.init({
    projectId,
    optionalChains: [walletNetwork.chainId],
    rpcMap: {
      [walletNetwork.chainId]: walletNetwork.rpcUrls[0],
    },
    showQrModal: true,
    metadata: {
      name: 'SourcePay',
      description: 'Creator citation payments on Arc Testnet',
      url: window.location.origin,
      icons: [`${window.location.origin}/sourcepay-mark.svg`],
    },
    optionalMethods: [
      'eth_accounts',
      'eth_requestAccounts',
      'personal_sign',
      'eth_sendTransaction',
      'eth_signTypedData_v4',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
    ],
  });

  walletConnectProvider = provider;
  return provider;
}

export async function connectWalletProvider(connector: WalletConnector) {
  const provider =
    connector === 'walletconnect' ? await createWalletConnectProvider() : getInjectedProvider();

  if (!provider) {
    throw new Error('Install a browser wallet or use WalletConnect to connect.');
  }

  try {
    activeWalletProvider = provider;
    const accountRequest =
      connector === 'walletconnect' && provider.enable
        ? provider.enable()
        : provider.request({
            method: 'eth_requestAccounts',
          });
    const accounts =
      connector === 'walletconnect'
        ? await withTimeout(
            accountRequest,
            WALLETCONNECT_CONNECT_TIMEOUT_MS,
            'WalletConnect did not complete. Close any open wallet prompt and try again.',
          )
        : await accountRequest;
    const address = Array.isArray(accounts) ? String(accounts[0] ?? '') : '';
    if (!address) {
      throw new Error('No wallet account was selected.');
    }

    await ensureArcNetwork(provider);
    return { address, connector };
  } catch (error) {
    if (connector === 'walletconnect') {
      await provider.disconnect?.().catch(() => undefined);
      walletConnectProvider = null;
    }
    activeWalletProvider = null;
    throw error;
  }
}

export function shortFingerprint(value: string | undefined) {
  if (!value) return '';
  return `sha256: ${value.slice(0, 16)}...${value.slice(-8)}`;
}

export async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value);
  const buffer = await window.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function sourceFingerprintForDraft(source: {
  title: string;
  kind: SourceKind;
  wallet: string;
  price: number;
  content: string;
}) {
  const payload = [
    source.title.trim(),
    source.kind,
    source.wallet.trim(),
    String(source.price),
    source.content.trim(),
  ].join('\n');
  return sha256Hex(payload);
}

export async function buildSourceOwnershipMessage(source: {
  title: string;
  kind: SourceKind;
  wallet: string;
  price: number;
  content: string;
}) {
  const fingerprint = await sourceFingerprintForDraft(source);
  return [
    'SourcePay source registration',
    `Payout wallet: ${source.wallet.trim()}`,
    `Title: ${source.title.trim()}`,
    `Class: ${source.kind.trim()}`,
    `Citation price USDC: ${source.price}`,
    `Source fingerprint: ${fingerprint}`,
  ].join('\n');
}

export async function buildSourceArchiveMessage(source: RegistrySource) {
  return [
    'SourcePay source archive',
    `Source ID: ${source.id}`,
    `Payout wallet: ${source.wallet.trim()}`,
    `Title: ${source.title.trim()}`,
    `Source fingerprint: ${source.fingerprint}`,
  ].join('\n');
}

export async function ensureArcNetwork(provider: EthereumProvider) {
  const payload = await requestJson<{ config: SafeConfig }>('/api/config');
  const { walletNetwork } = payload.config;
  const chainId = String(
    await provider.request({
      method: 'eth_chainId',
    }),
  ).toLowerCase();

  if (chainId === walletNetwork.chainIdHex.toLowerCase()) return walletNetwork;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: walletNetwork.chainIdHex }],
    });
  } catch (error) {
    const code = Number((error as { code?: number }).code);
    if (code !== 4902) {
      throw new Error(`Switch your wallet to ${walletNetwork.chainName} before continuing.`);
    }

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: walletNetwork.chainIdHex,
          chainName: walletNetwork.chainName,
          nativeCurrency: walletNetwork.nativeCurrency,
          rpcUrls: walletNetwork.rpcUrls,
          blockExplorerUrls: walletNetwork.blockExplorerUrls,
        },
      ],
    });
  }

  return walletNetwork;
}

export function formatStatus(value: string) {
  const normalized = value === 'requires_facilitator' ? 'settlement_setup' : value;
  const labels: Record<string, string> = {
    quoted: 'Quoted',
    blocked: 'Action needed',
    settlement_setup: 'Settlement setup',
    payment_required: 'Payment needs approval',
    payment_rejected: 'Payment rejected',
    paid: 'Paid',
    settled: 'Settled',
  };

  return labels[normalized] ?? normalized.replace(/_/gu, ' ');
}

export function paymentTone(status: string) {
  if (status === 'paid' || status === 'settled') {
    return {
      label: 'Paid',
      text: 'text-[#8CE0A0]',
      border: 'border-[#5FBF7A]/30',
      background: 'bg-[#5FBF7A]/12',
    };
  }

  if (status === 'payment_rejected' || status === 'blocked') {
    return {
      label: 'Needs review',
      text: 'text-[#F7B49D]',
      border: 'border-[#F4845F]/35',
      background: 'bg-[#F4845F]/12',
    };
  }

  if (status === 'payment_required' || status === 'settlement_setup') {
    return {
      label: 'Awaiting execution',
      text: 'text-[#9CCCFF]',
      border: 'border-[#5FA9FF]/35',
      background: 'bg-[#5FA9FF]/14',
    };
  }

  return {
    label: 'Open quote',
    text: 'text-white/60',
    border: 'border-white/10',
    background: 'bg-white/[0.035]',
  };
}

export function paymentStateCopy(status: string) {
  if (status === 'paid' || status === 'settled') {
    return 'Settled';
  }
  if (status === 'payment_rejected') {
    return 'Rejected';
  }
  if (status === 'payment_required') {
    return 'Approve';
  }
  if (status === 'settlement_setup') {
    return 'Configure';
  }
  return 'Quote';
}

export function isPublicReceiptStatus(status: string | undefined) {
  return status === 'paid' || status === 'settled';
}

export function receiptAccessQuery(receipt: Pick<Receipt, 'accessToken'> | null | undefined) {
  return receipt?.accessToken ? `?access=${encodeURIComponent(receipt.accessToken)}` : '';
}

export function receiptAccessBody(receipt: Pick<Receipt, 'accessToken'> | null | undefined) {
  return receipt?.accessToken ? { accessToken: receipt.accessToken } : {};
}

export function apiPath(path: string, params: Record<string, string | null | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function receiptDisplayUrl(id: string, receipt: Pick<Receipt, 'accessToken' | 'paymentStatus'> | null) {
  const base = `${window.location.origin}/receipt/${id}`;
  if (!receipt || isPublicReceiptStatus(receipt.paymentStatus) || !receipt.accessToken) {
    return base;
  }
  return `${base}?access=${encodeURIComponent(receipt.accessToken)}`;
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
    try {
      if (errorText) {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error) errorMessage = errorJson.error;
      }
    } catch {
      if (errorText && errorText.length < 120) {
        errorMessage = errorText;
      }
    }
    throw new Error(errorMessage);
  }
  return response.json();
}

export async function requestJsonWithStatus<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; payload: T }> {
  const response = await fetch(path, init);
  const errorText = await response.text().catch(() => '');
  let payload: T;
  try {
    payload = errorText ? JSON.parse(errorText) : {};
  } catch {
    payload = {} as T;
  }
  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

export const HERO_SOURCES: HeroSource[] = [
  {
    id: 'wallet-signed-source',
    label: 'Wallet signed ownership',
    type: 'Article',
    price: 'from 0.000001 USDC',
    paid: 'creator-owned',
    bg: '#071018',
    panel: '#5FA9FF',
    accent: '#071018',
    icon: 'article',
  },
  {
    id: 'licensed-social-cite',
    label: 'Socially verified cite',
    type: 'Social post',
    price: 'priced per cite',
    paid: 'X proof linked',
    bg: '#0d1410',
    panel: '#7CE38B',
    accent: '#071018',
    icon: 'social',
  },
  {
    id: 'transcript-source',
    label: 'Bound transcript source',
    type: 'Transcript',
    price: 'USDC payout',
    paid: 'creator wallet',
    bg: '#101116',
    panel: '#C8B7FF',
    accent: '#071018',
    icon: 'transcript',
  },
  {
    id: 'receipt-proof',
    label: 'x402 proof receipt',
    type: 'Receipt',
    price: 'settled on Arc',
    paid: 'verifiable',
    bg: '#140f0d',
    panel: '#F4845F',
    accent: '#071018',
    icon: 'receipt',
  },
];
