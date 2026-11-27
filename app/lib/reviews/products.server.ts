import type { AdminGraphql } from "../orders/sync.server";

/**
 * What the store needs to show a product beside a review: its current title,
 * a small picture and its page. Read from Shopify when the reviews are shown,
 * so a renamed product or a new photo shows up; kept for a few minutes so a
 * busy seller page doesn't ask again for every visitor.
 *
 * `url` is null for a product that is archived or a draft (no page to go to).
 * A product Shopify no longer has gets no card at all; the review then shows
 * the title from the buyer's order, as plain words.
 */
export type ProductCard = { title: string; url: string | null; image: string | null };

export const PRODUCTS_QUERY = `#graphql
  query SetuReviewProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id handle title status
        featuredMedia { preview { image { url(transform: { maxWidth: 240, maxHeight: 240 }) } } }
      }
    }
  }`;

const KEEP_MS = 10 * 60 * 1000;
const WAIT_MS = 3000;
const MAX_KEPT = 5000;
const kept = new Map<string, { at: number; card: ProductCard | null }>();

type Node = { id: string; handle: string; title: string; status: string; featuredMedia: { preview: { image: { url: string } | null } | null } | null } | null;

/** For tests. */
export const forgetProductCards = () => kept.clear();

/**
 * Cards for the given product ids (numbers as text), by id. Never throws: if
 * Shopify can't be asked or is slow, the ids it doesn't already know are
 * simply left out.
 */
export async function productCards(graphql: AdminGraphql | null, shop: string, ids: string[], now = Date.now()): Promise<Map<string, ProductCard>> {
  const out = new Map<string, ProductCard>();
  const ask: string[] = [];
  for (const id of new Set(ids)) {
    if (!/^\d{1,19}$/.test(id)) continue;
    const hit = kept.get(`${shop}:${id}`);
    if (hit && now - hit.at < KEEP_MS) {
      if (hit.card) out.set(id, hit.card);
    } else ask.push(id);
  }
  if (!ask.length || !graphql) return out;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("slow")), WAIT_MS); });
    const answer = (async () => (await (await graphql(PRODUCTS_QUERY, { variables: { ids: ask.slice(0, 250).map((id) => `gid://shopify/Product/${id}`) } })).json()) as { data?: { nodes: Node[] } })();
    const body = await Promise.race([answer, slow]).finally(() => clearTimeout(timer));
    if (!body.data) return out;
    if (kept.size > MAX_KEPT) kept.clear();
    const found = new Map(body.data.nodes.filter((n): n is NonNullable<Node> => !!n && !!n.id).map((n) => [n.id.split("/").pop()!, n]));
    for (const id of ask.slice(0, 250)) {
      const n = found.get(id);
      const card: ProductCard | null = n
        ? { title: n.title, url: n.status === "ACTIVE" ? `/products/${n.handle}` : null, image: n.featuredMedia?.preview?.image?.url ?? null }
        : null;
      kept.set(`${shop}:${id}`, { at: now, card });
      if (card) out.set(id, card);
    }
  } catch {
    // Reviews still show, with the titles from the orders.
  }
  return out;
}
