import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listAllVendors } from "../lib/vendors/team.server";

/**
 * All vendors with portal access: who owns each account, how many people,
 * who needs attention (approval, business changes). Team-only.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const vendors = await listAllVendors(db, session.shop);
  return {
    vendors,
    totals: {
      vendors: vendors.length,
      changes: vendors.filter((v) => v.pendingChange).length,
      approvals: vendors.reduce((n, v) => n + v.needsApproval, 0),
    },
  };
};

const cell = { padding: "8px 6px", borderBottom: "1px solid #eee", verticalAlign: "top" } as const;

export default function AllVendors() {
  const { vendors, totals } = useLoaderData<typeof loader>();
  return (
    <s-page heading="All vendors">
      {(totals.changes > 0 || totals.approvals > 0) && (
        <s-banner tone="warning">
          {totals.changes > 0 && <>{totals.changes} {totals.changes === 1 ? "vendor has" : "vendors have"} business changes waiting for approval. </>}
          {totals.approvals > 0 && <>{totals.approvals} {totals.approvals === 1 ? "person requires" : "people require"} approval. </>}
          Open the vendor to review.
        </s-banner>
      )}
      <s-section heading={`Vendors with portal access (${totals.vendors})`}>
        {vendors.length === 0 ? (
          <s-paragraph>No vendor has portal access yet. Approve a sign-up, or open a vendor from &ldquo;Vendors and orders&rdquo; and set up access.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={cell}>Vendor</th>
                <th style={cell}>Owner</th>
                <th style={cell}>People</th>
                <th style={cell}>Status</th>
                <th style={cell}>Needs attention</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => {
                const flags = [
                  v.pendingChange && "Business change to review",
                  v.needsApproval > 0 && `${v.needsApproval} requires approval`,
                  v.invited > 0 && `${v.invited} invited, no password yet`,
                ].filter(Boolean) as string[];
                return (
                  <tr key={v.id}>
                    <td style={cell}>
                      <s-link href={`/app/vendor?name=${encodeURIComponent(v.vendorName)}`}>{v.displayName}</s-link>
                      {v.displayName !== v.vendorName && <><br /><small style={{ color: "#666" }}>Shopify vendor: {v.vendorName}</small></>}
                      {v.city && <><br /><small style={{ color: "#666" }}>{v.city}</small></>}
                    </td>
                    <td style={cell}>{v.owners.length ? v.owners.join(", ") : <span style={{ color: "#a63a32" }}>No owner</span>}</td>
                    <td style={cell}>
                      {v.people} ({v.people - v.staff} owner{v.people - v.staff === 1 ? "" : "s"}, {v.staff} staff)
                      <br /><small style={{ color: "#666" }}>{v.active} active{v.deactivated ? ` · ${v.deactivated} deactivated` : ""}</small>
                    </td>
                    <td style={cell}>{v.status === "active" ? "Active" : <b>Paused</b>}</td>
                    <td style={cell}>{flags.length ? flags.map((f) => <div key={f}><s-badge tone="warning">{f}</s-badge></div>) : <span style={{ color: "#666" }}>–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
