import { PDFDocument, StandardFonts } from "pdf-lib";

/** Builds a small text PDF; each entry of `pages` becomes one page (lines separated by \n). */
export async function makePdf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([612, 792]);
    text.split("\n").forEach((line, i) => page.drawText(line, { x: 50, y: 740 - i * 18, size: 12, font }));
  }
  return Buffer.from(await doc.save());
}
