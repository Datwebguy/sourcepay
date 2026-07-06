import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Database,
  ExternalLink,
  Filter,
  Play,
  SendHorizontal,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react';
import type {
  ConnectedWallet,
  WalletConnector,
  WalletConnectionState,
  SourceKind,
  RegistrySource,
  Receipt,
  PaymentReadiness,
  SafeConfig,
  WalletBalanceCheck,
  ConsoleTab,
} from '../types';
import {
  SOURCE_KINDS,
  MIN_USDC_AMOUNT,
  DEFAULT_REQUEST_BUDGET,
  formatUsd,
  maskAddress,
  formatUsdcAtomic,
  encodeBalanceOf,
  getEthereumProvider,
  getInjectedProvider,
  ensureArcNetwork,
  readUsdcBalance,
  requestJson,
  shortFingerprint,
  formatStatus,
  apiPath,
} from '../utils';
import {
  SourcePayMark,
  MetricCard,
  sourceKindIcons,
} from './Common';

interface PlatformPageProps {
  onBack: () => void;
  onOpenCreator: () => void;
  onOpenReceipt: (id: string, nextReceipt?: Receipt | null) => void;
  onOpenSource: (id: string) => void;
  connectedWallet: ConnectedWallet;
  onConnectWallet: (connector?: WalletConnector) => Promise<string | null>;
  onDisconnectWallet: () => Promise<void>;
  isConnectingWallet: boolean;
  walletConnection: WalletConnectionState;
  sourceRefreshKey: number;
}

export function PlatformPage({
  onBack,
  onOpenCreator,
  onOpenReceipt,
  onOpenSource,
  connectedWallet,
  onConnectWallet,
  onDisconnectWallet,
  isConnectingWallet,
  walletConnection,
  sourceRefreshKey,
}: PlatformPageProps) {
  const [question, setQuestion] = useState('');
  const [budget, setBudget] = useState(DEFAULT_REQUEST_BUDGET);
  const [enabledTypes, setEnabledTypes] = useState<SourceKind[]>(SOURCE_KINDS);
  const [maxSpendLimit, setMaxSpendLimit] = useState(5000);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [policySavedMessage, setPolicySavedMessage] = useState('');
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [paymentReadiness, setPaymentReadiness] = useState<PaymentReadiness | null>(null);
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
    ['Wallet', Boolean(connectedWallet.address)],
    ['Arc Testnet connection', paymentReadiness?.requirements.rpcUrl],
    ['Circle Gateway', paymentReadiness?.requirements.gateway],
  ] satisfies Array<[string, boolean | undefined]>;

  const payableReceipts = receipts.filter((item) => item.sources.length > 0);
  const activeReceipt = receipt;
  const selectedSources = activeReceipt?.sources ?? [];
  const totalSpend = activeReceipt?.totalSpend ?? 0;
  const walletBalanceCopy = walletBalanceCheck.checking
    ? 'Checking balance'
    : walletBalanceCheck.balance !== null
      ? `${formatUsdcAtomic(walletBalanceCheck.balance)} USDC`
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

  const routingEligibleSources = sources.filter(
    (source) => enabledTypes.includes(source.kind) && source.price <= budget,
  );

  const hasRegisteredSources = sources.length > 0;
  const requestText = question.trim();
  const routeBlockReason = !hasRegisteredSources
    ? 'Add creator sources first'
    : !requestText
      ? 'Enter a request'
      : enabledTypes.length === 0
        ? 'Select source types'
        : routingEligibleSources.length === 0
          ? 'No sources within budget'
          : '';

  useEffect(() => {
    let ignore = false;
    const requiredFallback = activeReceipt
      ? BigInt(Math.round(activeReceipt.totalSpend * 1_000_000))
      : null;

    if (!connectedWallet.address) {
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

    const usdcAddr = safeConfig?.walletNetwork?.usdcAddress || '0x3600000000000000000000000000000000000000';

    ensureArcNetwork(provider)
      .then(async () => {
        const balanceHex = String(
          await provider.request({
            method: 'eth_call',
            params: [
              {
                to: usdcAddr,
                data: encodeBalanceOf(connectedWallet.address as string),
              },
              'latest',
            ],
          }),
        );
        const balance = BigInt(balanceHex);
        return { balance };
      })
      .then((result) => {
        if (ignore) return;
        const required = activeReceipt
          ? BigInt(Math.round(activeReceipt.totalSpend * 1_000_000))
          : null;
        const enough = required !== null ? result.balance >= required : null;

        setWalletBalanceCheck({
          checking: false,
          balance: result.balance,
          required,
          enough,
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
  }, [activeReceipt?.id, activeReceipt?.totalSpend, connectedWallet.address, safeConfig]);

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
  }, [sourceRefreshKey]);

  const refreshPaymentReadiness = async () => {
    const payload = await requestJson<{ payment: PaymentReadiness }>(
      '/api/payment-readiness?check=gateway',
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

  const refreshReceipts = async () => {
    const payload = await requestJson<{ receipts: Receipt[] }>('/api/receipts');
    setReceipts(payload.receipts);
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
          buyerWallet: connectedWallet.address || '',
        }),
      });
      setReceipt(payload.receipt);
      setReceipts((current) => [
        payload.receipt,
        ...current.filter((item) => item.id !== payload.receipt.id),
      ]);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsRouting(false);
    }
  };

  const connectWalletFromPage = async (connector?: WalletConnector) => {
    setError('');
    try {
      await onConnectWallet(connector);
      await refreshPaymentReadiness();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  const disconnectWalletFromPage = async () => {
    setError('');
    try {
      await onDisconnectWallet();
      await refreshReceipts();
      await refreshPaymentReadiness();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  const loadUserPolicy = async (walletAddress: string) => {
    try {
      const res = await requestJson<{
        policy: {
          maxSpendLimit: number;
          perAnswerAmount: number;
          enabledKinds: SourceKind[];
        };
      }>(`/api/policy?wallet=${walletAddress}`);
      if (res.policy) {
        setMaxSpendLimit(res.policy.maxSpendLimit);
        setBudget(Math.min(res.policy.perAnswerAmount, res.policy.maxSpendLimit));
        setEnabledTypes(res.policy.enabledKinds);
      }
    } catch (e) {
      console.error('Failed to load user policy:', e);
    }
  };

  const savePolicy = async (newMax: number, newPerAnswer: number, kinds: SourceKind[]) => {
    if (!connectedWallet.address) return;
    setIsSavingPolicy(true);
    setError('');
    setPolicySavedMessage('');
    try {
      await requestJson('/api/policy', {
        method: 'POST',
        body: JSON.stringify({
          wallet: connectedWallet.address,
          maxSpendLimit: newMax,
          perAnswerAmount: newPerAnswer,
          enabledKinds: kinds,
        }),
      });
      setPolicySavedMessage('Policy configuration saved successfully!');
      setTimeout(() => setPolicySavedMessage(''), 4000);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsSavingPolicy(false);
    }
  };

  useEffect(() => {
    if (connectedWallet.address) {
      loadUserPolicy(connectedWallet.address);
    } else {
      setMaxSpendLimit(5000);
      setBudget(100);
      setEnabledTypes(SOURCE_KINDS);
    }
  }, [connectedWallet.address]);

  const loadBuyerReceipts = async () => {
    setError('');
    try {
      let signer = connectedWallet.address;
      if (!signer) {
        signer = await onConnectWallet();
      } else {
        const currentProvider = getEthereumProvider();
        if (!currentProvider) {
          throw new Error('Connect the buyer wallet before loading your receipts.');
        }
        await ensureArcNetwork(currentProvider);
      }
      if (!signer) {
        throw new Error('Connect the buyer wallet before loading your receipts.');
      }
      const provider = getEthereumProvider();
      if (!provider) {
        throw new Error('Connect the buyer wallet before loading your receipts.');
      }

      const challengePayload = await requestJson<{ challenge: any }>(
        '/api/auth/challenge',
        {
          method: 'POST',
          body: JSON.stringify({
            wallet: signer,
            purpose: 'buyer-receipts',
          }),
        },
      );
      const authSignature = await provider.request({
        method: 'personal_sign',
        params: [challengePayload.challenge.message, signer],
      });
      const payload = await requestJson<{ receipts: Receipt[] }>('/api/buyer/receipts', {
        method: 'POST',
        body: JSON.stringify({
          wallet: signer,
          ownerWallet: signer,
          challengeId: challengePayload.challenge.id,
          authSignature: String(authSignature),
        }),
      });
      setReceipts(payload.receipts);
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
            <button
              type="button"
              onClick={() => setActiveTab('Wallet')}
              className="flex min-h-10 items-center gap-2 rounded-full border border-white/14 px-3 py-2 text-sm font-bold text-white/72 transition hover:border-white/40 hover:text-white sm:px-4"
            >
              <Wallet size={16} strokeWidth={2.25} />
              Wallet
            </button>
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
            <nav className="flex flex-row flex-wrap gap-1 lg:flex-col">
              {[
                { label: 'Requests', icon: SendHorizontal },
                { label: 'Sources', icon: Database },
                { label: 'Payments', icon: Wallet },
                { label: 'Policy', icon: ShieldCheck },
                { label: 'Wallet', icon: Wallet },
                { label: 'Guide', icon: Activity },
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
                  <span className="font-bold">Arc Testnet</span>
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
                ['1', 'Add creator sources', hasRegisteredSources],
                ['2', 'Route a request', selectedSources.length > 0],
                ['3', 'Approve & pay', activeReceipt?.paymentStatus === 'paid' || activeReceipt?.paymentStatus === 'settled'],
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
                      {done ? '✓' : step}
                    </span>
                    <span className="font-bold">{label}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Registered sources"
                value={sources.length.toString()}
                icon={Database}
              />
              <MetricCard
                label="Selected sources"
                value={selectedSources.length.toString()}
                icon={Filter}
              />
              <MetricCard
                label={activeReceipt?.paymentStatus === 'paid' || activeReceipt?.paymentStatus === 'settled' ? 'Paid' : 'Quoted spend'}
                value={`${formatUsd(totalSpend)} USDC`}
                icon={Wallet}
              />
              <MetricCard
                label="Wallet USDC"
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
                        <span className="text-white/42">per-answer budget</span>
                      </div>
                      <input
                        aria-label="Max spend"
                        type="range"
                        min={MIN_USDC_AMOUNT}
                        max={maxSpendLimit}
                        step="any"
                        value={budget}
                        onChange={(event) => setBudget(Number(event.target.value))}
                        className="w-full accent-[#5FA9FF]"
                      />
                      <input
                        aria-label="Max spend amount"
                        type="number"
                        min={MIN_USDC_AMOUNT}
                        max={maxSpendLimit}
                        step="any"
                        value={budget}
                        onChange={(event) =>
                          setBudget(
                            Math.min(
                              maxSpendLimit,
                              Math.max(MIN_USDC_AMOUNT, Number(event.target.value) || MIN_USDC_AMOUNT),
                            ),
                          )
                        }
                        className="mt-3 w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-semibold text-white outline-none focus:border-[#5FA9FF]/80"
                      />
                      {hasRegisteredSources && (
                        <p className={`mt-2 text-[11px] ${routingEligibleSources.length === 0 ? 'text-[#F7B49D]' : 'text-white/40'}`}>
                          {routingEligibleSources.length === 0
                            ? '⚠ No creator sources fit within this budget — increase the amount above.'
                            : `✓ ${routingEligibleSources.length} creator source${routingEligibleSources.length !== 1 ? 's' : ''} eligible at this budget`}
                        </p>
                      )}
                    </div>

                    <div>
                      <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                        <SlidersHorizontal size={14} strokeWidth={2.25} />
                        Source types
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {SOURCE_KINDS.map((kind) => {
                          const active = enabledTypes.includes(kind);
                          const kindCount = sources.filter(
                            (s) => s.kind === kind && s.price <= budget,
                          ).length;

                          return (
                            <button
                              key={kind}
                              type="button"
                              onClick={() => toggleSourceKind(kind)}
                              title={`${kindCount} source${kindCount !== 1 ? 's' : ''} available within budget`}
                              className={`rounded-[8px] border px-3 py-2 text-xs font-bold transition ${
                                active
                                  ? 'border-[#5FA9FF]/80 bg-[#5FA9FF]/16 text-white'
                                  : 'border-white/10 bg-white/[0.03] text-white/45 hover:text-white'
                              }`}
                            >
                              {kind}
                              {kindCount > 0 && (
                                <span className={`ml-1 text-[10px] ${active ? 'text-[#9CCCFF]' : 'text-white/30'}`}>
                                  ({kindCount})
                                </span>
                              )}
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
                      {isRouting ? 'Routing…' : routeBlockReason || 'Route request'}
                    </button>
                    <p className="text-xs font-medium leading-relaxed text-white/38">
                      Routing creates a quote. USDC is only deducted after you approve
                      payment on the receipt page.
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
                            {activeReceipt?.paymentStatus === 'paid' || activeReceipt?.paymentStatus === 'settled' ? 'paid' : 'quoted'}
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
                              'Wallet USDC',
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
                                ? 'Wallet USDC is below the quote. Payment can still proceed if Circle Gateway balance is funded.'
                                : walletBalanceCheck.enough === true
                                  ? 'Wallet has enough USDC for this quote.'
                                  : walletBalanceCheck.error || 'Wallet USDC balance could not be checked.'}
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
                          {activeReceipt?.paymentStatus === 'paid' || activeReceipt?.paymentStatus === 'settled'
                            ? 'Open receipt'
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
                    <p className="text-sm font-bold">Marketplace discovery</p>
                    <p className="text-xs text-white/45">
                      Search public creator sources available for routing.
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
                          <td colSpan={6} className="px-4 py-12 text-center">
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
                              className="border-b border-white/[0.06] transition hover:bg-white/[0.015]"
                            >
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-3">
                                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/70">
                                    <Icon size={16} strokeWidth={2.25} />
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => onOpenSource(source.id)}
                                    className="text-left font-semibold text-white underline-offset-4 hover:text-[#9CCCFF] hover:underline"
                                  >
                                    {source.title}
                                  </button>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-white/72">{source.kind}</td>
                              <td className="px-4 py-3 font-mono text-xs text-white/45">
                                {shortFingerprint(source.fingerprint)}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-white/64">
                                {maskAddress(source.wallet)}
                              </td>
                              <td className="px-4 py-3 font-bold text-[#8CE0A0]">
                                {formatUsd(source.price)} USDC
                              </td>
                              <td className="px-4 py-3 text-xs">
                                <span className="rounded-full bg-[#5FBF7A]/12 px-2 py-0.5 font-semibold text-[#8CE0A0] border border-[#5FBF7A]/20">
                                  {source.status}
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
                <div className="flex flex-col gap-3 border-b border-white/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-bold">Settlement queue</p>
                    <p className="text-xs text-white/45">
                      Public paid receipts plus private receipts loaded from the signed buyer wallet.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={loadBuyerReceipts}
                    disabled={isConnectingWallet}
                    className="inline-flex items-center justify-center gap-2 rounded-[8px] border border-white/14 px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-white/72 transition hover:border-[#5FA9FF]/70 hover:text-[#9CCCFF] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Wallet size={15} strokeWidth={2.25} />
                    My receipts
                  </button>
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
              <div className="grid gap-4 xl:grid-cols-[450px_minmax(0,1fr)]">
                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4 space-y-4">
                  <div>
                    <p className="mb-1 text-sm font-bold text-white">Spend policy</p>
                    <p className="text-xs leading-relaxed text-white/55">
                      Configure your global spending limit and routing parameters.
                    </p>
                  </div>

                  <div className="rounded-[8px] border border-white/10 bg-black/24 p-3">
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="font-bold text-white">${formatUsd(maxSpendLimit, 2)} USDC</span>
                      <span className="text-white/42 text-xs">max spend limit</span>
                    </div>
                    <input
                      aria-label="Policy max spend limit"
                      type="range"
                      min={1}
                      max={100000}
                      value={maxSpendLimit}
                      onChange={(event) => setMaxSpendLimit(Number(event.target.value))}
                      className="w-full accent-[#5FA9FF]"
                    />
                    <input
                      aria-label="Policy max spend limit amount"
                      type="number"
                      min={1}
                      max={100000}
                      value={maxSpendLimit}
                      onChange={(event) =>
                        setMaxSpendLimit(
                          Math.min(
                            100000,
                            Math.max(1, Number(event.target.value) || 1),
                          ),
                        )
                      }
                      className="mt-2 w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-xs font-semibold text-white outline-none focus:border-[#5FA9FF]/80"
                    />
                  </div>

                  <div className="rounded-[8px] border border-white/10 bg-black/24 p-3">
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="font-bold text-white">${formatUsd(budget, 2)} USDC</span>
                      <span className="text-white/42 text-xs">per answer amount</span>
                    </div>
                    <input
                      aria-label="Policy per answer"
                      type="range"
                      min={MIN_USDC_AMOUNT}
                      max={maxSpendLimit}
                      step="any"
                      value={budget}
                      onChange={(event) => setBudget(Number(event.target.value))}
                      className="w-full accent-[#5FA9FF]"
                    />
                    <input
                      aria-label="Policy per answer amount"
                      type="number"
                      min={MIN_USDC_AMOUNT}
                      max={maxSpendLimit}
                      step="any"
                      value={budget}
                      onChange={(event) =>
                        setBudget(
                          Math.min(
                            maxSpendLimit,
                            Math.max(MIN_USDC_AMOUNT, Number(event.target.value) || MIN_USDC_AMOUNT),
                          ),
                        )
                      }
                      className="mt-2 w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-xs font-semibold text-white outline-none focus:border-[#5FA9FF]/80"
                    />
                  </div>

                  <div>
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/42">
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

                  <button
                    type="button"
                    onClick={() => savePolicy(maxSpendLimit, budget, enabledTypes)}
                    disabled={!connectedWallet.address || isSavingPolicy}
                    className="w-full rounded-[8px] bg-white text-black font-extrabold uppercase tracking-[0.12em] py-2.5 text-xs hover:bg-[#5FA9FF] transition disabled:opacity-35 disabled:cursor-not-allowed"
                  >
                    {isSavingPolicy ? 'Saving policy...' : connectedWallet.address ? 'Save Policy Configuration' : 'Connect wallet to save policy'}
                  </button>

                  {policySavedMessage && (
                    <p className="text-xs text-[#8CE0A0] text-center font-semibold mt-2">{policySavedMessage}</p>
                  )}
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
                      ['Payment token', 'USDC'],
                      ['Network rail', paymentReadiness?.network ?? 'Arc Testnet'],
                      [
                        'Active limit',
                        `${formatUsd(budget)} USDC / answer`,
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
              <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-5">
                <div className="mb-4 border-b border-white/10 pb-3">
                  <h3 className="text-base font-bold text-white">Browser Wallet</h3>
                  <p className="text-xs leading-relaxed text-white/55 mt-0.5">
                    Network configuration for Arc Testnet settlements.
                  </p>
                </div>

                <div className="space-y-4 max-w-xl">
                  {!connectedWallet.address && (
                    <div className="space-y-3">
                      <p className="text-sm font-semibold text-white/70">Connect a Web3 account to enable paid citation routing.</p>
                      <div className="flex flex-wrap gap-2">
                        {getInjectedProvider() && (
                          <button
                            type="button"
                            onClick={() => connectWalletFromPage('injected')}
                            disabled={isConnectingWallet}
                            className="rounded-[8px] bg-white px-4 py-2.5 text-xs font-bold text-black uppercase tracking-[0.1em] hover:bg-[#5FA9FF] transition disabled:opacity-40"
                          >
                            Browser Wallet
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => connectWalletFromPage('walletconnect')}
                          disabled={isConnectingWallet}
                          className="rounded-[8px] border border-white/14 bg-white/[0.03] px-4 py-2.5 text-xs font-bold text-white uppercase tracking-[0.1em] hover:bg-white/[0.08] transition disabled:opacity-40"
                        >
                          WalletConnect
                        </button>
                      </div>
                    </div>
                  )}

                  {connectedWallet.address && (
                    <div className="space-y-4">
                      <div className="rounded-[8px] border border-white/10 bg-black/24 p-3 font-mono text-xs text-white/70 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-white/45">Account</span>
                          <span className="font-semibold text-white">{connectedWallet.address}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-white/45">Connector</span>
                          <span className="font-semibold capitalize text-white">{connectedWallet.connector}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-white/45">Balance</span>
                          <span className="font-bold text-[#8CE0A0]">{walletBalanceCopy}</span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={disconnectWalletFromPage}
                        className="rounded-[8px] border border-[#F4845F]/35 bg-[#F4845F]/10 hover:bg-[#F4845F]/20 px-4 py-2.5 text-xs font-bold text-[#F7B49D] uppercase tracking-[0.1em] transition"
                      >
                        Disconnect Wallet
                      </button>
                    </div>
                  )}

                  {walletConnection.message && (
                    <p className="text-xs font-semibold text-[#9CCCFF] mt-2 animate-pulse">{walletConnection.message}…</p>
                  )}
                  {walletConnection.error && (
                    <p className="rounded-[8px] border border-[#F4845F]/35 bg-[#F4845F]/12 px-3 py-2 text-xs font-semibold text-[#F7B49D] mt-2">{walletConnection.error}</p>
                  )}
                </div>
              </section>
            )}

            {activeTab === 'Guide' && (
              <div className="grid gap-6 md:grid-cols-2">
                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-5">
                  <div className="mb-4 flex items-center gap-2 border-b border-white/10 pb-3">
                    <div className="rounded-full bg-[#5FA9FF]/14 p-1.5 text-[#9CCCFF]">
                      <Activity size={18} />
                    </div>
                    <h3 className="text-base font-bold text-white">Buyer User Guide</h3>
                  </div>
                  <p className="mb-4 text-xs leading-relaxed text-white/55">
                    How to route research requests, verify citation lists, and settle receipts on the Arc Testnet.
                  </p>
                  <ol className="space-y-4 text-sm text-white/80">
                    <li className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white/70">1</span>
                      <div>
                        <p className="font-semibold text-white">Connect Wallet</p>
                        <p className="text-xs text-white/48 mt-0.5">Click Browser Wallet in the top right corner to connect your Web3 account.</p>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white/70">2</span>
                      <div>
                        <p className="font-semibold text-white">Route citation request</p>
                        <p className="text-xs text-white/48 mt-0.5">Go to the Requests tab, enter your research question and budget (USDC), and click Route Request.</p>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white/70">3</span>
                      <div>
                        <p className="font-semibold text-white">Settle Receipt</p>
                        <p className="text-xs text-white/48 mt-0.5">Review matched sources and click Connect and Pay to sign EIP-3009 TransferWithAuthorization micro-payments.</p>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white/70">4</span>
                      <div>
                        <p className="font-semibold text-white">Recover receipts</p>
                        <p className="text-xs text-white/48 mt-0.5">Under the Payments tab, connect your buyer wallet and sign the challenge to retrieve all your past invoices.</p>
                      </div>
                    </li>
                  </ol>
                  <div className="mt-5 rounded-[8px] bg-white/[0.03] p-3 text-xs leading-relaxed text-white/45 border border-white/5">
                    Note: Set budgets to very low values (e.g. 0.0001 USDC) to test the Arc Net nanopayments zero-dust capability.
                  </div>
                </section>

                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-5">
                  <div className="mb-4 flex items-center gap-2 border-b border-white/10 pb-3">
                    <div className="rounded-full bg-[#5FBF7A]/12 p-1.5 text-[#8CE0A0]">
                      <Activity size={18} />
                    </div>
                    <h3 className="text-base font-bold text-white">Creator User Guide</h3>
                  </div>
                  <p className="mb-4 text-xs leading-relaxed text-white/55">
                    How to register your articles, transcripts, or social posts, set your citation price, and view your real-time USDC payout metrics.
                  </p>
                  <ol className="space-y-4 text-sm text-white/80">
                    <li className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white/70">1</span>
                      <div>
                        <p className="font-semibold text-white">Connect payout wallet</p>
                        <p className="text-xs text-white/48 mt-0.5">Open the Creator Portal and click Connect Wallet. All earnings will be directly sent to this payout address.</p>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white/70">2</span>
                      <div>
                        <p className="font-semibold text-white">Register sources</p>
                        <p className="text-xs text-white/48 mt-0.5">Enter a title, select a category, write or fetch the content preview, set your price, and sign the ownership verification.</p>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white/70">3</span>
                      <div>
                        <p className="font-semibold text-white">Track citation usage</p>
                        <p className="text-xs text-white/48 mt-0.5">As AI agents route requests and purchase your material, your payout metrics will update dynamically in real time.</p>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-white/70">4</span>
                      <div>
                        <p className="font-semibold text-white">Verify on-chain settlements</p>
                        <p className="text-xs text-white/48 mt-0.5">Inspect individual citation settlements with direct transaction hash links to the Arc block explorer.</p>
                      </div>
                    </li>
                  </ol>
                  <div className="mt-5 rounded-[8px] bg-white/[0.03] p-3 text-xs leading-relaxed text-white/45 border border-white/5">
                    Note: Payouts are made instantly using TransferWithAuthorization. Funds arrive in your wallet as soon as the batch settles.
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
