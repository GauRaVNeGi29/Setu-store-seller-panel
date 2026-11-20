import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { listToShip } from "../lib/portal/data.server";
import { day } from "../lib/portal/format";
import { IconPrint } from "../lib/portal/icons";
import { plural } from "../lib/portal/ui";

/** "What to ship": every unit still to send, oldest order first. Tick-as-you-pack; printable. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  return { ...(await listToShip(db, { shop: me.shop, vendorName: me.vendor.vendorName })), vendor: me.vendor.displayName };
};

export const meta: MetaFunction = () => [{ title: "What to ship · Setu Store vendor portal" }];

export default function WhatToShip() {
  const d = useLoaderData<typeof loader>();
  return (
    <>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">What to ship</h1>
          <p className="vp-lead">
            {d.units
              ? `${plural(d.units, "unit", "units")} across ${plural(d.orders.length, "order", "orders")}, oldest order first.`
              : "Nothing is waiting to ship."}
          </p>
        </div>
        {d.units > 0 && (
          <button className="vp-btn vp-btn--quiet vp-noprint" type="button" onClick={() => window.print()}><IconPrint />Print pick list</button>
        )}
      </div>

      {d.orders.length === 0 ? (
        <div className="vp-panel vp-empty">
          <p className="vp-h3">You&apos;re all caught up</p>
          <p>New orders with your products will appear here as soon as they come in.</p>
          <p><Link to="/portal">See all orders</Link></p>
        </div>
      ) : (
        <>
          <p className="vp-tip">Tick items as you pack them. Ticks stay on this screen only; they don&apos;t mark anything as shipped.</p>
          <div className="vp-pick">
            {d.orders.map((o) => (
              <section className="vp-panel" key={o.orderId} aria-labelledby={`o-${o.orderId}`}>
                <div className="vp-pick-head">
                  <Link id={`o-${o.orderId}`} to={`/portal/orders/${o.orderId}`}>Order {o.orderName}</Link>
                  <span className="vp-small">Placed {day(o.createdAt)}</span>
                </div>
                {o.items.map((i, n) => (
                  <label className="vp-pick-row" key={n}>
                    <input type="checkbox" aria-label={`Packed ${i.toShip} × ${i.title}`} />
                    <span>
                      <span className="vp-pick-name"><b>{i.title}</b></span>
                      {i.sku && <span className="vp-small" style={{ display: "block" }}>SKU {i.sku}</span>}
                    </span>
                    <span className="vp-units">{i.toShip}<small>{i.toShip === 1 ? "unit" : "units"}</small></span>
                  </label>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}
