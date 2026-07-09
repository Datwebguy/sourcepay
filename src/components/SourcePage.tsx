import { useEffect, useState } from 'react';
import { ArrowLeft, FileText } from 'lucide-react';
import type { Receipt, SourceDetail } from '../types';
import {
  formatUsd,
  maskAddress,
  requestJson,
  shortFingerprint,
  formatStatus,
} from '../utils';
import { sourceKindIcons } from './Common';

export function SourcePage({
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
                  {source.registryTxHash && source.registryStatus === 'registered' && (
                    <a
                      href={`https://testnet.arcscan.app/tx/${source.registryTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-full border border-[#5FA9FF]/25 bg-[#5FA9FF]/10 px-2.5 py-1 text-xs font-bold text-[#9CCCFF] hover:underline"
                    >
                      On-Chain Registered
                    </a>
                  )}
                  {(source.sociallyVerified || source.socialProofStatus === 'verified') && (
                    <a
                      href={source.socialProofUrl || undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-full border border-[#5FBF7A]/25 bg-[#5FBF7A]/10 px-2.5 py-1 text-xs font-bold text-[#8CE0A0] hover:underline"
                    >
                      Socially Verified
                      {source.socialProofHandle ? ` · @${source.socialProofHandle}` : ''}
                    </a>
                  )}
                  {source.twitterHandle && !(source.sociallyVerified || source.socialProofStatus === 'verified') && (
                    <span className="rounded-full border border-[#5FA9FF]/25 bg-[#5FA9FF]/10 px-2.5 py-1 text-xs font-bold text-[#9CCCFF]">
                      🐦 @{source.twitterHandle}
                    </span>
                  )}
                  {source.mediumHandle && (
                    <span className="rounded-full border border-[#5FBF7A]/25 bg-[#5FBF7A]/10 px-2.5 py-1 text-xs font-bold text-[#8CE0A0]">
                      📝 @{source.mediumHandle}
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
                  Source preview
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
                    ['Paid earnings', `${formatUsd(detail.totals.paidAmount)} USDC`],
                    [
                      'Quoted pending',
                      `${formatUsd(detail.totals.quotedAmount - detail.totals.paidAmount)} USDC`,
                    ],
                    [
                      'Paid citations',
                      `${detail.totals.paidCitations} / ${detail.totals.citations}`,
                    ],
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
                          <span>{formatUsd(citation.paidAmount)} paid</span>
                          {citation.quotedAmount > citation.paidAmount && (
                            <span>
                              {formatUsd(citation.quotedAmount - citation.paidAmount)} quoted
                            </span>
                          )}
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
