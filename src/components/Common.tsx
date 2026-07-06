import { Component, type ReactNode } from 'react';
import {
  CircleDollarSign,
  Database,
  ShieldCheck,
  FileText,
  MessageSquareText,
  Mic2,
  ReceiptText,
} from 'lucide-react';
import type { HeroSource, ErrorBoundaryProps, ErrorBoundaryState } from '../types';

export const heroIcons = {
  article: FileText,
  social: MessageSquareText,
  transcript: Mic2,
  receipt: ReceiptText,
};

export const sourceKindIcons = {
  Article: FileText,
  'Social post': MessageSquareText,
  Transcript: Mic2,
};

export function GrainOverlay() {
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

export function SourceVisual({ item }: { item: HeroSource }) {
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

export function SourcePayMark({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <img
      src="/sourcepay-mark.svg"
      alt="SourcePay"
      className={`${className} rounded-[8px] shadow-lg shadow-black/20`}
    />
  );
}

export function MetricCard({
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

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
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
