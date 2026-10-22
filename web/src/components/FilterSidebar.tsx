import * as React from 'react';

export interface FilterConfig {
  key: string;
  label: string;
  type: 'multiselect' | 'range' | 'daterange' | 'autocomplete';
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export interface FilterSidebarProps {
  filters: FilterConfig[];
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
  resultCount: number;
  isLoading?: boolean;
}

const STORAGE_KEY = 'elicita_filters_open';
const MOBILE_BREAKPOINT = 767;

export function FilterSidebar({
  filters,
  values,
  onChange,
  resultCount,
  isLoading,
}: FilterSidebarProps) {
  const [open, setOpen] = React.useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  });
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);
  const [search, setSearch] = React.useState<Record<string, string>>({});
  const [autocompleteOpen, setAutocompleteOpen] = React.useState<Record<string, boolean>>({});
  const [focusedAutocomplete, setFocusedAutocomplete] = React.useState<string | null>(null);

  React.useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, String(open));
  }, [open]);

  const toggleSidebar = () => setOpen((v) => !v);
  const openMobile = () => setMobileOpen(true);
  const closeMobile = () => setMobileOpen(false);

  const handleMultiSelectToggle = (key: string, value: string) => {
    const current: string[] = values[key] || [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange(key, next.length ? next : undefined);
  };

  const handleRangeChange = (key: string, subKey: 'min' | 'max', value: string) => {
    const current = values[key] || {};
    const num = value === '' ? undefined : Number(value);
    onChange(key, { ...current, [subKey]: num });
  };

  const handleDateChange = (key: string, subKey: 'from' | 'to', value: string) => {
    const current = values[key] || {};
    onChange(key, { ...current, [subKey]: value || undefined });
  };

  const handleAutocompleteChange = (key: string, value: string) => {
    onChange(key, value || undefined);
  };

  const clearAll = () => {
    filters.forEach((f) => onChange(f.key, undefined));
  };

  const hasActiveFilters = filters.some((f) => {
    const v = values[f.key];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.values(v).some((x) => x != null && x !== '');
    return String(v).length > 0;
  });

  const activeFilterCount = filters.reduce((acc, f) => {
    const v = values[f.key];
    if (v == null) return acc;
    if (Array.isArray(v)) return acc + (v.length > 0 ? 1 : 0);
    if (typeof v === 'object') return acc + (Object.values(v).some((x) => x != null && x !== '') ? 1 : 0);
    return acc + (String(v).length > 0 ? 1 : 0);
  }, 0);

  const resultText = `${resultCount.toLocaleString('es-ES')} resultado${resultCount === 1 ? '' : 's'}`;

  const renderField = (filter: FilterConfig) => {
    const value = values[filter.key];

    switch (filter.type) {
      case 'multiselect': {
        const selected: string[] = value || [];
        const opts = filter.options || [];
        const searchTerm = search[filter.key] || '';
        const filteredOpts = searchTerm
          ? opts.filter((o) => o.label.toLowerCase().includes(searchTerm.toLowerCase()))
          : opts;
        const showSearch = opts.length > 8;

        return (
          <div key={filter.key} className="fs-field">
            <label className="fs-field-label">{filter.label}</label>
            {showSearch && (
              <input
                type="text"
                className="fs-search-input"
                placeholder="Buscar..."
                value={searchTerm}
                onChange={(e) => setSearch((s) => ({ ...s, [filter.key]: e.target.value }))}
              />
            )}
            <div className="fs-options">
              {filteredOpts.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`fs-option${checked ? ' checked' : ''}`}
                    onClick={() => handleMultiSelectToggle(filter.key, opt.value)}
                    aria-pressed={checked}
                  >
                    <span className="fs-check">{checked ? '✓' : ''}</span>
                    <span className="fs-option-label">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      }

      case 'range': {
        const range = value || {};
        return (
          <div key={filter.key} className="fs-field">
            <label className="fs-field-label">{filter.label}</label>
            <div className="fs-range-row">
              <div className="fs-range-input-wrap">
                <span className="fs-range-symbol">€</span>
                <input
                  type="number"
                  className="fs-range-input"
                  placeholder="Mín"
                  min={0}
                  value={range.min ?? ''}
                  onChange={(e) => handleRangeChange(filter.key, 'min', e.target.value)}
                />
              </div>
              <span className="fs-range-sep">—</span>
              <div className="fs-range-input-wrap">
                <span className="fs-range-symbol">€</span>
                <input
                  type="number"
                  className="fs-range-input"
                  placeholder="Máx"
                  min={0}
                  value={range.max ?? ''}
                  onChange={(e) => handleRangeChange(filter.key, 'max', e.target.value)}
                />
              </div>
            </div>
          </div>
        );
      }

      case 'daterange': {
        const dates = value || {};
        return (
          <div key={filter.key} className="fs-field">
            <label className="fs-field-label">{filter.label}</label>
            <div className="fs-date-row">
              <input
                type="date"
                className="fs-date-input"
                value={dates.from ?? ''}
                onChange={(e) => handleDateChange(filter.key, 'from', e.target.value)}
              />
              <span className="fs-range-sep">—</span>
              <input
                type="date"
                className="fs-date-input"
                value={dates.to ?? ''}
                onChange={(e) => handleDateChange(filter.key, 'to', e.target.value)}
              />
            </div>
          </div>
        );
      }

      case 'autocomplete': {
        const current = (value || '') as string;
        const opts = filter.options || [];
        const isOpen = autocompleteOpen[filter.key] || focusedAutocomplete === filter.key;
        const matches = current
          ? opts.filter((o) => o.label.toLowerCase().includes(current.toLowerCase())).slice(0, 6)
          : opts.slice(0, 6);
        return (
          <div key={filter.key} className="fs-field">
            <label className="fs-field-label">{filter.label}</label>
            <div className="fs-autocomplete">
              <input
                type="text"
                className="fs-text-input"
                placeholder={filter.placeholder || 'Escribe para buscar...'}
                value={current}
                onChange={(e) => handleAutocompleteChange(filter.key, e.target.value)}
                onFocus={() => {
                  setFocusedAutocomplete(filter.key);
                  setAutocompleteOpen((s) => ({ ...s, [filter.key]: true }));
                }}
                onBlur={() => {
                  setFocusedAutocomplete(null);
                  setTimeout(() => setAutocompleteOpen((s) => ({ ...s, [filter.key]: false })), 150);
                }}
              />
              {isOpen && matches.length > 0 && (
                <div className="fs-autocomplete-dropdown">
                  {matches.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className="fs-autocomplete-item"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleAutocompleteChange(filter.key, opt.value);
                        setAutocompleteOpen((s) => ({ ...s, [filter.key]: false }));
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  };

  const sidebarContent = (
    <>
      <div className="fs-header">
        <div className="fs-header-title">
          <span className="fs-icon">🛠</span>
          <span>Filtros</span>
          {activeFilterCount > 0 && <span className="fs-badge">{activeFilterCount}</span>}
        </div>
        {!isMobile && (
          <button
            type="button"
            className="fs-toggle-btn"
            onClick={toggleSidebar}
            aria-label={open ? 'Ocultar filtros' : 'Mostrar filtros'}
            title={open ? 'Ocultar filtros' : 'Mostrar filtros'}
          >
            {open ? '◀' : '▶'}
          </button>
        )}
      </div>

      <div className="fs-body">
        {filters.map(renderField)}
      </div>

      <div className="fs-footer">
        <div className="fs-result-count">
          {isLoading ? (
            <span className="fs-pulse">Actualizando...</span>
          ) : (
            <>
              <span className="fs-result-number">{resultCount.toLocaleString('es-ES')}</span>
              <span className="fs-result-label">{resultText}</span>
            </>
          )}
        </div>
        {hasActiveFilters && (
          <button type="button" className="fs-clear-btn" onClick={clearAll}>
            Limpiar todo
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      {!isMobile && (
        <div className={`fs-sidebar${open ? ' open' : ' collapsed'}`}>
          {open ? (
            sidebarContent
          ) : (
            <div className="fs-collapsed">
              <button
                type="button"
                className="fs-toggle-btn vertical"
                onClick={toggleSidebar}
                aria-label="Mostrar filtros"
                title="Mostrar filtros"
              >
                ▶
              </button>
              <span className="fs-collapsed-label">Filtros</span>
              {activeFilterCount > 0 && <span className="fs-collapsed-badge">{activeFilterCount}</span>}
            </div>
          )}
        </div>
      )}

      {/* Mobile floating filter button */}
      {isMobile && (
        <button type="button" className="fs-mobile-fab" onClick={openMobile} aria-label="Abrir filtros">
          <span>🛠</span>
          <span>Filtros</span>
          {activeFilterCount > 0 && <span className="fs-mobile-badge">{activeFilterCount}</span>}
        </button>
      )}

      {/* Mobile bottom sheet */}
      {isMobile && (
        <div className={`fs-mobile-overlay${mobileOpen ? ' open' : ''}`} onClick={closeMobile}>
          <div
            className={`fs-mobile-sheet${mobileOpen ? ' open' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fs-mobile-handle" />
            {sidebarContent}
            <div className="fs-mobile-actions">
              <button type="button" className="fs-mobile-results-btn" onClick={closeMobile}>
                Ver resultados
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`        
        .fs-sidebar {
          display: flex;
          flex-direction: column;
          width: 260px;
          min-width: 260px;
          height: 100%;
          background: hsl(var(--foreground) / 0.02);
          border-right: 1px solid hsl(var(--foreground) / 0.06);
          color: hsl(var(--foreground) / 0.7);
          overflow: hidden;
          transition: width 0.2s ease, min-width 0.2s ease;
        }
        .fs-sidebar.collapsed {
          width: 44px;
          min-width: 44px;
          align-items: center;
          padding: 12px 0;
        }

        .fs-collapsed {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding-top: 8px;
        }
        .fs-collapsed-label {
          writing-mode: vertical-rl;
          transform: rotate(180deg);
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: hsl(var(--foreground) / 0.35);
        }
        .fs-collapsed-badge {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: hsl(var(--primary));
          color: hsl(var(--background));
          font-size: 10px;
          font-weight: 600;
        }

        .fs-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px;
          border-bottom: 1px solid hsl(var(--foreground) / 0.06);
          flex-shrink: 0;
        }
        .fs-header-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: hsl(var(--foreground) / 0.55);
        }
        .fs-icon {
          font-size: 12px;
          opacity: 0.8;
        }
        .fs-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          border-radius: 9px;
          background: hsl(var(--primary));
          color: hsl(var(--background));
          font-size: 10px;
          font-weight: 600;
          font-family: 'Instrument Sans', sans-serif;
        }

        .fs-toggle-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          background: hsl(var(--foreground) / 0.04);
          border: 1px solid hsl(var(--foreground) / 0.08);
          border-radius: 4px;
          color: hsl(var(--foreground) / 0.4);
          font-size: 10px;
          cursor: pointer;
          transition: all 0.15s;
          flex-shrink: 0;
        }
        .fs-toggle-btn:hover {
          background: hsl(var(--foreground) / 0.08);
          color: hsl(var(--foreground) / 0.7);
          border-color: hsl(var(--foreground) / 0.12);
        }
        .fs-toggle-btn.vertical {
          width: 28px;
          height: 36px;
        }

        .fs-body {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 12px 14px;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }

        .fs-field {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .fs-field-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: hsl(var(--foreground) / 0.3);
        }

        .fs-search-input,
        .fs-text-input,
        .fs-date-input,
        .fs-range-input {
          width: 100%;
          background: hsl(var(--background) / 0.2);
          border: 1px solid hsl(var(--foreground) / 0.08);
          border-radius: 5px;
          padding: 7px 10px;
          color: hsl(var(--foreground) / 0.85);
          font-size: 12px;
          font-family: 'Instrument Sans', sans-serif;
          outline: none;
          transition: border-color 0.15s, background 0.15s;
        }
        .fs-search-input::placeholder,
        .fs-text-input::placeholder,
        .fs-range-input::placeholder {
          color: hsl(var(--foreground) / 0.25);
        }
        .fs-search-input:focus,
        .fs-text-input:focus,
        .fs-range-input:focus {
          border-color: hsl(var(--primary) / 0.35);
          background: hsl(var(--background) / 0.3);
        }

        .fs-options {
          display: flex;
          flex-direction: column;
          gap: 3px;
          max-height: 220px;
          overflow-y: auto;
          padding-right: 2px;
        }
        .fs-option {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          text-align: left;
          padding: 6px 8px;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 4px;
          color: hsl(var(--foreground) / 0.55);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.12s;
        }
        .fs-option:hover {
          background: hsl(var(--foreground) / 0.04);
          color: hsl(var(--foreground) / 0.8);
        }
        .fs-option.checked {
          background: hsl(var(--primary) / 0.08);
          border-color: hsl(var(--primary) / 0.2);
          color: hsl(var(--foreground) / 0.9);
        }
        .fs-check {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border-radius: 3px;
          border: 1px solid hsl(var(--foreground) / 0.15);
          font-size: 9px;
          color: hsl(var(--primary));
          flex-shrink: 0;
        }
        .fs-option.checked .fs-check {
          border-color: hsl(var(--primary) / 0.5);
          background: hsl(var(--primary) / 0.12);
        }
        .fs-option-label {
          line-height: 1.3;
        }

        .fs-range-row,
        .fs-date-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .fs-range-input-wrap {
          position: relative;
          flex: 1;
        }
        .fs-range-symbol {
          position: absolute;
          left: 8px;
          top: 50%;
          transform: translateY(-50%);
          font-size: 11px;
          color: hsl(var(--foreground) / 0.25);
          pointer-events: none;
        }
        .fs-range-input {
          padding-left: 22px;
          -moz-appearance: textfield;
        }
        .fs-range-input::-webkit-outer-spin-button,
        .fs-range-input::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .fs-range-sep {
          color: hsl(var(--foreground) / 0.2);
          font-size: 11px;
          flex-shrink: 0;
        }
        .fs-date-input {
          flex: 1;
          padding: 6px 8px;
          color-scheme: dark;
        }
        .fs-date-input::-webkit-calendar-picker-indicator {
          filter: invert(0.6);
          cursor: pointer;
        }

        .fs-autocomplete {
          position: relative;
        }
        .fs-autocomplete-dropdown {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          max-height: 200px;
          overflow-y: auto;
          background: hsl(var(--card) / 0.98);
          border: 1px solid hsl(var(--foreground) / 0.08);
          border-radius: 5px;
          z-index: 30;
          box-shadow: 0 8px 24px hsl(var(--background) / 0.5);
        }
        .fs-autocomplete-item {
          width: 100%;
          text-align: left;
          padding: 7px 10px;
          background: transparent;
          border: none;
          border-bottom: 1px solid hsl(var(--foreground) / 0.04);
          color: hsl(var(--foreground) / 0.6);
          font-size: 12px;
          cursor: pointer;
          transition: background 0.1s;
        }
        .fs-autocomplete-item:last-child {
          border-bottom: none;
        }
        .fs-autocomplete-item:hover {
          background: hsl(var(--foreground) / 0.05);
          color: hsl(var(--foreground) / 0.9);
        }

        .fs-footer {
          flex-shrink: 0;
          padding: 12px 14px;
          border-top: 1px solid hsl(var(--foreground) / 0.06);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          background: hsl(var(--foreground) / 0.01);
        }
        .fs-result-count {
          display: flex;
          align-items: baseline;
          gap: 5px;
          min-width: 0;
        }
        .fs-result-number {
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
          color: hsl(var(--foreground) / 0.85);
        }
        .fs-result-label {
          font-size: 11px;
          color: hsl(var(--foreground) / 0.35);
          white-space: nowrap;
        }
        .fs-pulse {
          font-size: 11px;
          color: hsl(var(--primary) / 0.7);
          animation: fsPulse 1.2s ease-in-out infinite;
        }
        @keyframes fsPulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        .fs-clear-btn {
          flex-shrink: 0;
          padding: 5px 10px;
          background: hsl(var(--destructive) / 0.08);
          border: 1px solid hsl(var(--destructive) / 0.2);
          border-radius: 4px;
          color: hsl(var(--destructive) / 0.85);
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }
        .fs-clear-btn:hover {
          background: hsl(var(--destructive) / 0.14);
          border-color: hsl(var(--destructive) / 0.35);
          color: hsl(var(--destructive));
        }

        .fs-mobile-fab {
          position: fixed;
          bottom: 16px;
          right: 16px;
          z-index: 40;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 10px 16px;
          background: hsl(var(--primary) / 0.12);
          border: 1px solid hsl(var(--primary) / 0.3);
          border-radius: 24px;
          color: hsl(var(--primary));
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          box-shadow: 0 4px 16px hsl(var(--background) / 0.4);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .fs-mobile-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          border-radius: 9px;
          background: hsl(var(--destructive));
          color: hsl(var(--foreground));
          font-size: 10px;
          font-weight: 600;
        }

        .fs-mobile-overlay {
          position: fixed;
          inset: 0;
          z-index: 50;
          background: hsl(var(--background) / 0.6);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.25s ease;
        }
        .fs-mobile-overlay.open {
          opacity: 1;
          pointer-events: auto;
        }
        .fs-mobile-sheet {
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 51;
          display: flex;
          flex-direction: column;
          max-height: 85vh;
          background: hsl(var(--card) / 0.98);
          border-top: 1px solid hsl(var(--foreground) / 0.08);
          border-radius: 16px 16px 0 0;
          transform: translateY(100%);
          transition: transform 0.25s ease;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .fs-mobile-sheet.open {
          transform: translateY(0);
        }
        .fs-mobile-handle {
          width: 36px;
          height: 4px;
          border-radius: 2px;
          background: hsl(var(--foreground) / 0.15);
          margin: 10px auto 4px;
          flex-shrink: 0;
        }
        .fs-mobile-sheet .fs-body {
          padding: 12px 16px 0;
        }
        .fs-mobile-sheet .fs-footer {
          border-top: none;
          padding-bottom: 0;
        }
        .fs-mobile-actions {
          flex-shrink: 0;
          padding: 12px 16px 24px;
        }
        .fs-mobile-results-btn {
          width: 100%;
          padding: 12px;
          background: hsl(var(--primary));
          border: none;
          border-radius: 8px;
          color: hsl(var(--background));
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
        }
        .fs-mobile-results-btn:hover {
          background: hsl(var(--primary) / 0.7);
        }
      `}</style>
    </>
  );
}
