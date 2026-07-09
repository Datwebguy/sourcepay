import type { ReactNode } from 'react';

export type AppView = 'landing' | 'platform' | 'creator' | 'receipt' | 'source';
export type ConsoleTab = 'Requests' | 'Sources' | 'Payments' | 'Policy' | 'Wallet' | 'Guide';
export type Direction = 'next' | 'prev';
export type SourceKind = 'Article' | 'Social post' | 'Transcript';
export type HeroIcon = 'article' | 'social' | 'transcript' | 'receipt';
export type WalletConnector = 'injected' | 'walletconnect';

export type HeroSource = {
  id: string;
  label: string;
  type: string;
  price: string;
  paid: string;
  bg: string;
  panel: string;
  accent: string;
  icon: HeroIcon;
};

export type RegistrySource = {
  id: string;
  title: string;
  kind: SourceKind;
  wallet: string;
  price: number;
  content: string;
  fingerprint?: string;
  ownerWallet?: string | null;
  ownershipVerified?: boolean;
  registryTxHash?: string | null;
  registryStatus?: string | null;
  socialProofStatus?: string | null;
  socialProofUrl?: string | null;
  socialProofHandle?: string | null;
  socialProofVerifiedAt?: string | null;
  sociallyVerified?: boolean;
  twitterHandle?: string | null;
  mediumHandle?: string | null;
  status: 'registered' | 'archived';
  createdAt?: string;
  rank?: number;
};

export type SourceDraft = {
  title: string;
  url: string;
  kind: SourceKind;
  wallet: string;
  price: string;
  content: string;
};

export type Receipt = {
  id: string;
  question: string;
  budget: number;
  totalSpend: number;
  status: string;
  paymentStatus: string;
  rail: string;
  network: string;
  readyForSettlement?: boolean;
  accessToken?: string | null;
  buyerWallet?: string;
  createdAt: string;
  sources: RegistrySource[];
  paymentAttempts?: PaymentAttempt[];
  paymentSettlements?: PaymentSettlement[];
};

export type PaymentRequirement = {
  sourceId: string;
  requirements: {
    asset: string;
    amount: string;
    payTo: string;
  };
  typedData:
    | ({
        message: Record<string, unknown>;
        paymentPayloadTemplate?: Record<string, unknown>;
      } & Record<string, unknown>)
    | null;
};

export type ReceiptPaymentRequirements = {
  receiptId: string;
  payer: string | null;
  requirements: PaymentRequirement[];
};

export type PaymentAttempt = {
  id: string;
  runId: string;
  status: string;
  reason: string;
  rail: string;
  network: string;
  createdAt: string;
};

export type PaymentSettlement = {
  id: string;
  attemptId: string;
  runId: string;
  sourceId: string;
  payer: string;
  payTo: string;
  amount: string;
  transactionId: string;
  network: string;
  createdAt: string;
};

export type CreatorEarnings = {
  wallet: string;
  totals: {
    citations: number;
    quotedAmount: number;
    paidAmount: number;
    paidCitations: number;
    sources: number;
  };
  sources: Array<{
    id: string;
    title: string;
    kind: SourceKind;
    fingerprint?: string;
    citations: number;
    quotedAmount: number;
    paidAmount: number;
  }>;
  receipts: Array<{
    receiptId: string;
    question: string;
    paymentStatus: string;
    rail: string;
    network: string;
    createdAt: string;
    source: {
      id: string;
      title: string;
      kind: SourceKind;
      price: number;
      fingerprint?: string;
    };
    rank: number;
    quotedAmount: number;
    paidAmount: number;
  }>;
};

export type SourceDetail = {
  source: RegistrySource;
  totals: {
    citations: number;
    quotedAmount: number;
    paidAmount: number;
    paidCitations: number;
    receipts: number;
  };
  citations: Array<{
    receiptId: string;
    question: string;
    paymentStatus: string;
    rail: string;
    network: string;
    createdAt: string;
    rank: number;
    quotedAmount: number;
    paidAmount: number;
  }>;
};

export type SourcePreview = {
  title: string;
  content: string;
  sourceType: 'url' | 'text';
  url?: string;
};

export type ConnectedWallet = {
  address: string | null;
  connector?: WalletConnector | null;
};

export type WalletBalanceCheck = {
  checking: boolean;
  balance: bigint | null;
  required: bigint | null;
  enough: boolean | null;
  error: string;
};

export type PaymentReadiness = {
  ready: boolean;
  network: string;
  rail: string;
  status: string;
  batching: {
    name: string;
    scheme: string;
    version: string;
    settlementScheme: string;
    supported: boolean;
  };
  x402Version: number;
  gateway: {
    url: string;
    checked: boolean;
    reachable: boolean | null;
    arcTestnetSupported: boolean | null;
    error: string;
  };
  requirements: {
    rpcUrl: boolean;
    gateway: boolean;
  };
};

export type SafeConfig = {
  network: string;
  arcRpcUrl: boolean;
  agentWallet: string | null;
  contentRegistryAddress: string | null;
  faucetUrls: {
    arc: string | null;
    usdc: string | null;
  };
  walletNetwork: {
    chainId: number;
    chainIdHex: string;
    chainName: string;
    nativeCurrency: {
      name: string;
      symbol: string;
      decimals: number;
    };
    rpcUrls: string[];
    blockExplorerUrls: string[];
    usdcAddress?: string;
  };
  walletConnectProjectId: string;
};

export type WalletAuthChallenge = {
  id: string;
  wallet: string;
  purpose: string;
  message: string;
  expiresAt: number;
};

export type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  enable?: () => Promise<string[]>;
  connect?: (opts?: {
    chains?: number[];
    optionalChains?: number[];
    rpcMap?: Record<string, string>;
  }) => Promise<void>;
  disconnect?: () => Promise<void>;
  on?: (event: any, handler: (...args: any[]) => void) => any;
  removeListener?: (event: any, handler: (...args: any[]) => void) => any;
};

export type WalletConnectionState = {
  connector: WalletConnector | null;
  message: string;
  error: string;
};

export type ErrorBoundaryProps = {
  children: ReactNode;
};

export type ErrorBoundaryState = {
  hasError: boolean;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
    okxwallet?: EthereumProvider;
  }
}
