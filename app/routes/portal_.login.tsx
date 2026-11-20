import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import db from "../db.server";
import { clientIp, getIdentity, readSessionToken, requestCode, sessionCookie, verifyCode } from "../lib/portal/auth.server";
import { portalShop } from "../lib/portal/context.server";
import { sendLoginCode } from "../lib/portal/email.server";
import styles from "../styles/portal.css?url";

/**
 * /portal/login – two steps on one page: email → 6-digit code.
 * The response to step 1 is identical whether or not the email has access.
 */

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];
export const meta: MetaFunction = () => [{ title: "Sign in · Setu vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = portalShop();
  if (await getIdentity(db, shop, readSessionToken(request))) throw redirect("/portal");
  return null;
};

type ActionData = { step: "email"; error?: string } | { step: "code"; email: string; error?: string; resent?: boolean; devCode?: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData | Response> => {
  const shop = portalShop();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const email = String(form.get("email") ?? "").slice(0, 254);
  const ctx = { shop, ip: clientIp(request), userAgent: request.headers.get("user-agent") };

  if (intent === "request" || intent === "resend") {
    const r = await requestCode(db, email, ctx);
    if (r.status === "invalid") return { step: "email", error: "Enter a valid email address." };
    let devCode: string | undefined;
    if (r.status === "sent") {
      try {
        devCode = (await sendLoginCode(r.email, r.code, r.vendorName)).devCode;
      } catch (e) {
        console.error("[vendor-portal] could not send sign-in code", e);
        return { step: "email", error: "We couldn't send the email just now. Please try again in a few minutes." };
      }
    }
    return { step: "code", email: r.email, resent: intent === "resend", ...(devCode ? { devCode } : {}) };
  }

  if (intent === "verify") {
    const r = await verifyCode(db, email, String(form.get("code") ?? "").slice(0, 20), ctx);
    if (!r.ok) return { step: "code", email, error: "That code didn't work. Check it, or ask for a new one." };
    return redirect("/portal", { headers: { "Set-Cookie": sessionCookie(r.token, r.expiresAt) } });
  }

  return { step: "email" };
};

export default function Login() {
  const data = useActionData<typeof action>() as ActionData | undefined;
  const busy = useNavigation().state !== "idle";
  const step = data?.step ?? "email";

  return (
    <main className="vp-login">
      <div className="vp-card">
        <div className="vp-brand">
          Setu Store
          <small>Vendor portal</small>
        </div>

        {step === "email" ? (
          <Form method="post">
            <h1 style={{ marginTop: 18 }}>Sign in</h1>
            <p className="vp-sub">We&apos;ll email you a 6-digit code. No password needed.</p>
            {data?.error && <p className="vp-error" role="alert">{data.error}</p>}
            <label htmlFor="email">Work email</label>
            <input id="email" name="email" type="email" autoComplete="email" required inputMode="email" />
            <input type="hidden" name="intent" value="request" />
            <button className="vp-btn" type="submit" disabled={busy}>{busy ? "Sending…" : "Email me a code"}</button>
            <p className="vp-note">Only email addresses added by the Setu team can sign in.</p>
          </Form>
        ) : (
          <>
            <Form method="post">
              <h1 style={{ marginTop: 18 }}>Check your email</h1>
              <p className="vp-sub">
                If <b>{(data as { email: string }).email}</b> has access, a code is on its way. It works once and expires in 10 minutes.
              </p>
              {data && "resent" in data && data.resent && <p className="vp-info" role="status">A new code has been sent. Earlier codes no longer work.</p>}
              {data?.error && <p className="vp-error" role="alert">{data.error}</p>}
              {data && "devCode" in data && data.devCode && (
                <p className="vp-dev" role="status">
                  Development only – no email service is set up, so here is the code: <b>{data.devCode}</b>
                </p>
              )}
              <label htmlFor="code">6-digit code</label>
              <input id="code" name="code" className="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
              <input type="hidden" name="email" value={(data as { email: string }).email} />
              <input type="hidden" name="intent" value="verify" />
              <button className="vp-btn" type="submit" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
            </Form>
            <Form method="post" style={{ marginTop: 12 }}>
              <input type="hidden" name="email" value={(data as { email: string }).email} />
              <input type="hidden" name="intent" value="resend" />
              <button className="vp-btn secondary" type="submit" disabled={busy} style={{ width: "100%" }}>Send a new code</button>
            </Form>
            <p className="vp-note" style={{ marginTop: 12 }}><a href="/portal/login">Use a different email</a></p>
          </>
        )}
      </div>
    </main>
  );
}
