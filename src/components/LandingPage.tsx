import { useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useSmallViewport } from '../App';
import { HERO_SOURCES } from '../utils';
import type { Direction } from '../types';
import { GrainOverlay, SourcePayMark, SourceVisual } from './Common';

export function LandingPage({ onLaunch }: { onLaunch: () => void }) {
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
        <span>Arc Testnet</span>
        <span>USDC</span>
        <span>x402</span>
        <span>Verified ownership</span>
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

      <div className="absolute bottom-5 left-4 z-[60] max-w-[220px] sm:bottom-20 sm:left-24 sm:max-w-[360px]">
        <p className="mb-2 text-base font-bold uppercase tracking-normal text-white opacity-95 sm:mb-3 sm:text-[22px]">
          Own the cite. Get paid.
        </p>
        <p className="mb-5 hidden text-sm leading-[1.6] text-white opacity-85 sm:block">
          Creators prove ownership with wallet signatures, X/Medium binding, and
          on-chain fingerprints. Agents route citations and settle nanopayments
          in USDC on Arc Testnet via x402.
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
