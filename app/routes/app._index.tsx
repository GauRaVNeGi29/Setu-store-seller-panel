import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { dashboard } from "../lib/admin/dashboard.server";
import { activityText, actorText, cell, headRow, inr, muted, plural, Stats, table, vendorHref, when } from "../lib/admin/ui";
import { daysText } from "../lib/vendors/shipping";

/**
 * Dashboard: the app's home. A short view of everything: what needs the
 * team's attention (each line links to where it is dealt with), the main
 * numbers for vendors, shipping, orders and reviews, a sales report for the
 * last 30 days, and the latest activity. Nothing is changed from here.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return dashboard(db, session.shop);
};

export default function Dashboard() {
  const { alerts, numbers: n, report, delivery, lastFullSyncAt, activity } = useLoaderData<typeof loader>();
  const broken = alerts.filter((a) => a.tone === "critical");
  const waiting = alerts.filter((a) => a.tone === "warning");

  return (
    <s-page heading="Dashboard">
      {broken.map((a) => (
        <s-banner key={a.key} tone="critical">
          {a.text}. <s-link href={a.href}>Fix it</s-link>
        </s-banner>
      ))}

      <s-section heading="Needs your attention">
        {waiting.length === 0 ? (
          <s-paragraph>Nothing is waiting for you.</s-paragraph>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {waiting.map((a) => (
              <li key={a.key} style={{ marginBottom: 6 }}>
                <s-link href={a.href}>{a.text}</s-link>
                {a.vendors && (
                  <span style={muted}>
                    {": "}
                    {a.vendors.map((v, i) => (
                      <span key={v.vendorName}>
                        {i > 0 && ", "}
                        <s-link href={vendorHref(v.vendorName)}>{v.name}</s-link>
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </s-section>

      <s-section heading="At a glance">
        <Stats items={[
          {
            label: "Vendors", value: String(n.vendors.total),
            note: `${n.vendors.active} active${n.vendors.paused ? `, ${n.vendors.paused} paused` : ""}${n.vendors.signups ? ` · ${plural(n.vendors.signups, "sign-up")} waiting` : ""}`,
            to: "/app/vendors", linkLabel: "All vendors",
          },
          {
            label: "Units to ship", value: String(n.shipping.unitsToShip),
            note: n.shipping.unitsToShip ? `${plural(n.shipping.openOrders, "open order")} across ${plural(n.shipping.vendorsToShip, "vendor")}` : "Nothing is waiting to ship",
            to: "/app/orders", linkLabel: "Shipping and orders",
          },
          {
            label: "Delivery time", value: delivery.range ? daysText(delivery.range) : "Not set",
            note: delivery.range ? "Added to each seller's processing time" : "Seller pages show no arrival dates",
            to: "/app/orders", linkLabel: delivery.range ? "Change" : "Set it",
          },
          {
            label: "Reviews", value: n.reviews.average ? `${n.reviews.average} / 5` : "–",
            note: `${plural(n.reviews.published, "published review")}${n.reviews.hidden ? `, ${n.reviews.hidden} hidden` : ""} · ${n.reviews.last30Days} in the last 30 days`,
            to: "/app/reviews", linkLabel: "All reviews",
          },
          {
            label: "Mails sent", value: String(n.mail.sent),
            note: `Last 7 days${n.mail.waiting ? ` · ${n.mail.waiting} waiting` : ""}${n.mail.failed ? ` · ${n.mail.failed} failed` : ""}${n.mail.bounced ? ` · ${n.mail.bounced} bounced` : ""}`,
            to: "/app/mail", linkLabel: "Mail",
          },
        ]} />
      </s-section>

      <s-section heading={`Sales report: last ${report.days} days`}>
        <Stats items={[
          { label: "Orders", value: String(report.orders) },
          { label: "Units sold", value: String(report.units) },
          { label: "Net sales", value: inr(report.net), note: "After discounts and refunds" },
          { label: "All-time net sales", value: inr(n.orders.net), note: `${plural(n.orders.total, "order")} copied from Shopify` },
        ]} />
        <h3 style={{ fontSize: 14, margin: "16px 0 6px" }}>Top vendors by sales</h3>
        {report.topVendors.length === 0 ? (
          <s-paragraph>No sales in the last {report.days} days.</s-paragraph>
        ) : (
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Vendor</th>
                <th style={cell}>Orders</th>
                <th style={cell}>Units sold</th>
                <th style={cell}>Net sales</th>
              </tr>
            </thead>
            <tbody>
              {report.topVendors.map((v) => (
                <tr key={v.vendorName}>
                  <td style={cell}><s-link href={vendorHref(v.vendorName)}>{v.name || "(no vendor)"}</s-link></td>
                  <td style={cell}>{v.orders}</td>
                  <td style={cell}>{v.units}</td>
                  <td style={cell}>{inr(v.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <s-paragraph>
          Sales for every vendor, and what is still to ship, are under <s-link href="/app/orders">Shipping and orders</s-link>.
        </s-paragraph>
      </s-section>

      <s-section heading="Recent activity">
        {activity.length === 0 ? (
          <s-paragraph>Nothing has happened yet.</s-paragraph>
        ) : (
          <table style={table}>
            <tbody>
              {activity.map((a) => (
                <tr key={a.id}>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>{when(a.at)}</td>
                  <td style={cell}>{activityText(a.action)}</td>
                  <td style={{ ...cell, ...muted }}>{actorText(a.actor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <s-paragraph>Orders last copied in full from Shopify: {when(lastFullSyncAt)}.</s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
