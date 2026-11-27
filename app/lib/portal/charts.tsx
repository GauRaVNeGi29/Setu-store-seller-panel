import { useEffect, useRef, useState } from "react";

/**
 * Small, dependency-free charts for the seller dashboard.
 *
 * Colors (validated with the dataviz palette check, light surface):
 *  - one series → CHART_GREEN (a more saturated step of the Setu Store green, so it doesn't read gray)
 *  - order status, in this order so green never sits next to red:
 *    shipped CHART_GREEN · open CHART_TURMERIC · cancelled CHART_MADDER (all pass CVD ≥ 8, contrast ≥ 3:1)
 * Marks: columns ≤ 24px with 4px rounded tops, square at the baseline; hairline solid grid.
 * Text never takes a series color. Every value is also in a table or printed beside its mark.
 */
export const CHART_GREEN = "#2F7A4B";
export const CHART_TURMERIC = "#C27D1E";
export const CHART_MADDER = "#A63A32";

const inr = (v: number | string) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inrWhole = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
/** Axis ticks: in full under 10,000, compact above (₹12K, ₹1.2L, ₹1.2Cr). One style per axis. */
const tickFormat = (max: number) => (v: number) => (max >= 10000 ? `₹${compact.format(v)}` : inrWhole(v));

function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** Width of an element, measured after hydration (server render uses `fallback`). */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

type Point = { key: string; label: string; full: string; net: string; orders: number };

/** A path for a column with 4px rounded top corners and a square base. */
function column(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function SalesChart({ points, title }: { points: Point[]; title: string }) {
  const [box, width] = useWidth<HTMLDivElement>(680);
  const [active, setActive] = useState<number | null>(null);
  const H = 220, top = 12, bottom = 28;
  const values = points.map((p) => Number(p.net));
  const max = Math.max(0, ...values);
  const ticks = niceTicks(max);
  const fmt = tickFormat(ticks[ticks.length - 1]);
  const left = Math.max(...ticks.map((t) => fmt(t).length)) * 7 + 12;
  const plotW = Math.max(120, width - left - 4);
  const plotH = H - top - bottom;
  const yMax = ticks[ticks.length - 1] || 1;
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const slot = plotW / Math.max(1, points.length);
  const barW = Math.max(2, Math.min(24, slot * 0.62));
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 64))));
  const empty = max === 0;
  const a = active !== null ? points[active] : null;
  const ax = active !== null ? left + active * slot + slot / 2 : 0;
  const ay = a ? y(Number(a.net)) : 0;
  // Above the bar when there's room; beside a tall bar (on the side with more space) when there isn't.
  const beside = a !== null && ay - 8 < 58;
  const toLeft = ax > width / 2;
  const tipStyle = !a ? {} : beside
    ? { left: toLeft ? ax - barW / 2 - 8 : ax + barW / 2 + 8, top: top, transform: toLeft ? "translate(-100%, 0)" : "none" }
    : { left: Math.min(Math.max(ax, 70), width - 70), top: ay - 8 };

  return (
    <div className="vp-chart" ref={box}>
      <svg width={width} height={H} role="img" aria-label={`${title}. ${empty ? "No sales in this period." : `Highest: ${inr(max)}.`} The table below lists every value.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className="vp-chart-grid" />
            <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="vp-chart-tick">{fmt(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const v = Number(p.net);
          const cx = left + i * slot + slot / 2;
          return (
            <g key={p.key}>
              {v > 0 && <path d={column(cx - barW / 2, y(v), barW, y(0) - y(v))} fill={CHART_GREEN} opacity={active === null || active === i ? 1 : 0.55} />}
              {i % every === (points.length - 1) % every && (
                <text x={cx} y={H - 8} textAnchor="middle" className="vp-chart-tick">{p.label}</text>
              )}
              {/* Hit target: the whole slot, bigger than the bar. */}
              <rect
                x={left + i * slot} y={top} width={slot} height={plotH} fill="transparent" tabIndex={0}
                aria-label={`${p.full}: ${inr(p.net)} from ${p.orders} ${p.orders === 1 ? "order" : "orders"}`}
                onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                className="vp-chart-hit"
              />
            </g>
          );
        })}
        {empty && <text x={left + plotW / 2} y={top + plotH / 2} textAnchor="middle" className="vp-chart-empty">No sales in this period</text>}
      </svg>
      {a && (
        <div className="vp-tip" style={tipStyle} role="status">
          <b>{inr(a.net)}</b>
          <span>{a.full} · {a.orders} {a.orders === 1 ? "order" : "orders"}</span>
        </div>
      )}
      <details className="vp-tableview">
        <summary>Show as a table</summary>
        <table className="vp-table vp-table--compact">
          <thead><tr><th>Period</th><th className="r">Orders</th><th className="r">Sales</th></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.key}><td>{p.full}</td><td className="r">{p.orders}</td><td className="r">{inr(p.net)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Ranked horizontal bars, one hue, largest first; the value is printed at each bar's tip. */
export function RankedBars({ rows }: { rows: { label: string; value: number; display: string; sub?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <ol className="vp-ranked">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="vp-ranked-name" title={r.label}>{r.label}</span>
          <span className="vp-ranked-row">
            <span className="vp-ranked-bar" style={{ ["--w" as string]: Math.max(1.5, (r.value / max) * 100), background: CHART_GREEN }} />
            <span className="vp-ranked-val">{r.display}{r.sub && <span className="vp-small"> · {r.sub}</span>}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One whole split into parts: a tall segmented bar with counts inside, and a legend naming the parts. */
export function StatusBar({ parts }: { parts: { name: string; value: number; color: string; ink: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <p className="vp-small" style={{ margin: 0 }}>No orders in this period.</p>;
  const shown = parts.filter((p) => p.value > 0);
  const fits = (p: { value: number }) => p.value / total >= 0.09;
  return (
    <div>
      <div className="vp-segbar" role="img" aria-label={shown.map((p) => `${p.name}: ${p.value}`).join(", ")}>
        {shown.map((p) => (
          <span key={p.name} className="vp-segbar-part" title={`${p.name}: ${p.value} (${Math.round((p.value / total) * 100)}%)`}
            style={{ flexGrow: p.value, background: p.color, color: p.ink }}>
            {fits(p) ? p.value : ""}
          </span>
        ))}
      </div>
      <ul className="vp-legend">
        {parts.map((p) => (
          <li key={p.name}>
            <span className="vp-legend-key" style={{ background: p.color }} />
            {p.name}{(!fits(p) || p.value === 0) && <span className="vp-small"> · {p.value}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
