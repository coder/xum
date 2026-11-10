import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";

import {
  IMAGE_TOKEN_ESTIMATE,
  PDF_MAX_PAGES_ESTIMATE,
  PDF_TOKENS_PER_PAGE_ESTIMATE,
} from "@/common/constants/contextBudget";

import { estimatePdfAttachmentTokens } from "./pdfTokenEstimate";

function pdfDataUrl(body: string | Buffer): string {
  const bytes = typeof body === "string" ? Buffer.from(body, "latin1") : body;
  return `data:application/pdf;base64,${bytes.toString("base64")}`;
}

function flateObjectStream(objectNumber: number, content: string, level?: number): Buffer {
  const compressed = deflateSync(Buffer.from(content, "latin1"), level == null ? {} : { level });
  return Buffer.concat([
    Buffer.from(
      `${objectNumber} 0 obj\n<< /Type /ObjStm /First 0 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\r\n`,
      "latin1"
    ),
    compressed,
    Buffer.from("\r\nendstream\nendobj\n", "latin1"),
  ]);
}

/** Page dictionaries packed into one FlateDecode object stream (PDF 1.5+ writers). */
function objectStreamPdf(pageCount: number, options?: { separateTreeStream?: boolean }): Buffer {
  const objects = Array.from(
    { length: pageCount },
    (_, index) => `${index + 2} 0 << /Type /Page /Parent 1 0 R /MediaBox [0 0 612 792] >>`
  ).join("\n");
  return Buffer.concat([
    Buffer.from("%PDF-1.5\n", "latin1"),
    ...(options?.separateTreeStream === true
      ? [flateObjectStream(100, `1 0 << /Type /Pages /Kids [] /Count ${pageCount} >>`)]
      : []),
    flateObjectStream(101, objects),
    Buffer.from("%%EOF\n", "latin1"),
  ]);
}

describe("estimatePdfAttachmentTokens", () => {
  it("prices visible page objects per page", () => {
    const pages = Array.from(
      { length: 3 },
      (_, index) => `${index + 1} 0 obj\n<< /Type /Page /Parent 9 0 R >>\nendobj`
    ).join("\n");
    const pdf = `%PDF-1.4\n${pages}\n9 0 obj\n<< /Type /Pages /Kids [1 0 R 2 0 R 3 0 R] /Count 3 >>\nendobj\n`;
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(3 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("counts page objects stored in compressed object streams", () => {
    // A highly compressible 40-page document is a few hundred bytes on the
    // wire: a size-based fallback would price it near the image floor while
    // the provider bills forty pages.
    const url = pdfDataUrl(objectStreamPdf(40));
    expect(estimatePdfAttachmentTokens(url)).toBe(40 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("does not add a compressed page tree count to the page objects of another stream", () => {
    // The tree's /Count and the page dictionaries live in different object
    // streams: the two sources are compared, never summed (a 2x estimate would
    // force compaction of a request that fits).
    const url = pdfDataUrl(objectStreamPdf(40, { separateTreeStream: true }));
    expect(estimatePdfAttachmentTokens(url)).toBe(40 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("scans the object streams even when a raw page object is visible", () => {
    // A hybrid or incrementally saved document: one page dictionary sits raw
    // while the page tree and the other pages live in object streams. The raw
    // source alone would price a 60-page document as one page and let the
    // pre-send check skip a compaction the provider then demands.
    const compressedPages = Array.from(
      { length: 59 },
      (_, index) => `${index + 3} 0 << /Type /Page /Parent 1 0 R >>`
    ).join("\n");
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.5\n2 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n", "latin1"),
      flateObjectStream(100, "1 0 << /Type /Pages /Kids [] /Count 60 >>"),
      flateObjectStream(101, compressedPages),
      Buffer.from("%%EOF\n", "latin1"),
    ]);
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(60 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("ignores page-like text inside content streams", () => {
    // A content stream can spell out page dictionaries as DATA (a document
    // about PDF syntax): only dictionaries outside stream payloads count, or a
    // two-page document would be priced as fifty and compacted for nothing.
    const pages = Array.from(
      { length: 2 },
      (_, index) => `${index + 1} 0 obj\n<< /Type /Page /Parent 9 0 R >>\nendobj`
    ).join("\n");
    const payload = "BT (/Type /Page and /Type /Pages /Count 40) Tj ET\n".repeat(50);
    const pdf =
      `%PDF-1.4\n${pages}\n9 0 obj\n<< /Type /Pages /Kids [1 0 R 2 0 R] /Count 2 >>\nendobj\n` +
      `10 0 obj\n<< /Length ${payload.length} >>\nstream\n${payload}endstream\nendobj\n`;
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(2 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("reads each stream's own dictionary, not the previous object's", () => {
    // A Flate content stream right after an object stream: a window of bytes
    // before its keyword still holds the object stream's /ObjStm, and the
    // content (page-like text as DATA) would be inflated and counted. Only the
    // dictionary that owns the stream decides, and nested dictionaries do not
    // confuse the parse.
    const content = deflateSync(
      Buffer.from("BT (/Type /Page and /Type /Pages /Count 40) Tj ET\n".repeat(50), "latin1")
    );
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.5\n", "latin1"),
      flateObjectStream(
        101,
        Array.from(
          { length: 2 },
          (_, index) => `${index + 2} 0 << /Type /Page /Parent 1 0 R >>`
        ).join("\n")
      ),
      Buffer.from(
        `7 0 obj\n<< /Filter /FlateDecode /DecodeParms << /Predictor 1 >> /Length ${content.length} >>\nstream\n`,
        "latin1"
      ),
      content,
      Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
    ]);
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(2 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("treats a stream whose dictionary cannot be delimited as an unknown page count", () => {
    // The word "stream" inside a string is no stream object and is skipped;
    // a stream closing a dictionary whose brackets never balance may be an
    // object stream holding uncounted pages, so the cap applies.
    const skipped =
      "%PDF-1.4\n1 0 obj\n<< /Type /Page /Title (a stream of text) >>\nendobj\n" +
      "9 0 obj\n<< /Type /Pages /Kids [1 0 R] /Count 1 >>\nendobj\n";
    expect(estimatePdfAttachmentTokens(pdfDataUrl(skipped))).toBe(PDF_TOKENS_PER_PAGE_ESTIMATE);
    const unbalanced =
      "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n" +
      "5 0 obj\n/Type /ObjStm /Filter /FlateDecode >>\nstream\nxx\nendstream\nendobj\n";
    expect(estimatePdfAttachmentTokens(pdfDataUrl(unbalanced))).toBe(
      PDF_MAX_PAGES_ESTIMATE * PDF_TOKENS_PER_PAGE_ESTIMATE
    );
  });

  it("caps the recovered page count at the provider limit", () => {
    // Providers reject longer documents anyway, so a larger count (real or a
    // false positive) cannot price a request beyond the cap.
    const pages = Array.from(
      { length: PDF_MAX_PAGES_ESTIMATE + 50 },
      (_, index) => `${index + 1} 0 obj\n<< /Type /Page >>\nendobj`
    ).join("\n");
    expect(estimatePdfAttachmentTokens(pdfDataUrl(`%PDF-1.4\n${pages}\n`))).toBe(
      PDF_MAX_PAGES_ESTIMATE * PDF_TOKENS_PER_PAGE_ESTIMATE
    );
  });

  it("delimits a stream by its declared length when its bytes spell out endstream", () => {
    // A stored (level 0) DEFLATE block keeps the page dictionaries verbatim, so
    // a dictionary string containing "endstream" appears inside the encoded
    // bytes. Cutting at the first occurrence would truncate the stream, fail
    // the inflation and — with one raw page visible — price 1 page for 31.
    const objects = [
      "2 0 << /Type /Page /Parent 1 0 R /Title (mentions endstream) >>",
      ...Array.from({ length: 29 }, (_, index) => `${index + 3} 0 << /Type /Page /Parent 1 0 R >>`),
    ].join("\n");
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.5\n40 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n", "latin1"),
      flateObjectStream(101, objects, 0),
      Buffer.from("%%EOF\n", "latin1"),
    ]);
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(31 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("treats an object stream that does not decode as an unknown page count", () => {
    // One page is visible raw, the rest sit in an object stream that fails to
    // inflate: the partial count is no bound, so the provider cap applies.
    const pdf =
      "%PDF-1.5\n2 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n" +
      "3 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length 8 >>\nstream\r\nnotzlib!\r\nendstream\nendobj\n";
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(
      PDF_MAX_PAGES_ESTIMATE * PDF_TOKENS_PER_PAGE_ESTIMATE
    );
  });

  it("uses the page tree count when the page objects themselves are not visible", () => {
    const pdf = "%PDF-1.5\n1 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 12 >>\nendobj\n";
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(12 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("assumes the provider page cap when no page count can be recovered", () => {
    // An object stream that does not inflate (encrypted, another filter): the
    // compressed size bounds nothing, so the estimate is the cap providers enforce.
    const pdf =
      "%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length 8 >>\nstream\r\nnotzlib!\r\nendstream\nendobj\n";
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(
      PDF_MAX_PAGES_ESTIMATE * PDF_TOKENS_PER_PAGE_ESTIMATE
    );
    expect(estimatePdfAttachmentTokens("https://example.com/a.pdf")).toBe(IMAGE_TOKEN_ESTIMATE);
  });
});
