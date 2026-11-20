import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import db from "../db.server";
import { clientIp, getIdentity, readSessionToken, sessionCookie, signUp, type SignupInput } from "../lib/portal/auth.server";
import { portalShop } from "../lib/portal/context.server";
import { MIN_PASSWORD } from "../lib/portal/rules";
import { AuthLayout, Field, portalLinks } from "../lib/portal/ui";

/**
 * /portal/signup – create an account in three steps.
 * Invited email (added by the Setu Store team) → straight into the portal.
 * Any other email → "under review" until the team approves it.
 * Without JavaScript all three steps show on one page and still submit.
 */

export const links: LinksFunction = portalLinks;
export const meta: MetaFunction = () => [{ title: "Create your account · Setu Store vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await getIdentity(db, portalShop(), readSessionToken(request));
  if (me) throw redirect(me.user.status === "active" ? "/portal" : "/portal/pending");
  return null;
};

const FIELDS: (keyof SignupInput)[] = ["name", "email", "password", "phone", "brandName", "gstNumber", "city", "state", "productNote", "description", "policy", "minimumOrderValue"];

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = portalShop();
  const form = await request.formData();
  const input = Object.fromEntries(FIELDS.map((k) => [k, String(form.get(k) ?? "").slice(0, 4000)])) as SignupInput;
  if (input.password !== String(form.get("confirm") ?? "")) {
    return { values: { ...input, password: "" }, errors: { confirm: "The two passwords don't match." } as Record<string, string> };
  }
  const r = await signUp(db, input, { shop, ip: clientIp(request), userAgent: request.headers.get("user-agent") });
  if (!r.ok) return { values: { ...input, password: "" }, errors: r.errors };
  return redirect(r.status === "active" ? "/portal" : "/portal/pending", { headers: { "Set-Cookie": sessionCookie(r.token, r.expiresAt) } });
};

const STEPS = [
  { title: "About you", note: "The person who will sign in for your brand.", fields: ["name", "email", "phone", "password", "confirm"] },
  { title: "Your business", note: "So the Setu Store team can match you to your products.", fields: ["brandName", "gstNumber", "city", "state", "productNote"] },
  { title: "Your brand", note: "Shown to retailers on Setu Store. You can leave these for later.", fields: ["description", "policy", "minimumOrderValue"] },
];

const noop = () => () => {};

export default function Signup() {
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const e = data?.errors ?? {};
  const v = (data?.values ?? {}) as Partial<SignupInput>;

  // true once the page is interactive; until then all steps show (and the form still works).
  const js = useSyncExternalStore(noop, () => true, () => false);
  const [step, setStep] = useState(0);
  const stepRefs = useRef<(HTMLFieldSetElement | null)[]>([]);

  // After a failed submit, open the first step that has a problem.
  const [seen, setSeen] = useState(data);
  if (data !== seen) {
    setSeen(data);
    const first = data?.errors ? STEPS.findIndex((s) => s.fields.some((f) => f in data.errors)) : -1;
    if (first >= 0) setStep(first);
  }

  useEffect(() => {
    if (!js) return;
    const el = stepRefs.current[step]?.querySelector<HTMLElement>("[aria-invalid='true'], input, textarea");
    el?.focus({ preventScroll: false });
  }, [step, js]);

  const next = () => {
    const box = stepRefs.current[step];
    if (!box) return;
    const inputs = [...box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")];
    for (const el of inputs) {
      if (!el.checkValidity()) { el.reportValidity(); return; }
    }
    if (step === 0) {
      const pw = box.querySelector<HTMLInputElement>("#password");
      const cf = box.querySelector<HTMLInputElement>("#confirm");
      if (pw && cf && pw.value !== cf.value) { cf.setCustomValidity("The two passwords don't match."); cf.reportValidity(); cf.setCustomValidity(""); return; }
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const formError = e.form ?? (Object.keys(e).length ? "Please check the highlighted fields." : null);

  return (
    <AuthLayout
      wide
      title="Create your account"
      lead="If the Setu Store team invited your email, you'll go straight to your orders. Otherwise the team will review your details first."
    >
      {js && (
        <ol className="vp-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.title} data-state={i < step ? "done" : i === step ? "current" : "todo"} aria-current={i === step ? "step" : undefined}>
              <span>{s.title}</span>
            </li>
          ))}
        </ol>
      )}
      {formError && <p className="vp-msg vp-msg--error" role="alert">{formError}</p>}

      <Form method="post" noValidate className={js ? undefined : "vp-nojs"}>
        {STEPS.map((s, i) => (
          <fieldset
            key={s.title}
            ref={(el) => { stepRefs.current[i] = el; }}
            className="vp-step"
            hidden={i !== step}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <legend className="vp-step-title">{s.title}</legend>
            <p className="vp-step-note">{s.note}</p>

            {i === 0 && (
              <>
                <Field name="name" label="Your name" required autoComplete="name" defaultValue={v.name} error={e.name} />
                <Field name="email" label="Work email" type="email" required autoComplete="email" inputMode="email" defaultValue={v.email} error={e.email} />
                <Field name="phone" label="Phone" type="tel" required autoComplete="tel" inputMode="tel" defaultValue={v.phone} error={e.phone} hint="Add the country code if you're outside India, e.g. +91 98765 43210." />
                <Field name="password" label="Password" type="password" required autoComplete="new-password" error={e.password} hint={`At least ${MIN_PASSWORD} characters, with letters as well as numbers.`} />
                <Field name="confirm" label="Confirm password" type="password" required autoComplete="new-password" error={e.confirm} />
              </>
            )}
            {i === 1 && (
              <>
                <Field name="brandName" label="Business or brand name" required autoComplete="organization" defaultValue={v.brandName} error={e.brandName} />
                <Field name="gstNumber" label="GST number (GSTIN)" defaultValue={v.gstNumber} error={e.gstNumber} maxLength={15} hint="15 characters, e.g. 08ABCDE1234F1Z5." />
                <div className="vp-row">
                  <Field name="city" label="City" required autoComplete="address-level2" defaultValue={v.city} error={e.city} />
                  <Field name="state" label="State" required autoComplete="address-level1" defaultValue={v.state} error={e.state} />
                </div>
                <Field name="productNote" label="What do you sell?" multiline defaultValue={v.productNote} error={e.productNote} hint="A line or two, e.g. hand-poured soy candles and wax sachets." />
              </>
            )}
            {i === 2 && (
              <>
                <Field name="description" label="Brand description" multiline defaultValue={v.description} error={e.description} hint="A few sentences retailers will read on your brand page." />
                <Field name="policy" label="Short policy" multiline defaultValue={v.policy} error={e.policy} hint="For example dispatch time, returns and damaged goods." />
                <Field name="minimumOrderValue" label="Minimum order value (₹)" inputMode="decimal" defaultValue={v.minimumOrderValue} error={e.minimumOrderValue} hint="The smallest order a retailer can place with you. Leave empty for no minimum." />
              </>
            )}

            {js && (
              <div className="vp-step-actions">
                {i > 0 && <button type="button" className="vp-btn vp-btn--quiet" onClick={() => setStep(i - 1)}>Back</button>}
                {i < STEPS.length - 1 ? (
                  <button type="button" className="vp-btn" onClick={next}>Continue</button>
                ) : (
                  <button type="submit" className="vp-btn" disabled={busy}>{busy ? "Creating your account…" : "Create account"}</button>
                )}
              </div>
            )}
          </fieldset>
        ))}
        {!js && <button type="submit" className="vp-btn vp-btn--block" style={{ marginTop: 24 }}>Create account</button>}
      </Form>

      <p className="vp-auth-alt">Already have an account? <Link to="/portal/login">Sign in</Link></p>
    </AuthLayout>
  );
}
