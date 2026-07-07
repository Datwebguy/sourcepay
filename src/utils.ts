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
  const payload = await requestJson<ReceiptPaymentRequirements>(
    `/api/receipts/${receipt.id}/payment-requirements${receiptAccessQuery(receipt)}`,
  );
  const firstRequirement = payload.requirements[0]?.requirements;
  if (!firstRequirement) {
    throw new Error('No creator payment requirements were found for this receipt.');
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
          data: encodeBalanceOf(wallet),
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

  return account || null;
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
    label: 'Wallet signed source',
    type: 'Article',
    price: '0.000001 USDC',
    paid: 'creator-owned',
    bg: '#071018',
    panel: '#5FA9FF',
    accent: '#071018',
    icon: 'article',
  },
  {
    id: 'licensed-social-cite',
    label: 'Licensed social cite',
    type: 'Social post',
    price: 'priced per cite',
    paid: 'paid by agent',
    bg: '#11150f',
    panel: '#7CE38B',
    accent: '#071018',
    icon: 'social',
  },
  {
    id: 'receipt-proof',
    label: 'Proof receipt',
    type: 'Receipt',
    price: 'x402 on Arc',
    paid: 'verifiable',
    bg: '#140f0d',
    panel: '#F4845F',
    accent: '#071018',
    icon: 'receipt',
  },
  {
    id: 'transcript-source',
    label: 'Transcript source',
    type: 'Transcript',
    price: 'USDC payout',
    paid: 'creator wallet',
    bg: '#101116',
    panel: '#C8B7FF',
    accent: '#071018',
    icon: 'transcript',
  },
];
