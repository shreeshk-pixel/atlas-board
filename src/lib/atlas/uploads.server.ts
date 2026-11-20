import mammoth from "mammoth";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";

export type IncomingFile = {
  name: string;
  kind: "text" | "image" | "file";
  text?: string;
  mime?: string;
  data?: string;
};

export type PreparedFile = {
  label: string;
  text: string;
  image: string | null;
};

const MAX_FILES = 4;
const MAX_DATA = 3_200_000;
const MAX_TEXT = 80_000;

function extOf(name: string) {
  const part = name.toLowerCase().split(".").pop() ?? "";
  return part === name.toLowerCase() ? "" : part;
}

function letters(value: string) {
  return (value.match(/[A-Za-z]/g) ?? []).length;
}

function decodeXml(value: string) {
  return value
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "'");
}

function dataBytes(data: string) {
  const match = data.match(/^data:[^;,]*;base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  return Buffer.from(match[1].replace(/\s/g, ""), "base64");
}

function xmlText(xml: string, tag: string) {
  const found: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  for (const match of xml.matchAll(re)) found.push(decodeXml(match[1]));
  return found.join(" ").replace(/\s+/g, " ").trim();
}

async function zipText(bytes: Buffer, pattern: RegExp, tag: string) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => pattern.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const parts: string[] = [];
  for (const name of names) {
    const xml = await zip.files[name].async("string");
    const text = xmlText(xml, tag);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function binaryText(bytes: Buffer) {
  const chunks = [
    bytes.toString("latin1"),
    bytes.toString("utf16le"),
  ];
  const lines = new Set<string>();
  for (const chunk of chunks) {
    for (const match of chunk.matchAll(/[A-Za-z][A-Za-z0-9 ,.;:'"()/+\-]{7,}/g)) {
      const line = match[0].replace(/\s+/g, " ").trim();
      if (letters(line) >= 8) lines.add(line);
    }
  }
  return [...lines].slice(0, 400).join("\n");
}

async function textFromFile(name: string, bytes: Buffer) {
  const ext = extOf(name);
  if (ext === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const extracted = await extractText(pdf, { mergePages: true });
    const text = Array.isArray(extracted.text) ? extracted.text.join("\n\n") : String(extracted.text ?? "");
    if (letters(text) < 20) {
      throw new Error(`${name} has no readable text. If it is a scan, upload the pages as photos.`);
    }
    return text;
  }
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer: bytes });
    const text = result.value ?? "";
    if (letters(text) < 20) throw new Error(`Could not read ${name}.`);
    return text;
  }
  if (ext === "pptx" || ext === "pptm") {
    const slides = await zipText(bytes, /^ppt\/slides\/slide\d+\.xml$/, "a:t");
    const notes = await zipText(bytes, /^ppt\/notesSlides\/notesSlide\d+\.xml$/, "a:t");
    const text = [slides, notes].filter(Boolean).join("\n");
    if (letters(text) < 20) throw new Error(`Could not read ${name}.`);
    return text;
  }
  if (ext === "xlsx" || ext === "xls" || ext === "xlsm" || ext === "xlsb") {
    const book = XLSX.read(bytes, { type: "buffer", cellDates: true });
    const text = book.SheetNames.map((sheet) => {
      const csv = XLSX.utils.sheet_to_csv(book.Sheets[sheet] ?? {});
      return `${sheet}\n${csv}`;
    })
      .join("\n\n")
      .trim();
    if (text.length < 2) throw new Error(`Could not read ${name}.`);
    return text;
  }
  if (ext === "doc" || ext === "ppt") {
    const text = binaryText(bytes);
    if (letters(text) < 40) {
      throw new Error(`${name} is an old Office file. Save it as PDF, DOCX, or PPTX and upload that.`);
    }
    return text;
  }
  throw new Error(`${name} is not a PDF, Excel, PowerPoint, Word, text, or photo file.`);
}

export async function prepareFiles(input: IncomingFile[] | undefined): Promise<
  { ok: true; files: PreparedFile[] } | { ok: false; error: string }
> {
  const files = input ?? [];
  if (files.length > MAX_FILES) return { ok: false, error: `Attach up to ${MAX_FILES} files.` };
  const prepared: PreparedFile[] = [];
  for (const file of files) {
    const label = (file.name || "file").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
    try {
      if (file.kind === "text") {
        const text = (file.text ?? "").trim();
        if (!text) return { ok: false, error: `${label} is empty.` };
        if (text.length > MAX_TEXT) return { ok: false, error: `${label} is too long. Split it.` };
        prepared.push({ label, text, image: null });
        continue;
      }
      if (file.kind === "image") {
        const data = file.data ?? "";
        if (!data.startsWith("data:image/")) return { ok: false, error: `${label} is not a photo.` };
        if (data.length > MAX_DATA) return { ok: false, error: `${label} is too large.` };
        prepared.push({ label, text: "", image: data });
        continue;
      }
      if (file.kind !== "file") return { ok: false, error: `Could not read ${label}.` };
      const data = file.data ?? "";
      if (data.length > MAX_DATA) return { ok: false, error: `${label} is too large. Keep it under 2 MB.` };
      const bytes = dataBytes(data);
      if (!bytes) return { ok: false, error: `Could not read ${label}.` };
      const text = (await textFromFile(label, bytes)).trim().slice(0, MAX_TEXT);
      prepared.push({ label, text, image: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : `Could not read ${label}.`;
      return { ok: false, error: message };
    }
  }
  return { ok: true, files: prepared };
}
