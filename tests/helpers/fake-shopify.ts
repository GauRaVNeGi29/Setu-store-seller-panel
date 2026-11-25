import type { AdminGraphql } from "../../app/lib/orders/sync.server";
import type { ShopifyOrder } from "../../app/lib/orders/map";

/** The app's own data on the fake store: app-data metafields as "namespace.key" → value. `deny` makes Shopify refuse writes. */
export type FakeAppData = { metafields: Map<string, string>; deny?: boolean; ops: string[] };
export const fakeAppData = (): FakeAppData => ({ metafields: new Map(), ops: [] });
const INSTALLATION = "gid://shopify/AppInstallation/1";

/** Fake Admin API serving the given orders, paged 2 at a time, line items 2 at a time. */
export function fakeShopify(list: ShopifyOrder[], app?: FakeAppData): AdminGraphql {
  const page = <T,>(items: T[], after: string | null | undefined, size: number) => {
    const start = after ? Number(after) : 0;
    const nodes = items.slice(start, start + size);
    const end = start + nodes.length;
    return { pageInfo: { hasNextPage: end < items.length, endCursor: String(end) }, nodes };
  };
  const shape = (o: ShopifyOrder, lineCursor: string | null | undefined) => ({ ...o, lineItems: page(o.lineItems.nodes, lineCursor, 2) });
  return async (query, opts) => ({
    json: async () => {
      const v = opts?.variables ?? {};
      if (query.includes("SetuVendorOrdersPage")) {
        const p = page(list, v.cursor as string | null, 2);
        return { data: { orders: { ...p, nodes: p.nodes.map((o) => shape(o, null)) } } };
      }
      if (query.includes("SetuVendorOrder(")) {
        const o = list.find((x) => x.id === v.id);
        return { data: { order: o ? shape(o, v.lineCursor as string | null) : null } };
      }
      if (query.includes("SetuVendorNames")) {
        const names = new Set(list.flatMap((o) => o.lineItems.nodes.map((li) => li.vendor ?? "")).filter(Boolean));
        return { data: { productVendors: { nodes: [...names].sort() } } };
      }
      if (app && query.includes("SetuAppInstallation")) return { data: { currentAppInstallation: { id: INSTALLATION } } };
      if (app && (query.includes("SetuSettingsSet") || query.includes("SetuSettingsDelete"))) {
        const set = query.includes("SetuSettingsSet");
        app.ops.push(set ? "set" : "delete");
        if (app.deny) return { errors: [{ message: "Access denied for metafieldsSet field." }] };
        const items = v.metafields as { ownerId: string; namespace: string; key: string; type?: string; value?: string }[];
        if (items.some((m) => m.ownerId !== INSTALLATION)) throw new Error("wrong owner");
        for (const m of items) {
          if (!set) app.metafields.delete(`${m.namespace}.${m.key}`);
          else if (m.type !== "number_integer" || !/^\d+$/.test(m.value ?? "")) return { data: { metafieldsSet: { metafields: [], userErrors: [{ message: "Value must be an integer." }] } } };
          else app.metafields.set(`${m.namespace}.${m.key}`, m.value!);
        }
        return { data: set ? { metafieldsSet: { metafields: items.map((m) => ({ key: m.key })), userErrors: [] } } : { metafieldsDelete: { deletedMetafields: items.map((m) => ({ key: m.key })), userErrors: [] } } };
      }
      throw new Error("unexpected query");
    },
  });
}
