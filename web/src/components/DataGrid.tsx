import * as React from "react";
import { ChevronDown, ChevronUp, EyeOff, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import "./DataGrid.css";

export type Density = "compact" | "comfortable" | "spacious";

export interface Column {
  key: string;
  label: string;
  width?: string;
  align?: "left" | "right" | "center";
  mono?: boolean;
  sortable?: boolean;
  hideable?: boolean;
  sortKey?: string;
  render?: (value: any, row: any) => React.ReactNode;
}

export interface DataGridProps {
  columns: Column[];
  data: any[];
  onRowClick?: (row: any) => void;
  showTotals?: boolean;
  totalsRow?: React.ReactNode;
  emptyState?: React.ReactNode;
  loadingState?: React.ReactNode;
  isLoading?: boolean;
  className?: string;
  tableClassName?: string;
  id?: string;
  /** Controlled / initial density. Defaults to comfortable and falls back to localStorage. */
  density?: Density;
  /** Initial sort key. */
  defaultSortKey?: string | null;
  /** Initial sort direction. */
  defaultSortDir?: "asc" | "desc";
  /** Custom count label, e.g. n => `${n} predicciones`. */
  countLabel?: (n: number) => string;
}

const STORAGE_KEY = "elicita.datagrid.density";

function getInitialDensity(): Density {
  if (typeof window === "undefined") return "comfortable";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "compact" || raw === "comfortable" || raw === "spacious") return raw;
  return "comfortable";
}

function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  if (typeof n !== "number") return String(n);
  return n.toLocaleString("es-ES");
}

function isNumericValue(value: unknown): boolean {
  return typeof value === "number" && !Number.isNaN(value);
}

function defaultRender(value: any, _row: any, column: Column): React.ReactNode {
  if (column.render) return null;
  if (isNumericValue(value)) return fmtNumber(value);
  if (value === null || value === undefined) return "—";
  return String(value);
}

export function DataGrid(props: DataGridProps) {
  const {
    columns: rawColumns,
    data,
    onRowClick,
    showTotals,
    totalsRow,
    emptyState,
    loadingState,
    isLoading,
    className,
    tableClassName,
    id,
    density: densityProp,
    defaultSortKey = null,
    defaultSortDir = "desc",
    countLabel,
  } = props;
  const [density, setDensity] = React.useState<Density>(densityProp || "comfortable");
  const [mounted, setMounted] = React.useState(false);
  const [sortKey, setSortKey] = React.useState<string | null>(defaultSortKey);
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">(defaultSortDir);
  const [hiddenKeys, setHiddenKeys] = React.useState<Set<string>>(new Set());
  const [menuColumn, setMenuColumn] = React.useState<Column | null>(null);
  const [menuAnchor, setMenuAnchor] = React.useState<{ x: number; y: number } | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setMounted(true);
    if (!densityProp) {
      setDensity(getInitialDensity());
    }
  }, [densityProp]);

  React.useEffect(() => {
    if (!mounted || densityProp) return;
    window.localStorage.setItem(STORAGE_KEY, density);
  }, [density, mounted, densityProp]);

  // Close context menu on outside click / scroll / resize
  React.useEffect(() => {
    if (!menuColumn) return;
    const close = (e: Event) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setMenuColumn(null);
      setMenuAnchor(null);
    };
    const closeOnEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuColumn(null);
        setMenuAnchor(null);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", closeOnEsc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", closeOnEsc);
    };
  }, [menuColumn]);

  const visibleColumns = React.useMemo(
    () => rawColumns.filter((c) => !hiddenKeys.has(c.key)),
    [rawColumns, hiddenKeys]
  );

  const totalsData = React.useMemo(() => {
    if (!showTotals) return null;
    const totals: Record<string, { count: number; sum: number }> = {};
    visibleColumns.forEach((col) => {
      totals[col.key] = { count: 0, sum: 0 };
    });
    data.forEach((row) => {
      visibleColumns.forEach((col) => {
        const v = row[col.key];
        if (isNumericValue(v)) {
          totals[col.key].count += 1;
          totals[col.key].sum += v;
        }
      });
    });
    return totals;
  }, [data, visibleColumns, showTotals]);

  const sortedData = React.useMemo(() => {
    if (!sortKey) return data;
    const col = visibleColumns.find((c) => c.key === sortKey);
    const sortKeyField = (col?.sortKey || sortKey) as string;
    if (!col) return data;

    const rows = [...data];
    const dir = sortDir === "asc" ? 1 : -1;

    return rows.sort((a, b) => {
      const va = a[sortKeyField];
      const vb = b[sortKeyField];

      if (isNumericValue(va) && isNumericValue(vb)) {
        return dir * (va - vb);
      }

      const sa = va === null || va === undefined ? "" : String(va);
      const sb = vb === null || vb === undefined ? "" : String(vb);
      return dir * sa.localeCompare(sb, "es", { sensitivity: "base" });
    });
  }, [data, sortKey, sortDir, visibleColumns]);

  const handleSort = (col: Column) => {
    if (!col.sortable) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setSortDir("desc");
    }
  };

  const handleHeaderContextMenu = (e: React.MouseEvent, col: Column) => {
    if (!col.sortable && col.hideable === false) return;
    e.preventDefault();
    setMenuColumn(col);
    const rect = wrapRef.current?.getBoundingClientRect();
    const x = rect ? Math.min(e.clientX - rect.left, (rect.width || 0) - 140) : e.clientX;
    const y = rect ? e.clientY - rect.top : e.clientY;
    setMenuAnchor({ x: Math.max(0, x), y: Math.max(0, y) });
  };

  const hideColumn = (col: Column) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      next.add(col.key);
      return next;
    });
    setMenuColumn(null);
    setMenuAnchor(null);
  };

  const showAllColumns = () => {
    setHiddenKeys(new Set());
  };

  const densityBtn = (value: Density, label: string) => (
    <button
      key={value}
      type="button"
      className={cn("dg-density-btn", density === value && "dg-density-active")}
      onClick={() => setDensity(value)}
      aria-pressed={density === value}
    >
      {label}
    </button>
  );

  const hasHidden = hiddenKeys.size > 0;
  const totalCount = data.length;
  const showingStart = totalCount === 0 ? 0 : 1;
  const showingEnd = totalCount;

  const densityClass = `dg-density-${density}`;

  return (
    <div className={cn("dg-root", densityClass, className)} id={id} ref={wrapRef}>
      <div className="dg-toolbar">
        <div className="dg-count">
          {isLoading ? (
            <span className="dg-count-loading">Cargando…</span>
          ) : countLabel ? (
            <>
              <strong>{fmtNumber(totalCount)}</strong>{" "}{countLabel(totalCount)}
            </>
          ) : (
            <>
              Mostrando{" "}
              <strong>
                {showingStart}-{showingEnd}
              </strong>{" "}
              de <strong>{fmtNumber(totalCount)}</strong>
            </>
          )}
        </div>
        <div className="dg-density" role="group" aria-label="Densidad de filas">
          {densityBtn("compact", "Compact")}
          {densityBtn("comfortable", "Comfortable")}
          {densityBtn("spacious", "Spacious")}
        </div>
      </div>

      <div className="dg-scroll">
        <table className={cn("dg-table", tableClassName)}>
          <thead>
            <tr>
              {visibleColumns.map((col, index) => {
                const sorted = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    className={cn(
                      "dg-th",
                      col.sortable && "dg-sortable",
                      sorted && "dg-sorted",
                      col.align && `dg-align-${col.align}`,
                      col.mono && "dg-mono",
                      index === 0 && "dg-first-col"
                    )}
                    style={{ width: col.width }}
                    onClick={() => handleSort(col)}
                    onContextMenu={(e) => handleHeaderContextMenu(e, col)}
                    aria-sort={sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <span className="dg-th-content">
                      <span className="dg-th-label">{col.label}</span>
                      {col.sortable && (
                        <span className={cn("dg-sort-icons", sorted && "dg-sort-visible")} aria-hidden="true">
                          <ChevronUp className={cn("dg-sort-icon", sorted && sortDir === "asc" && "dg-sort-active")} />
                          <ChevronDown
                            className={cn("dg-sort-icon", sorted && sortDir === "desc" && "dg-sort-active")}
                          />
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={visibleColumns.length} className="dg-loading-cell">
                  {loadingState || (
                    <div className="dg-loading">
                      <Spinner size="md" variant="white" />
                      <span>Cargando…</span>
                    </div>
                  )}
                </td>
              </tr>
            ) : sortedData.length === 0 ? (
              <tr>
                <td colSpan={visibleColumns.length} className="dg-empty-cell">
                  {emptyState || (
                    <div className="dg-empty">
                      <div className="dg-empty-icon">∅</div>
                      <div className="dg-empty-text">No hay datos disponibles</div>
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              sortedData.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className={cn("dg-tr", onRowClick && "dg-clickable")}
                  onClick={() => onRowClick?.(row)}
                >
                  {visibleColumns.map((col, colIndex) => {
                    const value = row[col.key];
                    const rendered = col.render ? col.render(value, row) : defaultRender(value, row, col);
                    return (
                      <td
                        key={col.key}
                        className={cn(
                          "dg-td",
                          col.align && `dg-align-${col.align}`,
                          col.mono && "dg-mono",
                          colIndex === 0 && "dg-first-col"
                        )}
                      >
                        {rendered}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
          {showTotals && totalsData && !isLoading && sortedData.length > 0 && (
            <tfoot className="dg-tfoot">
              {totalsRow ? (
                <tr>
                  <td colSpan={visibleColumns.length} className="dg-totals-custom">
                    {totalsRow}
                  </td>
                </tr>
              ) : (
                <tr>
                  {visibleColumns.map((col) => {
                    const t = totalsData[col.key];
                    const hasNumeric = t && t.count > 0;
                    return (
                      <td
                        key={col.key}
                        className={cn("dg-total", col.align && `dg-align-${col.align}`, col.mono && "dg-mono")}
                      >
                        {hasNumeric ? (
                          <span className="dg-total-value">{fmtNumber(t.sum)}</span>
                        ) : col.key === visibleColumns[0].key ? (
                          <span className="dg-total-label">
                            {t.count} {t.count === 1 ? "registro" : "registros"}
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>

      {hasHidden && (
        <div className="dg-hidden-banner">
          <span>{hiddenKeys.size} columna{hiddenKeys.size > 1 ? "s" : ""} oculta{hiddenKeys.size > 1 ? "s" : ""}</span>
          <button type="button" className="dg-show-all" onClick={showAllColumns}>
            Mostrar todo
          </button>
        </div>
      )}

      {menuColumn && menuAnchor && (
        <div
          ref={menuRef}
          className="dg-context-menu"
          style={{ left: menuAnchor.x, top: menuAnchor.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {menuColumn.sortable && (
            <>
              <button
                type="button"
                className="dg-menu-item"
                role="menuitem"
                onClick={() => {
                  if (sortKey === menuColumn.key && sortDir === "asc") {
                    setSortKey(null);
                  } else {
                    setSortKey(menuColumn.key);
                    setSortDir("asc");
                  }
                  setMenuColumn(null);
                  setMenuAnchor(null);
                }}
              >
                <ChevronUp size={14} />
                Ordenar ascendente
              </button>
              <button
                type="button"
                className="dg-menu-item"
                role="menuitem"
                onClick={() => {
                  if (sortKey === menuColumn.key && sortDir === "desc") {
                    setSortKey(null);
                  } else {
                    setSortKey(menuColumn.key);
                    setSortDir("desc");
                  }
                  setMenuColumn(null);
                  setMenuAnchor(null);
                }}
              >
                <ChevronDown size={14} />
                Ordenar descendente
              </button>
            </>
          )}
          {menuColumn.sortable && menuColumn.hideable !== false && <div className="dg-menu-divider" />}
          {menuColumn.hideable !== false && (
            <button
              type="button"
              className="dg-menu-item dg-menu-danger"
              role="menuitem"
              onClick={() => hideColumn(menuColumn)}
            >
              <EyeOff size={14} />
              Ocultar columna
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default DataGrid;
