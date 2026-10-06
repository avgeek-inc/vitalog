import { createHash } from "node:crypto";
import type { Attachment } from "../src/registry/attachments.js";

export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iCvwAAAAASUVORK5CYII=",
  "base64",
);
export const gif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
export function pdfFile(padding = 0) {
  let content = "%PDF-1.4\n% synthetic attachment fixture\n";
  const offsets = [0];
  for (const [index, object] of [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>",
  ].entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  if (padding) content += "%" + " ".repeat(padding) + "\n";
  const start = Buffer.byteLength(content);
  content += "xref\n0 4\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1))
    content += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(
    content +
      `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`,
  );
}
export const pdf = pdfFile();
export function fileMetadata(
  bytes: Uint8Array,
  contentType: Attachment["content_type"] = "image/png",
  filename = "meal.png",
) {
  return {
    filename,
    content_type: contentType,
    byte_length: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
