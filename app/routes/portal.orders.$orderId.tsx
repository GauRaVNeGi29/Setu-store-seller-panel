import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { getMyOrder } from "../lib/portal/data.server";
import { day, inr } from "../lib/portal/format";
import { IconBack, IconPrint } from "../lib/portal/icons";
import { plural, Status } from "../lib/portal/ui";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const order = await getMyOrder(db, { shop: me.shop, vendorName: me.vendor.vendorName }, String(params.orderId ?? ""));
  // Another vendor's order and a non-existent order look exactly the same.
  if (!order) throw new Response("Order not found", { status: 404 });
  return { order, vendor: me.vendor.displayName };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => [{ title: data ? `Order ${data.order.orderName} · Setu Store vendor portal` : "Order not found" }];

export default function OrderDetail() {
  const { order: o, vendor } = useLoaderData<typeof loader>();
  const ordered = o.lines.reduce((a, l) => a + l.quantity, 0);
  const refunded = o.lines.reduce((a, l) => a + l.refundedQuantity, 0);
  const shipped = o.lines.reduce((a, l) => a + l.shipped, 0);

  return (
    <>
      <Link className="vp-back" to="/portal"><IconBack />All orders</Link>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">Order {o.orderName}</h1>
          <p className="vp-lead">Placed {day(o.createdAt)}. Only your items from this order are shown.</p>
        </div>
        <Status value={o.status} />
      </div>

      <div className="vp-detail">
        <section className="vp-panel" aria-labelledby="items-title">
          <div className="vp-panel-head">
            <h2 className="vp-h2" id="items-title">Your items</h2>
            <span className="vp-small">{plural(o.lines.length, "product", "products")}</span>
          </div>
          <ul className="vp-items">
            {o.lines.map((l) => (
              <li className="vp-item" key={l.lineItemId}>
                <div>
                  <div className="vp-item-title">{l.title}</div>
                  <div className="vp-item-sub">
                    {[l.variantTitle, l.sku ? `SKU ${l.sku}` : null, `${inr(l.unitPrice)} each`].filter(Boolean).join(", ")}
                  </div>
                </div>
                <div className="vp-item-money">
                  {l.refundedAmount !== "0.00" && <s>{inr(l.lineTotal)}</s>}
                  {inr(l.netAmount)}
                </div>
                <div className="vp-qty">
                  <span>Ordered {l.quantity}</span>
                  {l.refundedQuantity > 0 && <span>Refunded {l.refundedQuantity}</span>}
                  {l.shipped > 0 && <span>Shipped {l.shipped}</span>}
                  {l.toShip > 0 && <span className="is-due">To ship {l.toShip}</span>}
                  {l.status === "cancelled" && <span>Cancelled</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <aside className="vp-panel vp-summary" aria-labelledby="summary-title">
          <div className="vp-panel-body">
            <h2 className="vp-h3" id="summary-title" style={{ marginBottom: 6 }}>Summary for {vendor}</h2>
            <dl>
              <div><dt>Units ordered</dt><dd>{ordered}</dd></div>
              {refunded > 0 && <div><dt>Units refunded</dt><dd>{refunded}</dd></div>}
              <div><dt>Units shipped</dt><dd>{shipped}</dd></div>
              <div><dt>Units to ship</dt><dd>{o.toShip}</dd></div>
              <div className="vp-total"><dt>Your sales</dt><dd>{inr(o.net)}</dd></div>
            </dl>
            <button className="vp-btn vp-btn--quiet vp-noprint" type="button" onClick={() => window.print()}><IconPrint />Print order</button>
          </div>
        </aside>
      </div>
    </>
  );
}

export function ErrorBoundary() {
  return (
    <>
      <Link className="vp-back" to="/portal"><IconBack />All orders</Link>
      <div className="vp-panel vp-empty">
        <h1 className="vp-h2">Order not found</h1>
        <p>This order doesn&apos;t exist or doesn&apos;t include your products.</p>
      </div>
    </>
  );
}
