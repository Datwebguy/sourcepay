import { Component, type ReactNode, useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  Database,
  ExternalLink,
  FileText,
  Filter,
  Pencil,
  MessageSquareText,
  Mic2,
  Play,
  ReceiptText,
  SendHorizontal,
  Server,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wallet,
  Download,
} from 'lucide-react';

type AppView = 'landing' | 'platform' | 'creator' | 'receipt' | 'source';
type ConsoleTab = 'Requests' | 'Sources' | 'Payments' | 'Policy' | 'Wallet';
type Direction = 'next' | 'prev';
type SourceKind = 'Article' | 'Social post' | 'Transcript';
type HeroIcon = 'article' | 'social' | 'transcript' | 'receipt';

type HeroSource = {
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

type RegistrySource = {
  id: string;
  title: string;
  kind: SourceKind;
  wallet: string;
  price: number;
  content: string;
  fingerprint?: string;
  ownerWallet?: string | null;
  ownershipVerified?: boolean;
  status: 'registered' | 'archived';
  createdAt?: string;
  rank?: number;
};

type SourceDraft = {
  title: string;
  url: string;
  kind: SourceKind;
  wallet: string;
  price: string;
  content: string;
};

type Receipt = {
  id: string;
  question: string;
  budget: number;
  totalSpend: number;
  status: string;
  paymentStatus: string;
  rail: string;
  network: string;
  readyForSettlement?: boolean;
  createdAt: string;
  sources: RegistrySource[];
  paymentAttempts?: PaymentAttempt[];
};

type PaymentRequirement = {
  sourceId: string;
  requirements: {
    asset: string;
    amount: string;
    payTo: string;
  };
  typedData: ({ message: Record<string, unknown> } & Record<string, unknown>) | null;
};

type ReceiptPaymentRequirements = {
  receiptId: string;
  payer: string | null;
  requirements: PaymentRequirement[];
};

type PaymentAttempt = {
  id: string;
  runId: string;
  status: string;
  reason: string;
  rail: string;
  network: string;
  createdAt: string;
};

type CreatorEarnings = {
  wallet: string;
  totals: {
    citations: number;
    quotedAmount: number;
    sources: number;
  };
  sources: Array<{
    id: string;
    title: string;
    kind: SourceKind;
    fingerprint?: string;
    citations: number;
    quotedAmount: number;
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
  }>;
};

type SourceDetail = {
  source: RegistrySource;
  totals: {
    citations: number;
    quotedAmount: number;
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
  }>;
};

type SourcePreview = {
  title: string;
  content: string;
  sourceType: 'url' | 'text';
  url?: string;
};

type ConnectedWallet = {
  address: string | null;
};

type WalletBalanceCheck = {
  checking: boolean;
  balance: bigint | null;
  required: bigint | null;
  enough: boolean | null;
  error: string;
};

type WalletConfig = {
  agentWallet: string | null;
  network: string;
  ready: boolean;
  updatedAt?: string;
};

type PaymentReadiness = {
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
  requirements: {
    agentWallet: boolean;
    rpcUrl: boolean;
  };
};

type SafeConfig = {
  network: string;
  arcRpcUrl: boolean;
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
  };
};

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

const HERO_SOURCES: HeroSource[] = [
  {
    id: 'licensed-url',
    label: 'Licensed URL',
    type: 'Article',
    price: 'priced per cite',
    paid: 'paid access',
    bg: '#F4845F',
    panel: '#F79B7F',
    accent: '#3B2018',
    icon: 'article',
  },
  {
    id: 'public-thread',
    label: 'Public thread',
    type: 'Social post',
    price: 'priced per quote',
    paid: 'creator wallet',
    bg: '#5FBF7A',
    panel: '#7ED08F',
    accent: '#12361F',
    icon: 'social',
  },
  {
    id: 'transcript-asset',
    label: 'Transcript asset',
    type: 'Transcript',
    price: 'priced per summary',
    paid: 'metered use',
    bg: '#E882B4',
    panel: '#ED9DC4',
    accent: '#4D1734',
    icon: 'transcript',
  },
  {
    id: 'settlement-proof',
    label: 'Payment proof',
    type: 'Receipt',
    price: 'USDC on Arc',
    paid: 'verifiable trail',
    bg: '#5FA9FF',
    panel: '#82BEFF',
    accent: '#102B4D',
    icon: 'receipt',
  },
];

const SOURCE_KINDS: SourceKind[] = ['Article', 'Social post', 'Transcript'];
const MIN_USDC_AMOUNT = 1;
const DEFAULT_SOURCE_PRICE = '1';
const DEFAULT_REQUEST_BUDGET = 5000;
const MAX_REQUEST_BUDGET = 10000;

const heroIcons = {
  article: FileText,
  social: MessageSquareText,
  transcript: Mic2,
  receipt: ReceiptText,
};

const sourceKindIcons = {
  Article: FileText,
  'Social post': MessageSquareText,
  Transcript: Mic2,
};

class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <section
        className="grid min-h-screen place-items-center px-4 text-white"
        style={{
          background:
            'radial-gradient(circle at 18% 12%, rgba(95,169,255,0.24), transparent 30%), linear-gradient(135deg, #071018 0%, #0d0f12 48%, #17100e 100%)',
        }}
      >
        <div className="w-full max-w-md rounded-[8px] border border-white/12 bg-[#0b0e11]/90 p-5 text-center shadow-2xl shadow-black/45">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/5">
            <ShieldCheck size={22} strokeWidth={2.25} />
          </div>
          <p className="text-lg font-bold">SourcePay needs a refresh</p>
          <p className="mt-2 text-sm font-medium leading-relaxed text-white/50">
            Your work is stored by the SourcePay API. Reload the app and continue.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-[8px] bg-white px-4 py-2.5 text-sm font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
          >
            Reload SourcePay
          </button>
        </div>
      </section>
    );
  }
}

function formatUsd(value: number, decimals = 4) {
  return value.toFixed(decimals);
}

function maskAddress(value: string | null | undefined) {
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function encodeBalanceOf(address: string) {
  return `0x70a08231${address.toLowerCase().replace(/^0x/u, '').padStart(64, '0')}`;
}

function formatUsdcAtomic(value: bigint | null) {
  if (value === null) return '--';
  const units = value / 1_000_000n;
  const decimals = value % 1_000_000n;
  const decimalText = decimals.toString().padStart(6, '0').replace(/0+$/u, '');
  return decimalText ? `${units}.${decimalText}` : units.toString();
}

async function readUsdcBalance({
  provider,
  receiptId,
  wallet,
}: {
  provider: EthereumProvider;
  receiptId: string;
  wallet: string;
}) {
  const payload = await requestJson<ReceiptPaymentRequirements>(
    `/api/receipts/${receiptId}/payment-requirements`,
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

function getEthereumProvider() {
  return typeof window !== 'undefined' ? window.ethereum : undefined;
}

function useSmallViewport() {
  const [isSmallViewport, setIsSmallViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 640 : false,
  );

  useEffect(() => {
    const update = () => setIsSmallViewport(window.innerWidth < 640);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return isSmallViewport;
}

function shortFingerprint(value: string | undefined) {
  if (!value) return 'unverified';
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

async function sha256Hex(value: string) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sourceFingerprintForDraft(source: {
  title: string;
  kind: SourceKind;
  wallet: string;
  price: number;
  content: string;
}) {
  return sha256Hex(
    [
      source.title.trim(),
      source.kind,
      source.wallet.trim(),
      String(source.price),
      source.content.trim(),
    ].join('\n'),
  );
}

async function buildSourceOwnershipMessage(source: {
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
    `Class: ${source.kind}`,
    `Citation price USDC: ${source.price}`,
    `Source fingerprint: ${fingerprint}`,
  ].join('\n');
}

async function buildSourceArchiveMessage(source: RegistrySource) {
  return [
    'SourcePay source archive',
    `Source ID: ${source.id}`,
    `Payout wallet: ${source.wallet.trim()}`,
    `Title: ${source.title.trim()}`,
    `Source fingerprint: ${source.fingerprint ?? ''}`,
  ].join('\n');
}

async function ensureArcNetwork(provider: EthereumProvider) {
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

function formatStatus(value: string) {
  const normalized =
    value === `requires_${'fac' + 'ilitator'}` ? 'settlement_setup' : value;
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

function paymentTone(status: string) {
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
      label: 'Needs approval',
      text: 'text-[#FFE2A8]',
      border: 'border-[#F6C15F]/30',
      background: 'bg-[#F6C15F]/10',
    };
  }

  return {
    label: 'Ready',
    text: 'text-[#9CCCFF]',
    border: 'border-[#5FA9FF]/30',
    background: 'bg-[#5FA9FF]/12',
  };
}

function paymentStateCopy(status: string) {
  if (status === 'paid' || status === 'settled') {
    return 'Creators have been paid for the selected sources.';
  }
  if (status === 'payment_rejected') {
    return 'Payment was not completed. Review the latest payment history entry.';
  }
  if (status === 'payment_required' || status === 'settlement_setup') {
    return 'Wallet approval is needed before creators can be paid.';
  }

  return 'Review the selected sources and settle payment when ready.';
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 15_000);
  try {
    response = await fetch(path, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new Error('SourcePay could not reach the API. Please refresh and try again.');
  } finally {
    window.clearTimeout(timeoutId);
  }
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error ?? 'Request failed.');
  }

  return payload as T;
}

async function requestJsonWithStatus<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; payload: T }> {
  let response: Response;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 15_000);
  try {
    response = await fetch(path, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new Error('SourcePay could not reach the API. Please refresh and try again.');
  } finally {
    window.clearTimeout(timeoutId);
  }
  const payload = (await response.json()) as T;
  return { ok: response.ok, status: response.status, payload };
}

function GrainOverlay() {
  const grainSvg =
    "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.08'/%3E%3C/svg%3E\")";

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-50 opacity-40"
      style={{ backgroundImage: grainSvg, backgroundSize: '200px 200px' }}
    />
  );
}

function SourceVisual({ item }: { item: HeroSource }) {
  const Icon = heroIcons[item.icon];

  return (
    <div
      className="flex h-full w-full flex-col justify-between overflow-hidden rounded-[8px] border border-white/40 px-5 py-5 shadow-2xl"
      style={{ backgroundColor: item.panel, color: item.accent }}
    >
      <div className="flex items-center justify-between">
        <div className="rounded-full bg-white/55 p-3">
          <Icon size={30} strokeWidth={2.25} />
        </div>
        <span className="text-xs font-bold uppercase tracking-[0.18em]">
          {item.type}
        </span>
      </div>

      <div>
        <p className="mb-3 max-w-[12rem] text-[clamp(1.5rem,4vw,2.8rem)] font-bold leading-[0.95]">
          {item.label}
        </p>
        <div className="h-2 w-24 rounded-full bg-white/70" />
      </div>

      <div className="space-y-2 rounded-[8px] bg-white/45 p-4 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3 text-sm font-bold">
          <span>{item.price}</span>
          <CircleDollarSign size={20} strokeWidth={2.25} />
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-80">
          {item.paid}
        </p>
      </div>
    </div>
  );
}

function SourcePayMark({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <img
      src="/sourcepay-mark.svg"
      alt="SourcePay"
      className={`${className} rounded-[8px] shadow-lg shadow-black/20`}
    />
  );
}

function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const isSmallViewport = useSmallViewport();
  const activeSource = HERO_SOURCES[activeIndex];
  const roles = {
    center: activeIndex,
    left: (activeIndex + HERO_SOURCES.length - 1) % HERO_SOURCES.length,
    right: (activeIndex + 1) % HERO_SOURCES.length,
    back: (activeIndex + 2) % HERO_SOURCES.length,
  };

  const navigate = (direction: Direction) => {
    if (isAnimating) return;

    setIsAnimating(true);
    setActiveIndex((current) =>
      direction === 'next'
        ? (current + 1) % HERO_SOURCES.length
        : (current + HERO_SOURCES.length - 1) % HERO_SOURCES.length,
    );
    window.setTimeout(() => setIsAnimating(false), 650);
  };

  return (
    <section
      className="relative min-h-[100svh] w-full overflow-x-hidden overflow-y-auto"
      style={{
        backgroundColor: activeSource.bg,
        transition: 'background-color 650ms cubic-bezier(0.4,0,0.2,1)',
      }}
    >
      <GrainOverlay />

      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 select-none items-center justify-center ${
          isSmallViewport ? 'hidden' : 'flex'
        }`}
        style={{ zIndex: 2, top: '18%' }}
      >
        <p
          className="font-display uppercase text-white"
          style={{
            fontSize: 'clamp(64px, 16vw, 250px)',
            fontWeight: 900,
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          SOURCEPAY
        </p>
      </div>

      <div className="absolute left-4 top-6 z-[60] flex items-center gap-3 sm:left-8">
        <SourcePayMark />
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-white opacity-90">
          SourcePay
        </span>
      </div>

      <div className="absolute right-4 top-6 z-[60] hidden items-center gap-4 text-xs font-semibold uppercase tracking-[0.14em] text-white/90 sm:flex">
        <span>Arc</span>
        <span>USDC</span>
        <span>x402</span>
      </div>

      <div className="absolute inset-0 z-[3]">
        {HERO_SOURCES.map((item, index) => {
          const role =
            roles.center === index
              ? 'center'
              : roles.left === index
                ? 'left'
                : roles.right === index
                  ? 'right'
                  : 'back';
          const isCenter = role === 'center';
          const isSide = role === 'left' || role === 'right';

          return (
            <div
              key={item.id}
              aria-hidden={!isCenter}
              className="absolute"
              style={{
                left: isSmallViewport
                  ? '50%'
                  : role === 'left'
                    ? '30%'
                    : role === 'right'
                      ? '70%'
                      : '50%',
                bottom: isSmallViewport ? '18%' : isCenter ? '8%' : '12%',
                height: isSmallViewport
                  ? isCenter
                    ? '46%'
                    : '22%'
                  : isCenter
                    ? '58%'
                    : isSide
                      ? '28%'
                      : '22%',
                opacity: isSmallViewport
                  ? isCenter
                    ? 1
                    : 0
                  : isCenter
                    ? 1
                    : isSide
                      ? 0.85
                      : 0.95,
                zIndex: isCenter ? 20 : isSide ? 10 : 5,
                transform: `translateX(-50%) scale(${
                  isSmallViewport ? (isCenter ? 1 : 0.9) : isCenter ? 1.22 : 1
                })`,
                filter: isCenter ? 'blur(0)' : isSide ? 'blur(2px)' : 'blur(4px)',
                transition:
                  'transform 650ms cubic-bezier(0.4,0,0.2,1), filter 650ms cubic-bezier(0.4,0,0.2,1), opacity 650ms cubic-bezier(0.4,0,0.2,1), left 650ms cubic-bezier(0.4,0,0.2,1), bottom 650ms cubic-bezier(0.4,0,0.2,1), height 650ms cubic-bezier(0.4,0,0.2,1)',
                willChange: 'transform, filter, opacity',
                aspectRatio: '0.68 / 1',
              }}
            >
              <SourceVisual item={item} />
            </div>
          );
        })}
      </div>

      <div className="absolute bottom-5 left-4 z-[60] max-w-[220px] sm:bottom-20 sm:left-24 sm:max-w-[340px]">
        <p className="mb-2 text-base font-bold uppercase tracking-normal text-white opacity-95 sm:mb-3 sm:text-[22px]">
          AI citations that pay
        </p>
        <p className="mb-5 hidden text-sm leading-[1.6] text-white opacity-85 sm:block">
          Agents buy the source material they use: articles, posts, transcripts,
          and receipts settled as USDC nanopayments on Arc.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            aria-label="Previous source"
            onClick={() => navigate('prev')}
            className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-white bg-transparent text-white transition duration-150 hover:scale-[1.08] hover:bg-white/15 sm:h-16 sm:w-16"
          >
            <ArrowLeft size={26} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            aria-label="Next source"
            onClick={() => navigate('next')}
            className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-white bg-transparent text-white transition duration-150 hover:scale-[1.08] hover:bg-white/15 sm:h-16 sm:w-16"
          >
            <ArrowRight size={26} strokeWidth={2.25} />
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={onLaunch}
        className="absolute bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center justify-center gap-2 whitespace-nowrap text-center text-xl font-semibold uppercase leading-none text-white opacity-95 transition-opacity duration-200 hover:opacity-100 sm:hidden"
      >
        Launch
        <ArrowRight className="h-5 w-5 shrink-0" strokeWidth={2.25} />
      </button>

      <button
        type="button"
        onClick={onLaunch}
        className="font-display absolute bottom-20 right-10 z-[60] hidden items-center justify-end gap-2 whitespace-nowrap text-right uppercase text-white opacity-95 transition-opacity duration-200 hover:opacity-100 sm:flex"
        style={{
          fontSize: 'clamp(20px, 4vw, 56px)',
          fontWeight: 400,
          lineHeight: 1,
        }}
      >
        Launch SourcePay
        <ArrowRight className="h-8 w-8 shrink-0" strokeWidth={2.25} />
      </button>
    </section>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Database;
}) {
  return (
    <div className="rounded-[8px] border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.025] p-4">
      <div className="mb-3 flex items-center justify-between text-white/48">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em]">
          {label}
        </span>
        <Icon size={17} strokeWidth={2.25} />
      </div>
      <p className="text-xl font-bold">{value}</p>
    </div>
  );
}

function PlatformPage({
  onBack,
  onOpenReceipt,
  onOpenCreator,
  onOpenSource,
  connectedWallet,
  onConnectWallet,
  onDisconnectWallet,
  isConnectingWallet,
}: {
  onBack: () => void;
  onOpenReceipt: (id: string, receipt?: Receipt) => void;
  onOpenCreator: () => void;
  onOpenSource: (id: string) => void;
  connectedWallet: ConnectedWallet;
  onConnectWallet: () => Promise<string | null>;
  onDisconnectWallet: () => Promise<void>;
  isConnectingWallet: boolean;
}) {
  const [question, setQuestion] = useState('');
  const [budget, setBudget] = useState(DEFAULT_REQUEST_BUDGET);
  const [enabledTypes, setEnabledTypes] = useState<SourceKind[]>(SOURCE_KINDS);
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [walletConfig, setWalletConfig] = useState<WalletConfig | null>(null);
  const [paymentReadiness, setPaymentReadiness] = useState<PaymentReadiness | null>(
    null,
  );
  const [safeConfig, setSafeConfig] = useState<SafeConfig | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [activeTab, setActiveTab] = useState<ConsoleTab>('Requests');
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceClassFilter, setSourceClassFilter] = useState<SourceKind | 'All'>('All');
  const [error, setError] = useState('');
  const [isRouting, setIsRouting] = useState(false);
  const [walletBalanceCheck, setWalletBalanceCheck] = useState<WalletBalanceCheck>({
    checking: false,
    balance: null,
    required: null,
    enough: null,
    error: '',
  });

  const readinessRequirements = [
    ['Wallet', Boolean(connectedWallet.address || walletConfig?.agentWallet)],
    ['Arc connection', paymentReadiness?.requirements.rpcUrl],
  ] satisfies Array<[string, boolean | undefined]>;

  const payableReceipts = receipts.filter((item) => item.sources.length > 0);
  const activeReceipt =
    receipt && receipt.sources.length > 0 ? receipt : payableReceipts[0] ?? receipt;
  const selectedSources = activeReceipt?.sources ?? [];
  const totalSpend = activeReceipt?.totalSpend ?? 0;
  const walletBalanceCopy = walletBalanceCheck.checking
    ? 'Checking balance'
    : walletBalanceCheck.enough === true
      ? 'Enough USDC'
      : walletBalanceCheck.enough === false
        ? 'Low USDC'
        : connectedWallet.address
          ? 'Check unavailable'
          : 'Connect wallet';
  const normalizedSourceSearch = sourceSearch.trim().toLowerCase();
  const discoveredSources = sources.filter((source) => {
    const matchesClass =
      sourceClassFilter === 'All' || source.kind === sourceClassFilter;
    const matchesSearch =
      !normalizedSourceSearch ||
      `${source.title} ${source.content} ${source.fingerprint ?? ''}`
        .toLowerCase()
        .includes(normalizedSourceSearch);
    const withinBudget = source.price <= budget;

    return matchesClass && matchesSearch && withinBudget;
  });
  const hasRegisteredSources = sources.length > 0;
  const requestText = question.trim();
  const routeBlockReason = !hasRegisteredSources
    ? 'Add creator sources first'
    : !requestText
      ? 'Enter a request'
      : enabledTypes.length === 0
        ? 'Select source types'
        : discoveredSources.length === 0
          ? 'No matching sources'
          : '';

  useEffect(() => {
    let ignore = false;
    const requiredFallback = activeReceipt
      ? BigInt(Math.round(activeReceipt.totalSpend * 1_000_000))
      : null;

    if (!activeReceipt || !connectedWallet.address || activeReceipt.sources.length === 0) {
      setWalletBalanceCheck({
        checking: false,
        balance: null,
        required: requiredFallback,
        enough: null,
        error: '',
      });
      return () => {
        ignore = true;
      };
    }

    const provider = getEthereumProvider();
    if (!provider) {
      setWalletBalanceCheck({
        checking: false,
        balance: null,
        required: requiredFallback,
        enough: null,
        error: 'Browser wallet unavailable.',
      });
      return () => {
        ignore = true;
      };
    }

    setWalletBalanceCheck((current) => ({
      ...current,
      checking: true,
      required: requiredFallback,
      error: '',
    }));

    ensureArcNetwork(provider)
      .then(() =>
        readUsdcBalance({
          provider,
          receiptId: activeReceipt.id,
          wallet: connectedWallet.address as string,
        }),
      )
      .then((result) => {
        if (ignore) return;
        setWalletBalanceCheck({
          checking: false,
          balance: result.balance,
          required: result.required,
          enough: result.enough,
          error: '',
        });
      })
      .catch((requestError: Error) => {
        if (ignore) return;
        setWalletBalanceCheck({
          checking: false,
          balance: null,
          required: requiredFallback,
          enough: null,
          error: requestError.message,
        });
      });

    return () => {
      ignore = true;
    };
  }, [activeReceipt?.id, activeReceipt?.totalSpend, connectedWallet.address]);

  useEffect(() => {
    let ignore = false;

    requestJson<{ sources: RegistrySource[] }>('/api/sources')
      .then((payload) => {
        if (!ignore) setSources(payload.sources);
      })
      .catch((requestError: Error) => {
        if (!ignore) setError(requestError.message);
      });

    return () => {
      ignore = true;
    };
  }, []);

  const refreshPaymentReadiness = async () => {
    const payload = await requestJson<{ payment: PaymentReadiness }>(
      '/api/payment-readiness',
    );
    setPaymentReadiness(payload.payment);
  };

  useEffect(() => {
    refreshPaymentReadiness().catch((requestError: Error) => {
      setError(requestError.message);
    });
  }, []);

  useEffect(() => {
    requestJson<{ config: SafeConfig }>('/api/config')
      .then((payload) => setSafeConfig(payload.config))
      .catch((requestError: Error) => setError(requestError.message));
  }, []);

  useEffect(() => {
    let ignore = false;

    requestJson<{ wallet: WalletConfig }>('/api/wallet')
      .then((payload) => {
        if (ignore) return;
        setWalletConfig(payload.wallet);
      })
      .catch((requestError: Error) => {
        if (!ignore) setError(requestError.message);
      });

    return () => {
      ignore = true;
    };
  }, []);

  const refreshReceipts = async () => {
    const payload = await requestJson<{ receipts: Receipt[] }>('/api/receipts');
    setReceipts(payload.receipts);
    setReceipt((current) => current ?? payload.receipts.find((item) => item.sources.length > 0) ?? null);
  };

  useEffect(() => {
    refreshReceipts().catch((requestError: Error) => {
      setError(requestError.message);
    });
  }, []);

  const toggleSourceKind = (kind: SourceKind) => {
    setEnabledTypes((current) =>
      current.includes(kind)
        ? current.filter((item) => item !== kind)
        : [...current, kind],
    );
  };

  const routeRequest = async () => {
    if (routeBlockReason) {
      setError(routeBlockReason);
      return;
    }

    setIsRouting(true);
    setError('');

    try {
      const payload = await requestJson<{ receipt: Receipt }>('/api/route', {
        method: 'POST',
        body: JSON.stringify({
          question,
          budget,
          kinds: enabledTypes,
        }),
      });
      setReceipt(payload.receipt);
      await refreshReceipts();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsRouting(false);
    }
  };

  const connectWalletFromPage = async () => {
    setError('');
    try {
      await onConnectWallet();
      await refreshPaymentReadiness();
      const payload = await requestJson<{ wallet: WalletConfig }>('/api/wallet');
      setWalletConfig(payload.wallet);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  const disconnectWalletFromPage = async () => {
    setError('');
    try {
      await onDisconnectWallet();
      const payload = await requestJson<{ wallet: WalletConfig }>('/api/wallet');
      setWalletConfig(payload.wallet);
      await refreshPaymentReadiness();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  return (
    <section
      className="min-h-screen px-3 py-3 text-white sm:px-5 sm:py-5"
      style={{
        background:
          'radial-gradient(circle at 14% 10%, rgba(95,169,255,0.28), transparent 30%), radial-gradient(circle at 84% 8%, rgba(244,132,95,0.2), transparent 28%), radial-gradient(circle at 55% 95%, rgba(95,191,122,0.1), transparent 30%), linear-gradient(135deg, #071018 0%, #0d0f12 44%, #17100e 100%)',
      }}
    >
      <div className="mx-auto flex w-full max-w-[1500px] flex-col overflow-x-auto rounded-[8px] border border-white/12 bg-[#0b0e11]/88 shadow-2xl shadow-black/45 backdrop-blur-xl">
        <header className="flex min-h-16 flex-col items-stretch justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <SourcePayMark />
            <div className="min-w-0">
              <p className="text-sm font-bold">SourcePay</p>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">
                agent payment router
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <button
              type="button"
              onClick={onBack}
              className="flex min-h-10 items-center gap-2 rounded-full border border-white/14 px-3 py-2 text-sm font-bold text-white/72 transition hover:border-white/40 hover:text-white sm:px-4"
            >
              <ArrowLeft size={17} strokeWidth={2.25} />
              Landing
            </button>
            {connectedWallet.address ? (
              <button
                type="button"
                onClick={disconnectWalletFromPage}
                className="flex min-h-10 items-center gap-2 rounded-full border border-[#F4845F]/35 px-3 py-2 text-sm font-bold text-[#F7B49D] transition hover:border-[#F4845F]/65 hover:text-white sm:px-4"
              >
                <Wallet size={16} strokeWidth={2.25} />
                Disconnect {maskAddress(connectedWallet.address)}
              </button>
            ) : (
              <button
                type="button"
                onClick={connectWalletFromPage}
                disabled={isConnectingWallet}
                className="flex min-h-10 items-center gap-2 rounded-full border border-white/14 px-3 py-2 text-sm font-bold text-white/72 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-45 sm:px-4"
              >
                <Wallet size={16} strokeWidth={2.25} />
                {isConnectingWallet ? 'Connecting' : 'Connect wallet'}
              </button>
            )}
            <button
              type="button"
              onClick={onOpenCreator}
              className="flex min-h-10 items-center gap-2 rounded-full border border-white/14 px-3 py-2 text-sm font-bold text-white/72 transition hover:border-white/40 hover:text-white sm:px-4"
            >
              Creator portal
              <ExternalLink size={16} strokeWidth={2.25} />
            </button>
          </div>
        </header>

        <div className="grid min-w-0 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="border-b border-white/10 bg-black/10 p-3 lg:border-b-0 lg:border-r lg:p-4">
            <nav className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-1">
              {[
                { label: 'Requests', icon: Activity },
                { label: 'Sources', icon: Database },
                { label: 'Payments', icon: ReceiptText },
                { label: 'Policy', icon: ShieldCheck },
                { label: 'Wallet', icon: Server },
              ].map(({ label, icon: Icon }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setActiveTab(label as ConsoleTab)}
                  className={`flex items-center gap-3 rounded-[8px] px-3 py-2.5 text-left text-sm font-semibold transition ${
                    activeTab === label
                      ? 'bg-white text-black'
                      : 'text-white/58 hover:bg-white/[0.04] hover:text-white'
                  }`}
                >
                  <Icon size={17} strokeWidth={2.25} />
                  {label}
                </button>
              ))}
            </nav>

            <div className="mt-5 rounded-[8px] border border-white/10 bg-black/28 p-4">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                Spend policy
              </p>
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-white/55">Per answer</span>
                  <span className="font-bold">${formatUsd(budget, 2)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/55">Network</span>
                  <span className="font-bold">Arc</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/55">Payment</span>
                  <span className="font-bold">USDC</span>
                </div>
              </div>
            </div>
          </aside>

          <div className="min-w-0 p-3 sm:p-5">
            <div className="mb-4 grid gap-2 md:grid-cols-3">
              {[
                ['1', 'Add sources', hasRegisteredSources],
                ['2', 'Route request', selectedSources.length > 0],
                ['3', 'Pay receipt', activeReceipt?.paymentStatus === 'paid'],
              ].map(([step, label, done]) => (
                <div
                  key={label as string}
                  className={`rounded-[8px] border px-3 py-2.5 text-sm ${
                    done
                      ? 'border-[#5FBF7A]/25 bg-[#5FBF7A]/10 text-[#8CE0A0]'
                      : 'border-white/10 bg-white/[0.025] text-white/48'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-current text-xs font-extrabold">
                      {step}
                    </span>
                    <span className="font-bold">{label}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Discoverable sources"
                value={discoveredSources.length.toString()}
                icon={Database}
              />
              <MetricCard
                label="Selected sources"
                value={selectedSources.length.toString()}
                icon={Filter}
              />
              <MetricCard
                label={activeReceipt?.paymentStatus === 'paid' ? 'Paid' : 'Quoted spend'}
                value={`${formatUsd(totalSpend)} USDC`}
                icon={Wallet}
              />
              <MetricCard
                label="Wallet balance"
                value={walletBalanceCopy}
                icon={Server}
              />
            </div>

            {activeTab === 'Requests' && (
            <div className="grid gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
              <section className="rounded-[8px] border border-white/10 bg-[#111]/90">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-sm font-bold">New request</p>
                  <p className="text-xs text-white/45">
                    Ask the agent to find and pay for matching creator sources.
                  </p>
                </div>

                <div className="space-y-3 p-4">
                  <label className="block">
                    <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                      Research objective
                    </span>
                    <textarea
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      placeholder="Enter the research request the agent should answer."
                      className="min-h-24 w-full resize-none rounded-[8px] border border-white/10 bg-black/30 p-3 text-sm font-medium leading-relaxed text-white outline-none transition placeholder:text-white/25 focus:border-[#5FA9FF]/80"
                    />
                  </label>

                  <div className="rounded-[8px] border border-white/10 bg-black/24 p-3">
                    <div className="mb-3 flex items-center justify-between text-sm">
                      <span className="font-bold">${formatUsd(budget, 2)} USDC</span>
                      <span className="text-white/42">max spend</span>
                    </div>
                    <input
                      aria-label="Max spend"
                      type="range"
                      min={MIN_USDC_AMOUNT}
                      max={MAX_REQUEST_BUDGET}
                      step="1"
                      value={budget}
                      onChange={(event) => setBudget(Number(event.target.value))}
                      className="w-full accent-[#5FA9FF]"
                    />
                    <input
                      aria-label="Max spend amount"
                      type="number"
                      min={MIN_USDC_AMOUNT}
                      max={MAX_REQUEST_BUDGET}
                      step="1"
                      value={budget}
                      onChange={(event) =>
                        setBudget(
                          Math.min(
                            MAX_REQUEST_BUDGET,
                            Math.max(MIN_USDC_AMOUNT, Number(event.target.value) || MIN_USDC_AMOUNT),
                          ),
                        )
                      }
                      className="mt-3 w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-semibold text-white outline-none focus:border-[#5FA9FF]/80"
                    />
                  </div>

                  <div>
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                      <SlidersHorizontal size={14} strokeWidth={2.25} />
                      Source types
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {SOURCE_KINDS.map((kind) => {
                        const active = enabledTypes.includes(kind);

                        return (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => toggleSourceKind(kind)}
                            className={`rounded-[8px] border px-3 py-2 text-xs font-bold transition ${
                              active
                                ? 'border-[#5FA9FF]/80 bg-[#5FA9FF]/16 text-white'
                                : 'border-white/10 bg-white/[0.03] text-white/45 hover:text-white'
                            }`}
                          >
                            {kind}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={routeRequest}
                    disabled={isRouting || Boolean(routeBlockReason)}
                    className="flex w-full items-center justify-center gap-2 rounded-[8px] bg-white px-4 py-3 text-sm font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF] disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <Play size={17} fill="currentColor" strokeWidth={2.25} />
                    {isRouting ? 'Routing' : routeBlockReason || 'Route request'}
                  </button>
                  <p className="text-xs font-medium leading-relaxed text-white/38">
                    Routing creates a quote. USDC is deducted only after wallet approval
                    on the receipt page.
                  </p>
                  {error && (
                    <p className="rounded-[8px] border border-[#F4845F]/35 bg-[#F4845F]/12 px-3 py-2 text-sm font-semibold text-[#F7B49D]">
                      {error}
                    </p>
                  )}
                </div>
              </section>

              <section className="rounded-[8px] border border-white/10 bg-gradient-to-br from-[#111] to-[#0d141b]">
                <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                  <div>
                    <p className="text-sm font-bold">Request outcome</p>
                    <p className="text-xs text-white/45">
                      Selected sources and payment summary for the current request.
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_300px]">
                  <div className="overflow-hidden rounded-[8px] border border-white/10 bg-black/18">
                    <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                      <div>
                        <p className="text-sm font-bold">Selected sources</p>
                        <p className="text-xs text-white/45">
                          Creator material chosen for the answer.
                        </p>
                      </div>
                      <div className="rounded-[8px] border border-[#5FBF7A]/30 bg-[#5FBF7A]/12 px-3 py-2 text-right text-[#8CE0A0]">
                        <p className="text-[10px] font-bold uppercase tracking-[0.14em]">
                          {activeReceipt?.paymentStatus === 'paid' ? 'paid' : 'quoted'}
                        </p>
                        <p className="text-sm font-extrabold">
                          {formatUsd(totalSpend)} USDC
                        </p>
                      </div>
                    </div>

                    <div className="divide-y divide-white/[0.06]">
                      {selectedSources.length === 0 ? (
                        <div className="px-4 py-12 text-center">
                          <p className="text-sm font-bold text-white/72">
                            {hasRegisteredSources
                              ? 'No sources selected yet'
                              : 'No creator sources registered yet'}
                          </p>
                          <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-relaxed text-white/42">
                            {hasRegisteredSources
                              ? 'Route a request to select matching creator sources for payment.'
                              : 'Add creator-owned material before routing a paid request.'}
                          </p>
                          {!hasRegisteredSources && (
                            <button
                              type="button"
                              onClick={onOpenCreator}
                              className="mt-4 inline-flex items-center gap-2 rounded-[8px] bg-white px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
                            >
                              Add creator source
                              <ExternalLink size={15} strokeWidth={2.25} />
                            </button>
                          )}
                        </div>
                      ) : (
                        selectedSources.map((source, index) => {
                          const Icon = sourceKindIcons[source.kind];

                          return (
                            <div
                              key={source.id}
                              className="grid gap-3 px-4 py-3 sm:grid-cols-[32px_1fr_auto] sm:items-center"
                            >
                              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-white/70">
                                <Icon size={17} strokeWidth={2.25} />
                              </div>
                              <div>
                                <button
                                  type="button"
                                  onClick={() => onOpenSource(source.id)}
                                  className="text-left font-semibold underline-offset-4 transition hover:text-[#9CCCFF] hover:underline"
                                >
                                  {source.title}
                                </button>
                                <p className="text-xs text-white/42">
                                  rank {source.rank ?? index + 1} · {source.kind}
                                </p>
                                <p className="mt-1 font-mono text-[11px] text-white/34">
                                  {shortFingerprint(source.fingerprint)}
                                </p>
                              </div>
                              <div className="text-left sm:text-right">
                                <p className="font-semibold">
                                  {formatUsd(source.price)} USDC
                                </p>
                                <p className="text-xs text-white/42">selected</p>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="rounded-[8px] border border-white/10 bg-black/18">
                    <div className="border-b border-white/10 px-4 py-3">
                      <p className="text-sm font-bold">Receipt</p>
                      <p className="text-xs text-white/45">
                        Created after a request is routed.
                      </p>
                    </div>
                    <div className="p-4">
                      <div className="mb-4 rounded-[8px] border border-[#5FA9FF]/35 bg-[#5FA9FF]/14 p-4">
                        <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#9CCCFF]">
                          total
                        </p>
                        <p className="text-3xl font-bold text-white">
                          {formatUsd(totalSpend)}
                        </p>
                        <p className="text-sm font-semibold text-white/50">USDC</p>
                      </div>
                      <div className="space-y-3 text-sm">
                        {[
                          ['Receipt', activeReceipt?.id.slice(0, 8) ?? 'Awaiting route'],
                          ['Sources', selectedSources.length.toString()],
                          [
                            'Wallet balance',
                            walletBalanceCheck.balance === null
                              ? walletBalanceCopy
                              : `${formatUsdcAtomic(walletBalanceCheck.balance)} USDC`,
                          ],
                          [
                            'Required',
                            walletBalanceCheck.required === null
                              ? `${formatUsd(totalSpend)} USDC`
                              : `${formatUsdcAtomic(walletBalanceCheck.required)} USDC`,
                          ],
                          ['Payment', 'USDC'],
                          [
                            'Status',
                            activeReceipt
                              ? formatStatus(activeReceipt.paymentStatus)
                              : 'Awaiting route',
                          ],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            className="flex items-center justify-between border-b border-white/[0.06] pb-3 last:border-0"
                          >
                            <span className="text-white/48">{label}</span>
                            <span className="font-semibold">{value}</span>
                          </div>
                        ))}
                      </div>
                      {activeReceipt && connectedWallet.address && (
                        <p
                          className={`mt-3 rounded-[8px] border px-3 py-2 text-xs font-semibold leading-relaxed ${
                            walletBalanceCheck.enough === false
                              ? 'border-[#F4845F]/35 bg-[#F4845F]/12 text-[#F7B49D]'
                              : walletBalanceCheck.enough === true
                                ? 'border-[#5FBF7A]/30 bg-[#5FBF7A]/10 text-[#8CE0A0]'
                                : 'border-white/10 bg-white/[0.035] text-white/45'
                          }`}
                        >
                          {walletBalanceCheck.checking
                            ? 'Checking wallet USDC balance...'
                            : walletBalanceCheck.enough === false
                              ? 'Wallet balance is below the quoted receipt amount.'
                              : walletBalanceCheck.enough === true
                                ? 'Wallet has enough USDC for this quoted receipt.'
                                : walletBalanceCheck.error || 'Wallet balance could not be checked.'}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          activeReceipt && onOpenReceipt(activeReceipt.id, activeReceipt)
                        }
                        disabled={!activeReceipt}
                        className="mt-4 w-full rounded-[8px] bg-white px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF] disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        {activeReceipt?.paymentStatus === 'paid'
                          ? 'Open paid receipt'
                          : 'Pay receipt'}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
            )}

            {activeTab === 'Sources' && (
              <section className="overflow-hidden rounded-[8px] border border-white/10 bg-[#111]/90">
                <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                  <div>
                    <p className="text-sm font-bold">Source discovery</p>
                    <p className="text-xs text-white/45">
                      Search registered creator sources before routing.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onOpenCreator}
                    className="flex items-center gap-2 rounded-[8px] bg-white px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
                  >
                    Add source
                    <ExternalLink size={15} strokeWidth={2.25} />
                  </button>
                </div>

                <div className="grid gap-2 border-b border-white/10 p-4 md:grid-cols-[minmax(0,1fr)_180px_160px]">
                  <input
                    value={sourceSearch}
                    onChange={(event) => setSourceSearch(event.target.value)}
                    placeholder="Search source title, text, or fingerprint"
                    className="min-w-0 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none placeholder:text-white/25 focus:border-[#5FA9FF]/80"
                  />
                  <select
                    value={sourceClassFilter}
                    onChange={(event) =>
                      setSourceClassFilter(event.target.value as SourceKind | 'All')
                    }
                    className="min-w-0 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-[#5FA9FF]/80"
                  >
                    <option>All</option>
                    {SOURCE_KINDS.map((kind) => (
                      <option key={kind}>{kind}</option>
                    ))}
                  </select>
                  <div className="rounded-[8px] border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm">
                    <span className="text-white/45">Max price </span>
                    <span className="font-bold">{formatUsd(budget)} USDC</span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                    <thead className="text-[11px] uppercase tracking-[0.14em] text-white/38">
                      <tr className="border-b border-white/10">
                        <th className="px-4 py-3 font-bold">Source</th>
                        <th className="px-4 py-3 font-bold">Class</th>
                        <th className="px-4 py-3 font-bold">Fingerprint</th>
                        <th className="px-4 py-3 font-bold">Payout wallet</th>
                        <th className="px-4 py-3 font-bold">Citation price</th>
                        <th className="px-4 py-3 font-bold">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {discoveredSources.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="px-4 py-12 text-center"
                          >
                            <p className="text-sm font-bold text-white/72">
                              {hasRegisteredSources
                                ? 'No sources match these filters'
                                : 'No creator sources registered yet'}
                            </p>
                            <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-relaxed text-white/42">
                              {hasRegisteredSources
                                ? 'Adjust the search, source type, or request budget to discover more material.'
                                : 'Creators need to publish articles, posts, transcripts, or notes before buyers can route paid requests.'}
                            </p>
                            {!hasRegisteredSources && (
                              <button
                                type="button"
                                onClick={onOpenCreator}
                                className="mt-4 inline-flex items-center gap-2 rounded-[8px] bg-white px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
                              >
                                Open creator portal
                                <ExternalLink size={15} strokeWidth={2.25} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ) : (
                        discoveredSources.map((source) => {
                          const Icon = sourceKindIcons[source.kind];

                          return (
                            <tr
                              key={source.id}
                              className="border-b border-white/[0.06] last:border-0"
                            >
                              <td className="px-4 py-3">
                                <div className="flex items-start gap-3">
                                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-white/[0.06] text-white/70">
                                    <Icon size={17} strokeWidth={2.25} />
                                  </div>
                                  <div className="min-w-0">
                                    <button
                                      type="button"
                                      onClick={() => onOpenSource(source.id)}
                                      className="text-left font-semibold text-white/90 underline-offset-4 transition hover:text-[#9CCCFF] hover:underline"
                                    >
                                      {source.title}
                                    </button>
                                    <p className="mt-1 max-w-[460px] truncate text-xs font-medium text-white/38">
                                      {source.content}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3 font-semibold text-white/62">
                                {source.kind}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-white/48">
                                {shortFingerprint(source.fingerprint)}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-white/48">
                                {maskAddress(source.wallet)}
                              </td>
                              <td className="px-4 py-3 font-semibold text-white/72">
                                {formatUsd(source.price)} USDC
                              </td>
                              <td className="px-4 py-3">
                                <span className="rounded-full border border-[#5FBF7A]/25 bg-[#5FBF7A]/10 px-2.5 py-1 text-xs font-bold text-[#8CE0A0]">
                                  Registered
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {activeTab === 'Payments' && (
              <section className="rounded-[8px] border border-white/10 bg-[#111]/90">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-sm font-bold">Settlement queue</p>
                  <p className="text-xs text-white/45">
                    Routed source purchases with selected creator material.
                  </p>
                </div>
                <div className="divide-y divide-white/[0.06]">
                  {payableReceipts.length === 0 ? (
                    <div className="px-4 py-12 text-center">
                      <p className="text-sm font-bold text-white/72">
                        No receipts ready for payment
                      </p>
                      <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-relaxed text-white/42">
                        {hasRegisteredSources
                          ? 'Route a request to create a receipt, then pay creators from the receipt page.'
                          : 'Start by adding creator sources, then route a request to create a payable receipt.'}
                      </p>
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {!hasRegisteredSources && (
                          <button
                            type="button"
                            onClick={onOpenCreator}
                            className="inline-flex items-center gap-2 rounded-[8px] bg-white px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
                          >
                            Add source
                            <ExternalLink size={15} strokeWidth={2.25} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setActiveTab('Requests')}
                          className="inline-flex items-center gap-2 rounded-[8px] border border-white/14 px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-white/72 transition hover:border-white/40 hover:text-white"
                        >
                          New request
                          <SendHorizontal size={15} strokeWidth={2.25} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    payableReceipts.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onOpenReceipt(item.id, item)}
                        className="grid w-full gap-3 px-4 py-3 text-left transition hover:bg-white/[0.035] sm:grid-cols-[1fr_120px_120px_auto] sm:items-center"
                      >
                        <div>
                          <p className="font-semibold text-white">{item.question}</p>
                        <p className="text-xs font-semibold text-white/38">
                          {new Date(item.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-white/64">
                          {item.sources.length} sources
                        </p>
                        <p className="text-sm font-semibold text-white/64">
                          {formatUsd(item.totalSpend)} USDC
                        </p>
                      <span className="rounded-full bg-[#5FA9FF]/14 px-2.5 py-1 text-xs font-bold text-[#9CCCFF]">
                          {formatStatus(item.paymentStatus)}
                      </span>
                      </button>
                    ))
                  )}
                </div>
              </section>
            )}

            {activeTab === 'Policy' && (
              <div className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4">
                  <p className="mb-2 text-sm font-bold">Spend policy</p>
                  <p className="max-w-sm text-sm leading-relaxed text-white/55">
                    Control how much an agent can spend and which creator source
                    classes are eligible for purchase.
                  </p>
                  <div className="mt-5 rounded-[8px] border border-white/10 bg-black/24 p-3">
                    <div className="mb-3 flex items-center justify-between text-sm">
                      <span className="font-bold">${formatUsd(budget, 2)} USDC</span>
                      <span className="text-white/42">max spend</span>
                    </div>
                    <input
                      aria-label="Policy max spend"
                      type="range"
                      min={MIN_USDC_AMOUNT}
                      max={MAX_REQUEST_BUDGET}
                      step="1"
                      value={budget}
                      onChange={(event) => setBudget(Number(event.target.value))}
                      className="w-full accent-[#5FA9FF]"
                    />
                    <input
                      aria-label="Policy max spend amount"
                      type="number"
                      min={MIN_USDC_AMOUNT}
                      max={MAX_REQUEST_BUDGET}
                      step="1"
                      value={budget}
                      onChange={(event) =>
                        setBudget(
                          Math.min(
                            MAX_REQUEST_BUDGET,
                            Math.max(MIN_USDC_AMOUNT, Number(event.target.value) || MIN_USDC_AMOUNT),
                          ),
                        )
                      }
                      className="mt-3 w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-semibold text-white outline-none focus:border-[#5FA9FF]/80"
                    />
                  </div>
                  <div className="mt-4">
                    <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                      Eligible classes
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {SOURCE_KINDS.map((kind) => {
                        const active = enabledTypes.includes(kind);

                        return (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => toggleSourceKind(kind)}
                            className={`rounded-[8px] border px-3 py-2 text-xs font-bold transition ${
                              active
                                ? 'border-[#5FA9FF]/80 bg-[#5FA9FF]/16 text-white'
                                : 'border-white/10 bg-white/[0.03] text-white/45 hover:text-white'
                            }`}
                          >
                            {kind}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>

                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4">
                  <p className="mb-2 text-sm font-bold">Routing policy</p>
                  <p className="max-w-2xl text-sm leading-relaxed text-white/55">
                    The router filters sources by class, scores source content against
                    the research objective, ranks relevant sources, and selects sources
                    until the request budget is exhausted.
                  </p>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    {[
                      ['Payment', 'USDC'],
                      ['Network', paymentReadiness?.network ?? 'Arc'],
                      [
                        'Payment status',
                        activeReceipt ? formatStatus(activeReceipt.paymentStatus) : 'Quoted',
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-[8px] border border-white/10 bg-white/[0.035] p-3"
                      >
                        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/38">
                          {label}
                        </p>
                        <p className="mt-2 font-bold">{value}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'Wallet' && (
              <div className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
                <section className="rounded-[8px] border border-white/10 bg-[#111]/90">
                  <div className="border-b border-white/10 px-4 py-3">
                    <p className="text-sm font-bold">Connected wallet</p>
                    <p className="text-xs text-white/45">
                      Your wallet pays creators when a receipt is settled.
                    </p>
                  </div>
                  <div className="space-y-3 p-4">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {!connectedWallet.address && (
                        <button
                          type="button"
                          onClick={connectWalletFromPage}
                          disabled={isConnectingWallet}
                          className="rounded-[8px] bg-white px-4 py-3 text-sm font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF] disabled:cursor-not-allowed disabled:opacity-45 sm:col-span-2"
                        >
                          {isConnectingWallet ? 'Connecting' : 'Connect wallet'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={disconnectWalletFromPage}
                        disabled={!connectedWallet.address}
                        className="rounded-[8px] border border-white/12 px-4 py-3 text-sm font-extrabold uppercase tracking-[0.12em] text-white/62 transition hover:border-[#F4845F]/45 hover:text-[#F7B49D] disabled:cursor-not-allowed disabled:opacity-35 sm:col-span-2"
                      >
                        Disconnect
                      </button>
                    </div>
                    {connectedWallet.address && (
                      <div className="rounded-[8px] border border-[#5FBF7A]/25 bg-[#5FBF7A]/10 p-3 text-sm">
                        <p className="font-bold text-[#8CE0A0]">Wallet connected</p>
                        <p className="mt-1 break-all font-mono text-xs text-white/55">
                          {maskAddress(connectedWallet.address)}
                        </p>
                      </div>
                    )}
                  </div>
                </section>

                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4">
                  <p className="mb-2 text-sm font-bold">Payment connection</p>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {readinessRequirements.map(([label, ready]) => (
                      <div
                        key={label}
                        className="flex items-center justify-between rounded-[8px] border border-white/10 px-3 py-2 text-sm"
                      >
                        <span className="text-white/55">{label}</span>
                        <span
                          className={
                            ready
                              ? 'font-bold text-[#8CE0A0]'
                              : 'font-bold text-white/38'
                          }
                        >
                          {ready ? 'Ready' : 'Action needed'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {safeConfig && (
                    <div className="mt-4 rounded-[8px] border border-white/10 bg-white/[0.025] p-3 text-sm">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="flex justify-between gap-3">
                          <span className="text-white/45">Network</span>
                          <span className="font-semibold">
                            {safeConfig.walletNetwork.chainName}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-white/45">Chain ID</span>
                          <span className="font-semibold">
                            {safeConfig.walletNetwork.chainId}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-white/45">RPC connection</span>
                          <span className="font-semibold">
                            {safeConfig.arcRpcUrl ? 'Ready' : 'Action needed'}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-white/45">Wallet guard</span>
                          <span className="font-semibold">Switches before payment</span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-white/46">
                    <span className="rounded-full border border-white/10 px-3 py-1.5">
                      {paymentReadiness?.ready ? 'Payments ready' : 'Payment setup needed'}
                    </span>
                  </div>
                </section>

                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4 xl:col-span-2">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-bold">Testnet funds</p>
                      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/55">
                        Claim testnet USDC for Arc gas and creator payments, then
                        return here and connect the funded wallet.
                      </p>
                    </div>
                    {connectedWallet.address && (
                      <p className="rounded-[8px] border border-white/10 bg-white/[0.025] px-3 py-2 font-mono text-xs font-semibold text-white/55">
                        {maskAddress(connectedWallet.address)}
                      </p>
                    )}
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {safeConfig?.faucetUrls.usdc || safeConfig?.faucetUrls.arc ? (
                      <a
                        href={safeConfig.faucetUrls.usdc || safeConfig.faucetUrls.arc || '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-center gap-2 rounded-[8px] bg-white px-4 py-3 text-sm font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
                      >
                        Claim testnet USDC
                        <ExternalLink size={16} strokeWidth={2.25} />
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled
                        className="rounded-[8px] border border-white/10 px-4 py-3 text-sm font-extrabold uppercase tracking-[0.12em] text-white/30"
                      >
                        Claim testnet USDC
                      </button>
                    )}
                    <div className="rounded-[8px] border border-white/10 bg-white/[0.025] px-4 py-3 text-sm font-semibold leading-relaxed text-white/55">
                      Arc uses USDC for transaction fees and creator payouts.
                    </div>
                  </div>
                  {(!safeConfig?.faucetUrls.arc || !safeConfig?.faucetUrls.usdc) && (
                    <p className="mt-3 text-xs font-medium leading-relaxed text-white/38">
                      Faucet links are configured by the SourcePay operator for the current
                      Arc testnet event.
                    </p>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function CreatorPage({
  onBack,
  onOpenSource,
  connectedWallet,
  onConnectWallet,
  onDisconnectWallet,
  isConnectingWallet,
}: {
  onBack: () => void;
  onOpenSource: (id: string) => void;
  connectedWallet: ConnectedWallet;
  onConnectWallet: () => Promise<string | null>;
  onDisconnectWallet: () => Promise<void>;
  isConnectingWallet: boolean;
}) {
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [draft, setDraft] = useState<SourceDraft>({
    title: '',
    url: '',
    kind: 'Article',
    wallet: '',
    price: DEFAULT_SOURCE_PRICE,
    content: '',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [isLoadingEarnings, setIsLoadingEarnings] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<SourceDraft>({
    title: '',
    url: '',
    kind: 'Article',
    wallet: '',
    price: DEFAULT_SOURCE_PRICE,
    content: '',
  });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const creatorSources = sources.filter(
    (source) =>
      draft.wallet.trim() &&
      source.wallet.toLowerCase() === draft.wallet.trim().toLowerCase(),
  );

  useEffect(() => {
    if (!connectedWallet.address) return;

    setDraft((current) =>
      current.wallet.trim() ? current : { ...current, wallet: connectedWallet.address ?? '' },
    );
  }, [connectedWallet.address]);

  useEffect(() => {
    let ignore = false;

    requestJson<{ sources: RegistrySource[] }>('/api/sources')
      .then((payload) => {
        if (!ignore) setSources(payload.sources);
      })
      .catch((requestError: Error) => {
        if (!ignore) setError(requestError.message);
      });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    const wallet = draft.wallet.trim();
    let ignore = false;

    if (!wallet) {
      setEarnings(null);
      return () => {
        ignore = true;
      };
    }

    setIsLoadingEarnings(true);
    requestJson<{ earnings: CreatorEarnings }>(
      `/api/creator-earnings?wallet=${encodeURIComponent(wallet)}`,
    )
      .then((payload) => {
        if (!ignore) setEarnings(payload.earnings);
      })
      .catch((requestError: Error) => {
        if (!ignore && wallet.length >= 42) setError(requestError.message);
      })
      .finally(() => {
        if (!ignore) setIsLoadingEarnings(false);
      });

    return () => {
      ignore = true;
    };
  }, [draft.wallet]);

  const prepareSource = async () => {
    const material = draft.url.trim() || draft.content.trim() || draft.title.trim();
    if (!material) {
      setError('Paste source material or enter a source URL first.');
      setNotice('');
      return;
    }

    setIsPreparing(true);
    setError('');
    setNotice('');

    try {
      const payload = await requestJson<{ preview: SourcePreview }>(
        '/api/source-preview',
        {
          method: 'POST',
          body: JSON.stringify({ material }),
        },
      );

      setDraft((current) => ({
        ...current,
        title: current.title.trim() ? current.title : payload.preview.title,
        url: current.url.trim() || payload.preview.url || '',
        content: payload.preview.content,
      }));
      setNotice('Source prepared. Review it before registering.');
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsPreparing(false);
    }
  };

  const registerSource = async () => {
    const title = draft.title.trim();
    const wallet = draft.wallet.trim();
    const content = draft.content.trim();
    const price = Number(draft.price);

    if (!title || !wallet || !content || !Number.isFinite(price) || price < MIN_USDC_AMOUNT) {
      setError('Complete every field and set a citation price of at least 1 USDC.');
      setNotice('');
      return;
    }

    setIsSaving(true);
    setError('');
    setNotice('');

    try {
      const ownership = await signSourceOwnership({
        title,
        kind: draft.kind,
        wallet,
        price,
        content,
      });
      const payload = await requestJson<{ source: RegistrySource }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          title,
          kind: draft.kind,
          wallet,
          price,
          content,
          ownerWallet: ownership.ownerWallet,
          ownershipSignature: ownership.ownershipSignature,
        }),
      });

      setSources((current) => [payload.source, ...current]);
      setDraft((current) => ({
        ...current,
        title: '',
        content: '',
      }));
      setNotice('Source registered for paid routing.');
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const beginEditSource = (source: RegistrySource) => {
    setEditingSourceId(source.id);
    setEditDraft({
      title: source.title,
      url: '',
      kind: source.kind,
      wallet: source.wallet,
      price: String(source.price),
      content: source.content,
    });
    setNotice('');
    setError('');
  };

  const cancelEditSource = () => {
    setEditingSourceId(null);
    setEditDraft({
      title: '',
      url: '',
      kind: 'Article',
      wallet: '',
      price: DEFAULT_SOURCE_PRICE,
      content: '',
    });
  };

  const saveEditedSource = async () => {
    if (!editingSourceId) return;

    const title = editDraft.title.trim();
    const wallet = editDraft.wallet.trim();
    const content = editDraft.content.trim();
    const price = Number(editDraft.price);

    if (!title || !wallet || !content || !Number.isFinite(price) || price < MIN_USDC_AMOUNT) {
      setError('Complete every field and set a citation price of at least 1 USDC.');
      setNotice('');
      return;
    }

    setIsSaving(true);
    setError('');
    setNotice('');

    try {
      const existing = sources.find((source) => source.id === editingSourceId);
      const sourceChanged =
        !existing ||
        existing.title !== title ||
        existing.kind !== editDraft.kind ||
        existing.wallet.toLowerCase() !== wallet.toLowerCase() ||
        Number(existing.price) !== price ||
        existing.content !== content;
      const ownership =
        sourceChanged || !existing?.ownershipVerified
          ? await signSourceOwnership({
              title,
              kind: editDraft.kind,
              wallet,
              price,
              content,
            })
          : null;
      const payload = await requestJson<{ source: RegistrySource }>(
        `/api/sources/${editingSourceId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            title,
            kind: editDraft.kind,
            wallet,
            price,
            content,
            ownerWallet: ownership?.ownerWallet,
            ownershipSignature: ownership?.ownershipSignature,
          }),
        },
      );

      setSources((current) =>
        current.map((source) =>
          source.id === payload.source.id ? payload.source : source,
        ),
      );
      cancelEditSource();
      setNotice('Source updated.');
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const archiveSource = async (source: RegistrySource) => {
    setIsSaving(true);
    setError('');
    setNotice('');

    try {
      const archiveProof = await signSourceArchive(source);
      await requestJson<{ ok: true }>(`/api/sources/${source.id}`, {
        method: 'DELETE',
        body: JSON.stringify(archiveProof),
      });
      setSources((current) => current.filter((item) => item.id !== source.id));
      if (editingSourceId === source.id) cancelEditSource();
      setNotice('Source archived.');
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const signSourceArchive = async (source: RegistrySource) => {
    const provider = getEthereumProvider();
    if (!provider) {
      throw new Error('Connect the payout wallet before archiving this source.');
    }

    let signer = connectedWallet.address;
    if (!signer) {
      signer = await onConnectWallet();
    } else {
      await ensureArcNetwork(provider);
    }
    if (!signer) {
      throw new Error('Connect the payout wallet before archiving this source.');
    }
    if (signer.toLowerCase() !== source.wallet.toLowerCase()) {
      throw new Error('Only the payout wallet can archive this source.');
    }

    const message = await buildSourceArchiveMessage(source);
    const signature = await provider.request({
      method: 'personal_sign',
      params: [message, signer],
    });

    return {
      ownerWallet: signer,
      archiveSignature: String(signature),
    };
  };

  const connectPayoutWallet = async () => {
    setError('');
    setNotice('');

    try {
      const address = await onConnectWallet();
      if (address) {
        setDraft((current) => ({ ...current, wallet: address }));
        setNotice('Payout wallet connected.');
      }
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  const signSourceOwnership = async (source: {
    title: string;
    kind: SourceKind;
    wallet: string;
    price: number;
    content: string;
  }) => {
    const provider = getEthereumProvider();
    if (!provider) {
      throw new Error('Connect the payout wallet before registering a source.');
    }

    let signer = connectedWallet.address;
    if (!signer) {
      signer = await onConnectWallet();
    } else {
      await ensureArcNetwork(provider);
    }
    if (!signer) {
      throw new Error('Connect the payout wallet before registering a source.');
    }
    if (signer.toLowerCase() !== source.wallet.toLowerCase()) {
      throw new Error('The connected wallet must match the payout wallet.');
    }

    const message = await buildSourceOwnershipMessage(source);
    const signature = await provider.request({
      method: 'personal_sign',
      params: [message, signer],
    });

    return {
      ownerWallet: signer,
      ownershipSignature: String(signature),
    };
  };

  const disconnectPayoutWallet = async () => {
    setError('');
    setNotice('');

    try {
      const disconnectedAddress = connectedWallet.address;
      await onDisconnectWallet();
      setDraft((current) =>
        disconnectedAddress && current.wallet === disconnectedAddress
          ? { ...current, wallet: '' }
          : current,
      );
      setNotice('Wallet disconnected from SourcePay.');
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  return (
    <section
      className="min-h-screen px-3 py-3 text-white sm:px-5 sm:py-5"
      style={{
        background:
          'radial-gradient(circle at 12% 12%, rgba(95,169,255,0.24), transparent 31%), radial-gradient(circle at 88% 10%, rgba(95,191,122,0.18), transparent 26%), radial-gradient(circle at 78% 86%, rgba(244,132,95,0.16), transparent 28%), linear-gradient(135deg, #071018 0%, #0f1112 45%, #17100e 100%)',
      }}
    >
      <div className="mx-auto flex w-full max-w-[1280px] flex-col overflow-x-auto rounded-[8px] border border-white/12 bg-[#0b0e11]/88 shadow-2xl shadow-black/45 backdrop-blur-xl">
        <header className="flex min-h-16 flex-col items-stretch justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/5">
              <Database size={20} strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-sm font-bold">Creator portal</p>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">
                source registration
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 rounded-full border border-white/14 px-4 py-2 text-sm font-bold text-white/72 transition hover:border-white/40 hover:text-white"
          >
            <ArrowLeft size={17} strokeWidth={2.25} />
            Dashboard
          </button>
        </header>

        <div className="grid gap-4 p-3 sm:p-5 xl:grid-cols-[420px_minmax(0,1fr)]">
          <section className="rounded-[8px] border border-white/10 bg-[#111]/90">
            <div className="border-b border-white/10 px-4 py-3">
              <p className="text-sm font-bold">Register source</p>
              <p className="text-xs text-white/45">
                Add material an agent can cite and pay for.
              </p>
            </div>

            <div className="space-y-3 p-4">
              <label className="block">
                <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                  Source URL
                </span>
                <input
                  value={draft.url}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, url: event.target.value }))
                  }
                  placeholder="https://x.com/creator/status/..."
                  className="w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none placeholder:text-white/25 focus:border-[#5FA9FF]/80"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                  Source title
                </span>
                <input
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="Creator post title or article headline"
                  className="w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none placeholder:text-white/25 focus:border-[#5FA9FF]/80"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                <label className="block">
                  <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                    Source class
                  </span>
                  <select
                    value={draft.kind}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        kind: event.target.value as SourceKind,
                      }))
                    }
                    className="w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-[#5FA9FF]/80"
                  >
                    {SOURCE_KINDS.map((kind) => (
                      <option key={kind}>{kind}</option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                    USDC cite
                  </span>
                  <input
                    value={draft.price}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, price: event.target.value }))
                    }
                    inputMode="decimal"
                    type="number"
                    min={MIN_USDC_AMOUNT}
                    step="1"
                    className="w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none placeholder:text-white/25 focus:border-[#5FA9FF]/80"
                  />
                </label>
              </div>

              <label className="block">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                    Payout wallet
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={connectPayoutWallet}
                      disabled={isConnectingWallet}
                      className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1 text-[11px] font-bold text-white/62 transition hover:border-white/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <Wallet size={13} strokeWidth={2.25} />
                      {isConnectingWallet
                        ? 'Connecting'
                        : connectedWallet.address
                          ? 'Use connected'
                          : 'Connect'}
                    </button>
                    {connectedWallet.address && (
                      <button
                        type="button"
                        onClick={disconnectPayoutWallet}
                        className="rounded-full border border-white/12 px-3 py-1 text-[11px] font-bold text-white/50 transition hover:border-white/35 hover:text-white"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
                <input
                  value={draft.wallet}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, wallet: event.target.value }))
                  }
                  placeholder="0x..."
                  className="w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-sm font-medium text-white outline-none placeholder:text-white/25 focus:border-[#5FA9FF]/80"
                />
                {draft.wallet.trim() && (
                  <p className="mt-2 text-xs font-semibold text-white/42">
                    Creator payouts will be sent to {maskAddress(draft.wallet.trim())}.
                  </p>
                )}
              </label>

              <label className="block">
                <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                  Source material
                </span>
                <textarea
                  value={draft.content}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, content: event.target.value }))
                  }
                  placeholder="Paste article text, a social post, transcript excerpt, or notes. If you entered a URL above, Prepare source will import readable text."
                  className="min-h-36 w-full resize-none rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium leading-relaxed text-white outline-none placeholder:text-white/25 focus:border-[#5FA9FF]/80"
                />
              </label>

              <button
                type="button"
                onClick={prepareSource}
                disabled={isPreparing}
                className="flex w-full items-center justify-center gap-2 rounded-[8px] border border-[#5FA9FF]/35 bg-[#5FA9FF]/12 px-4 py-3 text-sm font-extrabold uppercase tracking-[0.12em] text-[#9CCCFF] transition hover:border-[#5FA9FF]/65 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <FileText size={17} strokeWidth={2.25} />
                {isPreparing ? 'Preparing source' : 'Prepare source'}
              </button>

              <button
                type="button"
                onClick={registerSource}
                disabled={isSaving}
                className="flex w-full items-center justify-center gap-2 rounded-[8px] bg-white px-4 py-3 text-sm font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
              >
                <CheckCircle2 size={17} strokeWidth={2.25} />
                {isSaving ? 'Registering' : 'Register source'}
              </button>

              {notice && (
                <p className="rounded-[8px] border border-[#5FBF7A]/30 bg-[#5FBF7A]/10 px-3 py-2 text-sm font-semibold text-[#8CE0A0]">
                  {notice}
                </p>
              )}
              {error && (
                <p className="rounded-[8px] border border-[#F4845F]/35 bg-[#F4845F]/12 px-3 py-2 text-sm font-semibold text-[#F7B49D]">
                  {error}
                </p>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-[8px] border border-white/10 bg-[#111]/90">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div>
                <p className="text-sm font-bold">Registered material</p>
                <p className="text-xs text-white/45">
                  Inventory available to the routing engine.
                </p>
              </div>
              <div className="rounded-[8px] border border-[#5FA9FF]/25 bg-[#5FA9FF]/10 px-3 py-2 text-right">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#9CCCFF]">
                  sources
                </p>
                <p className="text-sm font-extrabold">{sources.length}</p>
              </div>
            </div>

            <div className="grid gap-3 border-b border-white/10 p-4 sm:grid-cols-3">
              {[
                ['Articles', sources.filter((source) => source.kind === 'Article').length],
                [
                  'Social posts',
                  sources.filter((source) => source.kind === 'Social post').length,
                ],
                [
                  'Transcripts',
                  sources.filter((source) => source.kind === 'Transcript').length,
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-[8px] border border-white/10 bg-white/[0.035] p-3"
                >
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/38">
                    {label}
                  </p>
                  <p className="mt-2 text-xl font-bold">{value}</p>
                </div>
              ))}
            </div>

            <div className="divide-y divide-white/[0.06]">
              {sources.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm font-medium text-white/42">
                  Register the first creator-owned source to make it available for routing.
                </div>
              ) : (
                sources.map((source) => {
                  const Icon = sourceKindIcons[source.kind];
                  const belongsToDraftWallet =
                    creatorSources.length > 0 &&
                    source.wallet.toLowerCase() === draft.wallet.trim().toLowerCase();
                  const isConnectedOwner =
                    Boolean(connectedWallet.address) &&
                    connectedWallet.address?.toLowerCase() === source.wallet.toLowerCase();
                  const isEditing = editingSourceId === source.id;

                  return (
                    <div
                      key={source.id}
                      className="grid gap-3 px-4 py-4 sm:grid-cols-[36px_1fr_auto] sm:items-start"
                    >
                      <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-white/[0.06] text-white/70">
                        <Icon size={18} strokeWidth={2.25} />
                      </div>
                      {isEditing ? (
                        <div className="min-w-0 sm:col-span-2">
                          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_150px_120px]">
                            <input
                              value={editDraft.title}
                              onChange={(event) =>
                                setEditDraft((current) => ({
                                  ...current,
                                  title: event.target.value,
                                }))
                              }
                              className="min-w-0 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-[#5FA9FF]/80"
                            />
                            <select
                              value={editDraft.kind}
                              onChange={(event) =>
                                setEditDraft((current) => ({
                                  ...current,
                                  kind: event.target.value as SourceKind,
                                }))
                              }
                              className="min-w-0 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-[#5FA9FF]/80"
                            >
                              {SOURCE_KINDS.map((kind) => (
                                <option key={kind}>{kind}</option>
                              ))}
                            </select>
                            <input
                              value={editDraft.price}
                              onChange={(event) =>
                                setEditDraft((current) => ({
                                  ...current,
                                  price: event.target.value,
                                }))
                              }
                              inputMode="decimal"
                              type="number"
                              min={MIN_USDC_AMOUNT}
                              step="1"
                              className="min-w-0 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-[#5FA9FF]/80"
                            />
                            <input
                              value={editDraft.wallet}
                              onChange={(event) =>
                                setEditDraft((current) => ({
                                  ...current,
                                  wallet: event.target.value,
                                }))
                              }
                              className="min-w-0 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-sm font-medium text-white outline-none focus:border-[#5FA9FF]/80 md:col-span-3"
                            />
                            <textarea
                              value={editDraft.content}
                              onChange={(event) =>
                                setEditDraft((current) => ({
                                  ...current,
                                  content: event.target.value,
                                }))
                              }
                              className="min-h-24 min-w-0 resize-none rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-[#5FA9FF]/80 md:col-span-3"
                            />
                          </div>
                          <div className="mt-3 flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              onClick={cancelEditSource}
                              className="rounded-[8px] border border-white/12 px-3 py-2 text-xs font-bold uppercase tracking-[0.12em] text-white/62 transition hover:border-white/35 hover:text-white"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={saveEditedSource}
                              disabled={isSaving}
                              className="rounded-[8px] bg-white px-3 py-2 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => onOpenSource(source.id)}
                                className="text-left font-semibold text-white/90 underline-offset-4 transition hover:text-[#9CCCFF] hover:underline"
                              >
                                {source.title}
                              </button>
                              {belongsToDraftWallet && (
                                <span className="rounded-full border border-[#5FBF7A]/25 bg-[#5FBF7A]/10 px-2 py-0.5 text-[11px] font-bold text-[#8CE0A0]">
                                  Your wallet
                                </span>
                              )}
                              {source.ownershipVerified && (
                                <span className="rounded-full border border-[#5FA9FF]/25 bg-[#5FA9FF]/10 px-2 py-0.5 text-[11px] font-bold text-[#9CCCFF]">
                                  Wallet signed
                                </span>
                              )}
                            </div>
                        <p className="mt-1 max-w-3xl truncate text-xs font-medium text-white/38">
                          {source.content}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2 font-mono text-xs text-white/42">
                          <span>{maskAddress(source.wallet)}</span>
                          <span>{shortFingerprint(source.fingerprint)}</span>
                        </div>
                          </div>
                          <div className="text-left sm:text-right">
                            <p className="text-sm font-bold text-white/78">
                              {formatUsd(source.price)} USDC
                            </p>
                            <p className="text-xs font-semibold text-white/42">
                              {source.kind}
                            </p>
                            {isConnectedOwner ? (
                              <div className="mt-3 flex gap-2 sm:justify-end">
                                <button
                                  type="button"
                                  aria-label={`Edit ${source.title}`}
                                  onClick={() => beginEditSource(source)}
                                  className="rounded-[8px] border border-white/10 p-2 text-white/55 transition hover:border-white/35 hover:text-white"
                                >
                                  <Pencil size={15} strokeWidth={2.25} />
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Archive ${source.title}`}
                                  onClick={() => archiveSource(source)}
                                  className="rounded-[8px] border border-white/10 p-2 text-white/55 transition hover:border-[#F4845F]/50 hover:text-[#F7B49D]"
                                >
                                  <Trash2 size={15} strokeWidth={2.25} />
                                </button>
                              </div>
                            ) : (
                              <p className="mt-3 text-xs font-semibold text-white/34">
                                View only
                              </p>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-[8px] border border-white/10 bg-[#111]/90 xl:col-span-2">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div>
                <p className="text-sm font-bold">Earnings</p>
                <p className="text-xs text-white/45">
                  Citation activity for the payout wallet in the registration form.
                </p>
              </div>
              <div className="rounded-[8px] border border-white/10 bg-white/[0.035] px-3 py-2 text-right">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/38">
                  wallet
                </p>
                <p className="font-mono text-xs font-bold text-white/72">
                  {earnings?.wallet || 'Enter wallet'}
                </p>
              </div>
            </div>

            {!draft.wallet.trim() ? (
              <div className="px-4 py-10 text-center text-sm font-medium text-white/42">
                Enter a payout wallet to view citation earnings.
              </div>
            ) : isLoadingEarnings ? (
              <div className="px-4 py-10 text-center text-sm font-medium text-white/42">
                Loading earnings.
              </div>
            ) : (
              <>
                <div className="grid gap-3 border-b border-white/10 p-4 sm:grid-cols-3">
                  {[
                    ['Quoted earnings', `${formatUsd(earnings?.totals.quotedAmount ?? 0)} USDC`],
                    ['Citations', String(earnings?.totals.citations ?? 0)],
                    ['Cited sources', String(earnings?.totals.sources ?? 0)],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-[8px] border border-white/10 bg-white/[0.035] p-3"
                    >
                      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/38">
                        {label}
                      </p>
                      <p className="mt-2 text-xl font-bold">{value}</p>
                    </div>
                  ))}
                </div>

                <div className="divide-y divide-white/[0.06]">
                  {!earnings || earnings.receipts.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm font-medium text-white/42">
                      No routed citations for this wallet yet.
                    </div>
                  ) : (
                    earnings.receipts.map((item) => (
                      <div
                        key={`${item.receiptId}-${item.source.id}-${item.rank}`}
                        className="grid gap-3 px-4 py-4 md:grid-cols-[1fr_160px_120px] md:items-center"
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-white/90">{item.source.title}</p>
                          <p className="mt-1 truncate text-xs font-medium text-white/38">
                            {item.question}
                          </p>
                          <p className="mt-2 font-mono text-[11px] text-white/34">
                            {shortFingerprint(item.source.fingerprint)}
                          </p>
                        </div>
                        <p className="text-sm font-semibold text-white/64">
                          {formatStatus(item.paymentStatus)}
                        </p>
                        <p className="text-left text-sm font-bold text-white/78 md:text-right">
                          {formatUsd(item.quotedAmount)} USDC
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

function SourcePage({
  id,
  onBack,
  onOpenReceipt,
}: {
  id: string;
  onBack: () => void;
  onOpenReceipt: (id: string, receipt?: Receipt) => void;
}) {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    setIsLoading(true);
    setError('');
    requestJson<SourceDetail>(`/api/sources/${id}`)
      .then((payload) => {
        if (!ignore) setDetail(payload);
      })
      .catch((requestError: Error) => {
        if (!ignore) setError(requestError.message);
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [id]);

  const source = detail?.source;
  const Icon = source ? sourceKindIcons[source.kind] : FileText;

  return (
    <section
      className="min-h-screen px-3 py-3 text-white sm:px-5 sm:py-5"
      style={{
        background:
          'radial-gradient(circle at 12% 12%, rgba(95,169,255,0.24), transparent 31%), radial-gradient(circle at 86% 16%, rgba(244,132,95,0.18), transparent 28%), linear-gradient(135deg, #071018 0%, #0f1112 46%, #17100e 100%)',
      }}
    >
      <div className="mx-auto flex w-full max-w-[1180px] flex-col overflow-x-auto rounded-[8px] border border-white/12 bg-[#0b0e11]/88 shadow-2xl shadow-black/45 backdrop-blur-xl">
        <header className="flex min-h-16 flex-col items-stretch justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/5">
              <Icon size={20} strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-sm font-bold">Source detail</p>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">
                registered material
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 rounded-full border border-white/14 px-4 py-2 text-sm font-bold text-white/72 transition hover:border-white/40 hover:text-white"
          >
            <ArrowLeft size={17} strokeWidth={2.25} />
            Dashboard
          </button>
        </header>

        {isLoading ? (
          <div className="px-4 py-16 text-center text-sm font-semibold text-white/42">
            Loading source.
          </div>
        ) : error || !detail || !source ? (
          <div className="px-4 py-16 text-center">
            <p className="text-lg font-bold">Source unavailable</p>
            <p className="mt-2 text-sm font-medium text-white/45">
              {error || 'The source could not be found.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 p-3 sm:p-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <section className="overflow-hidden rounded-[8px] border border-white/10 bg-[#111]/90">
              <div className="border-b border-white/10 px-4 py-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-[#5FA9FF]/25 bg-[#5FA9FF]/10 px-2.5 py-1 text-xs font-bold text-[#9CCCFF]">
                    {source.kind}
                  </span>
                  <span className="rounded-full border border-[#5FBF7A]/25 bg-[#5FBF7A]/10 px-2.5 py-1 text-xs font-bold text-[#8CE0A0]">
                    Registered
                  </span>
                  {source.ownershipVerified && (
                    <span className="rounded-full border border-[#5FA9FF]/25 bg-[#5FA9FF]/10 px-2.5 py-1 text-xs font-bold text-[#9CCCFF]">
                      Wallet signed
                    </span>
                  )}
                </div>
                <h1 className="max-w-3xl text-2xl font-bold leading-tight sm:text-3xl">
                  {source.title}
                </h1>
              </div>

              <div className="grid gap-3 border-b border-white/10 p-4 md:grid-cols-4">
                {[
                  ['Citation price', `${formatUsd(source.price)} USDC`],
                  ['Payout wallet', maskAddress(source.wallet)],
                  ['Fingerprint', shortFingerprint(source.fingerprint)],
                  ['Ownership', source.ownershipVerified ? 'Wallet signed' : 'Unsigned'],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-[8px] border border-white/10 bg-white/[0.035] p-3"
                  >
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/38">
                      {label}
                    </p>
                    <p className="mt-2 break-words font-semibold text-white/82">
                      {value}
                    </p>
                  </div>
                ))}
              </div>

              <div className="p-4">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                  Source text
                </p>
                <div className="max-h-[360px] overflow-auto rounded-[8px] border border-white/10 bg-black/24 p-4 text-sm font-medium leading-7 text-white/68">
                  {source.content}
                </div>
              </div>
            </section>

            <aside className="space-y-4">
              <section className="rounded-[8px] border border-white/10 bg-[#111]/90">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-sm font-bold">Citation totals</p>
                  <p className="text-xs text-white/45">
                    Calculated from routed receipts.
                  </p>
                </div>
                <div className="grid gap-3 p-4">
                  {[
                    ['Quoted earnings', `${formatUsd(detail.totals.quotedAmount)} USDC`],
                    ['Citations', String(detail.totals.citations)],
                    ['Receipts', String(detail.totals.receipts)],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-[8px] border border-white/10 bg-white/[0.035] p-3"
                    >
                      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/38">
                        {label}
                      </p>
                      <p className="mt-2 text-xl font-bold">{value}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="overflow-hidden rounded-[8px] border border-white/10 bg-[#111]/90">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-sm font-bold">Receipt history</p>
                  <p className="text-xs text-white/45">
                    Routes that selected this source.
                  </p>
                </div>
                <div className="divide-y divide-white/[0.06]">
                  {detail.citations.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm font-medium text-white/42">
                      No routed citations for this source yet.
                    </div>
                  ) : (
                    detail.citations.map((citation) => (
                      <button
                        key={`${citation.receiptId}-${citation.rank}`}
                        type="button"
                        onClick={() => onOpenReceipt(citation.receiptId)}
                        className="block w-full px-4 py-4 text-left transition hover:bg-white/[0.035]"
                      >
                        <p className="line-clamp-2 text-sm font-semibold text-white/88">
                          {citation.question}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-white/45">
                          <span>{formatStatus(citation.paymentStatus)}</span>
                          <span>{formatUsd(citation.quotedAmount)} USDC</span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </section>
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}

function ReceiptPage({
  id,
  initialReceipt,
  onBack,
  connectedWallet,
  onConnectWallet,
  isConnectingWallet,
}: {
  id: string;
  initialReceipt: Receipt | null;
  onBack: () => void;
  connectedWallet: ConnectedWallet;
  onConnectWallet: () => Promise<string | null>;
  isConnectingWallet: boolean;
}) {
  const [receipt, setReceipt] = useState<Receipt | null>(initialReceipt);
  const [loadError, setLoadError] = useState('');
  const [paymentNotice, setPaymentNotice] = useState('');
  const [receiptNotice, setReceiptNotice] = useState('');
  const [verificationNotice, setVerificationNotice] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [walletBalanceCheck, setWalletBalanceCheck] = useState<WalletBalanceCheck>({
    checking: false,
    balance: null,
    required: null,
    enough: null,
    error: '',
  });

  useEffect(() => {
    let ignore = false;
    const timeoutId = window.setTimeout(() => {
      if (!ignore && !initialReceipt) {
        setLoadError('Receipt is taking too long to load. Refresh the page or return to Requests and open the latest receipt.');
      }
    }, 18_000);
    setReceipt(initialReceipt);
    setLoadError('');
    setPaymentNotice('');
    setReceiptNotice('');
    setVerificationNotice('');

    requestJson<{ receipt: Receipt }>(`/api/receipts/${id}`)
      .then((payload) => {
        if (!ignore) {
          window.clearTimeout(timeoutId);
          setReceipt(payload.receipt);
        }
      })
      .catch((requestError: Error) => {
        if (!ignore) {
          window.clearTimeout(timeoutId);
          if (!initialReceipt) {
            setLoadError(requestError.message);
          } else {
            setReceiptNotice(requestError.message);
          }
        }
      });

    return () => {
      ignore = true;
      window.clearTimeout(timeoutId);
    };
  }, [id, initialReceipt]);

  useEffect(() => {
    let ignore = false;
    const requiredFallback = receipt
      ? BigInt(Math.round(receipt.totalSpend * 1_000_000))
      : null;

    if (!receipt || !connectedWallet.address || receipt.sources.length === 0) {
      setWalletBalanceCheck({
        checking: false,
        balance: null,
        required: requiredFallback,
        enough: null,
        error: '',
      });
      return () => {
        ignore = true;
      };
    }

    const provider = getEthereumProvider();
    if (!provider) {
      setWalletBalanceCheck({
        checking: false,
        balance: null,
        required: requiredFallback,
        enough: null,
        error: 'Browser wallet unavailable.',
      });
      return () => {
        ignore = true;
      };
    }

    setWalletBalanceCheck((current) => ({
      ...current,
      checking: true,
      required: requiredFallback,
      error: '',
    }));

    ensureArcNetwork(provider)
      .then(() =>
        readUsdcBalance({
          provider,
          receiptId: receipt.id,
          wallet: connectedWallet.address as string,
        }),
      )
      .then((result) => {
        if (ignore) return;
        setWalletBalanceCheck({
          checking: false,
          balance: result.balance,
          required: result.required,
          enough: result.enough,
          error: '',
        });
      })
      .catch((requestError: Error) => {
        if (ignore) return;
        setWalletBalanceCheck({
          checking: false,
          balance: null,
          required: requiredFallback,
          enough: null,
          error: requestError.message,
        });
      });

    return () => {
      ignore = true;
    };
  }, [receipt?.id, receipt?.totalSpend, connectedWallet.address]);

  const attemptPayment = async () => {
    setIsPaying(true);
    setPaymentNotice('');

    try {
      let payer = connectedWallet.address;
      if (!payer) {
        payer = await onConnectWallet();
      }
      if (!payer) {
        setPaymentNotice('Connect your wallet before settling this receipt.');
        return;
      }
      if (walletBalanceCheck.enough === false) {
        setPaymentNotice('Wallet balance is below the quoted receipt amount.');
        return;
      }

      const provider = getEthereumProvider();
      if (!provider) {
        setPaymentNotice('A browser wallet is required to settle this receipt.');
        return;
      }
      await ensureArcNetwork(provider);

      const requirementsPayload = await requestJson<ReceiptPaymentRequirements>(
        `/api/receipts/${id}/payment-requirements`,
      );
      const payments = [];

      for (const item of requirementsPayload.requirements) {
        if (!item.typedData) {
          setPaymentNotice('This receipt could not be prepared for payment.');
          return;
        }

        const signature = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [payer, JSON.stringify(item.typedData)],
        });

        payments.push({
          sourceId: item.sourceId,
          authorization: item.typedData.message,
          signature: String(signature),
        });
      }

      const response = await requestJsonWithStatus<{
        payment: { status: string; reason: string };
        receipt: Receipt;
      }>(`/api/receipts/${id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ payments }),
      });

      setReceipt(response.payload.receipt);
      setPaymentNotice(
        response.ok
          ? 'Creators paid. This receipt is now complete.'
          : response.payload.payment.reason,
      );
    } catch (requestError) {
      setPaymentNotice((requestError as Error).message);
    } finally {
      setIsPaying(false);
    }
  };

  const downloadProof = async () => {
    setPaymentNotice('');
    setReceiptNotice('');
    setVerificationNotice('');

    try {
      const payload = await requestJson<{ proof: unknown }>(
        `/api/receipts/${id}/proof`,
      );
      const blob = new Blob([JSON.stringify(payload.proof, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `sourcepay-receipt-${id.slice(0, 8)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setReceiptNotice('Receipt proof downloaded.');
    } catch (requestError) {
      setReceiptNotice((requestError as Error).message);
    }
  };

  const shareReceipt = async () => {
    setPaymentNotice('');
    setReceiptNotice('');
    setVerificationNotice('');
    const receiptUrl = window.location.href;

    try {
      if (navigator.share) {
        await navigator.share({
          title: 'SourcePay receipt',
          text: `SourcePay receipt ${id.slice(0, 8)}`,
          url: receiptUrl,
        });
        setReceiptNotice('Receipt share sheet opened.');
        return;
      }

      if (navigator.clipboard) {
        await navigator.clipboard.writeText(receiptUrl);
        setReceiptNotice('Receipt link copied.');
        return;
      }

      setReceiptNotice(receiptUrl);
    } catch (shareError) {
      if ((shareError as Error).name === 'AbortError') {
        setReceiptNotice('Share cancelled.');
        return;
      }

      try {
        await navigator.clipboard.writeText(receiptUrl);
        setReceiptNotice('Receipt link copied.');
      } catch {
        setReceiptNotice(receiptUrl);
      }
    }
  };

  const verifyProof = async () => {
    setIsVerifying(true);
    setPaymentNotice('');
    setReceiptNotice('');
    setVerificationNotice('');

    try {
      const proofPayload = await requestJson<{ proof: unknown }>(
        `/api/receipts/${id}/proof`,
      );
      const verificationPayload = await requestJson<{
        verification: { valid: boolean; reason: string };
      }>('/api/proofs/verify', {
        method: 'POST',
        body: JSON.stringify({ proof: proofPayload.proof }),
      });

      setVerificationNotice(
        verificationPayload.verification.valid
          ? 'Verified. This receipt matches the stored route and source fingerprints.'
          : verificationPayload.verification.reason,
      );
    } catch (requestError) {
      setVerificationNotice((requestError as Error).message);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <section
      className="min-h-screen px-3 py-3 text-white sm:px-5 sm:py-5"
      style={{
        background:
          'radial-gradient(circle at 16% 12%, rgba(95,169,255,0.24), transparent 30%), radial-gradient(circle at 86% 10%, rgba(244,132,95,0.18), transparent 28%), linear-gradient(135deg, #071018 0%, #0d0f12 48%, #111418 100%)',
      }}
    >
      <div className="mx-auto w-full max-w-5xl overflow-x-auto rounded-[8px] border border-white/12 bg-[#0b0e11]/90 shadow-2xl shadow-black/45 backdrop-blur-xl">
        <header className="flex min-h-16 flex-col items-stretch justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/5">
              <ReceiptText size={20} strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-sm font-bold">Receipt</p>
              <p className="font-mono text-[11px] text-white/42">
                {id.slice(0, 8)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 rounded-full border border-white/14 px-4 py-2 text-sm font-bold text-white/72 transition hover:border-white/40 hover:text-white"
          >
            <ArrowLeft size={17} strokeWidth={2.25} />
            Requests
          </button>
        </header>

        {loadError ? (
          <div className="p-5">
            <div className="rounded-[8px] border border-[#F4845F]/35 bg-[#F4845F]/12 p-4">
              <p className="text-sm font-semibold text-[#F7B49D]">{loadError}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded-[8px] bg-white px-4 py-2 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF]"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={onBack}
                  className="rounded-[8px] border border-white/14 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.12em] text-white/72 transition hover:border-white/40 hover:text-white"
                >
                  Requests
                </button>
              </div>
            </div>
          </div>
        ) : !receipt ? (
          <div className="p-8 text-center text-sm font-semibold text-white/45">
            Loading receipt...
          </div>
        ) : (
          <div className="p-4 sm:p-5">
            {(() => {
              const tone = paymentTone(receipt.paymentStatus);

              return (
                <div
                  className={`mb-5 rounded-[8px] border ${tone.border} ${tone.background} p-4`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className={`text-sm font-extrabold ${tone.text}`}>
                        {tone.label}
                      </p>
                      <p className="mt-1 max-w-2xl text-sm font-medium leading-relaxed text-white/62">
                        {paymentStateCopy(receipt.paymentStatus)}
                      </p>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                        Total
                      </p>
                      <p className="text-3xl font-bold text-white">
                        {formatUsd(receipt.totalSpend)}
                      </p>
                      <p className="text-sm font-semibold text-white/50">USDC</p>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <section className="overflow-hidden rounded-[8px] border border-white/10 bg-[#111]/90">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-sm font-bold">Selected creator sources</p>
                  <p className="mt-2 text-base font-semibold leading-relaxed text-white/82">
                    {receipt.question}
                  </p>
                </div>

                <div className="divide-y divide-white/[0.06]">
                  {receipt.sources.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm font-medium text-white/40">
                      No sources were selected for this route.
                    </div>
                  ) : (
                    receipt.sources.map((source, index) => {
                      const Icon = sourceKindIcons[source.kind];

                      return (
                        <div
                          key={source.id}
                          className="grid gap-3 px-4 py-4 sm:grid-cols-[36px_1fr_auto] sm:items-center"
                        >
                          <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-white/[0.06] text-white/70">
                            <Icon size={18} strokeWidth={2.25} />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-white/92">{source.title}</p>
                            <p className="mt-1 text-xs text-white/42">
                              {source.kind} · rank {source.rank ?? index + 1}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold text-white/38">
                              <span>{maskAddress(source.wallet)}</span>
                              <span>{shortFingerprint(source.fingerprint)}</span>
                            </div>
                          </div>
                          <div className="rounded-[8px] border border-white/10 bg-white/[0.035] px-3 py-2 text-left sm:text-right">
                            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/38">
                              Payout
                            </p>
                            <p className="font-bold text-white">
                              {formatUsd(source.price)} USDC
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <aside className="space-y-4">
                <section className="rounded-[8px] border border-white/10 bg-gradient-to-br from-[#111] to-[#0d141b] p-4">
                  <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                    Payment summary
                  </p>
                  <div className="space-y-3 text-sm">
                    {[
                      ['Budget', `${formatUsd(receipt.budget)} USDC`],
                      ['Sources', receipt.sources.length.toString()],
                      [
                        'Wallet balance',
                        walletBalanceCheck.balance === null
                          ? walletBalanceCheck.checking
                            ? 'Checking'
                            : connectedWallet.address
                              ? 'Unavailable'
                              : 'Connect wallet'
                          : `${formatUsdcAtomic(walletBalanceCheck.balance)} USDC`,
                      ],
                      [
                        'Required',
                        walletBalanceCheck.required === null
                          ? `${formatUsd(receipt.totalSpend)} USDC`
                          : `${formatUsdcAtomic(walletBalanceCheck.required)} USDC`,
                      ],
                      ['Payment', 'USDC'],
                      ['Network', receipt.network],
                      ['Status', formatStatus(receipt.paymentStatus)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="flex items-center justify-between border-b border-white/[0.06] pb-3 last:border-0"
                      >
                        <span className="text-white/48">{label}</span>
                        <span className="font-semibold">{value}</span>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={attemptPayment}
                    disabled={
                      isPaying ||
                      receipt.sources.length === 0 ||
                      receipt.paymentStatus === 'paid' ||
                      walletBalanceCheck.enough === false
                    }
                    className="mt-4 w-full rounded-[8px] bg-white px-4 py-3 text-sm font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF] disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {isPaying
                      ? 'Paying creators'
                      : isConnectingWallet
                        ? 'Connecting wallet'
                      : receipt.paymentStatus === 'paid'
                        ? 'Paid'
                          : connectedWallet.address
                            ? walletBalanceCheck.enough === false
                              ? 'Insufficient USDC'
                              : 'Pay creators'
                            : 'Connect and pay'}
                  </button>
                  {connectedWallet.address && (
                    <p
                      className={`mt-3 rounded-[8px] border px-3 py-2 text-xs font-semibold leading-relaxed ${
                        walletBalanceCheck.enough === false
                          ? 'border-[#F4845F]/35 bg-[#F4845F]/12 text-[#F7B49D]'
                          : walletBalanceCheck.enough === true
                            ? 'border-[#5FBF7A]/30 bg-[#5FBF7A]/10 text-[#8CE0A0]'
                            : 'border-white/10 bg-white/[0.035] text-white/45'
                      }`}
                    >
                      {walletBalanceCheck.checking
                        ? 'Checking wallet USDC balance...'
                        : walletBalanceCheck.enough === false
                          ? 'Wallet balance is below the quoted receipt amount.'
                          : walletBalanceCheck.enough === true
                            ? 'Wallet has enough USDC for this receipt.'
                            : walletBalanceCheck.error || 'Wallet balance could not be checked.'}
                    </p>
                  )}
                  <div className="mt-3 rounded-[8px] border border-white/10 bg-white/[0.025] p-3">
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/38">
                      Public receipt
                    </p>
                    <p className="mt-2 break-all font-mono text-xs font-semibold text-white/58">
                      {typeof window !== 'undefined' ? window.location.href : id}
                    </p>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={downloadProof}
                      className="flex items-center justify-center gap-2 rounded-[8px] border border-white/14 px-3 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-white/72 transition hover:border-white/40 hover:text-white"
                    >
                      <Download size={15} strokeWidth={2.25} />
                      Proof
                    </button>
                    <button
                      type="button"
                      onClick={shareReceipt}
                      className="flex items-center justify-center gap-2 rounded-[8px] border border-white/14 px-3 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-white/72 transition hover:border-white/40 hover:text-white"
                    >
                      <Share2 size={15} strokeWidth={2.25} />
                      Share
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={verifyProof}
                    disabled={isVerifying}
                    className="mt-3 w-full rounded-[8px] border border-[#5FBF7A]/25 bg-[#5FBF7A]/10 px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-[#8CE0A0] transition hover:border-[#5FBF7A]/45 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {isVerifying ? 'Verifying' : 'Verify receipt'}
                  </button>
                  {(paymentNotice || receiptNotice || verificationNotice) && (
                    <div className="mt-3 space-y-2">
                      {paymentNotice && (
                        <p
                          className={`rounded-[8px] border p-3 text-sm font-semibold leading-relaxed ${
                            receipt.paymentStatus === 'paid'
                              ? 'border-[#5FBF7A]/30 bg-[#5FBF7A]/10 text-[#8CE0A0]'
                              : 'border-[#F4845F]/35 bg-[#F4845F]/12 text-[#F7B49D]'
                          }`}
                        >
                          {paymentNotice}
                        </p>
                      )}
                      {receiptNotice && (
                        <p className="rounded-[8px] border border-[#5FA9FF]/30 bg-[#5FA9FF]/10 p-3 text-sm font-semibold leading-relaxed text-[#9CCCFF]">
                          {receiptNotice}
                        </p>
                      )}
                      {verificationNotice && (
                        <p className="rounded-[8px] border border-[#5FBF7A]/30 bg-[#5FBF7A]/10 p-3 text-sm font-semibold leading-relaxed text-[#8CE0A0]">
                          {verificationNotice}
                        </p>
                      )}
                    </div>
                  )}
                </section>

                {receipt.paymentAttempts && receipt.paymentAttempts.length > 0 && (
                  <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4">
                    <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                      Payment history
                    </p>
                    <div className="space-y-3">
                      {receipt.paymentAttempts.map((attempt) => (
                        <div
                          key={attempt.id}
                          className="rounded-[8px] border border-white/10 bg-white/[0.025] p-3 text-sm"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-semibold">
                              {formatStatus(attempt.status)}
                            </span>
                            <span className="text-xs font-semibold text-white/38">
                              {new Date(attempt.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                          {attempt.reason && (
                            <p className="mt-2 text-xs leading-relaxed text-white/45">
                              {attempt.reason}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </aside>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function App() {
  const initialReceiptId =
    typeof window !== 'undefined'
      ? window.location.pathname.match(/^\/receipt\/([^/]+)$/)?.[1]
      : undefined;
  const initialSourceId =
    typeof window !== 'undefined'
      ? window.location.pathname.match(/^\/source\/([^/]+)$/)?.[1]
      : undefined;
  const initialView =
    initialReceiptId
      ? 'receipt'
      : initialSourceId
        ? 'source'
        : typeof window !== 'undefined' && window.location.pathname === '/creator'
          ? 'creator'
          : 'landing';
  const [view, setView] = useState<AppView>(initialView);
  const [receiptId, setReceiptId] = useState(initialReceiptId ?? '');
  const [activeReceipt, setActiveReceipt] = useState<Receipt | null>(null);
  const [sourceId, setSourceId] = useState(initialSourceId ?? '');
  const [connectedWallet, setConnectedWallet] = useState<ConnectedWallet>({
    address: null,
  });
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);

  useEffect(() => {
    let ignore = false;

    requestJson<{ wallet: WalletConfig }>('/api/wallet')
      .then((payload) => {
        if (!ignore) {
          setConnectedWallet({ address: payload.wallet.agentWallet });
        }
      })
      .catch(() => {
        if (!ignore) {
          setConnectedWallet({ address: null });
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  const connectWallet = async () => {
    setIsConnectingWallet(true);

    try {
      const provider = getEthereumProvider();
      if (!provider) {
        throw new Error('Install or open a browser wallet to connect.');
      }

      const accounts = await provider.request({
        method: 'eth_requestAccounts',
      });
      const address = Array.isArray(accounts) ? String(accounts[0] ?? '') : '';
      if (!address) {
        throw new Error('No wallet account was selected.');
      }

      await ensureArcNetwork(provider);

      await requestJson<{ wallet: WalletConfig }>('/api/wallet', {
        method: 'POST',
        body: JSON.stringify({ agentWallet: address, network: 'Arc' }),
      });
      setConnectedWallet({ address });
      return address;
    } finally {
      setIsConnectingWallet(false);
    }
  };

  const disconnectWallet = async () => {
    await requestJson<{ wallet: WalletConfig }>('/api/wallet', {
      method: 'DELETE',
    });
    setConnectedWallet({ address: null });
  };

  const navigate = (nextView: AppView, nextId = '', nextReceipt: Receipt | null = null) => {
    setView(nextView);
    setReceiptId(nextView === 'receipt' ? nextId : '');
    setActiveReceipt(nextView === 'receipt' ? nextReceipt : null);
    setSourceId(nextView === 'source' ? nextId : '');

    if (nextView === 'receipt' && nextId) {
      window.history.pushState(null, '', `/receipt/${nextId}`);
      return;
    }

    if (nextView === 'source' && nextId) {
      window.history.pushState(null, '', `/source/${nextId}`);
      return;
    }

    window.history.pushState(
      null,
      '',
      nextView === 'creator' ? '/creator' : '/',
    );
  };

  return (
    <AppErrorBoundary>
      <main className="relative w-full overflow-x-hidden">
        {view === 'landing' ? (
          <LandingPage onLaunch={() => navigate('platform')} />
        ) : view === 'platform' ? (
          <PlatformPage
            onBack={() => navigate('landing')}
            onOpenCreator={() => navigate('creator')}
            onOpenReceipt={(id, nextReceipt) => navigate('receipt', id, nextReceipt ?? null)}
            onOpenSource={(id) => navigate('source', id)}
            connectedWallet={connectedWallet}
            onConnectWallet={connectWallet}
            onDisconnectWallet={disconnectWallet}
            isConnectingWallet={isConnectingWallet}
          />
        ) : view === 'creator' ? (
          <CreatorPage
            onBack={() => navigate('platform')}
            onOpenSource={(id) => navigate('source', id)}
            connectedWallet={connectedWallet}
            onConnectWallet={connectWallet}
            onDisconnectWallet={disconnectWallet}
            isConnectingWallet={isConnectingWallet}
          />
        ) : view === 'source' ? (
          <SourcePage
            id={sourceId}
            onBack={() => navigate('platform')}
            onOpenReceipt={(id, nextReceipt) => navigate('receipt', id, nextReceipt ?? null)}
          />
        ) : (
          <ReceiptPage
            id={receiptId}
            initialReceipt={activeReceipt}
            onBack={() => navigate('platform')}
            connectedWallet={connectedWallet}
            onConnectWallet={connectWallet}
            isConnectingWallet={isConnectingWallet}
          />
        )}
      </main>
    </AppErrorBoundary>
  );
}

export { App };
