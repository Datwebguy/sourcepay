import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CircleDollarSign,
  Download,
  Share2,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import type {
  ConnectedWallet,
  WalletConnector,
  Receipt,
  SafeConfig,
  WalletBalanceCheck,
  ReceiptPaymentRequirements,
} from '../types';
import {
  formatUsd,
  maskAddress,
  formatUsdcAtomic,
  getEthereumProvider,
  resolvePayingAccount,
  sameWalletAddress,
  recoverPaymentSignatureAddress,
  ensureArcNetwork,
  readUsdcBalance,
  requestJson,
  requestJsonWithStatus,
  receiptDisplayUrl,
  receiptAccessQuery,
  receiptAccessBody,
  apiPath,
  formatStatus,
  paymentTone,
  paymentStateCopy,
  isPublicReceiptStatus,
} from '../utils';
import { SourcePayMark } from './Common';

interface ReceiptPageProps {
  id: string;
  initialReceipt: Receipt | null;
  initialAccessToken?: string | null;
  onBack: () => void;
  connectedWallet: ConnectedWallet;
  onConnectWallet: (connector?: WalletConnector) => Promise<string | null>;
  isConnectingWallet: boolean;
}

export function ReceiptPage({
  id,
  initialReceipt,
  initialAccessToken,
  onBack,
  connectedWallet,
  onConnectWallet,
  isConnectingWallet,
}: ReceiptPageProps) {
  const [receipt, setReceipt] = useState<Receipt | null>(initialReceipt);
  const [safeConfig, setSafeConfig] = useState<SafeConfig | null>(null);
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
        setLoadError(
          'Receipt is taking too long to load. Refresh the page or return to Requests and open the latest receipt.',
        );
      }
    }, 18_000);
    setReceipt(initialReceipt);
    setLoadError('');
    setPaymentNotice('');
    setReceiptNotice('');
    setVerificationNotice('');

    const accessToken = initialReceipt?.accessToken ?? initialAccessToken ?? null;

    requestJson<{ config: SafeConfig }>('/api/config')
      .then((payload) => setSafeConfig(payload.config))
      .catch(() => {});

    requestJson<{ receipt: Receipt }>(
      apiPath(`/api/receipts/${id}`, { access: accessToken }),
    )
      .then((payload) => {
        if (!ignore) {
          window.clearTimeout(timeoutId);
          setReceipt({
            ...payload.receipt,
            accessToken: payload.receipt.accessToken ?? accessToken,
          });
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
  }, [id, initialReceipt, initialAccessToken]);

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

    // Prefer the wallet's currently selected account for balance (matches signing).
    resolvePayingAccount(provider)
      .catch(() => connectedWallet.address as string)
      .then((activeWallet) =>
        ensureArcNetwork(provider).then(() =>
          readUsdcBalance({
            provider,
            receipt: receipt as Receipt,
            wallet: activeWallet,
          }),
        ),
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

  // Polling logic for status check 'paid' -> 'settled'
  useEffect(() => {
    if (!receipt || receipt.paymentStatus !== 'paid') return;

    let ignore = false;
    let timerId: number | undefined;

    const poll = async () => {
      try {
        const accessToken = receipt.accessToken ?? initialAccessToken ?? null;
        const payload = await requestJson<{ receipt: Receipt }>(
          apiPath(`/api/receipts/${id}`, { access: accessToken }),
        );
        if (ignore) return;

        if (payload.receipt.paymentStatus === 'settled') {
          setReceipt({
            ...payload.receipt,
            accessToken: payload.receipt.accessToken ?? accessToken,
          });
          setPaymentNotice('Creators paid. Settlements confirmed on-chain.');
        } else {
          timerId = window.setTimeout(poll, 4000);
        }
      } catch (err) {
        console.error('Polling error:', err);
        if (!ignore) {
          timerId = window.setTimeout(poll, 4000);
        }
      }
    };

    timerId = window.setTimeout(poll, 4000);

    return () => {
      ignore = true;
      if (timerId) window.clearTimeout(timerId);
    };
  }, [id, receipt?.paymentStatus, receipt?.accessToken, initialAccessToken]);

  const attemptPayment = async () => {
    setIsPaying(true);
    setPaymentNotice('');

    try {
      if (!connectedWallet.address) {
        const connected = await onConnectWallet();
        if (!connected) {
          setPaymentNotice('Connect your wallet before settling this receipt.');
          return;
        }
      }
      const provider = getEthereumProvider();
      if (!provider) {
        setPaymentNotice('A browser wallet is required to settle this receipt.');
        return;
      }
      await ensureArcNetwork(provider);

      // If the wallet signs with a different key than eth_accounts reported, we lock onto
      // the recovered signer for a second prepare+sign pass (do NOT re-call eth_requestAccounts,
      // which often returns the stale "connected" account and overwrites the true signer).
      let forcedPayer: string | null = null;
      let payments: Array<Record<string, unknown>> = [];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const payer = forcedPayer ?? (await resolvePayingAccount(provider));
        const preparedFor = payer;
        setPaymentNotice(
          attempt === 0
            ? `Preparing payment with ${maskAddress(payer)}…`
            : `Rebuilding payment for the account that signed (${maskAddress(payer)})…`,
        );

        const requirementsPayload = await requestJson<ReceiptPaymentRequirements>(
          apiPath(`/api/receipts/${id}/payment-requirements`, {
            access: receipt?.accessToken,
            payer,
          }),
        );
        payments = [];
        let restartWithPayer: string | null = null;

        for (const item of requirementsPayload.requirements) {
          if (!item.typedData) {
            setPaymentNotice('This receipt could not be prepared for payment.');
            return;
          }

          const { paymentPayloadTemplate, ...signableTypedData } = item.typedData;
          const messageFrom = String(
            (signableTypedData as { message?: { from?: string } }).message?.from ?? payer,
          );
          // Always sign with the address embedded in typed data (authorization.from).
          const signAddress = messageFrom || payer;

          if (!sameWalletAddress(signAddress, payer)) {
            restartWithPayer = signAddress;
            break;
          }

          const signature = String(
            await provider.request({
              method: 'eth_signTypedData_v4',
              params: [signAddress, JSON.stringify(signableTypedData)],
            }),
          );

          const recovered = await recoverPaymentSignatureAddress({
            typedData: signableTypedData as {
              domain: Record<string, unknown>;
              types: Record<string, unknown>;
              primaryType: string;
              message: Record<string, unknown>;
            },
            signature,
          });

          if (recovered && !sameWalletAddress(recovered, signAddress)) {
            restartWithPayer = recovered;
            break;
          }

          const templatePayload =
            paymentPayloadTemplate && typeof paymentPayloadTemplate === 'object'
              ? paymentPayloadTemplate
              : null;
          const templateInnerPayload =
            templatePayload?.payload && typeof templatePayload.payload === 'object'
              ? (templatePayload.payload as Record<string, unknown>)
              : {};
          const templateAuthorization =
            templateInnerPayload.authorization && typeof templateInnerPayload.authorization === 'object'
              ? (templateInnerPayload.authorization as Record<string, unknown>)
              : item.typedData.message;

          payments.push({
            sourceId: item.sourceId,
            paymentPayload: templatePayload
              ? {
                  ...templatePayload,
                  payload: {
                    ...templateInnerPayload,
                    authorization: templateAuthorization,
                    signature,
                  },
                }
              : undefined,
            authorization: templatePayload ? undefined : item.typedData.message,
            signature: templatePayload ? undefined : signature,
          });
        }

        if (restartWithPayer) {
          if (attempt === 0) {
            setPaymentNotice(
              `Wallet used ${maskAddress(restartWithPayer)} to sign (not ${maskAddress(preparedFor)}). Rebuilding payment for that account — approve again…`,
            );
            forcedPayer = restartWithPayer;
            continue;
          }
          throw new Error(
            `Payment signature was produced by ${maskAddress(restartWithPayer)}, but typed data was for ${maskAddress(preparedFor)}. Open your wallet, switch the active account to ${maskAddress(restartWithPayer)}, then click Approve & Pay once more.`,
          );
        }

        break;
      }

      if (payments.length === 0) {
        setPaymentNotice('No payment approvals were created. Try Approve & Pay again.');
        return;
      }

      setPaymentNotice('Submitting signed payment…');
      const response = await requestJsonWithStatus<{
        payment?: { status: string; reason: string };
        receipt?: Receipt;
        error?: string;
      }>(`/api/receipts/${id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ ...receiptAccessBody(receipt), payments }),
      });

      if (response.payload.receipt) {
        setReceipt(response.payload.receipt);
      }
      setPaymentNotice(
        response.ok
          ? 'Creators paid. This receipt is now complete.'
          : response.payload.payment?.reason || response.payload.error || 'Payment was not completed.',
      );
    } catch (requestError) {
      setPaymentNotice((requestError as Error).message);
    } finally {
      setIsPaying(false);
    }
  };

  const attemptAgentPayment = async () => {
    setIsPaying(true);
    setPaymentNotice('');

    try {
      const response = await requestJsonWithStatus<{
        payment?: { status: string; reason: string };
        receipt?: Receipt;
        error?: string;
      }>(`/api/receipts/${id}/pay`, {
        method: 'POST',
        body: JSON.stringify({
          ...receiptAccessBody(receipt),
          payWithAgentWallet: true,
        }),
      });

      if (response.payload.receipt) {
        setReceipt(response.payload.receipt);
      }
      setPaymentNotice(
        response.ok
          ? 'Creators paid autonomously via Agent Wallet. This receipt is now complete.'
          : response.payload.payment?.reason || response.payload.error || 'Payment was not completed.',
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
        `/api/receipts/${id}/proof${receiptAccessQuery(receipt)}`,
      );
      const content = JSON.stringify(payload.proof, null, 2);
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const element = document.createElement('a');
      element.href = url;
      element.download = `receipt-${id.slice(0, 8)}-proof.json`;
      element.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setReceiptNotice((requestError as Error).message);
    }
  };

  const shareReceipt = async () => {
    setPaymentNotice('');
    setReceiptNotice('');
    setVerificationNotice('');

    const targetUrl = receiptDisplayUrl(id, receipt);
    if (navigator.share) {
      navigator
        .share({
          title: 'SourcePay receipt',
          text: `SourcePay citation receipt for "${receipt?.question}"`,
          url: targetUrl,
        })
        .catch(() => {});
    } else {
      navigator.clipboard
        .writeText(targetUrl)
        .then(() => setReceiptNotice('Receipt link copied to clipboard.'))
        .catch(() => setReceiptNotice('Failed to copy link.'));
    }
  };

  const verifyProof = async () => {
    setIsVerifying(true);
    setPaymentNotice('');
    setReceiptNotice('');
    setVerificationNotice('');

    try {
      const payload = await requestJson<{ proof: unknown }>(
        `/api/receipts/${id}/proof${receiptAccessQuery(receipt)}`,
      );
      const response = await requestJson<{ verification: { valid: boolean; reason?: string } }>(
        '/api/proofs/verify',
        {
          method: 'POST',
          body: JSON.stringify({ proof: payload.proof }),
        },
      );
      setVerificationNotice(
        response.verification.valid
          ? 'Receipt verification successful. The cryptographic signatures and contents match.'
          : response.verification.reason || 'Receipt verification failed.',
      );
    } catch (requestError) {
      setVerificationNotice((requestError as Error).message);
    } finally {
      setIsVerifying(false);
    }
  };

  const tone = receipt ? paymentTone(receipt.paymentStatus) : null;
  const isPaidOrSettled = receipt ? isPublicReceiptStatus(receipt.paymentStatus) : false;

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
            <SourcePayMark />
            <div>
              <p className="text-sm font-bold">Citation receipt</p>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">
                payment details
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 rounded-full border border-white/14 px-4 py-2 text-sm font-bold text-white/72 transition hover:border-white/40 hover:text-white"
          >
            <ArrowLeft size={17} strokeWidth={2.25} />
            Console
          </button>
        </header>

        {loadError ? (
          <div className="px-4 py-16 text-center">
            <p className="text-lg font-bold">Receipt unavailable</p>
            <p className="mt-2 text-sm font-medium text-white/45">{loadError}</p>
          </div>
        ) : !receipt ? (
          <div className="px-4 py-16 text-center text-sm font-semibold text-white/42">
            Loading receipt details.
          </div>
        ) : (
          <div className="grid gap-4 p-3 sm:p-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <section className="overflow-hidden rounded-[8px] border border-white/10 bg-[#111]/90">
              <div className="border-b border-white/10 px-4 py-4">
                <div className="mb-3 flex items-center justify-between">
                  <span
                    className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${tone?.text} ${tone?.border} ${tone?.background}`}
                  >
                    {tone?.label}
                  </span>
                  <span className="text-xs text-white/40">
                    {new Date(receipt.createdAt).toLocaleString()}
                  </span>
                </div>
                <h1 className="max-w-3xl text-xl font-bold leading-tight sm:text-2xl">
                  {receipt.question}
                </h1>
              </div>

              <div className="border-b border-white/10 p-4">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                  Citations and price details
                </p>
                <div className="overflow-hidden rounded-[8px] border border-white/10 bg-black/18">
                  <div className="divide-y divide-white/[0.06]">
                    {receipt.sources.map((source, idx) => (
                      <div
                        key={source.id}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                      >
                        <div>
                          <p className="font-semibold text-white">{source.title}</p>
                          <p className="text-xs text-white/42">
                            rank {source.rank ?? idx + 1} · {source.kind}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-[#8CE0A0]">
                            {formatUsd(source.price)} USDC
                          </p>
                          <p className="text-xs text-white/42 font-mono">
                            {maskAddress(source.wallet)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="p-4">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                  Verification proof metadata
                </p>
                <div className="rounded-[8px] border border-white/10 bg-black/24 p-4 font-mono text-xs text-white/58 space-y-2">
                  <div className="flex items-center justify-between border-b border-white/[0.05] pb-2">
                    <span className="text-white/34">Receipt ID</span>
                    <span className="font-semibold text-white">{receipt.id}</span>
                  </div>
                  <div className="flex items-center justify-between border-b border-white/[0.05] pb-2">
                    <span className="text-white/34">Payment rail</span>
                    <span>{receipt.rail}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/34">Settlement network</span>
                    <span>{receipt.network}</span>
                  </div>
                </div>
              </div>
            </section>

            <aside className="space-y-4">
              <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4">
                <div className="mb-4 rounded-[8px] border border-[#5FA9FF]/35 bg-[#5FA9FF]/14 p-4">
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#9CCCFF]">
                    quoted amount
                  </p>
                  <p className="text-3xl font-bold text-white">
                    {formatUsd(receipt.totalSpend)}
                  </p>
                  <p className="text-sm font-semibold text-white/50">USDC</p>
                </div>

                {!isPaidOrSettled && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={attemptPayment}
                      disabled={isPaying || receipt.sources.length === 0}
                      className="w-full rounded-[8px] bg-white px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-[#5FA9FF] disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {isPaying ? 'Processing payment...' : 'Approve & Pay receipt'}
                    </button>
                    {safeConfig?.agentWallet && (
                      <div className="pt-2 border-t border-white/5">
                        <button
                          type="button"
                          onClick={attemptAgentPayment}
                          disabled={isPaying || receipt.sources.length === 0}
                          className="w-full rounded-[8px] bg-[#5FA9FF] px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.12em] text-black transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          {isPaying ? 'Processing Agent Payout...' : 'Pay via Agent Wallet'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
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
                        ? `Active wallet ${maskAddress(connectedWallet.address)} USDC is below the quote. Switch the selected account in your wallet if needed.`
                        : walletBalanceCheck.enough === true
                          ? `Wallet ${maskAddress(connectedWallet.address)} has enough USDC for this receipt.`
                          : walletBalanceCheck.error || 'Wallet USDC balance could not be checked.'}
                  </p>
                )}
                <div className="mt-3 rounded-[8px] border border-white/10 bg-white/[0.025] p-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/38">
                    {isPaidOrSettled ? 'Public paid receipt' : 'Private quote link'}
                  </p>
                  <p className="mt-2 break-all font-mono text-xs font-semibold text-white/58">
                    {receiptDisplayUrl(id, receipt)}
                  </p>
                  {!isPaidOrSettled && (
                    <p className="mt-2 text-xs font-semibold leading-relaxed text-white/40">
                      This quote is not public until payment is completed.
                    </p>
                  )}
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
                          isPaidOrSettled
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
                          <span className="font-semibold">{formatStatus(attempt.status)}</span>
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

              {receipt.paymentSettlements && receipt.paymentSettlements.length > 0 && (
                <section className="rounded-[8px] border border-white/10 bg-[#111]/90 p-4">
                  <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-white/42">
                    Settlements
                  </p>
                  <div className="space-y-3">
                    {receipt.paymentSettlements.map((settlement) => (
                      <div
                        key={settlement.id}
                        className="rounded-[8px] border border-white/10 bg-white/[0.025] p-3 text-sm"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold">
                            {formatUsdcAtomic(BigInt(settlement.amount))} USDC
                          </span>
                          <span className="text-xs font-semibold text-white/38">
                            {settlement.network}
                          </span>
                        </div>
                        <div className="mt-2 space-y-1 font-mono text-[11px] text-white/42">
                          <p>payer {maskAddress(settlement.payer)}</p>
                          <p>payTo {maskAddress(settlement.payTo)}</p>
                          <p className="break-all">
                            tx{' '}
                            {settlement.transactionId ? (
                              <a
                                href={`https://testnet.arcscan.app/tx/${settlement.transactionId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[#9CCCFF] hover:underline"
                              >
                                {settlement.transactionId}
                              </a>
                            ) : (
                              'pending'
                            )}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}
