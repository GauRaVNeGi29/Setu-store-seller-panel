/** Upload rules per kind of file. Safe to use in the browser (for hints and the file picker). */

export type FileKindName = "gst" | "iec" | "ad_code" | "logo" | "banner";

const MB = 1024 * 1024;
const DOC = { mimes: ["application/pdf", "image/jpeg", "image/png"], accepts: "a PDF, JPG or PNG", accept: "application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png", maxBytes: 5 * MB };
const IMG = { mimes: ["image/png", "image/jpeg", "image/webp"], accepts: "a PNG, JPG or WebP image", accept: "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" };

export const FILE_RULES: Record<FileKindName, { label: string; mimes: string[]; accepts: string; accept: string; maxBytes: number; hint: string }> = {
  gst: { label: "GST certificate", ...DOC, hint: "PDF, JPG or PNG, up to 5 MB." },
  iec: { label: "IEC certificate", ...DOC, hint: "Import Export Code certificate. PDF, JPG or PNG, up to 5 MB." },
  ad_code: { label: "AD code letter", ...DOC, hint: "Authorised Dealer code letter from your bank. PDF, JPG or PNG, up to 5 MB." },
  logo: { label: "Brand logo", ...IMG, maxBytes: 2 * MB, hint: "Shown as a small circle beside your name on your product pages, so use your symbol rather than the full name and tagline. Square, at least 512 × 512 px. PNG, JPG or WebP, up to 2 MB." },
  banner: { label: "Brand banner", ...IMG, maxBytes: 5 * MB, hint: "Wide image, about 1600 × 500 px. PNG, JPG or WebP, up to 5 MB." },
};
