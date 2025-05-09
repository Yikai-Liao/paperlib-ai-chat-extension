import fs from "fs";
import { PdfParser } from "../parser.ts";
import * as Comlink from "comlink";
import { MupdfWorker } from "./mupdf.worker.ts";

interface Block {
  type: string;
  lines: { text?: string }[];
}

const WORKER_FILE_PATH = "mupdfWorker.js";

const worker = new Worker(new URL(WORKER_FILE_PATH, import.meta.url), {
  type: "module",
});
const mupdfWorker = Comlink.wrap<MupdfWorker>(worker);

export class MupdfParser implements PdfParser {
  constructor() {}

  async load(url: string) {
    const pdfFile = await fs.promises.readFile(url);
    await mupdfWorker.loadDocument(pdfFile);
  }

  async pageCount(): Promise<number> {
    return mupdfWorker.pageCount();
  }
  async pageContent(pageIndex: number): Promise<string> {
    const pageJson = await mupdfWorker.pageJson(pageIndex);
    const structuredPage = JSON.parse(pageJson) as {
      blocks: Block[];
    };
    return structuredPage.blocks
      .map((block) => {
        if (block.type === "text") {
          return block.lines
            .map((line) => line.text)
            .filter(Boolean)
            .join("\n");
        }
      })
      .filter(Boolean)
      .join("\n");
  }

  async pageAsPng(pageIndex: number) {
    return mupdfWorker.renderPageAsImage(pageIndex);
  }

  async extractPages(pageIndexes: number[]) {
    return mupdfWorker.extractPages(pageIndexes);
  }

  async parse(
    url: string,
    onProgress?: (progress: number) => void,
  ): Promise<string[]> {
    await this.load(url);
    const len = await this.pageCount();
    let contents: string[] = [];
    for (let i = 0; i < len; i++) {
      contents.push(await this.pageContent(i));
      const progress = ((i + 1) / len) * 100;
      onProgress?.(progress);
    }
    return contents;
  }
}
