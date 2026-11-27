import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { FILE_RULES, type FileKindName } from "./rules";

/**
 * Files vendors upload: GST / IEC / AD code documents, logo and banner.
 *
 * - The type is decided from the file's first bytes (PDF, PNG, JPEG, WebP),
 *   never from the name or what the browser claims. SVG and anything else is refused.
 * - Files are private. They're served only by routes that check who is asking
 *   (the vendor's own signed-in people, or the team in Shopify admin), with
 *   nosniff and a sandboxing CSP so a file can't run as a page.
 * - Stored in the database for now (VendorFile.data). Everything goes through
 *   this module, so moving to object storage later only changes this file.
 */

export { FILE_RULES, type FileKindName };

/** Whole upload request limit, checked before the body is read. */
export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

const SIGNATURES: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: "application/pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

export function sniffMime(bytes: Buffer): string | null {
  return SIGNATURES.find((s) => s.test(bytes))?.mime ?? null;
}

/** A browser sends an empty File when the picker was left alone. */
export const isFilePicked = (v: FormDataEntryValue | null | undefined): v is File =>
  typeof v === "object" && v !== null && "arrayBuffer" in v && (v as File).size > 0;

export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.normalize("NFKC").replace(/[^\p{L}\p{N} ._()-]/gu, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "file").slice(-120);
}

export type FileCheck = { ok: true; bytes: Buffer; mime: string; name: string } | { ok: false; error: string };

export async function checkUpload(kind: FileKindName, file: File): Promise<FileCheck> {
  const rule = FILE_RULES[kind];
  if (file.size > rule.maxBytes) return { ok: false, error: `${rule.label} is too large – the limit is ${rule.maxBytes / 1024 / 1024} MB.` };
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > rule.maxBytes) return { ok: false, error: `${rule.label} is too large – the limit is ${rule.maxBytes / 1024 / 1024} MB.` };
  const mime = sniffMime(bytes);
  if (!mime || !rule.mimes.includes(mime)) return { ok: false, error: `${rule.label} must be ${rule.accepts}.` };
  return { ok: true, bytes, mime, name: cleanFileName(file.name) };
}

export async function storeFile(
  db: PrismaClient,
  a: { shop: string; vendorId: string; kind: FileKindName; checked: Extract<FileCheck, { ok: true }>; uploadedById: string | null },
): Promise<string> {
  const f = await db.vendorFile.create({
    data: {
      shop: a.shop, vendorId: a.vendorId, kind: a.kind, fileName: a.checked.name, mimeType: a.checked.mime,
      size: a.checked.bytes.length, sha256: createHash("sha256").update(a.checked.bytes).digest("hex"),
      data: new Uint8Array(a.checked.bytes), uploadedById: a.uploadedById,
    },
    select: { id: true },
  });
  return f.id;
}

export type FileInfo = { id: string; kind: FileKindName; fileName: string; mimeType: string; size: number; createdAt: string };

/** Metadata only (never the bytes), for files of this vendor. */
export async function fileInfo(db: PrismaClient, vendorId: string, ids: (string | null | undefined)[]): Promise<Record<string, FileInfo>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return {};
  const rows = await db.vendorFile.findMany({
    where: { id: { in: want }, vendorId },
    select: { id: true, kind: true, fileName: true, mimeType: true, size: true, createdAt: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, { ...r, createdAt: r.createdAt.toISOString() }]));
}

/** Deletes files that nothing points at any more (a withdrawn, replaced or declined request's uploads). */
export async function deleteFilesIfUnused(db: PrismaClient, vendorId: string, ids: (string | null | undefined)[]) {
  const candidates = ids.filter((x): x is string => !!x);
  if (!candidates.length) return;
  const v = await db.vendor.findUnique({ where: { id: vendorId }, select: { gstFileId: true, iecFileId: true, adCodeFileId: true, logoFileId: true, bannerFileId: true } });
  const pending = await db.vendorChangeRequest.findMany({ where: { vendorId, status: "pending" }, select: { changes: true } });
  const inUse = new Set<string>([...Object.values(v ?? {}).filter(Boolean) as string[], ...pending.flatMap((p) => Object.values((p.changes ?? {}) as Record<string, { to?: string | null }>).map((c) => c?.to ?? "")) ]);
  const unused = candidates.filter((id) => !inUse.has(id));
  if (unused.length) await db.vendorFile.deleteMany({ where: { id: { in: unused }, vendorId } });
}

/**
 * The HTTP response for a file. `vendorId` must come from the signed-in
 * person (portal) or be checked against the team's shop (admin): a file of
 * another vendor or shop is "not found", like one that doesn't exist.
 */
export async function fileResponse(db: PrismaClient, where: { id: string; shop: string; vendorId?: string }, download = false): Promise<Response> {
  if (!where.id || where.id.length > 40) return new Response("Not found", { status: 404 });
  const f = await db.vendorFile.findFirst({ where: { id: where.id, shop: where.shop, ...(where.vendorId ? { vendorId: where.vendorId } : {}) } });
  if (!f) return new Response("Not found", { status: 404 });
  const disposition = `${download ? "attachment" : "inline"}; filename="${f.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`;
  return new Response(new Uint8Array(f.data), {
    headers: {
      "Content-Type": f.mimeType,
      "Content-Length": String(f.size),
      "Content-Disposition": disposition,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
