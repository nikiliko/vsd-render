import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TPL_PDF = join(ROOT, "templates", "template.pdf");
const TPL_PNG = join(ROOT, "templates", "sheet.png");
const FIELD_MAP_PATH = join(ROOT, "FIELD_MAP.json");

// util
const okCors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
};
const parseJSON = async (req) => {
  try { return JSON.parse(await streamToString(req)); } catch { return {}; }
};
const streamToString = (req) => new Promise((resolve, reject) => {
  let data = ""; req.on("data", c => data += c);
  req.on("end", () => resolve(data)); req.on("error", reject);
});
const signed = (n) => (n > 0 ? `+${n}` : String(n));

// your app’s values live in localStorage client-side; the frontend will POST them to this API.
function coerceValues(payload = {}) {
  // You can reshape here if needed.
  return payload.values || {};
}

// draw to PDF (top-left coords from FIELD_MAP)
async function renderPDF(values, mapOverride) {
  const templateBytes = await readFile(TPL_PDF);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.getPages()[0];
  const { width, height } = page.getSize();

  const fieldMap = mapOverride || JSON.parse(await readFile(FIELD_MAP_PATH, "utf8"));

  for (const [key, conf] of Object.entries(fieldMap)) {
    const text = values[key] ?? "";
    if (text === null || text === undefined || text === "") continue;

    const size = conf.size || 10;
    const color = rgb(0, 0, 0);
    const w = font.widthOfTextAtSize(String(text), size);

    let x = conf.x;
    if (conf.align === "center") x = conf.x - w / 2;
    if (conf.align === "right")  x = conf.x - w;

    // top-left → bottom-left conversion
    const baselineAdjust = conf.baselineAdjust || 0;
    const y = height - conf.y - baselineAdjust;

    page.drawText(String(text), { x, y, size, font, color });
  }

  return Buffer.from(await pdfDoc.save());
}

// draw to PNG using background sheet.png (must match PDF layout)
async function renderPNG(values, mapOverride) {
  const img = await loadImage(TPL_PNG);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const fieldMap = mapOverride || JSON.parse(await readFile(FIELD_MAP_PATH, "utf8"));
  ctx.fillStyle = "#111";
  ctx.textBaseline = "top"; // we mapped to top-left

  for (const [key, conf] of Object.entries(fieldMap)) {
    const text = values[key] ?? "";
    if (text === null || text === undefined || text === "") continue;

    const size = conf.size || 10;
    ctx.font = `${size}px Helvetica`;

    // measure for center/right alignment
    const metrics = ctx.measureText(String(text));
    let x = conf.x;
    if (conf.align === "center") x = conf.x - metrics.width / 2;
    if (conf.align === "right")  x = conf.x - metrics.width;

    const y = conf.y + (conf.baselineAdjust || 0);
    ctx.fillText(String(text), x, y);
  }

  return canvas.toBuffer("image/png");
}

export default async function handler(req, res) {
  okCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST /api/render" });
  }

  try {
    const body = await parseJSON(req);
    const format = (body.format || "pdf").toLowerCase(); // 'pdf' | 'png'
    const values = coerceValues(body);

    if (format === "png") {
      const png = await renderPNG(values);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `attachment; filename="VsD_Character.png"`);
      return res.status(200).end(png);
    }

    const pdf = await renderPDF(values);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="VsD_Character.pdf"`);
    return res.status(200).end(pdf);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Render failed", details: String(e?.message || e) });
  }
}
