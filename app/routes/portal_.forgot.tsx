import type { ActionFunctionArgs, LinksFunction, MetaFunction } from "react-router";
import { Form, Link, useActionData, useNavigation } from "react-router";
import db from "../db.server";
import { clientIp, requestPasswordReset } from "../lib/portal/auth.server";
import { portalBaseUrl, portalShop } from "../lib/portal/context.server";
import { sendPasswordReset } from "../lib/portal/email.server";
import { AuthCard, DevEmailPreview, Field } from "../lib/portal/ui";
import styles from "../styles/portal.css?url";

/** /portal/forgot – emails a reset link. Same answer whether or not the email has an account. */

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];
export const meta: MetaFunction = () => [{ title: "Reset password · Setu vendor portal" }, { name: "robots", content: "noindex" }];

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = portalShop();
  const form = await request.formData();
  const email = String(form.get("email") ?? "").slice(0, 254);
  const r = await requestPasswordReset(db, email, { shop, ip: clientIp(request) });
  let devPreview: { subject: string; link?: string } | undefined;
  if (r.status === "sent") {
    const link = `${portalBaseUrl(request)}/portal/reset?token=${encodeURIComponent(r.token)}`;
    try {
      devPreview = (await sendPasswordReset(r.email, r.name, link)).devPreview;
    } catch (e) {
      console.error("[vendor-portal] could not send reset email", e);
      return { sent: false, error: "We couldn't send the email just now. Please try again in a few minutes." };
    }
  }
  return { sent: true, email, devPreview };
};

export default function Forgot() {
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  if (data?.sent) {
    return (
      <AuthCard title="Check your email" sub={<>If <b>{data.email}</b> has an account, we&apos;ve sent a link to reset the password. It works once and expires in 30 minutes.</>}>
        <DevEmailPreview preview={data.devPreview} />
        <p className="vp-note"><Link to="/portal/login">Back to sign in</Link></p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Forgot your password?" sub="Enter your email and we'll send you a link to choose a new one.">
      {data?.error && <p className="vp-error" role="alert">{data.error}</p>}
      <Form method="post">
        <Field name="email" label="Email" type="email" autoComplete="email" inputMode="email" required />
        <button className="vp-btn" type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      </Form>
      <p className="vp-note" style={{ marginTop: 14 }}><Link to="/portal/login">Back to sign in</Link></p>
    </AuthCard>
  );
}
