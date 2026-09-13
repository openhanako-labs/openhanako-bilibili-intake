import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

export function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function truncateText(text, maxLength) {
  const clean = normalizeWhitespace(text);
  if (!maxLength || clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

export function sanitizePathSegment(input, fallback = "item") {
  const normalized = safeTrim(String(input ?? ""))
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return normalized || fallback;
}

export function hashText(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 10);
}

export function normalizeBilibiliSource(source, page) {
  const raw = safeTrim(source);
  if (!raw) {
    return "";
  }

  if (/^BV[0-9A-Za-z]+$/i.test(raw)) {
    return appendPage(`https://www.bilibili.com/video/${raw}`, page);
  }

  if (/^av\d+$/i.test(raw)) {
    return appendPage(`https://www.bilibili.com/video/${raw}`, page);
  }

  if (/^https?:\/\//i.test(raw)) {
    return appendPage(raw, page);
  }

  return appendPage(`https://www.bilibili.com/video/${raw}`, page);
}

function appendPage(url, page) {
  if (!page || Number.isNaN(Number(page)) || Number(page) <= 1) {
    return url;
  }
  const target = new URL(url);
  target.searchParams.set("p", String(page));
  return target.toString();
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf-8"));
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export async function hashFile(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}
