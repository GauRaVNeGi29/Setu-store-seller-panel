"""Storefront check, step 2: opens the pages made by render.mjs in Chromium (desktop and phone)
and checks the Brands list (sort, search, pages, product rows) and the seller page header."""
import asyncio, os, sys
from playwright.async_api import async_playwright
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".cache/storefront")
res = []
def check(what, ok, detail=""):
    res.append(ok); print(("PASS " if ok else "FAIL ") + what + (f" — {detail}" if detail and not ok else ""), flush=True)
async def names(p):
    return await p.eval_on_selector_all("[data-setu-brand]:not([hidden]) .setu-brand__name", "els => els.map(e => e.textContent.trim())")
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        errors = []
        for label, vp in [("desktop", {"width": 1440, "height": 900}), ("mobile", {"width": 390, "height": 844})]:
            ctx = await b.new_context(viewport=vp, device_scale_factor=1, has_touch=label == "mobile")
            p = await ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e))); p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            await p.goto(f"file://{OUT}/brands.html"); await p.wait_for_selector("[data-setu-ready]")
            n = await names(p)
            check(f"[{label}] 10 of 13 sellers on page 1, sorted A–Z", len(n) == 10 and n == sorted(n, key=str.lower) and n[0] == "Ashnur Candles", str(n))
            check(f"[{label}] sort and search bar shows once the script runs", await p.is_visible("[data-setu-bar]"))
            pager = await p.eval_on_selector_all("[data-setu-pager] button", "els => els.map(e => [e.textContent, e.getAttribute('aria-label'), e.disabled, e.getAttribute('aria-current')])")
            check(f"[{label}] pager: ←, 1 (current), 2, →", [x[0] for x in pager] == ["←", "1", "2", "→"] and pager[0][2] and pager[1][3] == "page" and pager[2][1] == "Page 2", str(pager))
            box = await p.evaluate("(() => { const r = document.querySelector('.setu-brands').getBoundingClientRect(), h = document.querySelector('h1').getBoundingClientRect(), t = document.querySelector('.rte').getBoundingClientRect(); return { left: r.left, width: r.width, title: h.left, column: t.width } })()")
            sw = await p.evaluate("document.documentElement.scrollWidth")
            pad = 40 if label == "desktop" else 16
            check(f"[{label}] list is as wide as the page, past the text column, lined up with the title, no sideways scroll", sw <= vp["width"] and abs(box["left"] - box["title"]) < 1 and abs(box["width"] - (min(vp["width"], 1400) - 2 * pad)) < 2 and box["width"] >= box["column"], f"{box} sw={sw}")
            await p.screenshot(path=f"{OUT}/brands-{label}.png", full_page=True)
            await p.click("[data-setu-pager] button:has-text('2')")
            n2 = await names(p)
            check(f"[{label}] page 2 has the other 3 sellers", len(n2) == 3 and not set(n) & set(n2), str(n2))
            await p.select_option("[data-setu-sort]", "za")
            nz = await names(p)
            check(f"[{label}] Z–A goes back to page 1, reversed", len(nz) == 10 and nz == sorted(nz, key=str.lower, reverse=True), str(nz))
            await p.fill("[data-setu-search]", "ja")
            ns = await names(p)
            check(f"[{label}] search 'ja' finds JAI AMAR PAPERS and Blue Pottery Jaipur, no pager", sorted(ns) == ["Blue Pottery Jaipur", "JAI AMAR PAPERS"] and not await p.is_visible("[data-setu-pager]"), str(ns))
            await p.fill("[data-setu-search]", "zzzz")
            check(f"[{label}] no match shows a message", await names(p) == [] and await p.is_visible("[data-setu-none]"))
            await p.fill("[data-setu-search]", ""); await p.select_option("[data-setu-sort]", "az")
            await p.click("[data-setu-pager] button:has-text('2')")  # Urban Store is on page 2
            row = p.locator("[data-setu-brand]", has_text="Urban Store").first
            cards = await row.locator(".setu-brand__card").count()
            last = (await row.locator(".setu-brand__card--all").inner_text()).split()
            check(f"[{label}] a seller's row: 8 products then 'View all 10 products' linking to the collection", cards == 9 and last[:4] == ["View", "all", "10", "products"] and await row.locator(".setu-brand__card--all a").get_attribute("href") == "/collections/urban-store" and await row.locator(".setu-brand__seller").get_attribute("href") == "/collections/urban-store", f"{cards} {last}")
            rt = " ".join((await row.inner_text()).split())
            check(f"[{label}] row shows minimum, MSRP and the rating", all(x in rt for x in ["Minimum purchase amount Rs. 1,000.00", "MSRP", "4.5 (2)"]) and await row.locator("[role=img][aria-label='Rated 4.5 out of 5 from 2 reviews']").count() == 1, rt)
            check(f"[{label}] the row is on screen after changing page", await row.is_visible())
            empty = p.locator("[data-setu-brand]", has_text="Pyramid and Precious").first
            check(f"[{label}] a seller with no products says so, with no empty row", "No products listed yet." in await empty.inner_text() and await empty.locator(".setu-brand__card").count() == 0)
            if label == "desktop":
                nxt, prv, track = row.locator("[data-setu-next]"), row.locator("[data-setu-prev]"), row.locator("[data-setu-track]")
                check("[desktop] arrows: only 'more' shows at the start of a long row", await nxt.is_visible() and not await prv.is_visible())
                await nxt.click(); await p.wait_for_timeout(700)
                check("[desktop] 'more' scrolls the row and 'previous' appears", await track.evaluate("e => e.scrollLeft") > 100 and await prv.is_visible())
                for _ in range(4):
                    if await nxt.is_visible(): await nxt.click(); await p.wait_for_timeout(600)
                check("[desktop] at the end of the row 'more' goes away", not await nxt.is_visible() and await prv.is_visible())
                few = p.locator("[data-setu-brand]", has_text="Zari").first
                check("[desktop] a short row has no arrows", not await few.locator("[data-setu-next]").is_visible())
                await p.keyboard.press("Tab")
            else:
                check("[mobile] arrows are hidden; the row swipes", not await row.locator("[data-setu-next]").is_visible() and await row.locator("[data-setu-track]").evaluate("e => e.scrollWidth > e.clientWidth"))
            await p.set_viewport_size({"width": 1000 if label == "desktop" else 360, "height": 800}); await p.wait_for_timeout(150)
            w2 = await p.evaluate("(() => { const r = document.querySelector('.setu-brands').getBoundingClientRect(); return [r.left, r.right, document.documentElement.scrollWidth, innerWidth] })()")
            check(f"[{label}] the width follows the window when it is resized", w2[2] <= w2[3] and abs(w2[0] - pad) < 1 and abs(w2[1] - (w2[3] - pad)) < 2, str(w2))
            await p.set_viewport_size(vp)
            await p.goto(f"file://{OUT}/brands-auto.html"); await p.wait_for_selector("[data-setu-ready]")
            check(f"[{label}] with no placeholder, the list adds itself to the end of the page content", await p.locator("#MainContent > .setu-all-brands--auto [data-setu-brand]:not([hidden])").count() == 10 and await p.evaluate("document.documentElement.scrollWidth") <= vp["width"])
            await p.goto(f"file://{OUT}/brands-nojs.html")
            check(f"[{label}] without the script, every seller still lists", await p.locator("[data-setu-brand]:visible").count() == 13 and not await p.is_visible("[data-setu-bar]"))
            await p.goto(f"file://{OUT}/seller-urban.html"); await p.wait_for_selector(".setu-seller")
            h1 = await p.eval_on_selector_all("h1", "els => els.map(e => [e.textContent.trim(), e.hidden, !!e.closest('.setu-seller')])")
            body = " ".join((await p.inner_text(".setu-seller")).split())
            check(f"[{label}] seller page: header at the top of the page with banner, name, tagline, Min, rating, description", await p.evaluate("document.querySelector('#MainContent').firstElementChild.classList.contains('setu-seller-header')") and await p.locator(".setu-seller__banner img").count() == 1 and all(x in body for x in ["Urban Store", "Handmade in small batches", "Rs. 1,000.00", "4.5 (2)", "cast and finished by hand"]), body)
            check(f"[{label}] seller page: the theme's own title is hidden, the seller's name is the one heading", sorted(h1) == sorted([["Urban Store", True, False], ["Urban Store", False, True]]), str(h1))
            check(f"[{label}] seller page: no sideways scroll", await p.evaluate("document.documentElement.scrollWidth") <= vp["width"])
            await p.screenshot(path=f"{OUT}/seller-{label}.png", full_page=True)
            await p.goto(f"file://{OUT}/seller-ashnur.html"); await p.wait_for_selector(".setu-seller")
            check(f"[{label}] seller without a banner or description still gets a header", await p.locator(".setu-seller__banner").count() == 0 and "Ashnur Candles" in await p.inner_text(".setu-seller"))
            await p.screenshot(path=f"{OUT}/seller-plain-{label}.png")
            await p.goto(f"file://{OUT}/not-seller.html"); await p.wait_for_timeout(300)
            check(f"[{label}] an ordinary collection gets no header and keeps its title", await p.locator(".setu-seller").count() == 0 and await p.locator(".setu-seller-header").count() == 0 and await p.is_visible("h1"))
            await ctx.close()
        check("no script errors", not errors, str(errors[:3]))
        await b.close()
    print(f"\n{sum(res)} passed, {len(res) - sum(res)} failed"); sys.exit(0 if all(res) else 1)
asyncio.run(main())
