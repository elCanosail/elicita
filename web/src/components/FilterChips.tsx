import * as React from 'react';

export interface FilterChipDef {
  key: string;
  label: string;
  value: any;
  display: string;
}

export interface FilterChipsProps {
  chips: FilterChipDef[];
  onRemove: (key: string, value?: any) => void;
  onClearAll: () => void;
  resultCount?: number;
  isLoading?: boolean;
}

export function FilterChips({
  chips,
  onRemove,
  onClearAll,
  resultCount,
  isLoading,
}: FilterChipsProps) {
  if (chips.length === 0 && resultCount == null) return null;

  return (
    <>
      <div className="fc-bar flex items-start justify-between gap-4 py-3 pb-4 flex-wrap">
        <div className="fc-chips flex flex-wrap items-center gap-2 flex-1 min-w-0">
          {chips.map((chip) => (
            <button
              key={`${chip.key}-${JSON.stringify(chip.value)}`}
              type="button"
              className="fc-chip inline-flex items-center gap-[5px] max-w-full py-[5px] pl-[10px] pr-2 bg-[hsl(var(--primary)/0.08)] border border-[hsl(var(--primary)/0.2)] rounded-2xl text-xs text-[hsl(var(--foreground)/0.75)] cursor-pointer transition-all duration-[120ms] no-underline hover:bg-[hsl(var(--primary)/0.14)] hover:border-[hsl(var(--primary)/0.35)] hover:text-[hsl(var(--foreground)/0.9)]"
              onClick={() => onRemove(chip.key, chip.value)}
              aria-label={`Quitar filtro ${chip.label}: ${chip.display}`}
            >
              <span className="fc-chip-label font-[JetBrains_Mono] text-[9px] uppercase tracking-[0.05em] text-[hsl(var(--primary)/0.8)] whitespace-nowrap">
                {chip.label}
              </span>
              <span className="fc-chip-sep text-[hsl(var(--foreground)/0.25)] mx-px">
                :
              </span>
              <span
                className="fc-chip-value max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap"
                title={chip.display}
              >
                {chip.display}
              </span>
              <span
                className="fc-chip-remove inline-flex items-center justify-center w-4 h-4 rounded-full bg-[hsl(var(--background)/0.2)] text-[hsl(var(--foreground)/0.5)] transition-all duration-[120ms] shrink-0 group-hover:bg-[hsl(var(--primary)/0.2)] group-hover:text-[hsl(var(--primary))]"
                aria-hidden="true"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </span>
            </button>
          ))}
          {chips.length > 0 && (
            <button
              type="button"
              className="fc-clear-all py-[5px] px-[10px] bg-transparent border border-[hsl(var(--foreground)/0.1)] rounded-[14px] text-[hsl(var(--foreground)/0.45)] text-xs cursor-pointer transition-all duration-[120ms] shrink-0 hover:bg-[hsl(var(--foreground)/0.05)] hover:border-[hsl(var(--foreground)/0.18)] hover:text-[hsl(var(--foreground)/0.75)]"
              onClick={onClearAll}
            >
              Limpiar todo
            </button>
          )}
        </div>
        {resultCount != null && (
          <div className="fc-count flex items-baseline gap-[5px] shrink-0 pt-1">
            {isLoading ? (
              <span className="fc-count-pulse text-xs text-[hsl(var(--primary)/0.7)] animate-[fcPulse_1.2s_ease-in-out_infinite]">
                Actualizando…
              </span>
            ) : (
              <>
                <span className="fc-count-number font-[JetBrains_Mono] text-sm text-[hsl(var(--foreground)/0.85)]">
                  {resultCount.toLocaleString('es-ES')}
                </span>
                <span className="fc-count-label text-xs text-[hsl(var(--foreground)/0.35)]">
                  resultado{resultCount === 1 ? '' : 's'}
                </span>
              </>
            )}
          </div>
        )}
      </div>
      <style>{`
        @keyframes fcPulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        @media (max-width: 767px) {
          .fc-bar {
            padding-top: 10px;
            padding-bottom: 12px;
          }
          .fc-count {
            display: none;
          }
        }
      `}</style>
    </>
  );
}
