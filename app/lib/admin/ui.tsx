import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { HIDE_REASON_MAX } from "../reviews/rules";

/**
 * Pieces the team's pages in Shopify admin share, so every page is laid out
 * the same way: tabs under the page title, a row of numbers, tables.
 */

export const cell = { padding: "8px 6px", borderBottom: "1px solid #eee", verticalAlign: "top" } as const;
export const table = { width: "100%", borderCollapse: "collapse", fontSize: 13 } as const;
export const headRow = { textAlign: "left", borderBottom: "1px solid #ddd" } as const;
export const input = { padding: 6, border: "1px solid #ccc", borderRadius: 6, font: "inherit" } as const;
export const muted = { color: "#616161" } as const;

export const inr = (v: string | number) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never");
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
export const vendorHref = (vendorName: string) => `/app/vendor?name=${encodeURIComponent(vendorName)}`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The activity record's codes in plain words. A code that isn't listed is shown as it is, with spaces. */
const ACTIVITY: Record<string, string> = {
  "sync.full": "All orders copied from Shopify",
  "order.synced": "Order copied from Shopify",
  "order.removed": "Order removed",
  "signup.created": "New sign-up",
  "signup.approved": "Sign-up approved",
  "signup.rejected": "Sign-up declined",
  "vendor.enabled": "Portal access set up for a vendor",
  "vendor.brand_updated": "Vendor changed their brand details",
  "vendor.details_updated_by_team": "Team changed a vendor's details",
  "vendor.business_change_requested": "Vendor asked to change business details",
  "vendor.business_change_withdrawn": "Vendor withdrew a business change",
  "vendor.business_change_approved": "Business change approved",
  "vendor.business_change_rejected": "Business change declined",
  "vendor.commission_set": "Commission rate set",
  "vendor.paused": "Vendor paused",
  "vendor.active": "Vendor made active again",
  "vendor_user.added": "Person added to a vendor",
  "vendor_user.updated": "Person's access changed",
  "vendor_user.details_updated": "Person changed their own details",
  "vendor_user.removed": "Person removed from a vendor",
  "vendor_user.staff_added": "Vendor invited a staff member",
  "vendor_user.staff_updated": "Vendor changed a staff member's access",
  "vendor_user.staff_removed": "Vendor removed a staff member",
  "review.added": "New review",
  "review.changed": "Buyer changed their review",
  "review.hidden": "Review hidden",
  "review.shown": "Review shown again",
  "settings.delivery_time_updated": "Delivery time changed",
  "mail.template_on": "Mail switched on",
  "mail.template_off": "Mail switched off",
  "mail.team_addresses_updated": "Team mail addresses changed",
  "mail.settings_updated": "Mail settings changed",
  "portal.team_view_opened": "Team opened a vendor's portal",
  "password.reset": "Password reset",
  "password.reset_requested": "Password reset asked for",
  "login.locked": "Sign-in locked after failed attempts",
  "login.success": "Signed in",
  "login.failed": "Failed sign-in",
};
export const activityText = (action: string) => ACTIVITY[action] ?? action.replace(/[._]/g, " ");

/** Who did it, without the internal prefix: a team member, a seller, a buyer, or the app itself. */
export function actorText(actor: string): string {
  if (actor.startsWith("admin:")) return `${actor.slice(6)} (team)`;
  if (actor.startsWith("portal:")) return `${actor.slice(7)} (seller)`;
  if (actor === "buyer") return "A buyer";
  if (actor === "webhook" || actor === "system") return "Automatic";
  return actor;
}

export type Tab = { id: string; label: string; to: string; count?: number };

/** A row of tabs under the page title. Each tab is a link, so a view can be bookmarked and the Back button works. */
export function Tabs({ tabs, current, label }: { tabs: Tab[]; current: string; label: string }) {
  return (
    <nav aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: 4, borderBottom: "1px solid #dcdcdc", margin: "0 0 16px" }}>
      {tabs.map((t) => {
        const on = t.id === current;
        return (
          <Link key={t.id} to={t.to} aria-current={on ? "page" : undefined}
            style={{
              padding: "10px 14px", marginBottom: -1, fontSize: 14, textDecoration: "none", color: on ? "#1a1a1a" : "#616161",
              fontWeight: on ? 600 : 400, borderBottom: `2px solid ${on ? "#1a1a1a" : "transparent"}`,
            }}>
            {t.label}{t.count !== undefined && <span style={{ marginLeft: 6, fontWeight: 400, color: "#616161" }}>{t.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

/** The tabs shared by the Vendors page and the Sign-ups page, with how many are in each. */
export function vendorTabs(counts: { all: number; attention: number; signups: number; noAccess: number }): Tab[] {
  return [
    { id: "all", label: "All vendors", to: "/app/vendors", count: counts.all },
    { id: "attention", label: "Needs attention", to: "/app/vendors?view=attention", count: counts.attention },
    { id: "signups", label: "Sign-ups", to: "/app/signups", count: counts.signups },
    { id: "no-access", label: "Without portal access", to: "/app/vendors?view=no-access", count: counts.noAccess },
  ];
}

export type StatItem = { label: string; value: string; note?: string; to?: string; linkLabel?: string };

/** A row of figures, each with what it counts and, where useful, a link to the page behind it. */
export function Stats({ items }: { items: StatItem[] }) {
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, margin: 0 }}>
      {items.map((s) => (
        <div key={s.label} style={{ border: "1px solid #e3e3e3", borderRadius: 8, padding: "12px 14px", background: "#fff" }}>
          <dt style={{ fontSize: 13, ...muted }}>{s.label}</dt>
          <dd style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }}>{s.value}</dd>
          {s.note && <dd style={{ margin: "4px 0 0", fontSize: 12, ...muted }}>{s.note}</dd>}
          {s.to && <dd style={{ margin: "8px 0 0", fontSize: 13 }}><Link to={s.to}>{s.linkLabel ?? "View"}</Link></dd>}
        </div>
      ))}
    </dl>
  );
}

export type TeamReview = {
  id: string; rating: number; comment: string | null; authorName: string; orderName: string; createdAt: string; edited: boolean;
  items: string[]; location: string | null; hidden: boolean; hiddenReason: string | null; hiddenBy: string | null;
  /** Set on the Reviews page, where the list covers every seller. */
  vendor?: { vendorName: string; name: string };
};

/**
 * One review as a table row, with Hide (a reason is required; the vendor sees
 * it) and Show again. Posts `hide_review` / `show_review` to the page it is on,
 * with `fields` added so that page knows which vendor it belongs to.
 */
export function ReviewRowView({ r, fields }: { r: TeamReview; fields: Record<string, string> }) {
  const fetcher = useFetcher<{ ok: boolean; message?: string; error?: string }>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.message) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);
  const reasonId = `reason-${r.id}`;
  const hidden = Object.entries({ ...fields, reviewId: r.id }).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
  return (
    <tr>
      {r.vendor && <td style={cell}><s-link href={vendorHref(r.vendor.vendorName)}>{r.vendor.name}</s-link></td>}
      <td style={{ ...cell, whiteSpace: "nowrap" }}><b>{r.rating}</b> / 5</td>
      <td style={cell}>
        {r.comment ? <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.comment}</span> : <span style={muted}>No written review</span>}
        <br /><small style={muted}>{r.authorName}{r.location ? ` (${r.location})` : ""}, {when(r.createdAt)}{r.edited ? " (edited)" : ""}, order {r.orderName}{r.items.length ? `, about ${r.items.join(", ")}` : ""}</small>
        {r.hidden && <><br /><small style={{ color: "#a63a32" }}>Hidden{r.hiddenBy ? ` by ${r.hiddenBy.replace(/^admin:/, "")}` : ""}{r.hiddenReason ? `: ${r.hiddenReason}` : ""}</small></>}
        {fetcher.data && !fetcher.data.ok && fetcher.data.error && <><br /><small style={{ color: "#a63a32" }}>{fetcher.data.error}</small></>}
        {fetcher.data && fetcher.data.ok && fetcher.data.error && <><br /><small style={{ color: "#8a5a12" }}>{fetcher.data.error}</small></>}
      </td>
      <td style={cell}>{r.hidden ? <s-badge tone="critical">Hidden</s-badge> : <s-badge tone="success">Published</s-badge>}</td>
      <td style={cell}>
        {r.hidden ? (
          <fetcher.Form method="post">
            {hidden}
            <input type="hidden" name="intent" value="show_review" />
            <s-button type="submit" {...(busy ? { loading: true } : {})}>Show again</s-button>
          </fetcher.Form>
        ) : asking ? (
          <fetcher.Form method="post" style={{ display: "grid", gap: 6, minWidth: 220 }} onSubmit={() => setAsking(false)}>
            {hidden}
            <input type="hidden" name="intent" value="hide_review" />
            <label htmlFor={reasonId} style={{ fontSize: 13 }}>Why hide it? The vendor sees this.</label>
            <input id={reasonId} name="reason" required maxLength={HIDE_REASON_MAX} placeholder="e.g. Abusive language" style={input} />
            <span style={{ display: "flex", gap: 6 }}>
              <s-button type="submit" tone="critical" {...(busy ? { loading: true } : {})}>Hide review</s-button>
              <s-button type="button" variant="tertiary" onClick={() => setAsking(false)}>Cancel</s-button>
            </span>
          </fetcher.Form>
        ) : (
          <s-button type="button" onClick={() => setAsking(true)} {...(busy ? { loading: true } : {})}>Hide</s-button>
        )}
      </td>
    </tr>
  );
}
