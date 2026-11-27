import type { PrismaClient } from "@prisma/client";
import { compose, TEMPLATES, wordsFor, type DataOf, type TemplateKey } from "./templates";
import { hand, mailBaseUrl, type Env } from "./transport.server";

/**
 * The mail queue.
 *
 * `queueMail` writes one row per address and returns at once, so the page that
 * caused the mail never waits for the mail service. `deliverDue` hands waiting
 * mails to the service; one that fails for a passing reason is tried again
 * later (after 1, 5, 30 and 120 minutes), then given up. A timer runs
 * `deliverDue` every minute while the app is up, and every new mail triggers
 * it straight away.
 */

export type Recipient = { email: string; name?: string | null };

const RETRY_MINUTES = [1, 5, 30, 120];
/** A subject is one line, however a brand or an order was named. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 250);
const BATCH = 25;

/** Whether this kind of mail is switched on for the shop. Required mails always are. */
export async function isEnabled(db: PrismaClient, shop: string, template: TemplateKey): Promise<boolean> {
  if ((TEMPLATES[template] as { required?: boolean }).required) return true;
  const s = await db.mailTemplateSetting.findUnique({ where: { shop_template: { shop, template } } });
  return s?.enabled ?? true;
}

export type QueueOptions = {
  vendorId?: string | null;
  /** The same key never mails the same address twice (for events that can be reported more than once). */
  dedupe?: string;
  env?: Env;
  /** Send even if the template is switched off (the Mail page's test). */
  force?: boolean;
  /** A test from the Mail page: the subject says so. */
  test?: boolean;
};

/** Queues a mail to each address. Returns how many were queued (0 when switched off, or all were duplicates). */
export async function queueMail<K extends TemplateKey>(
  db: PrismaClient, shop: string, template: K, to: Recipient[], data: DataOf<K>, opts: QueueOptions = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const seen = new Set<string>();
  const people = to.filter((r) => r.email && !seen.has(r.email.toLowerCase()) && seen.add(r.email.toLowerCase()));
  if (!people.length || (!opts.force && !(await isEnabled(db, shop, template)))) return 0;
  const words = wordsFor(template, data, mailBaseUrl(env));
  const made = await db.mailMessage.createMany({
    data: people.map((r) => ({
      shop, template, audience: TEMPLATES[template].audience, toEmail: r.email.toLowerCase(), toName: r.name?.trim() || null, vendorId: opts.vendorId ?? null,
      subject: oneLine(`${opts.test ? "Test: " : ""}${words.subject}`), body: words.lines.join("\n"), linkLabel: words.link?.label ?? null, linkUrl: words.link?.url ?? null,
      note: opts.test ? "A test sent from the Mail page." : null,
      dedupeKey: opts.dedupe ? `${opts.dedupe}:${r.email.toLowerCase()}` : null,
    })),
    skipDuplicates: true,
  });
  if (made.count) kick(db, env);
  return made.count;
}

/**
 * Sends a mail that carries a one-time link straight away (the person is
 * waiting for it), and keeps a record of it WITHOUT the link. Throws if it
 * couldn't be sent, so the page can say so.
 */
export async function sendSecret<K extends TemplateKey>(
  db: PrismaClient, shop: string, template: K, to: Recipient, data: DataOf<K>, opts: { vendorId?: string | null; env?: Env; fetcher?: typeof fetch } = {},
): Promise<{ delivered: boolean; note: string | null; subject: string; link: string | null }> {
  const env = opts.env ?? process.env;
  const words = wordsFor(template, data, mailBaseUrl(env));
  const body = words.lines.join("\n");
  const row = await db.mailMessage.create({
    data: {
      shop, template, audience: TEMPLATES[template].audience, toEmail: to.email.toLowerCase(), toName: to.name?.trim() || null, vendorId: opts.vendorId ?? null,
      subject: oneLine(words.subject), body, linkLabel: words.link?.label ?? null, linkUrl: null, status: "sending", attempts: 1,
    },
  });
  const full = compose({ toName: row.toName, audience: row.audience, body, linkLabel: words.link?.label, linkUrl: words.link?.url });
  const r = await hand({ id: row.id, to: row.toEmail, subject: row.subject, ...full }, env, opts.fetcher);
  const now = new Date();
  if (r.status === "sent") await db.mailMessage.update({ where: { id: row.id }, data: { status: "sent", providerId: r.providerId, sentAt: now, note: "One-time link not kept." } });
  else if (r.status === "logged") await db.mailMessage.update({ where: { id: row.id }, data: { status: "logged", note: r.note } });
  else {
    await db.mailMessage.update({ where: { id: row.id }, data: { status: "failed", note: r.note } });
    throw new Error(r.note);
  }
  return { delivered: r.status === "sent", note: r.status === "logged" ? r.note : null, subject: row.subject, link: words.link?.url ?? null };
}

/** Hands every mail that is due to the mail service. Safe to run from several places at once. */
export async function deliverDue(db: PrismaClient, env: Env = process.env, now = new Date(), fetcher: typeof fetch = fetch): Promise<{ sent: number; logged: number; failed: number; later: number }> {
  const out = { sent: 0, logged: 0, failed: 0, later: 0 };
  // A mail left in "sending" by a process that stopped is picked up again after ten minutes.
  await db.mailMessage.updateMany({ where: { status: "sending", updatedAt: { lt: new Date(now.getTime() - 10 * 60000) } }, data: { status: "queued" } });
  const due = await db.mailMessage.findMany({ where: { status: "queued", nextAttemptAt: { lte: now } }, orderBy: { createdAt: "asc" }, take: BATCH });
  for (const m of due) {
    const claimed = await db.mailMessage.updateMany({ where: { id: m.id, status: "queued" }, data: { status: "sending", attempts: { increment: 1 } } });
    if (claimed.count !== 1) continue; // another run took it
    const r = await hand({ id: m.id, to: m.toEmail, subject: m.subject, ...compose(m) }, env, fetcher);
    if (r.status === "sent") {
      await db.mailMessage.update({ where: { id: m.id }, data: { status: "sent", providerId: r.providerId, sentAt: new Date(), note: null } });
      out.sent++;
    } else if (r.status === "logged") {
      await db.mailMessage.update({ where: { id: m.id }, data: { status: "logged", note: r.note } });
      out.logged++;
    } else {
      const wait = RETRY_MINUTES[m.attempts]; // m.attempts is the count before this try
      if (r.again && wait !== undefined) {
        await db.mailMessage.update({ where: { id: m.id }, data: { status: "queued", note: r.note, nextAttemptAt: new Date(now.getTime() + wait * 60000) } });
        out.later++;
      } else {
        await db.mailMessage.update({ where: { id: m.id }, data: { status: "failed", note: r.note } });
        out.failed++;
      }
    }
  }
  return out;
}

let running: Promise<unknown> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Starts a delivery run soon, without waiting for it, and makes sure the every-minute timer is on. Not used in tests. */
export function kick(db: PrismaClient, env: Env = process.env) {
  // Tests run the queue themselves, whatever environment they pretend to be in.
  if (env.NODE_ENV === "test" || env.VITEST || process.env.VITEST) return;
  if (!timer) {
    timer = setInterval(() => kick(db, env), 60000);
    timer.unref?.();
  }
  if (running) return;
  running = deliverDue(db, env).catch((e) => console.error("[mail] delivery run failed:", e)).finally(() => { running = null; });
}

/** Puts a mail that failed, bounced or was only logged back in the queue (the Mail page's "Send again"). */
export async function sendAgain(db: PrismaClient, shop: string, id: string, env: Env = process.env): Promise<{ ok: boolean; error?: string }> {
  const m = await db.mailMessage.findFirst({ where: { id, shop } });
  if (!m) return { ok: false, error: "Mail not found" };
  if ((TEMPLATES[m.template as TemplateKey] as { secret?: boolean } | undefined)?.secret) {
    return { ok: false, error: "This mail carried a one-time link, which isn't kept. Ask the person to use “Forgot password”, or invite them again." };
  }
  if (m.status === "queued" || m.status === "sending") return { ok: false, error: "This mail is already waiting to be sent." };
  await db.mailMessage.update({ where: { id: m.id }, data: { status: "queued", attempts: 0, nextAttemptAt: new Date(), note: null, providerId: null } });
  kick(db, env);
  return { ok: true };
}
