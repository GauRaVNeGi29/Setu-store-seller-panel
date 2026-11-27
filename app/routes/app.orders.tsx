import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { storeTotals, vendorOverview } from "../lib/orders/admin.server";
import { fullSync } from "../lib/orders/sync.server";
import { deliveryTime, resendDeliveryTime, saveDeliveryTime } from "../lib/settings/settings.server";
import { listAllVendors } from "../lib/vendors/team.server";
import { daysText, totalDays } from "../lib/vendors/shipping";
import { cell, day, headRow, inr, input, muted, plural, Stats, table, Tabs, vendorHref, when } from "../lib/admin/ui";

/**
 * Shipping and orders, in three views:
 *  - Shipping: what each vendor still has to ship, the store's delivery time,
 *    and each seller's processing time with the total buyers are shown as dates.
 *  - Sales by vendor: orders, units and money for every vendor on an order,
 *    worked out from the app's own copy of the order lines.
 *  - Order sync: when orders were last copied from Shopify, and copying again.
 */
const VIEWS = ["shipping", "sales", "sync"] as const;
type View = (typeof VIEWS)[number];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const asked = new URL(request.url).searchParams.get("view");
  const view: View = (VIEWS as readonly string[]).includes(asked ?? "") ? (asked as View) : "shipping";
  const [overview, delivery, portal] = await Promise.all([
    vendorOverview(db, session.shop),
    deliveryTime(db, session.shop),
    listAllVendors(db, session.shop),
  ]);
  const account = new Map(portal.map((v) => [v.vendorName, v]));
  const vendors = overview.vendors.map((v) => {
    const p = account.get(v.vendorName);
    return {
      ...v, name: p?.displayName ?? v.vendorName, processing: p?.processing ?? null,
      portal: p ? `${p.status === "active" ? "Active" : "Paused"} · ${plural(p.people, "person", "people")}` : "Not set up",
    };
  });
  return {
    view, ...overview, vendors, totals: storeTotals(overview.vendors), delivery,
    /** Every seller with a portal account, with the processing time they gave. */
    sellers: portal.map((v) => ({ id: v.id, name: v.displayName, vendorName: v.vendorName, processing: v.processing })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  if (intent === "delivery_time") {
    return saveDeliveryTime(db, admin.graphql, session.shop, { min: String(form.get("deliveryDaysMin") ?? ""), max: String(form.get("deliveryDaysMax") ?? "") }, actor);
  }
  if (intent === "delivery_resend") return resendDeliveryTime(db, admin.graphql, session.shop);
  if (intent === "resync") {
    try {
      const result = await fullSync(db, admin.graphql, session.shop, actor);
      return { ok: true as const, orders: result.orders };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }
  return { ok: false as const, error: "Unknown action" };
};

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

function Shipping({ data }: { data: Data }) {
  const { delivery, vendors, sellers } = data;
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = (intent: string) => fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent;
  const result = fetcher.data;
  const saved = result && result.ok && "onStore" in result ? result : null;
  useEffect(() => {
    if (saved?.onStore) shopify.toast.show(saved.range ? "Delivery time saved" : "Delivery time removed");
  }, [saved, shopify]);
  const toShip = vendors.filter((v) => v.unitsToShip > 0).sort((a, b) => b.unitsToShip - a.unitsToShip);
  const example = { min: 10, max: 15 };

  return (
    <>
      <s-section heading="Waiting to ship">
        {toShip.length === 0 ? (
          <s-paragraph>Nothing is waiting to ship.</s-paragraph>
        ) : (
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Vendor</th>
                <th style={cell}>Open orders</th>
                <th style={cell}>Units to ship</th>
                <th style={cell}>Processing time</th>
              </tr>
            </thead>
            <tbody>
              {toShip.map((v) => (
                <tr key={v.vendorName || "__none__"}>
                  <td style={cell}><s-link href={vendorHref(v.vendorName)}>{v.name || "(no vendor)"}</s-link></td>
                  <td style={cell}>{v.openOrders}</td>
                  <td style={cell}><b>{v.unitsToShip}</b></td>
                  <td style={cell}>{v.processing ? daysText(v.processing) : <span style={muted}>Not given</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <s-paragraph>Open a vendor to see the order lines behind these numbers.</s-paragraph>
      </s-section>

      <s-section heading="Delivery time">
        <s-paragraph>
          How many days a shipment takes to reach the buyer once the seller hands it over. It is one range for the whole store.
          It is added to each seller&apos;s processing time, and the seller page shows the result as dates: when an order placed today arrives.
        </s-paragraph>
        {result && !result.ok && <s-banner tone="critical">{result.error}</s-banner>}
        {delivery.error && !saved?.onStore && (
          <s-banner tone="warning">
            The delivery time is saved here, but the store doesn&apos;t show it yet. {delivery.error}
            <fetcher.Form method="post" style={{ marginTop: 8 }}>
              <input type="hidden" name="intent" value="delivery_resend" />
              <s-button type="submit" {...(busy("delivery_resend") ? { loading: true } : {})}>Send to the store again</s-button>
            </fetcher.Form>
          </s-banner>
        )}
        <fetcher.Form method="post" key={`${delivery.range?.min}-${delivery.range?.max}`}>
          <input type="hidden" name="intent" value="delivery_time" />
          <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
            <legend style={{ padding: 0, marginBottom: 4, fontWeight: 600 }}>Delivery time, in days</legend>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <input name="deliveryDaysMin" type="number" min={0} max={365} step={1} aria-label="Delivery time: from, in days" defaultValue={delivery.range?.min ?? ""} style={{ ...input, width: 90 }} />
              <span>to</span>
              <input name="deliveryDaysMax" type="number" min={1} max={365} step={1} aria-label="Delivery time: to, in days" defaultValue={delivery.range?.max ?? ""} style={{ ...input, width: 90 }} />
              <span>days</span>
              <s-button type="submit" variant="primary" {...(busy("delivery_time") ? { loading: true } : {})}>Save</s-button>
            </div>
          </fieldset>
        </fetcher.Form>
        <s-paragraph>
          {delivery.range ? (
            <>
              Now: <b>{daysText(delivery.range)}</b>
              {delivery.updatedBy && delivery.updatedAt && <> · set by {delivery.updatedBy} on {day(delivery.updatedAt)}</>}
              . For a seller who needs {daysText(example)} to ready an order, buyers see the dates {daysText(totalDays(example, delivery.range)!)} from today, such as &ldquo;Arrives Dec 10 – Dec 17&rdquo;.
            </>
          ) : (
            <>Not set. Seller pages show no arrival dates until you set it. Leave both boxes empty and save to remove it again.</>
          )}
        </s-paragraph>
      </s-section>

      <s-section heading="Shipping times by seller">
        <s-paragraph>
          Each seller sets their processing time (days to make or ready an order) in the vendor portal, under My brand. You can change it on the vendor&apos;s page.
          Buyers don&apos;t see these numbers, only the arrival dates they add up to.
        </s-paragraph>
        {sellers.length === 0 ? (
          <s-paragraph>No vendor has portal access yet.</s-paragraph>
        ) : (
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Seller</th>
                <th style={cell}>Processing time</th>
                <th style={cell}>Delivery time</th>
                <th style={cell}>Arrives after</th>
              </tr>
            </thead>
            <tbody>
              {sellers.map((v) => {
                const total = totalDays(v.processing, delivery.range);
                return (
                  <tr key={v.id}>
                    <td style={cell}><s-link href={vendorHref(v.vendorName)}>{v.name}</s-link></td>
                    <td style={cell}>{v.processing ? daysText(v.processing) : <span style={{ color: "#8a5a12" }}>Not given</span>}</td>
                    <td style={cell}>{delivery.range ? daysText(delivery.range) : <span style={muted}>Not set</span>}</td>
                    <td style={cell}>{total ? <b>{daysText(total)}</b> : <span style={muted}>–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </s-section>
    </>
  );
}

function Sales({ data }: { data: Data }) {
  return (
    <s-section heading="Orders and sales by vendor">
      {data.vendors.length === 0 ? (
        <s-paragraph>No orders yet.</s-paragraph>
      ) : (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Vendor</th>
              <th style={cell}>Orders</th>
              <th style={cell}>Units sold</th>
              <th style={cell}>Gross (₹)</th>
              <th style={cell}>Refunded (₹)</th>
              <th style={cell}>Net (₹)</th>
              <th style={cell}>Units to ship</th>
              <th style={cell}>Open orders</th>
              <th style={cell}>Portal access</th>
            </tr>
          </thead>
          <tbody>
            {data.vendors.map((v) => (
              <tr key={v.vendorName || "__none__"}>
                <td style={cell}><s-link href={vendorHref(v.vendorName)}>{v.vendorName || "(no vendor)"}</s-link></td>
                <td style={cell}>{v.orders}</td>
                <td style={cell}>{v.units}</td>
                <td style={cell}>{inr(v.gross)}</td>
                <td style={cell}>{inr(v.refunded)}</td>
                <td style={cell}>{inr(v.net)}</td>
                <td style={cell}>{v.unitsToShip}</td>
                <td style={cell}>{v.openOrders}</td>
                <td style={cell}>{v.portal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <s-paragraph>
        All time. Gross is after discounts and before refunds; cancelled orders add nothing. Shipping and taxes are not split by vendor yet.
      </s-paragraph>
    </s-section>
  );
}

function Sync({ data }: { data: Data }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const result = fetcher.data;
  useEffect(() => {
    if (result && result.ok && "orders" in result) shopify.toast.show(`Resynced ${result.orders} orders`);
  }, [result, shopify]);
  return (
    <s-section heading="Order sync">
      <s-paragraph>
        {plural(data.orderCount, "order")} copied · last full sync {when(data.lastFullSyncAt)}. New and changed orders arrive automatically within a few seconds.
        Copy everything again only if the numbers here don&apos;t match Shopify.
      </s-paragraph>
      {data.lastError && <s-banner tone="critical">Last sync error: {data.lastError}</s-banner>}
      {result && !result.ok && <s-banner tone="critical">{result.error}</s-banner>}
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="resync" />
        <s-button type="submit" {...(fetcher.state !== "idle" ? { loading: true } : {})}>Resync all orders</s-button>
      </fetcher.Form>
    </s-section>
  );
}

export default function ShippingAndOrders() {
  const data = useLoaderData<typeof loader>();
  const { totals, delivery } = data;
  return (
    <s-page heading="Shipping and orders">
      <Tabs label="Shipping and orders" current={data.view} tabs={[
        { id: "shipping", label: "Shipping", to: "/app/orders" },
        { id: "sales", label: "Sales by vendor", to: "/app/orders?view=sales", count: data.vendors.length },
        { id: "sync", label: "Order sync", to: "/app/orders?view=sync" },
      ]} />
      <s-section>
        <Stats items={[
          { label: "Units to ship", value: String(totals.unitsToShip), note: totals.unitsToShip ? `Across ${plural(totals.vendorsToShip, "vendor")}` : "Nothing is waiting" },
          { label: "Delivery time", value: delivery.range ? daysText(delivery.range) : "Not set", note: delivery.error ? "Not on the store yet" : undefined },
          { label: "Orders", value: String(data.orderCount), note: "Copied from Shopify" },
          { label: "Net sales", value: inr(totals.net), note: "All time, after refunds" },
        ]} />
      </s-section>
      {data.lastError && data.view !== "sync" && <s-banner tone="critical">Orders didn&apos;t copy from Shopify. <s-link href="/app/orders?view=sync">See order sync</s-link></s-banner>}
      {data.view === "shipping" && <Shipping data={data} />}
      {data.view === "sales" && <Sales data={data} />}
      {data.view === "sync" && <Sync data={data} />}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
