import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { mailBounced } from "./notify.server";

/**
 * What the mail service (Resend) reports back about a mail it accepted:
 * delivered, bounced, or refused. Resend signs each report the Svix way; a
 * report whose signature doesn't check out is ignored.
 */

const TOLERANCE_SECONDS = 5 * 60;

/** Checks a Svix signature: HMAC-SHA256 of "id.timestamp.body" with the secret after "whsec_". */
export function signedByResend(secret: string | undefined, headers: Headers, body: string, now = new Date()): boolean {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const given = headers.get("svix-signature");
  if (!secret || !id || !timestamp || !given) return false;
  const at = Number(timestamp);
  if (!Number.isFinite(at) || Math.abs(now.getTime() / 1000 - at) > TOLERANCE_SECONDS) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return false;
  }
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return given.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const got = Buffer.from(value, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

type Report = { type?: string; data?: { email_id?: string; bounce?: { message?: string }; failed?: { reason?: string } } };

/** Records a report on the mail it is about. Returns what changed, for the log line. */
export async function applyReport(db: PrismaClient, report: Report, now = new Date()): Promise<"delivered" | "bounced" | "failed" | "noted" | "ignored"> {
  const providerId = report.data?.email_id;
  if (!providerId || typeof providerId !== "string") return "ignored";
  const m = await db.mailMessage.findFirst({ where: { providerId } });
  if (!m) return "ignored";
  switch (report.type) {
    case "email.delivered":
      // A bounce that arrived first wins.
      if (m.status !== "sent") return "ignored";
      await db.mailMessage.update({ where: { id: m.id }, data: { status: "delivered" } });
      return "delivered";
    case "email.bounced": {
      if (m.status === "bounced") return "ignored";
      const why = report.data?.bounce?.message?.slice(0, 300);
      await db.mailMessage.update({ where: { id: m.id }, data: { status: "bounced", note: why ? `The address refused it: ${why}` : "The address refused it." } });
      await mailBounced(db, m.shop, m, now);
      return "bounced";
    }
    case "email.failed": {
      const why = report.data?.failed?.reason?.slice(0, 300);
      await db.mailMessage.update({ where: { id: m.id }, data: { status: "failed", note: why ? `The mail service couldn't send it: ${why}` : "The mail service couldn't send it." } });
      return "failed";
    }
    case "email.complained":
      await db.mailMessage.update({ where: { id: m.id }, data: { note: "The person marked this mail as spam." } });
      return "noted";
    default:
      return "ignored";
  }
}
