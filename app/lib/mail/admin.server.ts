import type { MailStatus, PrismaClient, Prisma } from "@prisma/client";
import { isValidEmail, normaliseEmail } from "../vendors/vendors.server";
import { deliverDue, queueMail, sendAgain } from "./queue.server";
import { LOG_PAGE_SIZE, LOG_STATUSES, TEAM_ADDRESSES_MAX } from "./rules";
import { compose, isTemplateKey, TEMPLATE_KEYS, TEMPLATES, wordsFor, type DataOf, type TemplateKey } from "./templates";
import { mailBaseUrl, sendingMode, type Env } from "./transport.server";

/** What the Mail page in the Shopify app shows and does. */

const DAY = 24 * 60 * 60 * 1000;

type Result = { ok: true; message: string } | { ok: false; error: string };

/** Every mail the app can send, with whether it is on and how it reads. */
export async function mailTemplates(db: PrismaClient, shop: string, env: Env = process.env) {
  const settings = new Map((await db.mailTemplateSetting.findMany({ where: { shop } })).map((s) => [s.template, s.enabled]));
  const base = mailBaseUrl(env) || "https://vendors.example";
  return TEMPLATE_KEYS.map((key) => {
    const t = TEMPLATES[key] as { audience: "seller" | "admin"; group: string; name: string; when: string; to: string; required?: boolean; secret?: boolean; sample: unknown };
    const words = wordsFor(key, t.sample as DataOf<typeof key>, base);
    const preview = compose({ toName: t.audience === "seller" ? "Priya" : null, audience: t.audience, body: words.lines.join("\n"), linkLabel: words.link?.label, linkUrl: words.link?.url });
    return {
      key, audience: t.audience, group: t.group, name: t.name, when: t.when, to: t.to, required: !!t.required, secret: !!t.secret,
      enabled: t.required ? true : (settings.get(key) ?? true),
      preview: { subject: words.subject, text: preview.text },
    };
  });
}

export async function mailNumbers(db: PrismaClient, shop: string, now = new Date()) {
  const week = new Date(now.getTime() - 7 * DAY);
  const count = (where: Prisma.MailMessageWhereInput) => db.mailMessage.count({ where: { shop, ...where } });
  const [sent, waiting, failed, bounced, logged, setting] = await Promise.all([
    count({ status: { in: ["sent", "delivered"] }, createdAt: { gte: week } }),
    count({ status: { in: ["queued", "sending"] } }),
    count({ status: "failed", createdAt: { gte: week } }),
    count({ status: "bounced", createdAt: { gte: week } }),
    count({ status: "logged", createdAt: { gte: week } }),
    db.shopSetting.findUnique({ where: { shop }, select: { adminEmails: true } }),
  ]);
  return { sent, waiting, failed, bounced, logged, team: setting?.adminEmails ?? [] };
}

export type LogFilter = { status?: string; template?: string; to?: string; page?: number };

export async function mailLog(db: PrismaClient, shop: string, f: LogFilter = {}) {
  const status = (LOG_STATUSES as readonly string[]).includes(f.status ?? "") ? (f.status as MailStatus) : undefined;
  const template = f.template && isTemplateKey(f.template) ? f.template : undefined;
  const to = (f.to ?? "").trim().toLowerCase().slice(0, 254);
  const where: Prisma.MailMessageWhereInput = {
    shop,
    // "Waiting" covers the moment a mail is being handed over, too.
    ...(status ? { status: status === "queued" ? { in: ["queued", "sending"] } : status } : {}),
    ...(template ? { template } : {}),
    ...(to ? { toEmail: { contains: to } } : {}),
  };
  const total = await db.mailMessage.count({ where });
  const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(f.page ?? 1) || 1), pages);
  const rows = await db.mailMessage.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * LOG_PAGE_SIZE, take: LOG_PAGE_SIZE });
  return {
    total, page, pages, filter: { status: status ?? "", template: template ?? "", to },
    rows: rows.map((m) => {
      const t = (TEMPLATES as Record<string, { name: string; secret?: boolean }>)[m.template];
      return {
        id: m.id, to: m.toEmail, audience: m.audience, subject: m.subject, mail: t?.name ?? m.template, status: m.status === "sending" ? "queued" as const : m.status,
        note: m.note, attempts: m.attempts, createdAt: m.createdAt.toISOString(), sentAt: m.sentAt?.toISOString() ?? null,
        canSendAgain: !t?.secret && ["failed", "bounced", "logged"].includes(m.status),
      };
    }),
  };
}

export async function setTemplateEnabled(db: PrismaClient, shop: string, template: string, enabled: boolean, actor: string): Promise<Result> {
  if (!isTemplateKey(template)) return { ok: false, error: "Unknown mail" };
  const t = TEMPLATES[template] as { name: string; required?: boolean };
  if (t.required) return { ok: false, error: `“${t.name}” can't be switched off: people need it to get into their account or to keep it safe.` };
  await db.mailTemplateSetting.upsert({ where: { shop_template: { shop, template } }, create: { shop, template, enabled, updatedBy: actor }, update: { enabled, updatedBy: actor } });
  await db.auditLog.create({ data: { shop, actor, action: enabled ? "mail.template_on" : "mail.template_off", target: "mail", detail: { template } } });
  return { ok: true, message: `“${t.name}” is now ${enabled ? "on" : "off"}.` };
}

/** Addresses separated by commas, spaces or new lines. */
export function cleanAddresses(raw: string): { list: string[]; error?: string } {
  const list = [...new Set(String(raw ?? "").split(/[\s,;]+/).map(normaliseEmail).filter(Boolean))];
  const bad = list.filter((e) => !isValidEmail(e));
  if (bad.length) return { list, error: `${bad.map((b) => `“${b.slice(0, 60)}”`).join(", ")} ${bad.length === 1 ? "isn't a valid email address" : "aren't valid email addresses"}.` };
  if (list.length > TEAM_ADDRESSES_MAX) return { list, error: `Up to ${TEAM_ADDRESSES_MAX} addresses.` };
  return { list };
}

export async function saveTeamAddresses(db: PrismaClient, shop: string, raw: string, actor: string): Promise<Result> {
  const { list, error } = cleanAddresses(raw);
  if (error) return { ok: false, error };
  await db.shopSetting.upsert({ where: { shop }, create: { shop, adminEmails: list }, update: { adminEmails: list } });
  await db.auditLog.create({ data: { shop, actor, action: "mail.team_addresses_updated", target: "mail", detail: { count: list.length } } });
  return { ok: true, message: list.length ? `Team mails now go to ${list.join(", ")}.` : "No team address is set. Team mails go to nobody." };
}

/** Sends a template's sample to one address now, and says what happened to it. */
export async function sendTest(db: PrismaClient, shop: string, template: string, rawTo: string, env: Env = process.env, fetcher: typeof fetch = fetch): Promise<Result> {
  if (!isTemplateKey(template)) return { ok: false, error: "Unknown mail" };
  const to = normaliseEmail(rawTo);
  if (!isValidEmail(to)) return { ok: false, error: "Enter the email address to send the test to." };
  const t = TEMPLATES[template] as { name: string; sample: unknown };
  await queueMail(db, shop, template as TemplateKey, [{ email: to, name: "Priya" }], t.sample as never, { env, force: true, test: true });
  await deliverDue(db, env, new Date(), fetcher);
  const m = await db.mailMessage.findFirst({ where: { shop, template, toEmail: to }, orderBy: { createdAt: "desc" } });
  if (m?.status === "sent" || m?.status === "delivered") return { ok: true, message: `Test of “${t.name}” sent to ${to}.` };
  if (m?.status === "logged") return { ok: false, error: `The test wasn't really sent. ${m.note ?? sendingMode(env).text}` };
  if (m?.status === "failed") return { ok: false, error: `The test couldn't be sent. ${m.note ?? ""}`.trim() };
  return { ok: true, message: `Test of “${t.name}” is waiting to be sent to ${to}. Look in the log in a minute.` };
}

export async function sendLogMailAgain(db: PrismaClient, shop: string, id: string, env: Env = process.env): Promise<Result> {
  const r = await sendAgain(db, shop, id, env);
  return r.ok ? { ok: true, message: "Put back in the queue. It goes out within a minute." } : { ok: false, error: r.error ?? "Couldn't send it again" };
}

/** How mail is sent here, and where sellers' replies go. */
export function mailSetup(env: Env = process.env) {
  const from = env.PORTAL_EMAIL_FROM ?? "";
  const replyTo = env.PORTAL_EMAIL_REPLY_TO || (from.match(/<([^>]+)>/)?.[1] ?? from);
  return { ...sendingMode(env), replyTo: replyTo || null };
}
