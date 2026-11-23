import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { vendorEarnings } from "../lib/commission/commission.server";
import { RANGES, isRange, type RangeKey } from "../lib/portal/ranges";
import { day, inr } from "../lib/portal/format";
import { plural, Status } from "../lib/portal/ui";

/**
 * Earnings: the vendor's commission rate (and its history), and for a period,
 * per order: sales after refunds, the rate used, Setu Store's commission and
 * what the vendor earns. Only this vendor's own orders.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const want = new URL(request.url).searchParams.get("range");
  const range: RangeKey = isRange(want) ? want : "30";
  return vendorEarnings(db, { shop: me.shop, vendorName: me.vendor.vendorName, vendorId: me.vendor.id }, range);
};

export const meta: MetaFunction = () => [{ title: "Earnings · Setu Store vendor portal" }];

const pct = (rate: string) => `${Number(rate).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;

export default function Earnings() {
  const e = useLoaderData<typeof loader>();
  const loading = useNavigation().state === "loading";
  const t = e.totals;
  const period = e.rangeLabel.toLowerCase();

  return (
    <>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">Earnings</h1>
          <p className="vp-lead">What you earn from your Setu Store sales after Setu Store&apos;s commission.</p>
        </div>
      </div>

      <section className="vp-panel vp-panel-body vp-rate" aria-labelledby="rate-title">
        <h2 className="vp-h2" id="rate-title">Your commission</h2>
        {e.rate !== null ? (
          <>
            <p className="vp-rate-line">
              Setu Store takes <b>{pct(e.rate)}</b> of your sales after discounts and refunds.
            </p>
            {e.history.length > 1 && (
              <ul className="vp-rate-history">
                {e.history.map((h, i) => {
                  const until = i > 0 ? e.history[i - 1].effectiveFrom : null; // newest first
                  const text = h.fromStart
                    ? (until ? `on orders placed before ${day(until)}` : "on all orders")
                    : `on orders placed from ${day(h.effectiveFrom)}${until ? ` to ${day(until)}` : " onwards"}`;
                  return <li key={h.createdAt + h.rate}><b>{pct(h.rate)}</b> {text}</li>;
                })}
              </ul>
            )}
            <p className="vp-small" style={{ margin: "8px 0 0" }}>
              A change of rate applies only to orders placed after it. Questions about your rate? Contact the Setu Store team.
            </p>
          </>
        ) : (
          <p className="vp-rate-line">Your commission rate hasn&apos;t been set yet. Once the Setu Store team sets it, your earnings will show here.</p>
        )}
      </section>

      <nav className="vp-seg vp-dash-range" aria-label="Period">
        {(Object.keys(RANGES) as RangeKey[]).map((r) => (
          <Link key={r} to={r === "30" ? "/portal/earnings" : `/portal/earnings?range=${r}`} aria-current={e.range === r ? "true" : undefined} preventScrollReset>
            {RANGES[r]}
          </Link>
        ))}
      </nav>

      <div className={`vp-dash-period${loading ? " vp-dash-period--loading" : ""}`}>
        <div className="vp-earn-tiles">
          <div className="vp-tile">
            <span className="vp-tile-label">Sales after refunds</span>
            <span className="vp-tile-value">{inr(t.net)}</span>
            <span className="vp-delta">{plural(e.rows.filter((r) => r.status !== "cancelled").length, "order", "orders")}, {period}</span>
          </div>
          <div className="vp-tile">
            <span className="vp-tile-label">Setu Store commission{e.rate !== null ? ` (${pct(e.rate)})` : ""}</span>
            <span className="vp-tile-value">{e.rate === null && t.commission === "0.00" ? "–" : `− ${inr(t.commission)}`}</span>
            <span className="vp-delta">Worked out order by order</span>
          </div>
          <div className="vp-tile vp-tile--earn">
            <span className="vp-tile-label">You earn</span>
            <span className="vp-tile-value">{e.rate === null && t.ordersWithoutRate ? "–" : inr(t.earnings)}</span>
            <span className="vp-delta">Before shipping and taxes</span>
          </div>
        </div>

        {t.ordersWithoutRate > 0 && e.rate !== null && (
          <p className="vp-msg vp-msg--todo" role="status">
            {plural(t.ordersWithoutRate, "order has", "orders have")} no commission rate yet, so {t.ordersWithoutRate === 1 ? "it isn't" : "they aren't"} in &ldquo;You earn&rdquo;.
          </p>
        )}

        <section className="vp-panel" aria-labelledby="by-order">
          <div className="vp-panel-head">
            <h2 className="vp-h2" id="by-order">By order</h2>
            <span className="vp-small">{e.rangeLabel}</span>
          </div>
          {e.rows.length ? (
            <>
              <table className="vp-table vp-table--orders">
                <thead>
                  <tr><th>Order</th><th>Placed</th><th>Status</th><th className="r">Sales</th><th className="r">Rate</th><th className="r">Commission</th><th className="r">You earn</th></tr>
                </thead>
                <tbody>
                  {e.rows.map((r) => (
                    <tr key={r.orderId}>
                      <td><Link className="vp-ordno" to={`/portal/orders/${r.orderId}`}>{r.orderName}</Link></td>
                      <td>{day(r.createdAt)}</td>
                      <td><Status value={r.status} /></td>
                      <td className="r">{inr(r.net)}</td>
                      <td className="r">{r.rate !== null ? pct(r.rate) : "Not set"}</td>
                      <td className="r">{r.commission !== null ? inr(r.commission) : "–"}</td>
                      <td className="r"><b>{r.earnings !== null ? inr(r.earnings) : "–"}</b></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>Total</td>
                    <td className="r">{inr(t.net)}</td>
                    <td />
                    <td className="r">{inr(t.commission)}</td>
                    <td className="r">{inr(t.earnings)}</td>
                  </tr>
                </tfoot>
              </table>
              <ul className="vp-cards" aria-label="Earnings by order">
                {e.rows.map((r) => (
                  <li key={r.orderId}>
                    <Link className="vp-card-link" to={`/portal/orders/${r.orderId}`}>
                      <b>{r.orderName}</b>
                      <Status value={r.status} />
                      <span className="vp-card-meta">
                        <span>{day(r.createdAt)}{r.status === "cancelled" ? "" : ` · sales ${inr(r.net)}${r.commission !== null ? ` − ${inr(r.commission)} (${pct(r.rate!)})` : ""}`}</span>
                        <strong>{r.earnings !== null ? inr(r.earnings) : "–"}</strong>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="vp-panel-body vp-small" style={{ margin: 0 }}>No orders {period}.</p>
          )}
        </section>

        <p className="vp-small">
          Commission is worked out on each order&apos;s sales after discounts and refunds, rounded to the paisa. Cancelled orders have no commission.
          Shipping, taxes and payouts aren&apos;t shown here.
        </p>
      </div>
    </>
  );
}
