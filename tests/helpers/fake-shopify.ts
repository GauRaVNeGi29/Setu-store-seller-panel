import type { AdminGraphql } from "../../app/lib/orders/sync.server";
import type { ShopifyOrder } from "../../app/lib/orders/map";

/** Fake Admin API serving the given orders, paged 2 at a time, line items 2 at a time. */
export function fakeShopify(list: ShopifyOrder[]): AdminGraphql {
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
      throw new Error("unexpected query");
    },
  });
}
