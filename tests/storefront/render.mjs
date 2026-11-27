// Storefront check, step 1: renders the theme extension's real snippets with a local Liquid
// engine (LiquidJS) and mock store data into static pages that load the real CSS and JS.
//   node tests/storefront/render.mjs extensions/setu-vendor-details .cache/storefront
//   python3 tests/storefront/browser.py .cache/storefront
// Shopify-only filters (image_url, money, t, …) are stood in for below; what Shopify itself
// returns (metaobject lookups, paginate in a snippet) was checked on the dev store.
import { Liquid } from "liquidjs";
import fs from "node:fs";
import path from "node:path";
const EXT = process.argv[2], OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const locale = JSON.parse(fs.readFileSync(path.join(EXT, "locales/en.default.json"), "utf8"));
const snippet = (name) => fs.readFileSync(path.join(EXT, "snippets", name + ".liquid"), "utf8").replace(/\{%-?\s*doc\s*-?%\}[\s\S]*?\{%-?\s*enddoc\s*-?%\}/g, "");
const engine = new Liquid({ fs: { readFileSync: (f) => snippet(path.basename(f, ".liquid")), existsSync: () => true, exists: async () => true, readFile: async (f) => snippet(path.basename(f, ".liquid")), resolve: (_r, f) => f, contains: () => true }, extname: ".liquid", strictFilters: true });
engine.registerTag("paginate", { parse(tok, remaining) { this.tpls = []; const stream = this.liquid.parser.parseStream(remaining).on("tag:endpaginate", () => stream.stop()).on("template", (t) => this.tpls.push(t)); stream.start(); }, *render(ctx, emitter) { yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter); } });
const swatch = (c, label = "") => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='${c}'/><text x='50' y='56' font-size='12' text-anchor='middle' fill='#fff'>${label}</text></svg>`);
engine.registerFilter("image_url", (img) => (img && img.src) || "");
engine.registerFilter("image_tag", (src, ...args) => { const o = Object.fromEntries(args.filter(Array.isArray)); return `<img src="${src}" alt="${o.alt ?? ""}" class="${o.class ?? ""}"${o.width ? ` width="${o.width}"` : ""}${o.height ? ` height="${o.height}"` : ""} loading="${o.loading ?? "lazy"}">`; });
engine.registerFilter("money", (c) => "Rs. " + (Number(c) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 }));
engine.registerFilter("within", (u, c) => (c ? c.url : "") + u);
engine.registerFilter("url_for_vendor", (v) => "/collections/vendors?q=" + encodeURIComponent(v));
engine.registerFilter("handleize", (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
engine.registerFilter("t", (key, ...args) => { const o = Object.fromEntries(args.filter(Array.isArray)); let v = key.split(".").reduce((a, k) => a?.[k], locale); if (v && typeof v === "object") v = o.count === 1 ? v.one : v.other; if (typeof v !== "string") throw new Error("missing translation " + key); return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => o[k] ?? ""); });

const COLORS = ["#8a6d3b", "#5b7a65", "#7a4b5b", "#4b617a", "#a0522d", "#556b2f"];
let pid = 0;
const product = (vendor, i) => ({ title: ["Golden Sculpted Statement Ring", "Sunburst Pearl Ring", "Molten Gold Studs", "Bell Jar Candle", "Leather Journal with a very long product name that should not wrap"][i % 5], url: `/products/p${++pid}`, vendor, price: 6000 + i * 4500, compare_at_price: i % 2 ? 9000 + i * 6000 : null, featured_image: { src: swatch(COLORS[(pid) % COLORS.length], "product"), alt: "Product photo" } });
const NAMES = ["Urban Store", "Ashnur", "Pyramid and Precious", "JAI AMAR PAPERS", "KKATHA ACCESSORIES", "State Art Corporation", "The Bamboo Bae", "Zari & Zardozi Handloom Weavers Co-operative", "ONEarth", "Blue Pottery Jaipur", "Channapatna Toys", "Kutch Weaves", "Moradabad Brass"];
const sellers = NAMES.map((name, i) => {
  const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const n = [10, 3, 0, 37, 17, 44, 212, 1, 5, 9, 12, 2, 1128][i];
  const products = Array.from({ length: Math.min(n, 30) }, (_, k) => product(name, k));
  const collection = i === 8 ? null : { id: 1000 + i, handle, title: name, url: "/collections/" + handle, products_count: n, all_products_count: n, products };
  if (collection) collection.products.first = products[0];
  const f = (v) => ({ value: v });
  return { system: { handle }, vendor_name: f(name), display_name: f(i === 1 ? "Ashnur Candles" : name), short_description: f(i % 2 ? "" : "Handmade in small batches"), description: f(i === 0 ? "Urban Store makes statement jewellery for boutiques.\nEvery piece is cast and finished by hand in Ludhiana." : ""), logo: f(i % 3 === 2 ? null : { src: swatch(COLORS[i % COLORS.length], "logo") }), banner: f(i === 0 ? { src: swatch("#c9b79c", "") } : null), minimum_order_value: f(i === 4 ? null : [1000, 10000, 9574, 2500][i % 4]), collection: f(collection), rating: f(i < 2 ? [4.5, 3.7][i] : null), review_count: f(i < 2 ? [2, 14][i] : null), location: f(i === 0 ? "Ludhiana, India" : i === 1 ? "India" : null), joined_on: f(i < 2 ? "2026-03-14" : null), processing_days_min: f(i < 2 ? [10, 7][i] : null), processing_days_max: f(i < 2 ? [15, 7][i] : null), brand_values: f(i === 0 ? ["Women owned", "Eco-friendly", "Handmade", "Small batch", "Made in India"] : i === 1 ? ["Cruelty-free"] : null) };
});
const marketplace_seller = { values: sellers };
for (const s of sellers) marketplace_seller[s.system.handle] = s;
const shop = { metaobjects: { marketplace_seller } };
const routes = { root_url: "/", account_login_url: "/account/login" };
// The store's delivery time: app-data metafields, read in Liquid as app.metafields.setu_seller.*
const delivery = (min, max) => ({ metafields: { setu_seller: { delivery_days_min: { value: min }, delivery_days_max: { value: max } } } });
const NO_APP_DATA = { metafields: {} };
// shop, routes, customer and app are global in Shopify: visible inside rendered snippets too.
const render = (name, vars) => engine.parseAndRenderSync(snippet(name), vars, { globals: { shop, routes, customer: vars.customer ?? null, app: vars.app ?? delivery(5, 7) } });

const css = fs.readFileSync(path.join(EXT, "assets/setu-vendor.css"), "utf8");
const js = ["setu-vendor.js", "setu-brands.js", "setu-reviews.js", "setu-review-form.js", "setu-about.js"].map((f) => fs.readFileSync(path.join(EXT, "assets", f), "utf8")).join("</script><script>");
const page = (title, main, templates) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{--color-background:#fff;--color-foreground:#4a4a4a}body{margin:0;font:14px/1.5 Georgia,serif;color:#4a4a4a;background:#fff}header,footer{padding:20px 40px;border-bottom:1px solid #eee}footer{background:#e9e4e0;margin-top:40px}h1{font-weight:400;font-size:40px;margin:0}.section{padding:40px 40px 0;max-width:1400px;margin:0 auto;box-sizing:border-box}.page-width-content{padding-bottom:80px}.rte{max-width:42rem}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.grid div{aspect-ratio:1;background:#f3f3f3}@media(max-width:749px){.section{padding:24px 16px 0}.grid{grid-template-columns:repeat(2,1fr)}}</style>
<style>${css}</style></head><body><header>Seller Panel Dev</header><main id="MainContent">${main}</main><footer>Footer</footer>${templates}<script>${js}</script></body></html>`;
const brands = render("setu-brands", { per_page: 10, product_limit: 8 });
fs.writeFileSync(path.join(OUT, "brands.html"), page("Brands", `<div class="section page-width-content"><h1>Brands</h1><div class="rte"><div class="setu-all-brands"></div></div></div>`, `<template id="setu-all-brands-tpl" data-auto="end">${brands}</template>`));
// The dev theme's page (Horizon): the section is a full-width grid whose side columns are the page margins, the
// title and the page text sit in the middle column, and rich text indents lists and gives items bullets and spacing.
const HORIZON = `<style>.hz{--page-margin:16px;display:grid;grid-template-columns:minmax(var(--page-margin),1fr) min(1800px,100% - var(--page-margin)*2) minmax(var(--page-margin),1fr);padding:40px 0 80px}.hz>*{grid-column:2}.hz-wrap{display:flex;flex-direction:column;gap:32px}.hz .rte{max-width:none}.rte :is(ul,ol):not(:is(ul,ol) :is(ul,ol)){padding-inline-start:2.25em;list-style:disc}.rte li{margin-block:.5em;list-style:inherit}.rte li::marker{content:"• "}@media(min-width:750px){.hz{--page-margin:40px}}</style>`;
fs.writeFileSync(path.join(OUT, "brands-horizon.html"), page("Brands", `${HORIZON}<div class="shopify-section"><div class="hz"><div class="hz-wrap"><h1>Brands</h1><div class="rte"><div class="setu-all-brands"></div></div></div></div></div>`, `<template id="setu-all-brands-tpl" data-auto="end">${brands}</template>`));
fs.writeFileSync(path.join(OUT, "brands-auto.html"), page("Brands", `<div class="section page-width-content"><h1>Brands</h1></div>`, `<template id="setu-all-brands-tpl" data-auto="end">${brands}</template>`));
fs.writeFileSync(path.join(OUT, "brands-nojs.html"), page("Brands", `<div class="section"><h1>Brands</h1>${render("setu-brands", { per_page: 10, wide: false })}</div>`, "").replace(/<script>[\s\S]*<\/script>/, ""));
const grid = (cells = 8) => `<div class="section"><div class="grid">${"<div></div>".repeat(cells)}</div></div>`;
// A seller's collection page as the app embed builds it: the header goes to the top of the content, ratings and reviews to the end.
const sellerPage = (c, name, customer = null, more = {}) => {
  const html = render("setu-seller-page", { collection: c, heading_tag: "h1", customer, ...more });
  const reviews = more.show_feedback === false ? "" : render("setu-seller-page", { part: "reviews", collection: c, customer });
  fs.writeFileSync(path.join(OUT, name), page(c.title, `<div class="section"><h1>${c.title}</h1></div>${grid(more.cells)}`,
    `<template id="setu-seller-header-tpl" data-auto="top" data-hide-title="${c.title}">${html}</template><template id="setu-seller-reviews-tpl" data-auto="bottom">${reviews}</template>`));
  return html.trim().length;
};
const urban = sellers[0].collection.value, ashnur = sellers[1].collection.value, pyramid = sellers[2].collection.value;
const rings = { id: 5, handle: "rings", title: "Rings", url: "/collections/rings", products_count: 2, all_products_count: 2, products: [urban.products[0], ashnur.products[0]] }; rings.products.first = rings.products[0];
const other = { id: 6, handle: "urban-store", title: "Urban Store", url: "/collections/x", products_count: 1, all_products_count: 1, products: [ashnur.products[0]] }; other.products.first = other.products[0];
sellerPage(urban, "seller-urban-buyer.html", { first_name: "Asha" });
sellerPage(urban, "seller-urban-tall.html", null, { cells: 48 }); // many products: the reviews start far below the screen
sellerPage(urban, "seller-urban-noreviews.html", null, { show_feedback: false });
// A long description in several paragraphs (folds to two lines), on a page with a banner and on one without; and without the script.
const LONG = "Ashnur: Handcrafted Candles, Made to Be Remembered\n\nAshnur makes handcrafted candles that do more than light up a room. Founded by makers with deep candle-making expertise, the studio hand-pours every candle in small batches. That keeps the quality consistent, piece after piece.\n\nThe collection includes sculpted floral blooms such as peonies, roses, lotus, daisies and sunflowers. There are also elegant jar and glass candles, modern ribbed and classic pillars, wooden urli and boat centrepieces, and festive collections for Diwali and Christmas.\n\nClean burning · Cruelty-free · Handmade in small batches · Custom hampers · Ships worldwide";
for (const [i, name] of [[0, "seller-urban-long.html"], [1, "seller-ashnur-long.html"]]) { const was = sellers[i].description; sellers[i].description = { value: LONG }; sellerPage(sellers[i].collection.value, name); sellers[i].description = was; }
fs.writeFileSync(path.join(OUT, "seller-ashnur-long-nojs.html"), fs.readFileSync(path.join(OUT, "seller-ashnur-long.html"), "utf8").replace(/<script>[\s\S]*<\/script>/, "").replace(/<template[^>]*>([\s\S]*)<\/template>/, "$1"));
// Arrival date: no delivery time set on the store; switched off in the theme; one-day delivery.
sellerPage(urban, "seller-urban-nodelivery.html", null, { app: NO_APP_DATA });
sellerPage(urban, "seller-urban-notimes.html", null, { show_times: false, show_values: false });
sellerPage(ashnur, "seller-ashnur-oneday.html", null, { app: delivery(1, 1) });
console.log(JSON.stringify({ urban: sellerPage(urban, "seller-urban.html") > 0, ashnur: sellerPage(ashnur, "seller-ashnur.html") > 0, emptySeller: sellerPage(pyramid, "seller-empty.html") > 0, categoryCollection: sellerPage(rings, "not-seller.html"), sameHandleDifferentCollection: sellerPage(other, "not-seller-2.html"), rows: (brands.match(/data-setu-brand /g) || []).length }));
