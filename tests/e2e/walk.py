"""Browser walk-through of the Setu Store vendor portal against a local copy.

Run (from the repo root, with a throwaway database):
  E2E_DATABASE_URL=postgresql://…/vp_e2e npx prisma migrate deploy
  E2E_DATABASE_URL=… npx tsx tests/e2e/helper.mts seed
  npm run build && NODE_ENV=development DATABASE_URL=$E2E_DATABASE_URL PORTAL_SHOP=seller-panel-dev.myshopify.com \
    ALLOWED_SHOPS=seller-panel-dev.myshopify.com PORTAL_DEV_SHOW_EMAILS=true SHOPIFY_API_KEY=x SHOPIFY_API_SECRET=y \
    SHOPIFY_APP_URL=http://localhost:3999 SCOPES=read_orders PORT=3999 npx react-router-serve build/server/index.js
  python3 tests/e2e/walk.py        (needs: pip install playwright; optional E2E_CHROME=/path/to/chrome)
Never point it at the Neon dev database or production: "seed" wipes the vendor tables.

Every check is recorded as PASS/FAIL; browser console errors and failed
requests (other than expected 404s) are collected per page.
"""
import asyncio, json, os, re, subprocess, sys
from playwright.async_api import async_playwright

B = "http://localhost:3999"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ENV = {**os.environ, "DATABASE_URL": os.environ.get("E2E_DATABASE_URL", "postgresql://postgres:ci@localhost:5432/vp_e2e")}
PDF = b"%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'


def png(w, h, rgb):
    import struct, zlib
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


PNG_LOGO = png(64, 64, (63, 107, 78))
PNG_BANNER = png(320, 100, (183, 121, 31))
CONT = "fieldset.vp-step:not([hidden]) button:has-text('Continue')"
PW, PW2 = "Demo-password-2026", "Brand-new-password-77"
SHOTS = os.path.join(REPO, ".cache", "e2e-shots")
os.makedirs(SHOTS, exist_ok=True)
results, console_errors = [], []


def check(area, what, ok, detail=""):
    results.append((area, what, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + f"[{area}] {what}" + (f" — {detail}" if detail and not ok else ""), flush=True)


def admin(*args):
    out = subprocess.run(["npx", "tsx", "tests/e2e/helper.mts", *args], cwd=REPO, env=ENV, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else None


INFLIGHT = {}


async def settle(page, quiet_ms=700, limit_ms=15000):
    """Wait until the page has had no requests in flight for quiet_ms (client-side navigations included)."""
    waited, quiet = 0, 0
    while waited < limit_ms:
        await page.wait_for_timeout(100); waited += 100
        quiet = quiet + 100 if INFLIGHT.get(id(page), 0) <= 0 else 0
        if quiet >= quiet_ms:
            return


def watch(page, label):
    INFLIGHT[id(page)] = 0
    page.on("request", lambda r: INFLIGHT.__setitem__(id(page), INFLIGHT[id(page)] + 1))
    page.on("requestfinished", lambda r: INFLIGHT.__setitem__(id(page), INFLIGHT[id(page)] - 1))
    page.on("requestfailed", lambda r: INFLIGHT.__setitem__(id(page), INFLIGHT[id(page)] - 1))
    page.on("console", lambda m: m.type == "error" and console_errors.append((label, m.text[:200])))
    page.on("pageerror", lambda e: console_errors.append((label, "pageerror: " + str(e)[:200])))


HYDRATED = "() => !!(window.__reactRouterDataRouter && window.__reactRouterDataRouter.state.initialized)"
IDLE = "() => { const r = window.__reactRouterDataRouter; return !r || (r.state.navigation.state === 'idle' && r.state.revalidation === 'idle' && [...r.state.fetchers.values()].every(f => f.state === 'idle')); }"


async def ready(p):
    """Page loaded and (when JavaScript is on) React Router has taken over the page."""
    await p.wait_for_load_state("networkidle")
    try:
        if await p.evaluate("() => typeof window.__reactRouterContext !== 'undefined'"):
            await p.wait_for_function(HYDRATED, timeout=10000)
            await p.wait_for_timeout(100)
    except Exception:
        pass  # JavaScript disabled


async def go(p, path):
    r = await p.goto(B + path)
    await ready(p)
    return r


async def login(p, email, pw=PW):
    await go(p, "/portal/login")
    await p.fill("#email", email)
    await p.fill("#password", pw)
    await submit(p, "button[type=submit]")
    try:
        await p.wait_for_url(lambda u: "/portal/login" not in u, timeout=6000)
        await ready(p); await settle(p)
    except Exception:
        err = p.locator(".vp-msg--error")
        print(f"   (sign-in as {email} stayed on login: {await err.inner_text() if await err.count() else 'no message'})", flush=True)


async def submit(page, target):
    """Click a submit button and wait for the form's POST to finish and the page to settle."""
    loc = page.locator(target) if isinstance(target, str) else target
    async with page.expect_response(lambda r: r.request.method == "POST" and r.url.startswith(B), timeout=20000):
        await loc.click()
    await ready(page)
    try:
        await page.wait_for_function(IDLE, timeout=15000)
    except Exception:
        pass
    await settle(page)


async def text(p):
    return await p.inner_text("body")


async def dev_link(p):
    a = p.locator(".vp-msg--dev a")
    return await a.get_attribute("href") if await a.count() else None


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(**({"executable_path": os.environ["E2E_CHROME"]} if os.environ.get("E2E_CHROME") else {}), args=["--no-sandbox"])
        desk = dict(viewport={"width": 1366, "height": 900})
        mob = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)

        # ------------------------------------------------------------ front page
        c = await browser.new_context(**desk); p = await c.new_page(); watch(p, "front")
        await go(p, "/")
        check("Front page", "shows Vendor sign-in button that opens /portal/login", await p.locator("a[href='/portal/login']").count() == 1)
        await go(p, "/portal")
        check("Sign-in", "signed-out visitor to /portal is sent to sign-in", p.url.endswith("/portal/login"))
        await c.close()

        # ------------------------------------------------------------ sign-up of a new seller (pending)
        c = await browser.new_context(**desk); p = await c.new_page(); watch(p, "signup-new")
        await go(p, "/portal/signup")
        ids = await p.eval_on_selector_all("form input:not([type=hidden])", "els => els.map(e => e.id)")
        check("Sign-up", "asks only for name, email, phone and password", ids == ["name", "email", "phone", "password"], str(ids))
        await submit(p, "button:has-text('Create account')")
        errs = await p.locator("[aria-invalid='true']").count()
        check("Sign-up", "sending it empty flags all four fields", errs == 4 and p.url.endswith("/portal/signup"), f"{errs} flagged")
        await p.fill("#name", "Meera Joshi"); await p.fill("#email", "meera@newbrand.example"); await p.fill("#phone", "+91 99887 76655")
        await p.fill("#password", PW)
        await p.click("button:has-text('Show')")
        check("Sign-up", "Show reveals the password while typing", await p.get_attribute("#password", "type") == "text")
        await submit(p, "button:has-text('Create account')")
        check("Sign-up", "a new seller lands on the 'under review' page", p.url.endswith("/portal/pending") and "reviewing your account" in await text(p), p.url)
        for path in ["/portal", "/portal/ship", "/portal/profile", "/portal/team", "/portal/orders/19043720134765"]:
            await go(p, path)
            if not p.url.endswith("/portal/pending"):
                check("Sign-up", f"applicant under review can't open {path}", False, p.url); break
        else:
            check("Sign-up", "applicant under review is kept away from every order and brand page", True)
        await go(p, "/portal/signup")
        check("Sign-up", "a signed-in applicant visiting sign-up goes to the review page", p.url.endswith("/portal/pending"))
        await c.close()

        # duplicate email + no-JS sign-up
        c = await browser.new_context(**desk, java_script_enabled=False); p = await c.new_page()
        await go(p, "/portal/signup")
        for k, v in {"name": "Dup", "email": "MEERA@newbrand.example", "phone": "+91 99887 76655", "password": PW}.items():
            await p.fill(f"#{k}", v)
        await submit(p, "button[type=submit]:has-text('Create account')")
        check("Sign-up", "without JavaScript the form still works; an email already in use (any capitals) is refused", "already exists" in await text(p))
        await go(p, "/portal/login")
        check("Sign-in", "sign-in page asks only for email and password", await p.eval_on_selector_all("form input:not([type=hidden])", "els => els.map(e => e.id)") == ["email", "password"])
        await p.fill("#email", "meera@newbrand.example"); await p.fill("#password", PW)
        await submit(p, "button[type=submit]")
        check("Sign-in", "signing in works before/without JavaScript (slow phones)", p.url.endswith("/portal/pending"), p.url)
        r = await go(p, "/portal/login")
        check("Security", "portal pages can't be framed, aren't cached, send no referrer to other sites",
              r.headers.get("x-frame-options") == "DENY" and "no-store" in r.headers.get("cache-control", "") and r.headers.get("referrer-policy") == "same-origin")
        await c.close()

        # ------------------------------------------------------------ invited owner signs up → straight in
        c = await browser.new_context(**desk); owner = await c.new_page(); watch(owner, "owner")
        await go(owner, "/portal/signup")
        await owner.fill("#name", "Harpreet Singh"); await owner.fill("#email", "owner@urban.example"); await owner.fill("#phone", "+91 98140 12345")
        await owner.fill("#password", PW)
        await submit(owner, "button:has-text('Create account')")
        check("Sign-up", "an email the team invited goes straight to its orders", owner.url.endswith("/portal"), owner.url)
        cookies = {x["name"]: x for x in await c.cookies()}
        ck = cookies.get("__Host-vp_session", {})
        check("Security", "session cookie is HttpOnly, Secure, SameSite=Lax", ck.get("httpOnly") and ck.get("secure") and ck.get("sameSite") == "Lax", str(ck)[:120])

        # ------------------------------------------------------------ dashboard
        body = await text(owner)
        check("Dashboard", "is the home page after sign-in, with a greeting", owner.url.endswith("/portal") and "Harpreet" in await owner.inner_text("h1"))
        check("Dashboard", "Dashboard is first in the menu", (await owner.locator("nav.vp-nav a").first.inner_text()).strip() == "Dashboard")
        check("Dashboard", "To ship card: 33 units across 3 orders, oldest first", "33 units waiting across 3 orders" in body)
        check("Dashboard", "never shows Ashnur's products", not re.search(r"Candle|Cutout", body))
        await owner.click(".vp-dash-range a:has-text('All time')"); await owner.wait_for_url("**range=all"); await settle(owner)
        body = await text(owner)
        check("Dashboard", "All time: sales ₹3,475.00, 4 orders, 51 units, ₹75.00 refunded",
              all(x in body for x in ["₹3,475.00", "₹868.75", "₹75.00"]) and await owner.locator(".vp-tile-value").first.inner_text() == "4")
        check("Dashboard", "top product is the Golden Armlet (₹800.00)", (await owner.locator(".vp-ranked li").first.inner_text()).startswith("Elegant Spiral Golden Armlet"))
        check("Dashboard", "orders by status: 1 shipped, 3 to ship, 1 cancelled",
              [await x.inner_text() for x in await owner.locator(".vp-segbar-part").all()] == ["1", "3", "1"])
        bar = owner.locator(".vp-chart-hit[aria-label*='Nov 2026: ₹3,475.00']")
        await bar.focus(); await owner.wait_for_timeout(150)
        tip = owner.locator(".vp-tip")
        check("Dashboard", "sales chart: focusing the November bar shows ₹3,475.00", await tip.count() == 1 and "₹3,475.00" in await tip.inner_text())
        await owner.click(".vp-tableview summary")
        check("Dashboard", "sales chart has a table view with every value", "₹3,475.00" in await owner.inner_text(".vp-tableview table"))
        await owner.click(".vp-dash-range a:has-text('Last 7 days')"); await owner.wait_for_url("**range=7"); await settle(owner)
        check("Dashboard", "Last 7 days shows 7 daily bars", await owner.locator(".vp-chart-hit").count() == 7)
        await owner.screenshot(path=f"{SHOTS}/dashboard.png", full_page=True)

        # ------------------------------------------------------------ orders
        await go(owner, "/portal/orders")
        body = await text(owner)
        check("My orders", "lists Urban Store's 5 orders at /portal/orders", all(f"#100{i}" in body for i in range(1, 6)))
        check("My orders", "never shows Ashnur products", not re.search(r"Candle|Cutout", body))
        await owner.click(".vp-seg a:has-text('To ship')"); await owner.wait_for_timeout(1200)
        check("My orders", "'To ship' filter opens and keeps only open orders", "#1005" not in await owner.inner_text("main"), owner.url)
        await go(owner, "/portal/orders/19043720298605")
        body = await text(owner)
        check("Order detail", "#1003 (two brands) shows only Urban Store's lines", "#1003" in body and "Candle" not in body)
        r = await go(owner, "/portal/orders/99999999")
        check("Order detail", "an order that doesn't exist answers 'not found' (404)", r.status == 404)
        r = await go(owner, "/portal/orders/abc' OR 1=1")
        check("Order detail", "a tampered order address answers 'not found' (404)", r.status == 404)

        # ------------------------------------------------------------ what to ship
        await go(owner, "/portal/ship")
        body = await text(owner)
        check("What to ship", "pick list shows units to ship for Urban Store only", "33" in body and "Candle" not in body)
        boxes = owner.locator("input[type=checkbox]")
        if await boxes.count():
            await boxes.first.check()
            check("What to ship", "ticking an item as packed works", await boxes.first.is_checked())
        check("What to ship", "has a Print pick list button", await owner.locator("button:has-text('Print pick list')").count() == 1)

        # ------------------------------------------------------------ orders page reminder
        await go(owner, "/portal")
        check("My brand", "orders page reminds a new vendor to complete their profile",
              "Complete your profile" in await text(owner) and "company name, business address and minimum order value" in await text(owner))

        # ------------------------------------------------------------ my brand: three sections
        await go(owner, "/portal/profile")
        heads = await owner.eval_on_selector_all("section.vp-panel h2", "els => els.map(e => e.textContent)")
        check("My brand", "has Seller details, Business details and Brand details", heads == ["Seller details", "Business details", "Brand details"], str(heads))
        body = await text(owner)
        check("My brand", "required details not yet added are marked", body.count("Required – not added yet") == 3)

        # seller details
        await owner.click("a[href$='?edit=seller']"); await owner.wait_for_url("**edit=seller"); await owner.wait_for_selector("#phone")
        check("Seller details", "email is shown but can't be edited", await owner.locator("input#email").count() == 0 and "can't be changed" in await text(owner))
        await owner.fill("#phone", "12"); await submit(owner, "button:has-text('Save')")
        check("Seller details", "a bad phone number is refused", "at least 8 digits" in await text(owner))
        await owner.fill("#phone", "+91 98140 00000"); await owner.fill("#name", "Harpreet S."); await submit(owner, "button:has-text('Save')")
        body = await text(owner)
        check("Seller details", "name and phone save at once", "Your details are saved." in body and "Harpreet S." in body and "+91 98140 00000" in body)
        check("Seller details", "password row links to Change password", await owner.locator("a[href='/portal/forgot']").count() == 1)

        # brand details with logo + banner
        await owner.click("a[href$='?edit=brand']"); await owner.wait_for_url("**edit=brand"); await owner.wait_for_selector("#minimumOrderValue")
        await owner.fill("#minimumOrderValue", ""); await owner.click("button:has-text('Save brand details')")
        check("Brand details", "minimum order value is required (stopped before sending)", await owner.evaluate("!document.querySelector('#minimumOrderValue').checkValidity()"))
        await owner.set_input_files("#logoFile", files=[{"name": "logo.svg", "mimeType": "image/svg+xml", "buffer": SVG}])
        await owner.fill("#minimumOrderValue", "1500")
        await submit(owner, "button:has-text('Save brand details')")
        check("Brand details", "an SVG logo is refused with a clear message", "PNG, JPG or WebP" in await text(owner))
        await owner.fill("#shortDescription", "Sunglasses and watches since 2017.")
        await owner.fill("#description", "Urban Store designs sunglasses, watches and statement jewellery in Ludhiana.")
        await owner.fill("#minimumOrderValue", "1500")
        await owner.set_input_files("#logoFile", files=[{"name": "logo.png", "mimeType": "image/png", "buffer": PNG_LOGO}])
        await owner.set_input_files("#bannerFile", files=[{"name": "banner.png", "mimeType": "image/png", "buffer": PNG_BANNER}])
        await submit(owner, "button:has-text('Save brand details')")
        body = await text(owner)
        check("Brand details", "description, short description and minimum save at once", "Brand details saved." in body and "1,500" in body and "since 2017" in body)
        imgs = await owner.eval_on_selector_all(".vp-brandpreview img", "els => els.map(e => e.naturalWidth)")
        check("Brand details", "logo and banner upload and show as a preview", len(imgs) == 2 and all(w > 0 for w in imgs), str(imgs))
        await owner.screenshot(path=f"{SHOTS}/brand.png", full_page=True)

        # business details with documents
        await owner.click("a[href$='?edit=business']"); await owner.wait_for_url("**edit=business"); await owner.wait_for_selector("#companyName")
        await owner.click("button:has-text('Send for approval')")
        bad = await owner.evaluate("['companyName','addressLine','city','state','postalCode'].filter(id => !document.getElementById(id).checkValidity())")
        check("Business details", "company name and full address are required (stopped before sending)", bad == ["companyName", "addressLine", "city", "state", "postalCode"], str(bad))
        await owner.fill("#companyName", "Urban Store Pvt Ltd"); await owner.fill("#addressLine", "5 Mall Road")
        await owner.fill("#city", "Ludhiana"); await owner.fill("#state", "Punjab"); await owner.fill("#postalCode", "14100")
        await submit(owner, "button:has-text('Send for approval')")
        check("Business details", "a 5-digit PIN code is refused", "6 digits" in await text(owner))
        await owner.fill("#postalCode", "141001")
        await owner.set_input_files("#gstFile", files=[{"name": "gst.pdf", "mimeType": "application/pdf", "buffer": b"<html>not a pdf</html>"}])
        await submit(owner, "button:has-text('Send for approval')")
        check("Business details", "an HTML file named .pdf is refused", "must be a PDF, JPG or PNG" in await text(owner))
        await owner.set_input_files("#gstFile", files=[{"name": "GST certificate.pdf", "mimeType": "application/pdf", "buffer": PDF}])
        await owner.set_input_files("#iecFile", files=[{"name": "IEC.pdf", "mimeType": "application/pdf", "buffer": PDF}])
        await submit(owner, "button:has-text('Send for approval')")
        body = await text(owner)
        check("Business details", "request shows 'Waiting for approval' with the documents", "Waiting for approval" in body and "GST certificate.pdf" in body and "IEC.pdf" in body)
        check("Business details", "nothing changes until approved", admin("vendor", "Urban Store").get("companyName") is None)
        href = await owner.locator(".vp-change a.vp-filelink").first.get_attribute("href")
        st = await owner.evaluate("async (h) => { const r = await fetch(h); return [r.status, r.headers.get('content-type')]; }", href)
        check("Business details", "the vendor can open their own uploaded document", st == [200, "application/pdf"], str(st))
        await submit(owner, "button:has-text('Withdraw request')")
        check("Business details", "withdrawing removes the request", "withdrawn" in await text(owner) and "Waiting for approval" not in await text(owner))

        await owner.click("a[href$='?edit=business']"); await owner.wait_for_url("**edit=business"); await owner.wait_for_selector("#companyName")
        await owner.fill("#companyName", "Urban Store Pvt Ltd"); await owner.fill("#addressLine", "5 Mall Road")
        await owner.fill("#city", "Ludhiana"); await owner.fill("#state", "Punjab"); await owner.fill("#postalCode", "141001")
        await owner.set_input_files("#gstFile", files=[{"name": "GST certificate.pdf", "mimeType": "application/pdf", "buffer": PDF}])
        await submit(owner, "button:has-text('Send for approval')")
        admin("review-change", "Urban Store", "reject")
        await go(owner, "/portal/profile")
        body = await text(owner)
        check("Business details", "a declined request shows the team's reason; details unchanged", "proof of the new address" in body and admin("vendor", "Urban Store").get("companyName") is None)
        await owner.click("a[href$='?edit=business']"); await owner.wait_for_url("**edit=business"); await owner.wait_for_selector("#companyName")
        await owner.fill("#companyName", "Urban Store Pvt Ltd"); await owner.fill("#addressLine", "5 Mall Road")
        await owner.fill("#city", "Ludhiana"); await owner.fill("#state", "Punjab"); await owner.fill("#postalCode", "141001")
        await owner.set_input_files("#gstFile", files=[{"name": "GST certificate.pdf", "mimeType": "application/pdf", "buffer": PDF}])
        await owner.set_input_files("#adCodeFile", files=[{"name": "AD code.png", "mimeType": "image/png", "buffer": PNG_LOGO}])
        await submit(owner, "button:has-text('Send for approval')")
        admin("review-change", "Urban Store", "approve")
        await go(owner, "/portal/profile")
        body = await text(owner)
        check("Business details", "after approval the company name, address and documents show", all(x in body for x in ["Urban Store Pvt Ltd", "5 Mall Road", "141001", "GST certificate.pdf", "AD code.png"]))
        check("My brand", "profile complete: no reminder, nothing marked required", "complete your profile" not in body.lower() and "Required – not added yet" not in body)
        doc_href = await owner.locator("dl a.vp-filelink").first.get_attribute("href")

        # ------------------------------------------------------------ team
        await go(owner, "/portal/team")
        check("Team", "owner sees the Team page with themselves as Owner", "Harpreet S." in await text(owner) and "Full access" in await text(owner))
        await owner.fill("#email", "not-an-email"); await owner.click("button:has-text('Add and send invite')")
        check("Team", "a badly typed email is stopped before sending", await owner.evaluate("!document.querySelector('#email').checkValidity()"))
        await owner.fill("#name", "Ravi"); await owner.fill("#email", "ravi@urban.example"); await owner.check("#access-view")
        await submit(owner, "button:has-text('Add and send invite')")
        link = await dev_link(owner)
        check("Team", "adding staff sends an invite link (shown on page in dev)", link and "/portal/reset?token=" in link and "Invite sent" in await text(owner))
        check("Team", "new staff shows as Invited", admin("user", "ravi@urban.example") == {"status": "invited", "role": "staff", "access": "view"})
        await owner.fill("#email", "owner@urban.example"); await submit(owner, "button:has-text('Add and send invite')")
        check("Team", "an email already in use is refused", "already" in await text(owner))

        # staff accepts invite in a separate browser
        sc = await browser.new_context(**desk); staff = await sc.new_page(); watch(staff, "staff")
        await staff.goto(link); await ready(staff)
        check("Staff invite", "invite link opens 'Welcome – choose your password' for that email", "Welcome" in await text(staff) and "ravi@urban.example" in await text(staff))
        await staff.fill("#password", PW); await staff.fill("#confirm", PW); await submit(staff, "button:has-text('Set password')")
        check("Staff invite", "after setting the password they're asked to sign in", "Your password is set" in await text(staff))
        await staff.goto(link); await ready(staff)
        check("Staff invite", "the invite link can't be used twice", "expired" in await text(staff))
        await login(staff, "ravi@urban.example")
        check("View-only staff", "signs in to Urban Store's orders", staff.url.endswith("/portal") and "#1001" in await text(staff), staff.url + " | " + (await text(staff))[:200].replace("\n", " / "))
        check("View-only staff", "has no Team tab", await staff.locator("nav a[href='/portal/team']").count() == 0)
        await go(staff, "/portal/team")
        check("View-only staff", "opening /portal/team sends them back to orders", staff.url.endswith("/portal"))
        await go(staff, "/portal/profile")
        body = await text(staff)
        check("View-only staff", "business and brand are read-only (only their own seller details are editable)",
              "view-only access" in body and await staff.locator("a[href$='?edit=brand']").count() == 0 and await staff.locator("a[href$='?edit=business']").count() == 0
              and await staff.locator("a[href$='?edit=seller']").count() == 1)
        st = await staff.evaluate("async (h) => (await fetch(h)).status", doc_href)
        check("View-only staff", "can open their vendor's documents", st == 200, str(st))
        await go(staff, "/portal/profile?edit=brand")
        check("View-only staff", "?edit=brand in the address doesn't open the form", await staff.locator("#description").count() == 0)
        st = await staff.evaluate("""async () => { const r = await fetch('/portal/profile?_data=routes%2Fportal.profile', {method:'POST', body:new URLSearchParams({intent:'brand', description:'hacked', minimumOrderValue:'1'})}); return r.status }""")
        check("View-only staff", "a forged save request doesn't change anything", "hacked" not in json.dumps(admin("vendor", "Urban Store")), f"status {st}")

        # owner upgrades to edit
        await go(owner, "/portal/team")
        row = owner.locator("li.vp-person", has_text="ravi@urban.example")
        await row.locator("select[name=access]").select_option("edit"); await submit(owner, row.locator("button:has-text('Save')"))
        check("Team", "owner changes staff access to View and edit", admin("user", "ravi@urban.example")["access"] == "edit")
        await go(staff, "/portal/profile")
        check("Edit staff", "after the change, staff can edit brand and business (no sign-in needed)",
              await staff.locator("a[href$='?edit=brand']").count() == 1 and await staff.locator("a[href$='?edit=business']").count() == 1)
        check("Edit staff", "still no Team tab", await staff.locator("nav a[href='/portal/team']").count() == 0)

        # deactivate
        await go(owner, "/portal/team")
        row = owner.locator("li.vp-person", has_text="ravi@urban.example")
        await submit(owner, row.locator("button:has-text('Deactivate')"))
        await go(staff, "/portal")
        check("Team", "deactivating staff signs them out at once", staff.url.endswith("/portal/login"))
        await login(staff, "ravi@urban.example")
        check("Team", "deactivated staff can't sign in", not staff.url.endswith("/portal"))
        row = owner.locator("li.vp-person", has_text="ravi@urban.example")
        await submit(owner, row.locator("button:has-text('Reactivate')"))
        await login(staff, "ravi@urban.example")
        check("Team", "reactivated staff can sign in again", staff.url.endswith("/portal"))
        owner.once("dialog", lambda d: asyncio.ensure_future(d.accept()))
        row = owner.locator("li.vp-person", has_text="ravi@urban.example")
        await submit(owner, row.locator("button:has-text('Remove')"))
        check("Team", "removing staff deletes their access", admin("user", "ravi@urban.example") is None)
        await go(staff, "/portal")
        check("Team", "removed staff are signed out", staff.url.endswith("/portal/login"))
        await sc.close()

        # ------------------------------------------------------------ another vendor can't see Urban Store
        admin("approve-signup", "meera@newbrand.example", "Ashnur")
        ac = await browser.new_context(**desk); ash = await ac.new_page(); watch(ash, "ashnur")
        await login(ash, "meera@newbrand.example")
        body = await text(ash)
        check("Isolation", "approved applicant sees Ashnur orders only", ash.url.endswith("/portal") and "#1003" in body and "#1001" not in body, ash.url + " | " + body[:200].replace("\n", " / "))
        r = await go(ash, "/portal/orders/19043720134765")
        check("Isolation", "Ashnur opening Urban Store's order #1001 gets 'not found'", r.status == 404)
        await go(ash, "/portal/orders/19043720298605")
        check("Isolation", "on the shared order #1003, Ashnur sees only candles", "Candle" in await text(ash) and "Sunglass" not in await text(ash))
        st = await ash.evaluate("async (h) => (await fetch(h)).status", doc_href)
        check("Isolation", "Ashnur can't open Urban Store's GST document (not found)", st == 404, str(st))
        await ac.close()

        # ------------------------------------------------------------ forgot / reset, lockout, sign-out
        fc = await browser.new_context(**desk); f = await fc.new_page(); watch(f, "forgot")
        await go(f, "/portal/forgot"); await f.fill("#email", "nobody@nowhere.example"); await submit(f, "button[type=submit]")
        check("Password reset", "unknown email gets the same 'check your email' answer, no link", "Check your email" in await text(f) and await dev_link(f) is None)
        await go(f, "/portal/forgot"); await f.fill("#email", "owner@urban.example"); await submit(f, "button[type=submit]")
        link = await dev_link(f)
        check("Password reset", "known email gets a reset link", bool(link))
        await f.goto(link); await ready(f)
        await f.fill("#password", "short"); await f.fill("#confirm", "short"); await submit(f, "button[type=submit]")
        check("Password reset", "a weak new password is refused", "at least" in (await text(f)).lower())
        await f.fill("#password", PW2); await f.fill("#confirm", PW2); await submit(f, "button[type=submit]")
        check("Password reset", "new password saved; asked to sign in", "password has been changed" in await text(f))
        await go(owner, "/portal")
        check("Password reset", "resetting signs the owner out everywhere", owner.url.endswith("/portal/login"))
        await login(f, "owner@urban.example", PW)
        check("Password reset", "old password no longer works", not f.url.endswith("/portal"))
        await login(f, "owner@urban.example", PW2)
        check("Password reset", "new password works", f.url.endswith("/portal"))
        await submit(f, ".vp-side-foot button:has-text('Sign out')")
        await go(f, "/portal")
        check("Sign-out", "after signing out, /portal asks to sign in", f.url.endswith("/portal/login"))
        async def err_msg():
            e = f.locator(".vp-msg--error")
            return await e.inner_text() if await e.count() else ""
        await login(f, "nobody@nowhere.example", "Wrong-password-123"); unknown = await err_msg()
        await login(f, "owner@urban.example", "Wrong-password-123"); wrong = await err_msg()
        check("Sign-in", "unknown email and wrong password get the identical message", unknown and unknown == wrong, f"{unknown!r} vs {wrong!r}")
        for _ in range(5):
            await login(f, "owner@urban.example", "Wrong-password-123")
        await login(f, "owner@urban.example", PW2)
        check("Sign-in", "after 5 wrong passwords the right one is refused for 15 minutes", not f.url.endswith("/portal") and ("locked" in (await text(f)).lower() or "too many" in (await text(f)).lower()), (await text(f))[:200])
        await fc.close()
        await c.close()

        # ------------------------------------------------------------ mobile
        subprocess.run(["npx", "tsx", "tests/e2e/helper.mts", "clear-logins"], cwd=REPO, env=ENV, capture_output=True)
        mc = await browser.new_context(**mob); m = await mc.new_page(); watch(m, "mobile")
        await login(m, "owner@urban.example", PW2)
        tabs = m.locator("nav.vp-tabs a")
        n = await tabs.count()
        boxes = [await tabs.nth(i).bounding_box() for i in range(n)]
        check("Mobile", "owner sees 5 bottom tabs (Home first), all on one row", n == 5 and len({round(b["y"]) for b in boxes}) == 1 and (await tabs.first.inner_text()).strip() == "Home")
        sw = await m.evaluate("document.documentElement.scrollWidth")
        check("Mobile", "no sideways scrolling on My orders", sw <= 390, f"scrollWidth {sw}")
        for path in ["/portal?range=all", "/portal/orders", "/portal/profile", "/portal/team", "/portal/ship", "/portal/orders/19043720298605"]:
            await go(m, path)
            sw = await m.evaluate("document.documentElement.scrollWidth")
            if sw > 390:
                check("Mobile", f"no sideways scrolling on {path}", False, f"scrollWidth {sw}")
        else:
            check("Mobile", "no sideways scrolling on Dashboard, My orders, My brand, Team, What to ship, order detail", True)
        await m.screenshot(path=f"{SHOTS}/mobile-order.png", full_page=True)
        await mc.close()

        await browser.close()

    # ------------------------------------------------------------ report
    fails = [r for r in results if not r[2]]
    print(f"\n{len(results) - len(fails)} passed, {len(fails)} failed")
    noisy = [e for e in console_errors if "404" not in e[1] and "Failed to load resource" not in e[1]]
    print(f"console errors: {len(noisy)}")
    for e in noisy[:20]:
        print("  ", e)
    json.dump({"results": results, "console": console_errors}, open(os.path.join(SHOTS, "results.json"), "w"), indent=1)


asyncio.run(main())
