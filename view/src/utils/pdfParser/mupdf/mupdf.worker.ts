/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { Document, Buffer, PDFDocument } from "mupdf";

export const MUPDF_LOADED = "MUPDF_LOADED";

const mupdfScript = self.location.href.replace(
  "assets/mupdfWorker.js",
  "assets/mupdf.js",
);

export class MupdfWorker {
  private mupdf?: any;
  private document?: Document;

  constructor() {
    this.initializeMupdf();
  }

  private async initializeMupdf() {
    try {
      const mupdfModule = await import(/* @vite-ignore */ mupdfScript);
      this.mupdf = mupdfModule;
      postMessage(MUPDF_LOADED);
    } catch (error) {
      console.error("Failed to initialize MuPDF:", error);
    }
  }

  async loadDocument(document: ArrayBuffer): Promise<boolean> {
    if (!this.mupdf) throw new Error("MuPDF not initialized");
    this.document = this.mupdf.Document.openDocument(
      document,
      "application/pdf",
    );
    return true;
  }

  async pageCount() {
    if (!this.mupdf || !this.document) throw new Error("Document not loaded");
    return this.document.countPages();
  }

  async pageJson(pageIndex: number) {
    if (!this.mupdf || !this.document) throw new Error("Document not loaded");
    return this.document.loadPage(pageIndex).toStructuredText().asJSON();
  }

  async extractPages(pageIndexes: number[]) {
    if (!this.mupdf || !this.document) throw new Error("Document not loaded");
    const tempDocument = new this.mupdf.PDFDocument() as PDFDocument;
    pageIndexes.forEach((pageIndex) => {
      tempDocument.graftPage(-1, this.document as PDFDocument, pageIndex);
    });
    const documentBuf = tempDocument.saveToBuffer() as Buffer;
    tempDocument.destroy();
    return documentBuf.asUint8Array();
  }

  async renderPageAsImage(
    pageIndex: number = 0,
    scale: number = 1,
  ): Promise<Uint8Array> {
    if (!this.mupdf || !this.document) throw new Error("Document not loaded");
    const page = this.document.loadPage(pageIndex);
    const pixmap = page.toPixmap(
      [scale, 0, 0, scale, 0, 0],
      this.mupdf.ColorSpace.DeviceRGB,
    );
    return pixmap.asPNG();
  }
}

Comlink.expose(new MupdfWorker());
