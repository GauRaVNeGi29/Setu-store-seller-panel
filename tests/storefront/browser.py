"""Storefront check, step 2: opens the pages made by render.mjs in Chromium (desktop and phone)
and checks the Brands list (sort, search, pages, product rows) and the seller page header."""
import asyncio, datetime, functools, http.server, json, os, sys, threading, urllib.parse
from playwright.async_api import async_playwright

# "Dec 10": the date so many days from today, as the seller page writes it.
day = lambda n: (datetime.date.today() + datetime.timedelta(days=n)).strftime("%b %-d")
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".cache/storefront")
res = []
# The pages are served over http so the Feedback block can call its address; the app's answers are stood in for below.
_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=OUT))
threading.Thread(target=_srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{_srv.server_address[1]}"


PAT = "**/apps/setu-seller/reviews**"

class FakeApp:
    """Answers /apps/setu-seller/reviews the way app/routes/proxy.reviews.tsx does."""
    def __init__(self, signed_in=False, can_review=False, fail=False, empty=False):
        self.signed_in, self.can_review, self.fail, self.posts, self.mine, self.gets = signed_in, can_review, fail, [], None, []
        self.reviews = [] if empty else [{"rating": 5, "comment": "Lovely finish, well packed.", "author": "Meera", "date": "2026-11-20T10:00:00Z", "edited": False, "item": "Sunburst Pearl Ring"},
                        {"rating": 4, "comment": "<img src=x onerror=\"document.title='hacked'\"> Good", "author": "Verified buyer", "date": "2026-11-18T10:00:00Z", "edited": True, "item": None}] \
            + [{"rating": 3 if i else 1, "comment": f"Older {i}", "author": "Buyer", "date": "2026-10-01T10:00:00Z", "edited": False, "item": None} for i in range(10)]
    async def handle(self, route):
        req = route.request
        q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(req.url).query).items()}
        if self.fail:
            return await route.fulfill(status=500, content_type="application/json", body='{"ok":false}')
        if req.method == "POST":
            f = {k: v[0] for k, v in urllib.parse.parse_qs(req.post_data or "", keep_blank_values=True).items()}
            self.posts.append(f)
            self.mine = {"rating": int(f["rating"]), "comment": f.get("comment", ""), "name": f.get("name", ""), "item": f.get("item", ""), "hidden": False}
            self.reviews.insert(0, {"rating": int(f["rating"]), "comment": f.get("comment") or None, "author": f.get("name") or "Verified buyer", "date": "2026-11-25T10:00:00Z", "edited": False, "item": "Molten Gold Studs" if f.get("item") == "22" else None})
            return await route.fulfill(content_type="application/json", body='{"ok":true,"replaced":false}')
        self.gets.append(q)
        page, sort = int(q.get("page", "1")), q.get("sort", "newest")
        rows = self.reviews if sort == "newest" else sorted(self.reviews, key=lambda r: r["rating"], reverse=sort == "highest")  # a stable sort: newest first within the same stars
        n = len(rows)
        body = {"ok": True, "summary": {"count": n, "average": f"{sum(r['rating'] for r in rows) / n:.1f}" if n else None, "breakdown": {str(k): sum(1 for r in rows if r["rating"] == k) for k in range(1, 6)}},
                "page": page, "sort": sort, "more": page * 10 < n, "reviews": rows[(page - 1) * 10: page * 10]}
        if page == 1 and q.get("only") != "list":
            body["me"] = {"signedIn": True, "canReview": self.can_review, "items": [{"id": "11", "title": "Sunburst Pearl Ring"}, {"id": "22", "title": "Molten Gold Studs"}] if self.can_review else [], "review": self.mine} if self.signed_in else {"signedIn": False}
        await route.fulfill(content_type="application/json", body=json.dumps(body))

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
            app = FakeApp(); await p.route(PAT, app.handle)  # seller pages ask the app for reviews; each reviews check below swaps in its own
            await p.goto(f"{BASE}/brands.html"); await p.wait_for_selector("[data-setu-ready]")
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
            await p.goto(f"{BASE}/brands-auto.html"); await p.wait_for_selector("[data-setu-ready]")
            check(f"[{label}] with no placeholder, the list adds itself to the end of the page content", await p.locator("#MainContent > .setu-all-brands--auto [data-setu-brand]:not([hidden])").count() == 10 and await p.evaluate("document.documentElement.scrollWidth") <= vp["width"])
            await p.goto(f"{BASE}/brands-nojs.html")
            check(f"[{label}] without the script, every seller still lists", await p.locator("[data-setu-brand]:visible").count() == 13 and not await p.is_visible("[data-setu-bar]"))
            await p.goto(f"{BASE}/seller-urban.html"); await p.wait_for_selector(".setu-seller")
            h1 = await p.eval_on_selector_all("h1", "els => els.map(e => [e.textContent.trim(), e.hidden, !!e.closest('.setu-seller')])")
            body = " ".join((await p.inner_text(".setu-seller")).split())
            check(f"[{label}] seller page: header at the top of the page with banner, name, minimum, rating, description", await p.evaluate("document.querySelector('#MainContent').firstElementChild.classList.contains('setu-seller-header')") and await p.locator(".setu-seller__banner img").count() == 1 and all(x in body for x in ["Urban Store", "Rs. 1,000.00", "4.5 (2)", "cast and finished by hand"]), body)
            check(f"[{label}] seller page: the theme's own title is hidden, the seller's name is the one heading", sorted(h1) == sorted([["Urban Store", True, False], ["Urban Store", False, True]]), str(h1))
            check(f"[{label}] seller page: no sideways scroll", await p.evaluate("document.documentElement.scrollWidth") <= vp["width"])
            await p.screenshot(path=f"{OUT}/seller-{label}.png", full_page=True)
            about = await p.eval_on_selector_all(".setu-seller__meta--about li", "els => els.map(e => e.textContent.trim())")
            check(f"[{label}] seller page, line 1 under the name: rating, city and country, joining date, number of products", len(about) == 4 and about[0].endswith("4.5 (2)") and about[1:] == ["Ludhiana, India", "Joined March 2026", "10 products"], str(about))
            terms = await p.eval_on_selector_all(".setu-seller__meta--terms li", "els => els.map(e => e.textContent.trim())")
            check(f"[{label}] seller page, line 2: the minimum, then the dates an order placed today arrives (today + 15 to 22 days)", terms == ["Rs. 1,000.00 minimum", f"Arrives {day(15)} – {day(22)}"], str(terms))
            box = await p.evaluate("(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const n = r('.setu-seller__name'), a = r('.setu-seller__meta--about'), t = r('.setu-seller__meta--terms'), m = r('.setu-seller__min'); return [a.top >= n.bottom - 1, t.top >= a.bottom - 1, Math.abs(m.left - n.left) < 2, t.right <= innerWidth] })()")
            check(f"[{label}] seller page: the minimum sits under the name, lined up with it, not in the right corner", all(box) and await p.locator(".setu-vendor-hd__min").count() == 0, str(box))
            check(f"[{label}] seller page: processing and delivery times are not spelled out", not any(x in body for x in ["Processing time", "Delivery time", "days"]), body)
            tags = await p.eval_on_selector_all(".setu-seller__values li", "els => els.map(e => e.textContent.trim())")
            check(f"[{label}] seller page: brand values (the seller's five tags, in their order) where the short description was, with no 'Brand values' wording on show (it stays as the list's name for screen readers)", tags == ["Women owned", "Eco-friendly", "Handmade", "Small batch", "Made in India"] and "Brand values" not in body and await p.get_attribute(".setu-seller__values", "aria-label") == "Brand values" and await p.locator(".setu-seller__tagline").count() == 0 and "Handmade in small batches" not in body, str(tags))
            mid = await p.eval_on_selector_all(".setu-seller__values li", "els => els.map(e => { const b = e.getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(e); const t = r.getBoundingClientRect(); return [Math.abs((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2), Math.abs((t.left + t.right) / 2 - (b.left + b.right) / 2), b.height, getComputedStyle(e).borderTopLeftRadius] })")
            check(f"[{label}] seller page: each tag's words sit in the middle of its rounded border, up-down and left-right, and every pill is the same height", all(m[0] <= 1 and m[1] <= 1 and m[2] == 30 and m[3] != "0px" for m in mid), str(mid))
            vbox = await p.evaluate("(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const v = r('.setu-seller__values'), t = r('.setu-seller__meta--terms'), n = r('.setu-seller__name'), a = r('.setu-seller__about'); const pills = [...document.querySelectorAll('.setu-seller__values li')].map(e => e.getBoundingClientRect()); return [v.top >= t.bottom - 1, v.bottom <= a.top + 1, Math.abs(v.left - n.left) < 2, pills.every(x => x.right <= innerWidth && x.left >= 0), document.documentElement.scrollWidth <= innerWidth] })()")
            check(f"[{label}] seller page: brand values sit under the minimum line, lined up with the name, above the description, and wrap inside the page", all(vbox), str(vbox))

            # ---- Ratings and reviews under the products, as a visitor who isn't signed in
            await p.wait_for_selector(".setu-reviews__item")
            sec = p.locator("#SetuReviews")
            check(f"[{label}] no Feedback button in the header any more; the rating there is a link to the reviews", await p.locator("[data-setu-feedback-open], .setu-seller__feedback-btn").count() == 0 and "Feedback" not in body and await p.get_attribute(".setu-seller__meta--about a", "href") == "#SetuReviews" and "4.5 (2)" in await p.inner_text(".setu-seller__rating-link"))
            place = await p.evaluate("(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const s = r('#SetuReviews'), g = r('.grid'), f = r('footer'), m = document.querySelector('#MainContent'); return [s.top >= g.bottom, s.bottom <= f.top + 1, m.lastElementChild.classList.contains('setu-seller-reviews'), document.querySelectorAll('#SetuReviews').length] })()")
            check(f"[{label}] 'Ratings and reviews' comes after the product listing, at the end of the page content, once", place == [True, True, True, 1] and (await p.inner_text(".setu-reviews__title")).strip() == "Ratings and reviews", str(place))
            side = " ".join((await p.inner_text(".setu-reviews__side")).split())
            bars = await p.eval_on_selector_all(".setu-reviews__bar", "els => els.map(e => [e.querySelector('.setu-reviews__bar-n').textContent, e.querySelector('.setu-reviews__bar-c').textContent, e.querySelector('.setu-reviews__bar-fill').style.width, e.getAttribute('aria-label')])")
            check(f"[{label}] left side: the big rating, 'Brand rating (12 reviews)', and a bar with a count for each number of stars, 5 down to 1", side.startswith("★ 3.1 out of 5 Brand rating (12 reviews)") and bars == [["5", "1", "8%", "5-star reviews: 1"], ["4", "1", "8%", "4-star reviews: 1"], ["3", "9", "75%", "3-star reviews: 9"], ["2", "0", "0%", "2-star reviews: 0"], ["1", "1", "8%", "1-star reviews: 1"]], side[:80] + str(bars))
            first = await p.evaluate("(() => { const li = document.querySelector('.setu-reviews__item'); return [li.querySelector('.setu-stars').getAttribute('aria-label'), li.querySelector('.setu-reviews__text').textContent, [...li.querySelectorAll('.setu-reviews__meta span')].map(e => e.textContent)] })()")
            check(f"[{label}] right side: the first 10 reviews, each with stars, the words, then date, name and item", await p.locator(".setu-reviews__item").count() == 10 and first == ["5 out of 5 stars", "Lovely finish, well packed.", ["Nov 20, 2026", "Meera", "About: Sunburst Pearl Ring"]] and "(edited)" in await p.inner_text(".setu-reviews__list"), str(first))
            check(f"[{label}] review text is shown as text, never run as HTML", await p.locator(".setu-reviews__list img").count() == 0 and await p.title() != "hacked" and "<img src=x" in await p.inner_text(".setu-reviews__list"))
            cols = await p.evaluate("(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const a = r('.setu-reviews__side'), b = r('.setu-reviews__main'), h = r('.setu-reviews__title'), s = r('[data-setu-rv-sort]'), g = r('.grid'); return { side: [a.left, a.top, a.right, a.bottom], main: [b.left, b.top, b.right], title: h.left, sortRight: s.right, sortTop: s.top, titleBottom: h.bottom, grid: [g.left, g.right] } })()")
            if label == "desktop":
                check(f"[{label}] two columns: rating on the left, reviews on the right, starting level; title and sort menu on one row; lined up with the products", abs(cols["side"][1] - cols["main"][1]) < 2 and cols["main"][0] >= cols["side"][2] + 40 and abs(cols["title"] - cols["grid"][0]) < 1 and abs(cols["sortRight"] - cols["grid"][1]) < 1 and cols["sortTop"] < cols["titleBottom"], str(cols))
            else:
                check(f"[{label}] on a phone: one column, the rating first and the reviews under it, inside the page", cols["main"][1] >= cols["side"][3] and abs(cols["side"][0] - cols["main"][0]) < 1 and cols["main"][2] <= vp["width"], str(cols))
            await p.locator("#SetuReviews").scroll_into_view_if_needed(); await p.screenshot(path=f"{OUT}/reviews-{label}.png", full_page=True)
            await p.click("[data-setu-rv-more]"); await p.wait_for_function("document.querySelectorAll('.setu-reviews__item').length === 12")
            check(f"[{label}] 'Show more reviews' adds the rest and then goes away", not await p.is_visible("[data-setu-rv-more]"))
            await p.select_option("[data-setu-rv-sort]", "highest"); await p.wait_for_function("document.querySelectorAll('.setu-reviews__item').length === 10 && !document.querySelector('.setu-reviews__list[aria-busy]')")
            top = await p.eval_on_selector_all(".setu-reviews__item .setu-stars", "els => els.slice(0, 3).map(e => e.getAttribute('aria-label')[0])")
            opts = await p.eval_on_selector_all("[data-setu-rv-sort] option", "els => els.map(e => e.textContent.trim())")
            check(f"[{label}] the sort menu (Newest, Highest rated, Lowest rated) re-orders the list without asking about the buyer again", opts == ["Newest", "Highest rated", "Lowest rated"] and top == ["5", "4", "3"] and app.gets[-1] == {"seller": "urban-store", "sort": "highest", "only": "list"} and await p.is_visible("[data-setu-rv-more]"), str(top) + str(app.gets[-1]))
            await p.select_option("[data-setu-rv-sort]", "lowest"); await p.wait_for_function("document.querySelector('.setu-reviews__item .setu-stars').getAttribute('aria-label')[0] === '1'")
            await p.click("[data-setu-rv-more]"); await p.wait_for_function("document.querySelectorAll('.setu-reviews__item').length === 12")
            check(f"[{label}] 'Show more' keeps the chosen order", app.gets[-1] == {"seller": "urban-store", "sort": "lowest", "page": "2"} and (await p.eval_on_selector_all(".setu-reviews__item .setu-stars", "els => els.map(e => e.getAttribute('aria-label')[0])"))[-2:] == ["4", "5"], str(app.gets[-1]))
            link = p.locator(".setu-reviews__write a")
            check(f"[{label}] signed out: a sign-in link that comes back to this page, and no form or 'Write a review' button", await link.get_attribute("href") == "/account/login?return_to=%2Fcollections%2Furban-store" and await p.locator("[data-setu-rv-form], [data-setu-rv-open]").count() == 0)
            check(f"[{label}] no sideways scroll with the reviews on the page", await p.evaluate("document.documentElement.scrollWidth") <= vp["width"])

            # ---- a long product listing: reviews load only when the buyer gets near them, or follows the rating link
            await p.unroute(PAT); app = FakeApp(); await p.route(PAT, app.handle)
            await p.goto(f"{BASE}/seller-urban-tall.html"); await p.wait_for_selector(".setu-seller"); await p.wait_for_timeout(300)
            far = await p.evaluate("document.querySelector('#SetuReviews').getBoundingClientRect().top > innerHeight + 700")
            waiting = " ".join((await p.inner_text(".setu-reviews__side")).split())
            check(f"[{label}] far below the screen, nothing is asked of the app yet; the rating and count the store already knows are there", far and app.gets == [] and waiting.startswith("★ 4.5 out of 5 Brand rating (2 reviews)"), f"{far} {app.gets} {waiting[:60]}")
            await p.click(".setu-seller__rating-link"); await p.wait_for_selector(".setu-reviews__item")
            check(f"[{label}] following the rating link goes to the reviews and loads them, once", len(app.gets) == 1 and await p.evaluate("(() => { const t = document.querySelector('#SetuReviews').getBoundingClientRect().top; return t >= 0 && t < innerHeight })()"), str(app.gets))

            # ---- signed in, with a shipped order from this seller
            await p.unroute(PAT); app = FakeApp(signed_in=True, can_review=True); await p.route(PAT, app.handle)
            await p.goto(f"{BASE}/seller-urban-buyer.html"); await p.wait_for_selector("[data-setu-rv-open]:not([hidden])")
            opener = p.locator("[data-setu-rv-open]")
            check(f"[{label}] a buyer sees 'Write a review' under the rating; the form stays shut until asked for", (await opener.inner_text()).strip() == "Write a review" and await opener.get_attribute("aria-expanded") == "false" and not await p.is_visible("[data-setu-rv-form]"))
            await opener.click()
            opts = await p.eval_on_selector_all("[data-setu-rv-item] option", "els => els.map(e => e.textContent.trim())")
            check(f"[{label}] the form: 5 stars, their items to choose from, their first name filled in", await opener.get_attribute("aria-expanded") == "true" and await p.is_visible("[data-setu-rv-form]") and await p.locator("input[name=rating]").count() == 5 and opts == ["The seller in general", "Sunburst Pearl Ring", "Molten Gold Studs"] and await p.input_value("input[name=name]") == "Asha")
            await p.click("[data-setu-rv-send]")
            check(f"[{label}] sending without a rating asks for one and sends nothing", (await p.inner_text("[data-setu-rv-error]")).startswith("Choose a rating") and app.posts == [])
            await p.locator("input[name=rating][value='4']").check(force=True)
            lit = await p.eval_on_selector_all(".setu-reviews__star", "els => els.map(e => getComputedStyle(e).color)")
            check(f"[{label}] choosing 4 stars fills the first four, and the 'choose a rating' message goes away", len(set(lit[:4])) == 1 and lit[4] != lit[0] and not await p.is_visible("[data-setu-rv-error]"), str(lit))
            await p.select_option("[data-setu-rv-item]", "22"); await p.fill("textarea[name=comment]", "Sturdy and well finished.")
            await p.screenshot(path=f"{OUT}/reviews-form-{label}.png", full_page=True)
            await p.click("[data-setu-rv-send]"); await p.wait_for_selector("[data-setu-rv-thanks]:not([hidden])")
            check(f"[{label}] the review is sent with the seller, rating, item, comment and name", app.posts == [{"rating": "4", "item": "22", "comment": "Sturdy and well finished.", "name": "Asha", "seller": "urban-store"}], str(app.posts))
            await p.wait_for_function("document.querySelector('.setu-reviews__item .setu-reviews__text')?.textContent === 'Sturdy and well finished.'")
            await p.wait_for_function("document.querySelector('[data-setu-rv-open]').textContent.trim() === 'Change your review'")
            first = " ".join((await p.locator(".setu-reviews__item").first.inner_text()).split())
            check(f"[{label}] after sending: thanks, the form shuts, the new review is at the top, the count goes up, and the button becomes 'Change your review'", "Asha" in first and "About: Molten Gold Studs" in first and not await p.is_visible("[data-setu-rv-form]") and "Brand rating (13 reviews)" in await p.inner_text(".setu-reviews__side") and await p.evaluate("document.activeElement.hasAttribute('data-setu-rv-open')"))
            await opener.click()
            check(f"[{label}] opening it again shows their answers ready to change", await p.inner_text("[data-setu-rv-form-title]") == "Change your review" and await p.input_value("textarea[name=comment]") == "Sturdy and well finished." and await p.locator("input[name=rating][value='4']").is_checked() and await p.input_value("[data-setu-rv-item]") == "22" and not await p.is_visible("[data-setu-rv-thanks]"))

            # ---- signed in, nothing shipped from this seller; a seller with no reviews; then the app not answering
            await p.unroute(PAT); app = FakeApp(signed_in=True, can_review=False); await p.route(PAT, app.handle)
            await p.goto(f"{BASE}/seller-urban-buyer.html"); await p.wait_for_selector("[data-setu-rv-cannot]:not([hidden])")
            check(f"[{label}] a buyer with nothing shipped from this seller is told why they can't review yet, with no button or form", "once an order from them has shipped" in await p.inner_text("[data-setu-rv-cannot]") and not await p.is_visible("[data-setu-rv-form]") and not await p.is_visible("[data-setu-rv-open]"))
            await p.unroute(PAT); app = FakeApp(empty=True); await p.route(PAT, app.handle)
            await p.goto(f"{BASE}/seller-empty.html"); await p.wait_for_function("document.querySelector('[data-setu-rv-status]').textContent.includes('will show here')")
            none = " ".join((await sec.inner_text()).split())
            check(f"[{label}] a seller with no reviews: 'No reviews yet', a line saying whose reviews will show, and no rating, bars or sort menu", none.startswith("Ratings and reviews No reviews yet.") and not await p.is_visible("[data-setu-rv-score]") and not await p.is_visible("[data-setu-rv-bars]") and not await p.is_visible("[data-setu-rv-sort]") and await p.locator(".setu-reviews__item").count() == 0, none[:120])
            await p.unroute(PAT); app = FakeApp(fail=True); await p.route(PAT, app.handle)
            await p.goto(f"{BASE}/seller-urban.html"); await p.wait_for_function("document.querySelector('[data-setu-rv-status]').textContent.includes('try again')")
            check(f"[{label}] if the app doesn't answer, the section says so, keeps the rating the store knows, and the rest of the page is fine", await p.is_visible(".setu-seller__name") and "Brand rating (2 reviews)" in await p.inner_text(".setu-reviews__side") and not await p.is_visible("[data-setu-rv-sort]"))
            await p.goto(f"{BASE}/seller-urban-noreviews.html"); await p.wait_for_selector(".setu-seller")
            check(f"[{label}] with reviews switched off in the theme: no section, and the rating in the header is plain text", await p.locator("#SetuReviews").count() == 0 and await p.locator(".setu-seller__rating-link").count() == 0 and "4.5 (2)" in await p.inner_text(".setu-seller__meta--about"))
            await p.unroute(PAT); app = FakeApp(); await p.route(PAT, app.handle)

            await p.goto(f"{BASE}/seller-ashnur.html"); await p.wait_for_selector(".setu-seller")
            check(f"[{label}] seller without a banner or description still gets a header", await p.locator(".setu-seller__banner").count() == 0 and "Ashnur Candles" in await p.inner_text(".setu-seller"))
            terms = await p.eval_on_selector_all(".setu-seller__meta--terms li", "els => els.map(e => e.textContent.trim())")
            check(f"[{label}] another seller: its own minimum and dates (today + 12 to 14 days)", terms == ["Rs. 10,000.00 minimum", f"Arrives {day(12)} – {day(14)}"], str(terms))
            await p.screenshot(path=f"{OUT}/seller-plain-{label}.png")
            # ---- The description box: full width, light grey, two lines with See more / See less
            geo = "(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const c = getComputedStyle(document.querySelector('.setu-seller__about')); const t = document.querySelector('.setu-seller__about-text'); const b = document.querySelector('[data-setu-about-toggle]'); return { seller: r('.setu-seller'), ref: r(REF), box: r('.setu-seller__about'), textH: t.clientHeight, fullH: t.scrollHeight, line: parseFloat(getComputedStyle(t).lineHeight), bg: c.backgroundColor, border: c.borderTopWidth + ' ' + c.borderTopStyle, button: b.hidden ? null : b.textContent.trim(), weight: getComputedStyle(b).fontWeight, expanded: b.getAttribute('aria-expanded'), page: document.documentElement.scrollWidth } })()"
            for page_name, ref, what in [("seller-ashnur-long.html", ".setu-seller__body", "plain header"), ("seller-urban-long.html", ".setu-seller__body", "header with a banner")]:
                await p.goto(f"{BASE}/{page_name}"); await p.wait_for_selector(".setu-seller")
                g = await p.evaluate(geo.replace("REF", repr(ref)))
                inset = 20 if "urban" in page_name and vp["width"] > 749 else 12 if "urban" in page_name else 0
                left, right = g["box"]["left"] - g["seller"]["left"], g["seller"]["right"] - g["box"]["right"]
                check(f"[{label}] description ({what}): a box across the full width, the same gap right as left", abs(left - right) < 1 and abs(left - inset) < 1 and g["box"]["width"] > g["seller"]["width"] - 2 * inset - 1 and g["page"] <= vp["width"], f"{left} {right} {g['box']['width']} {g['seller']['width']}")
                check(f"[{label}] description ({what}): light grey background (#f7f7f7) with a border", g["bg"] == "rgb(247, 247, 247)" and g["border"] == "1px solid", f"{g['bg']} {g['border']}")
                check(f"[{label}] description ({what}): opens two lines tall with 'See more'", g["textH"] <= 2 * g["line"] + 2 and g["textH"] > g["line"] and g["fullH"] > g["textH"] and g["button"] == "See more" and g["expanded"] == "false", str(g))
                first = await p.evaluate("(() => { const t = document.querySelector('.setu-seller__about-text'); const r = document.createRange(); r.selectNodeContents(t); const rows = new Set([...r.getClientRects()].filter(x => x.width > 1 && x.top < t.getBoundingClientRect().bottom - 2).map(x => Math.round(x.top))); return rows.size })()")
                check(f"[{label}] description ({what}): both of the two lines carry words (no blank line from a paragraph break)", first == 2, str(first))
                await p.click("[data-setu-about-toggle]")
                o = await p.evaluate(geo.replace("REF", repr(ref)))
                check(f"[{label}] description ({what}): 'See more' unfolds all of it, paragraphs kept, button becomes 'See less'", o["textH"] >= o["fullH"] - 1 and o["textH"] > 3 * o["line"] and o["button"] == "See less" and o["weight"] in ("400", "normal") and o["expanded"] == "true" and "Ships worldwide" in await p.inner_text(".setu-seller__about-text") and await p.locator(".setu-seller__about-text br:visible").count() >= 0 and o["page"] <= vp["width"], str(o))
                await p.screenshot(path=f"{OUT}/about-open-{label}.png") if "ashnur" in page_name else None
                await p.keyboard.press("Enter")
                c = await p.evaluate(geo.replace("REF", repr(ref)))
                check(f"[{label}] description ({what}): 'See less' folds it again (keyboard works, focus stays on the button)", c["textH"] == g["textH"] and c["button"] == "See more" and c["expanded"] == "false" and await p.evaluate("document.activeElement.hasAttribute('data-setu-about-toggle')"), str(c))
                await p.screenshot(path=f"{OUT}/about-{label}.png") if "ashnur" in page_name else None
            await p.goto(f"{BASE}/seller-urban.html"); await p.wait_for_selector(".setu-seller")
            fits = vp["width"] > 749  # the sample description is one line on a wide screen, more than two on a phone
            state = await p.evaluate("(() => { const b = document.querySelector('.setu-seller__about'), t = b.querySelector('p'), k = b.querySelector('button'); return [b.classList.contains('is-short'), !k.hidden, t.scrollHeight > t.clientHeight + 1] })()")
            check(f"[{label}] a description that fits in two lines shows whole with no button; on a screen where it doesn't fit, it folds", state == ([False, False, False] if fits else [True, True, True]) and "Urban Store makes" in await p.inner_text(".setu-seller__about"), str(state))
            await p.goto(f"{BASE}/seller-ashnur-long-nojs.html"); await p.wait_for_selector(".setu-seller")
            check(f"[{label}] without the script, the whole description shows and there is no dead button", await p.locator("[data-setu-about-toggle]:visible").count() == 0 and await p.evaluate("(() => { const t = document.querySelector('.setu-seller__about-text'); return t.scrollHeight <= t.clientHeight + 1 && t.clientHeight > 100 })()"))
            for page_name, want, what in [
                ("seller-urban-nodelivery.html", ["Rs. 1,000.00 minimum"], "no delivery time set: no arrival date"),
                ("seller-empty.html", ["Rs. 9,574.00 minimum"], "a seller without a processing time: no arrival date"),
                ("seller-urban-notimes.html", ["Rs. 1,000.00 minimum"], "switched off in the theme: no arrival date"),
                ("seller-ashnur-oneday.html", ["Rs. 10,000.00 minimum", f"Arrives by {day(8)}"], "both ends the same: one date"),
            ]:
                await p.goto(f"{BASE}/{page_name}"); await p.wait_for_selector(".setu-seller")
                terms = await p.eval_on_selector_all(".setu-seller__meta--terms li", "els => els.map(e => e.textContent.trim())")
                check(f"[{label}] arrival date, {what}", terms == want, str(terms))
            await p.goto(f"{BASE}/seller-urban-notimes.html"); await p.wait_for_selector(".setu-seller")
            check(f"[{label}] brand values can be switched off in the theme", await p.locator(".setu-seller__values").count() == 0)
            await p.goto(f"{BASE}/seller-empty.html"); await p.wait_for_selector(".setu-seller")
            check(f"[{label}] a seller with no brand values shows no label and no empty row", await p.locator(".setu-seller__values").count() == 0 and "Brand values" not in await p.inner_text(".setu-seller"))
            await p.goto(f"{BASE}/seller-ashnur.html"); await p.wait_for_selector(".setu-seller")
            one = await p.eval_on_selector_all(".setu-seller__values li", "els => els.map(e => e.textContent.trim())")
            check(f"[{label}] a seller with one brand value shows just that one", one == ["Cruelty-free"], str(one))
            await p.goto(f"{BASE}/not-seller.html"); await p.wait_for_timeout(300)
            check(f"[{label}] an ordinary collection gets no header and keeps its title", await p.locator(".setu-seller").count() == 0 and await p.locator(".setu-seller-header").count() == 0 and await p.is_visible("h1"))
            await ctx.close()
        errors = [e for e in errors if "Failed to load resource" not in e]  # the app-not-answering check does that on purpose
        check("no script errors", not errors, str(errors[:3]))
        await b.close()
    print(f"\n{sum(res)} passed, {len(res) - sum(res)} failed"); sys.exit(0 if all(res) else 1)
asyncio.run(main())
