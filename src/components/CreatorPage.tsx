import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CircleDollarSign,
  ExternalLink,
  Plus,
  Trash2,
  Wallet,
  Download,
  Database,
} from 'lucide-react';
import type {
  ConnectedWallet,
  WalletConnector,
  WalletConnectionState,
  SourceKind,
  RegistrySource,
  SourceDraft,
  CreatorEarnings,
  SourcePreview,
} from '../types';
import {
  SOURCE_KINDS,
  DEFAULT_SOURCE_PRICE,
  MIN_USDC_AMOUNT,
  formatUsd,
  maskAddress,
  getEthereumProvider,
  getInjectedProvider,
  getActiveProviderAccount,
  ensureArcNetwork,
  requestJson,
  shortFingerprint,
  sourceFingerprintForDraft,
  buildSourceOwnershipMessage,
  buildSourceArchiveMessage,
} from '../utils';
import {
  SourcePayMark,
  MetricCard,
  sourceKindIcons,
} from './Common';

interface CreatorPageProps {
  onBack: () => void;
  onOpenSource: (id: string) => void;
  connectedWallet: ConnectedWallet;
  onConnectWallet: (connector?: WalletConnector) => Promise<string | null>;
  onDisconnectWallet: () => Promise<void>;
  isConnectingWallet: boolean;
  walletConnection: WalletConnectionState;
}

export function CreatorPage({
  onBack,
  onOpenSource,
  connectedWallet,
  onConnectWallet,
  onDisconnectWallet,
  isConnectingWallet,
  walletConnection,
}: CreatorPageProps) {
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [draft, setDraft] = useState<SourceDraft>({
    title: '',
    url: '',
    kind: 'Article',
    wallet: '',
    price: DEFAULT_SOURCE_PRICE,
    content: '',
  });
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isArchiving, setIsArchiving] = useState<Record<string, boolean>>({});
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [earningsWallet, setEarningsWallet] = useState('');
  const [isCheckingEarnings, setIsCheckingEarnings] = useState(false);
  const [earningsLoadedMessage, setEarningsLoadedMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'payouts' | 'register'>('payouts');

  const sourceWalletFilter = connectedWallet.address || draft.wallet.trim();

  useEffect(() => {
    if (!connectedWallet.address) return;
    setDraft((current) =>
      current.wallet.trim() ? current : { ...current, wallet: connectedWallet.address ?? '' },
    );
  }, [connectedWallet.address]);

  const loadSources = async (walletAddress: string) => {
    try {
      const payload = await requestJson<{ sources: RegistrySource[] }>(
        `/api/sources?wallet=${walletAddress}`,
      );
      setSources(payload.sources);
    } catch (e) {
      console.error('Failed to load creator sources:', e);
    }
  };

  useEffect(() => {
    if (connectedWallet.address) {
      loadSources(connectedWallet.address);
    } else {
      setSources([]);
    }
  }, [connectedWallet.address]);

  const loadCreatorEarnings = async () => {
    setError('');
    setInfo('');
    setEarningsLoadedMessage('');
    try {
      let signer = connectedWallet.address;
      if (!signer) {
        signer = await onConnectWallet();
      } else {
        const currentProvider = getEthereumProvider();
        if (!currentProvider) {
          throw new Error('Connect your payout wallet to load earnings.');
        }
        await ensureArcNetwork(currentProvider);
      }
      if (!signer) {
        throw new Error('Connect your payout wallet to load earnings.');
      }
      const provider = getEthereumProvider();
      if (!provider) {
        throw new Error('Connect your payout wallet to load earnings.');
      }

      setIsCheckingEarnings(true);
      const challengePayload = await requestJson<{ challenge: any }>(
        '/api/auth/challenge',
        {
          method: 'POST',
          body: JSON.stringify({
            wallet: signer,
            purpose: 'creator-earnings',
          }),
        },
      );
      const authSignature = await provider.request({
        method: 'personal_sign',
        params: [challengePayload.challenge.message, signer],
      });
      const payload = await requestJson<{ earnings: CreatorEarnings }>('/api/creator-earnings', {
        method: 'POST',
        body: JSON.stringify({
          wallet: signer,
          ownerWallet: signer,
          challengeId: challengePayload.challenge.id,
          authSignature: String(authSignature),
        }),
      });
      setEarnings(payload.earnings);
      setEarningsWallet(signer);
      setEarningsLoadedMessage('Earnings metrics loaded successfully!');
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsCheckingEarnings(false);
    }
  };

  const handlePreview = async () => {
    setError('');
    setInfo('');
    setPreview(null);
    setIsPreviewing(true);

    try {
      const material = draft.url.trim() || draft.content.trim();
      if (!material) {
        throw new Error('Enter a URL or text content to generate a preview.');
      }

      const payload = await requestJson<{ preview: SourcePreview }>('/api/source-preview', {
        method: 'POST',
        body: JSON.stringify({ material }),
      });
      setPreview(payload.preview);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleRegister = async () => {
    setError('');
    setInfo('');
    setIsRegistering(true);

    try {
      let signer = connectedWallet.address;
      if (!signer) {
        signer = await onConnectWallet();
      }
      if (!signer) {
        throw new Error('Connect your wallet before registering a source.');
      }
      const provider = getEthereumProvider();
      if (!provider) {
        throw new Error('A browser wallet is required to sign this source.');
      }
      await ensureArcNetwork(provider);
      const activePayer = await getActiveProviderAccount(provider);
      if (!activePayer) {
        throw new Error('Select the payout wallet in your browser extension before continuing.');
      }
      signer = activePayer;
      const signerAddress = signer as string;

      const title = preview?.title.trim() || draft.title.trim();
      const content = preview?.content.trim() || draft.content.trim();
      const price = Number(draft.price);

      if (!title) throw new Error('Source title is required.');
      if (!content) throw new Error('Source content is required.');
      if (!Number.isFinite(price) || price < MIN_USDC_AMOUNT) {
        throw new Error(`Citation price must be at least ${MIN_USDC_AMOUNT} USDC.`);
      }

      const unsignedSource = {
        title,
        kind: draft.kind,
        wallet: signerAddress,
        price,
        content,
      };

      const message = await buildSourceOwnershipMessage(unsignedSource);
      const signature = await provider.request({
        method: 'personal_sign',
        params: [message, signerAddress],
      });

      await requestJson<{ source: RegistrySource }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          ...unsignedSource,
          ownershipSignature: String(signature),
        }),
      });

      setDraft({
        title: '',
        url: '',
        kind: 'Article',
        wallet: signerAddress,
        price: DEFAULT_SOURCE_PRICE,
        content: '',
      });
      setPreview(null);
      setInfo('Source registered successfully.');
      await loadSources(signerAddress);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsRegistering(false);
    }
  };

  const handleArchive = async (source: RegistrySource) => {
    setError('');
    setInfo('');
    setIsArchiving((current) => ({ ...current, [source.id]: true }));

    try {
      let signer = connectedWallet.address;
      if (!signer) {
        signer = await onConnectWallet();
      }
      if (!signer) {
        throw new Error('Connect your wallet before archiving a source.');
      }
      const provider = getEthereumProvider();
      if (!provider) {
        throw new Error('A browser wallet is required to sign this action.');
      }
      await ensureArcNetwork(provider);
      const activePayer = await getActiveProviderAccount(provider);
      if (!activePayer) {
        throw new Error('Select the payout wallet in your browser extension before continuing.');
      }
      signer = activePayer;
      const signerAddress = signer as string;

      if (source.wallet.toLowerCase() !== signerAddress.toLowerCase()) {
        throw new Error('You can only archive sources owned by your wallet.');
      }

      const message = await buildSourceArchiveMessage(source);
      const signature = await provider.request({
        method: 'personal_sign',
        params: [message, signerAddress],
      });

      await requestJson(`/api/sources/${source.id}`, {
        method: 'DELETE',
        body: JSON.stringify({
          wallet: signerAddress,
          archiveSignature: String(signature),
        }),
      });

      setInfo('Source archived successfully.');
      await loadSources(signerAddress);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsArchiving((current) => ({ ...current, [source.id]: false }));
    }
  };

  const connectWalletFromPage = async (connector?: WalletConnector) => {
    setError('');
    try {
      await onConnectWallet(connector);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  const disconnectWalletFromPage = async () => {
    setError('');
    try {
      await onDisconnectWallet();
      setEarnings(null);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  return (
    <section
      className="min-h-screen px-3 py-3 text-white sm:px-5 sm:py-5"
      style={{
        background:
          'radial-gradient(circle at 14% 10%, rgba(95,191,122,0.22), transparent 30%), radial-gradient(circle at 84% 8%, rgba(95,169,255,0.2), transparent 28%), radial-gradient(circle at 55% 95%, rgba(244,132,95,0.1), transparent 30%), linear-gradient(135deg, #071018 0%, #0c120f 44%, #120e0d 100%)',
      }}
    >
      <div className="mx-auto flex w-full max-w-[1500px] flex-col overflow-x-auto rounded-[8px] border border-white/12 bg-[#0b110e]/88 shadow-2xl shadow-black/45 backdrop-blur-xl">
        <header className="flex min-h-16 flex-col items-stretch justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <SourcePayMark />
            <div className="min-w-0">
              <p className="text-sm font-bold">SourcePay</p>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">
                Creator Portal
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
              Buyer Console
            </button>
          </div>
        </header>

        <div className="grid min-w-0 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="border-b border-white/10 bg-black/10 p-3 lg:border-b-0 lg:border-r lg:p-4">
            <nav className="flex flex-row flex-wrap gap-1 lg:flex-col">
              {[
                { id: 'payouts', label: 'Earnings & Payouts', icon: Wallet },
                { id: 'register', label: 'Register Content', icon: Plus },
              ].map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id as any)}
                  className={`flex items-center gap-3 rounded-[8px] px-3 py-2.5 text-left text-sm font-semibold transition ${
                    activeTab === id
                      ? 'bg-white text-black'
                      : 'text-white/58 hover:bg-white/[0.04] hover:text-white'
                  }`}
                >
                  <Icon size={17} strokeWidth={2.25} />
                  {label}
                </button>
              ))}
            </nav>

            {connectedWallet.address && (
              <div className="mt-5 rounded-[8px] border border-white/10 bg-black/28 p-4">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                  Creator Wallet
                </p>
                <div className="space-y-1">
                  <p className="font-mono text-xs font-semibold text-white/80">
                    {maskAddress(connectedWallet.address)}
                  </p>
                  <button
                    type="button"
                    onClick={disconnectWalletFromPage}
                    className="text-[11px] font-bold text-[#F7B49D] hover:underline"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            )}
          </aside>

          <div className="min-w-0 p-3 sm:p-5">
            {error && (
              <p className="mb-4 rounded-[8px] border border-[#F4845F]/35 bg-[#F4845F]/12 px-3 py-2 text-sm font-semibold text-[#F7B49D]">
                {error}
              </p>
            )}
            {info && (
              <p className="mb-4 rounded-[8px] border border-[#5FBF7A]/30 bg-[#5FBF7A]/12 px-3 py-2 text-sm font-semibold text-[#8CE0A0]">
                {info}
              </p>
            )}

            {activeTab === 'payouts' && (
              <div className="space-y-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-[8px] border border-white/10 bg-[#111]/90 p-4">
                  <div>
                    <h3 className="text-base font-bold text-white">Earnings Analytics</h3>
                    <p className="text-xs leading-relaxed text-white/55 mt-0.5">
                      Verify citation counts and claim earnings to your registered payout wallet.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={loadCreatorEarnings}
                    disabled={isCheckingEarnings}
                    className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-white px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Wallet size={15} strokeWidth={2.25} />
                    {isCheckingEarnings ? 'Checking…' : 'Load Earnings'}
                  </button>
                </div>

                {earningsLoadedMessage && (
                  <p className="text-xs text-[#8CE0A0] font-semibold">{earningsLoadedMessage}</p>
                )}

                {earnings && (
                  <div className="space-y-6">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <MetricCard
                        label="Citations"
                        value={earnings.totals.citations.toString()}
                        icon={Wallet}
                      />
                      <MetricCard
                        label="Paid Citations"
                        value={earnings.totals.paidCitations.toString()}
                        icon={Wallet}
                      />
                      <MetricCard
                        label="Earned USDC"
                        value={`${formatUsd(earnings.totals.paidAmount)} USDC`}
                        icon={CircleDollarSign}
                      />
                      <MetricCard
                        label="Active Sources"
                        value={earnings.totals.sources.toString()}
                        icon={Database}
                      />
                    </div>

                    <section className="rounded-[8px] border border-white/10 bg-[#111]/90 overflow-hidden">
                      <div className="border-b border-white/10 px-4 py-3">
                        <p className="text-sm font-bold">Payouts by Source</p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[600px] border-collapse text-left text-sm">
                          <thead className="text-[11px] uppercase tracking-[0.14em] text-white/38 border-b border-white/10">
                            <tr>
                              <th className="px-4 py-3">Source</th>
                              <th className="px-4 py-3">Citations</th>
                              <th className="px-4 py-3">Price</th>
                              <th className="px-4 py-3">Total Earned</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.06]">
                            {earnings.sources.map((item) => (
                              <tr key={item.id} className="transition hover:bg-white/[0.015]">
                                <td className="px-4 py-3">
                                  <button
                                    type="button"
                                    onClick={() => onOpenSource(item.id)}
                                    className="font-semibold text-white hover:text-[#9CCCFF] hover:underline"
                                  >
                                    {item.title}
                                  </button>
                                  <p className="text-[10px] text-white/38 mt-0.5">{item.kind} · {shortFingerprint(item.fingerprint)}</p>
                                </td>
                                <td className="px-4 py-3 font-semibold">{item.citations}</td>
                                <td className="px-4 py-3 font-semibold">{formatUsd(item.paidAmount / (item.citations || 1))} USDC</td>
                                <td className="px-4 py-3 font-bold text-[#8CE0A0]">{formatUsd(item.paidAmount)} USDC</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    <section className="rounded-[8px] border border-white/10 bg-[#111]/90 overflow-hidden">
                      <div className="border-b border-white/10 px-4 py-3">
                        <p className="text-sm font-bold">Citation History</p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                          <thead className="text-[11px] uppercase tracking-[0.14em] text-white/38 border-b border-white/10">
                            <tr>
                              <th className="px-4 py-3">Request</th>
                              <th className="px-4 py-3">Cited Content</th>
                              <th className="px-4 py-3">Date</th>
                              <th className="px-4 py-3">Earnings</th>
                              <th className="px-4 py-3">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.06]">
                            {earnings.receipts.map((item, idx) => (
                              <tr key={idx} className="transition hover:bg-white/[0.015]">
                                <td className="px-4 py-3 font-semibold text-white/90">{item.question}</td>
                                <td className="px-4 py-3">
                                  <span className="font-semibold text-white/80">{item.source.title}</span>
                                  <p className="text-[10px] text-white/38 mt-0.5">Rank {item.rank}</p>
                                </td>
                                <td className="px-4 py-3 text-white/60">{new Date(item.createdAt).toLocaleDateString()}</td>
                                <td className="px-4 py-3 font-bold text-[#8CE0A0]">{formatUsd(item.paidAmount)} USDC</td>
                                <td className="px-4 py-3">
                                  <span className="rounded-full bg-[#5FBF7A]/12 border border-[#5FBF7A]/25 px-2 py-0.5 text-xs text-[#8CE0A0] font-semibold uppercase">
                                    {item.paymentStatus}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </div>
                )}

                {!earnings && (
                  <div className="rounded-[8px] border border-white/10 bg-[#111]/90 p-8 text-center">
                    <p className="text-sm font-semibold text-white/70">Connect payout wallet to load earnings analytics.</p>
                    {!connectedWallet.address && (
                      <div className="mt-4 flex justify-center gap-2">
                        {getInjectedProvider() && (
                          <button
                            type="button"
                            onClick={() => connectWalletFromPage('injected')}
                            disabled={isConnectingWallet}
                            className="rounded-[8px] bg-white px-4 py-2.5 text-xs font-bold text-black uppercase tracking-[0.10em] hover:bg-[#5FA9FF] transition disabled:opacity-40"
                          >
                            Injected Wallet
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => connectWalletFromPage('walletconnect')}
                          disabled={isConnectingWallet}
                          className="rounded-[8px] border border-white/14 bg-white/[0.03] px-4 py-2.5 text-xs font-bold text-white uppercase tracking-[0.10em] hover:bg-white/[0.08] transition disabled:opacity-40"
                        >
                          WalletConnect
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'register' && (
              <div className="grid gap-6 xl:grid-cols-[1fr_minmax(0,1fr)]">
                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4 space-y-4">
                  <div className="border-b border-white/10 pb-3">
                    <h3 className="text-base font-bold text-white">Register Creator Content</h3>
                    <p className="text-xs leading-relaxed text-white/55 mt-0.5">
                      Publish content descriptions to the metadata marketplace.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                        Source Category
                      </span>
                      <div className="grid grid-cols-3 gap-2">
                        {SOURCE_KINDS.map((kind) => {
                          const active = draft.kind === kind;

                          return (
                            <button
                              key={kind}
                              type="button"
                              onClick={() => setDraft((current) => ({ ...current, kind }))}
                              className={`rounded-[8px] border px-3 py-2.5 text-xs font-bold transition ${
                                active
                                  ? 'border-[#5FBF7A]/80 bg-[#5FBF7A]/12 text-white'
                                  : 'border-white/10 bg-white/[0.03] text-white/45 hover:text-white'
                              }`}
                            >
                              {kind}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <label className="block">
                      <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                        Price (USDC per Citation)
                      </span>
                      <input
                        type="number"
                        step="any"
                        min={MIN_USDC_AMOUNT}
                        value={draft.price}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, price: event.target.value }))
                        }
                        className="w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-semibold text-white outline-none focus:border-[#5FBF7A]/80"
                      />
                    </label>

                    <label className="block">
                      <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                        Source URL (optional)
                      </span>
                      <input
                        type="url"
                        placeholder="https://example.com/article"
                        value={draft.url}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            url: event.target.value,
                            content: event.target.value ? current.content : '',
                          }))
                        }
                        className="w-full rounded-[8px] border border-white/10 bg-black/30 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-[#5FBF7A]/80"
                      />
                    </label>

                    {!draft.url && (
                      <label className="block">
                        <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                          Source Text Content
                        </span>
                        <textarea
                          placeholder="Paste or write the full text to register."
                          value={draft.content}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, content: event.target.value }))
                          }
                          className="min-h-32 w-full resize-none rounded-[8px] border border-white/10 bg-black/30 p-3 text-sm font-medium leading-relaxed text-white outline-none transition placeholder:text-white/25 focus:border-[#5FBF7A]/80"
                        />
                      </label>
                    )}

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handlePreview}
                        disabled={isPreviewing || !(draft.url.trim() || draft.content.trim())}
                        className="flex-1 rounded-[8px] border border-white/14 bg-white/[0.03] py-2.5 text-xs font-bold text-white uppercase tracking-[0.1em] hover:bg-white/[0.08] transition disabled:opacity-40"
                      >
                        {isPreviewing ? 'Previewing…' : 'Generate Preview'}
                      </button>
                      <button
                        type="button"
                        onClick={handleRegister}
                        disabled={isRegistering || !preview}
                        className="flex-1 rounded-[8px] bg-white text-black py-2.5 text-xs font-extrabold uppercase tracking-[0.1em] hover:bg-[#5FBF7A] hover:text-white transition disabled:opacity-40"
                      >
                        {isRegistering ? 'Registering…' : 'Sign & Register'}
                      </button>
                    </div>
                  </div>
                </section>

                <section className="space-y-4">
                  {preview && (
                    <div className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4 space-y-3">
                      <div className="border-b border-white/10 pb-2">
                        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#8CE0A0]">Preview Outcome</span>
                        <h4 className="text-sm font-bold text-white mt-1">{preview.title}</h4>
                      </div>
                      <p className="text-xs leading-relaxed text-white/55 font-medium max-h-60 overflow-y-auto whitespace-pre-wrap">
                        {preview.content}
                      </p>
                    </div>
                  )}

                  <div className="rounded-[8px] border border-white/10 bg-[#111]/90 overflow-hidden">
                    <div className="border-b border-white/10 px-4 py-3 flex items-center justify-between">
                      <p className="text-sm font-bold">Your Registered Material</p>
                      <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs font-bold text-white/60">{sources.length} sources</span>
                    </div>
                    <div className="divide-y divide-white/[0.06] max-h-[400px] overflow-y-auto">
                      {sources.length === 0 ? (
                        <div className="px-4 py-8 text-center text-xs text-white/42">No registered content found for this wallet.</div>
                      ) : (
                        sources.map((item) => {
                          const Icon = sourceKindIcons[item.kind];
                          return (
                            <div key={item.id} className="p-3 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/5 text-white/60">
                                  <Icon size={14} />
                                </div>
                                <div className="min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => onOpenSource(item.id)}
                                    className="text-left text-xs font-bold text-white hover:text-[#9CCCFF] hover:underline truncate block"
                                  >
                                    {item.title}
                                  </button>
                                  <p className="text-[10px] text-white/34 mt-0.5">{formatUsd(item.price)} USDC · {shortFingerprint(item.fingerprint)}</p>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleArchive(item)}
                                disabled={isArchiving[item.id]}
                                className="rounded-full p-1.5 hover:bg-white/5 text-white/50 hover:text-[#F7B49D] transition shrink-0"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
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
