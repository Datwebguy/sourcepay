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
  ShieldCheck,
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
  const [activeTab, setActiveTab] = useState<'payouts' | 'register' | 'identity'>('payouts');
  const [linkedTwitter, setLinkedTwitter] = useState<string | null>(null);
  const [linkedMedium, setLinkedMedium] = useState<string | null>(null);
  const [twitterInput, setTwitterInput] = useState('');
  const [mediumInput, setMediumInput] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  const [verifyPanelSourceId, setVerifyPanelSourceId] = useState<string | null>(null);
  const [verifyTweetUrl, setVerifyTweetUrl] = useState('');
  const [verifyTweetText, setVerifyTweetText] = useState('');
  const [isLoadingProof, setIsLoadingProof] = useState(false);
  const [isVerifyingSocial, setIsVerifyingSocial] = useState(false);

  const sourceWalletFilter = connectedWallet.address || draft.wallet.trim();

  const loadSocials = async (walletAddress: string) => {
    try {
      const payload = await requestJson<{ socials: { platform: string; handle: string }[] }>(
        `/api/socials?wallet=${walletAddress}`,
      );
      let twitter: string | null = null;
      let medium: string | null = null;
      payload.socials.forEach((social) => {
        if (social.platform === 'twitter') twitter = social.handle;
        if (social.platform === 'medium') medium = social.handle;
      });
      setLinkedTwitter(twitter);
      setLinkedMedium(medium);
    } catch (e) {
      console.error('Failed to load linked socials:', e);
    }
  };

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
      loadSocials(connectedWallet.address);
    } else {
      setSources([]);
      setLinkedTwitter(null);
      setLinkedMedium(null);
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
      const originUrl = (preview?.url || draft.url || '').trim();

      if (!title) throw new Error('Source title is required.');
      if (!content) throw new Error('Source content is required.');
      if (!Number.isFinite(price) || price < MIN_USDC_AMOUNT) {
        throw new Error(`Citation price must be at least ${MIN_USDC_AMOUNT} USDC.`);
      }
      if (draft.kind === 'Social post' && !originUrl) {
        throw new Error(
          'Social posts require your public X post URL (Identity tab must link that X handle).',
        );
      }
      if (draft.kind === 'Article' && !originUrl) {
        throw new Error(
          'Articles require your Medium URL (Identity tab must link that Medium handle).',
        );
      }
      if (draft.kind === 'Social post' && !linkedTwitter) {
        throw new Error('Link your X handle in the Identity tab before registering a Social post.');
      }
      if (draft.kind === 'Article' && !linkedMedium) {
        throw new Error('Link your Medium handle in the Identity tab before registering an Article.');
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

      const registered = await requestJson<{ source: RegistrySource }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          ...unsignedSource,
          originUrl: originUrl || undefined,
          ownerWallet: signerAddress,
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
      if (registered.source.contentTrust === 'unbound') {
        setInfo(
          'Transcript registered with low trust. Use Verify X on this source so it becomes eligible for routing payouts.',
        );
      } else {
        setInfo('Source registered successfully with platform-bound ownership.');
      }
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
          ownerWallet: signerAddress,
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

  const openSocialVerify = async (source: RegistrySource) => {
    setError('');
    setInfo('');
    setVerifyPanelSourceId(source.id);
    setVerifyTweetUrl('');
    setIsLoadingProof(true);
    try {
      const proof = await requestJson<{
        tweetText: string;
        fingerprint: string;
        socialProofStatus: string;
        socialProofUrl?: string | null;
      }>(`/api/sources/${source.id}/social-proof`);
      setVerifyTweetText(proof.tweetText);
      if (proof.socialProofStatus === 'verified' && proof.socialProofUrl) {
        setVerifyTweetUrl(proof.socialProofUrl);
      }
    } catch (requestError) {
      setError((requestError as Error).message);
      setVerifyPanelSourceId(null);
    } finally {
      setIsLoadingProof(false);
    }
  };

  const copyVerifyText = async () => {
    if (!verifyTweetText) return;
    try {
      await navigator.clipboard.writeText(verifyTweetText);
      setInfo('Verification message copied. Post it on X, then paste the tweet URL below.');
    } catch {
      setError('Could not copy to clipboard. Select and copy the message manually.');
    }
  };

  const handleSocialVerify = async (source: RegistrySource) => {
    setError('');
    setInfo('');
    if (!verifyTweetUrl.trim()) {
      setError('Paste the public X/Twitter post URL that contains the fingerprint.');
      return;
    }

    setIsVerifyingSocial(true);
    try {
      let signer = connectedWallet.address;
      if (!signer) {
        signer = await onConnectWallet();
      }
      if (!signer) {
        throw new Error('Connect your wallet before verifying social proof.');
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

      if (source.wallet.toLowerCase() !== String(signer).toLowerCase()) {
        throw new Error('You can only verify sources owned by your wallet.');
      }

      const challengePayload = await requestJson<{ challenge: any }>('/api/auth/challenge', {
        method: 'POST',
        body: JSON.stringify({
          wallet: signer,
          purpose: 'social-verify',
        }),
      });
      const authSignature = await provider.request({
        method: 'personal_sign',
        params: [challengePayload.challenge.message, signer],
      });

      const response = await requestJson<{
        success: boolean;
        source: RegistrySource;
      }>(`/api/sources/${source.id}/social-proof`, {
        method: 'POST',
        body: JSON.stringify({
          wallet: signer,
          ownerWallet: signer,
          challengeId: challengePayload.challenge.id,
          authSignature: String(authSignature),
          tweetUrl: verifyTweetUrl.trim(),
        }),
      });

      if (response.success) {
        setInfo('Source socially verified via X post proof.');
        setVerifyPanelSourceId(null);
        setVerifyTweetUrl('');
        setVerifyTweetText('');
        await loadSources(String(signer));
        await loadSocials(String(signer));
      }
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsVerifyingSocial(false);
    }
  };

  const handleLinkSocial = async (platform: 'twitter' | 'medium', handleVal: string) => {
    setError('');
    setInfo('');
    if (!handleVal.trim()) {
      setError('Please enter a valid handle.');
      return;
    }

    setIsLinking(true);
    try {
      let signer = connectedWallet.address;
      if (!signer) {
        signer = await onConnectWallet();
      }
      if (!signer) {
        throw new Error('Connect your wallet before linking social accounts.');
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

      const challengePayload = await requestJson<{ challenge: any }>(
        '/api/auth/challenge',
        {
          method: 'POST',
          body: JSON.stringify({
            wallet: signer,
            purpose: 'link-social',
          }),
        },
      );
      const authSignature = await provider.request({
        method: 'personal_sign',
        params: [challengePayload.challenge.message, signer],
      });

      const response = await requestJson<{ success: boolean; handle: string }>('/api/socials/link', {
        method: 'POST',
        body: JSON.stringify({
          wallet: signer,
          ownerWallet: signer,
          challengeId: challengePayload.challenge.id,
          authSignature: String(authSignature),
          platform,
          handle: handleVal,
        }),
      });

      if (response.success) {
        setInfo(`Linked ${platform === 'twitter' ? 'Twitter/X' : 'Medium'} successfully!`);
        if (platform === 'twitter') {
          setLinkedTwitter(response.handle);
          setTwitterInput('');
        } else {
          setLinkedMedium(response.handle);
          setMediumInput('');
        }
        if (connectedWallet.address) {
          await loadSources(connectedWallet.address);
        }
      }
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setIsLinking(false);
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
                { id: 'identity', label: 'Verify Identity', icon: ShieldCheck },
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
                      Exact copies of existing content are blocked. Social posts must use your linked X URL;
                      Articles must use your linked Medium URL. Transcripts can be free-text but stay low-trust
                      until you Verify X.
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
                        {draft.kind === 'Social post'
                          ? 'X Post URL (required)'
                          : draft.kind === 'Article'
                            ? 'Medium URL (required)'
                            : 'Source URL (optional for transcripts)'}
                      </span>
                      <input
                        type="url"
                        placeholder={
                          draft.kind === 'Social post'
                            ? 'https://x.com/you/status/…'
                            : draft.kind === 'Article'
                              ? 'https://medium.com/@you/your-article'
                              : 'https://example.com/transcript (optional)'
                        }
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
                      <p className="mt-1.5 text-[10px] text-white/40">
                        {draft.kind === 'Social post' && (
                          <>
                            Must be from your linked X handle
                            {linkedTwitter ? ` (@${linkedTwitter})` : ' (link it in Identity first)'}.
                          </>
                        )}
                        {draft.kind === 'Article' && (
                          <>
                            Must be from your linked Medium profile
                            {linkedMedium ? ` (@${linkedMedium})` : ' (link it in Identity first)'}.
                          </>
                        )}
                        {draft.kind === 'Transcript' && (
                          <>
                            Free-text transcripts are allowed but stay low-trust until social proof.
                          </>
                        )}
                      </p>
                    </label>

                    {draft.kind === 'Transcript' && (
                      <label className="block">
                        <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                          Transcript Text Content
                        </span>
                        <textarea
                          placeholder="Paste or write the transcript text to register."
                          value={draft.content}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, content: event.target.value }))
                          }
                          className="min-h-32 w-full resize-none rounded-[8px] border border-white/10 bg-black/30 p-3 text-sm font-medium leading-relaxed text-white outline-none transition placeholder:text-white/25 focus:border-[#5FBF7A]/80"
                        />
                      </label>
                    )}
                    {draft.kind !== 'Transcript' && !draft.url && (
                      <p className="rounded-[8px] border border-[#F4845F]/25 bg-[#F4845F]/8 px-3 py-2 text-[11px] text-[#F7B49D]">
                        Free-text paste is blocked for {draft.kind}. Provide your own platform URL and generate a
                        preview.
                      </p>
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
                          const isVerifyOpen = verifyPanelSourceId === item.id;
                          return (
                            <div key={item.id} className="p-3 space-y-2">
                              <div className="flex items-center justify-between gap-3">
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
                                    <p className="text-[10px] text-white/34 mt-0.5">
                                      {formatUsd(item.price)} USDC · {shortFingerprint(item.fingerprint)}
                                    </p>
                                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                      {item.ownershipVerified && (
                                        <span className="inline-flex items-center rounded bg-white/8 border border-white/12 px-1.5 py-0.5 text-[9px] font-extrabold text-white/70">
                                          Wallet signed
                                        </span>
                                      )}
                                      {item.contentTrust === 'platform_bound' && (
                                        <span className="inline-flex items-center rounded bg-[#5FBF7A]/12 border border-[#5FBF7A]/20 px-1.5 py-0.5 text-[9px] font-extrabold text-[#8CE0A0]">
                                          Platform bound
                                        </span>
                                      )}
                                      {item.contentTrust === 'unbound' && (
                                        <span className="inline-flex items-center rounded bg-[#F4845F]/12 border border-[#F4845F]/20 px-1.5 py-0.5 text-[9px] font-extrabold text-[#F7B49D]">
                                          Low trust
                                        </span>
                                      )}
                                      {item.registryTxHash && item.registryStatus === 'registered' && (
                                        <a
                                          href={`https://testnet.arcscan.app/tx/${item.registryTxHash}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 rounded bg-[#5FA9FF]/12 border border-[#5FA9FF]/20 px-1.5 py-0.5 text-[9px] font-extrabold text-[#9CCCFF] hover:underline"
                                        >
                                          On-Chain
                                        </a>
                                      )}
                                      {item.sociallyVerified || item.socialProofStatus === 'verified' ? (
                                        <a
                                          href={item.socialProofUrl || undefined}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-0.5 rounded bg-[#5FBF7A]/12 border border-[#5FBF7A]/20 px-1.5 py-0.5 text-[9px] font-extrabold text-[#8CE0A0] hover:underline"
                                        >
                                          Socially Verified
                                          {item.socialProofHandle ? ` · @${item.socialProofHandle}` : ''}
                                        </a>
                                      ) : item.twitterHandle ? (
                                        <span className="inline-flex items-center gap-0.5 rounded bg-[#5FA9FF]/12 border border-[#5FA9FF]/20 px-1.5 py-0.5 text-[9px] font-extrabold text-[#9CCCFF]">
                                          🐦 @{item.twitterHandle}
                                        </span>
                                      ) : null}
                                      {item.mediumHandle && (
                                        <span className="inline-flex items-center gap-0.5 rounded bg-[#5FBF7A]/12 border border-[#5FBF7A]/20 px-1.5 py-0.5 text-[9px] font-extrabold text-[#8CE0A0]">
                                          📝 @{item.mediumHandle}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {!(item.sociallyVerified || item.socialProofStatus === 'verified') && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        isVerifyOpen ? setVerifyPanelSourceId(null) : openSocialVerify(item)
                                      }
                                      className="rounded-full border border-white/12 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-white/70 hover:bg-white/5 hover:text-white transition"
                                    >
                                      Verify X
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleArchive(item)}
                                    disabled={isArchiving[item.id]}
                                    className="rounded-full p-1.5 hover:bg-white/5 text-white/50 hover:text-[#F7B49D] transition"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>

                              {isVerifyOpen && (
                                <div className="rounded-[8px] border border-white/10 bg-black/25 p-3 space-y-2">
                                  <p className="text-[11px] font-semibold text-white/70">
                                    Post this exact message on X, then paste the public tweet URL:
                                  </p>
                                  <div className="flex gap-2">
                                    <code className="flex-1 break-all rounded border border-white/10 bg-black/40 px-2 py-1.5 text-[10px] text-[#9CCCFF]">
                                      {isLoadingProof ? 'Loading verification message…' : verifyTweetText || '—'}
                                    </code>
                                    <button
                                      type="button"
                                      onClick={copyVerifyText}
                                      disabled={!verifyTweetText}
                                      className="rounded border border-white/12 px-2 py-1 text-[10px] font-bold uppercase text-white/75 hover:bg-white/5 disabled:opacity-40"
                                    >
                                      Copy
                                    </button>
                                  </div>
                                  <div className="flex gap-2">
                                    <input
                                      type="url"
                                      placeholder="https://x.com/you/status/…"
                                      value={verifyTweetUrl}
                                      onChange={(e) => setVerifyTweetUrl(e.target.value)}
                                      className="flex-1 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2 text-xs font-medium text-white outline-none focus:border-[#5FBF7A]/80"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => handleSocialVerify(item)}
                                      disabled={isVerifyingSocial || !verifyTweetUrl.trim()}
                                      className="rounded-[8px] bg-white px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-black hover:bg-[#5FA9FF] transition disabled:opacity-40"
                                    >
                                      {isVerifyingSocial ? 'Checking…' : 'Submit proof'}
                                    </button>
                                  </div>
                                  <p className="text-[10px] text-white/40">
                                    Optional but recommended. Verified sources get a stronger routing preference.
                                  </p>
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'identity' && (
              <div className="space-y-6 max-w-3xl">
                <div className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4 space-y-4">
                  <div className="border-b border-white/10 pb-3">
                    <h3 className="text-base font-bold text-white">Verify Publishing Channels</h3>
                    <p className="text-xs leading-relaxed text-white/55 mt-0.5">
                      Link your X (Twitter) or Medium accounts to this wallet, then use <span className="text-white/80 font-semibold">Verify X</span> on each registered source to post a fingerprint proof tweet. Tweet proof is stronger than handle linking alone.
                    </p>
                  </div>

                  <div className="space-y-6">
                    {/* Twitter Linking */}
                    <div className="space-y-3">
                      <span className="block text-xs font-bold uppercase tracking-[0.16em] text-white/60">
                        🐦 X / Twitter Account
                      </span>
                      {linkedTwitter ? (
                        <div className="flex items-center justify-between rounded-[8px] border border-[#5FBF7A]/20 bg-[#5FBF7A]/5 px-3 py-2 text-sm font-semibold text-[#8CE0A0]">
                          <span>Linked Handle: @{linkedTwitter}</span>
                          <span className="text-xs font-bold uppercase tracking-wider text-[#5FBF7A]">Active</span>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder="Enter X handle (e.g. @myhandle)"
                            value={twitterInput}
                            onChange={(e) => setTwitterInput(e.target.value)}
                            className="flex-1 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2 text-sm font-medium text-white outline-none focus:border-[#5FBF7A]/80"
                          />
                          <button
                            type="button"
                            onClick={() => handleLinkSocial('twitter', twitterInput)}
                            disabled={isLinking || !twitterInput.trim()}
                            className="rounded-[8px] bg-white px-4 py-2 text-xs font-bold text-black uppercase tracking-[0.10em] hover:bg-[#5FA9FF] transition disabled:opacity-40"
                          >
                            Link X
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Medium Linking */}
                    <div className="space-y-3">
                      <span className="block text-xs font-bold uppercase tracking-[0.16em] text-white/60">
                        📝 Medium Publication Profile
                      </span>
                      {linkedMedium ? (
                        <div className="flex items-center justify-between rounded-[8px] border border-[#5FBF7A]/20 bg-[#5FBF7A]/5 px-3 py-2 text-sm font-semibold text-[#8CE0A0]">
                          <span>Linked Profile: @{linkedMedium}</span>
                          <span className="text-xs font-bold uppercase tracking-wider text-[#5FBF7A]">Active</span>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder="Enter Medium handle (e.g. @myhandle)"
                            value={mediumInput}
                            onChange={(e) => setMediumInput(e.target.value)}
                            className="flex-1 rounded-[8px] border border-white/10 bg-black/30 px-3 py-2 text-sm font-medium text-white outline-none focus:border-[#5FBF7A]/80"
                          />
                          <button
                            type="button"
                            onClick={() => handleLinkSocial('medium', mediumInput)}
                            disabled={isLinking || !mediumInput.trim()}
                            className="rounded-[8px] bg-white px-4 py-2 text-xs font-bold text-black uppercase tracking-[0.10em] hover:bg-[#5FA9FF] transition disabled:opacity-40"
                          >
                            Link Medium
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
