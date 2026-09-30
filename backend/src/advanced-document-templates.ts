import * as cheerio from "cheerio";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentAssetPlacement, TradeDocument, TradeDocumentItem } from "./types.js";

export interface AdvancedDocumentTemplate {
  id: string;
  name: string;
  category: "sales" | "shipping" | "procurement";
  description: string;
  fileName: string;
  recommendedTypes: TradeDocument["type"][];
  maxItems: number;
  dynamicItems?: boolean;
  compatibility: "full" | "partial";
  warnings: string[];
  assetCapabilities: Array<"letterhead" | "productImages" | "stamp" | "signature">;
}

export interface AdvancedDocumentImage {
  data: Uint8Array;
  extension: "png" | "jpg";
}

export interface AdvancedDocumentAssets {
  logo?: AdvancedDocumentImage;
  logoPlacement?: DocumentAssetPlacement;
  stamp?: AdvancedDocumentImage;
  stampPlacement?: DocumentAssetPlacement;
  signature?: AdvancedDocumentImage;
  productImages?: Record<string, AdvancedDocumentImage>;
}

interface InternalTemplate extends AdvancedDocumentTemplate {
  assetName: string;
  build: (files: Record<string, Uint8Array>, document: TradeDocument) => number[] | void;
}

type XmlApi = cheerio.CheerioAPI;
type PlaceholderValue = string | number;

const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/document-templates");
const DEFAULT_LOGO_ASSET = "goodjob-default-logo.png";
const xmlTag = (name: string) => `x\\:${name}, ${name}`;
const xmlNode = ($: XmlApi, name: string) => $(`x\\:${name}`).length ? `x:${name}` : name;
const xmlAttrTag = (name: string, attribute: string) => `x\\:${name}[${attribute}], ${name}[${attribute}]`;

function excelDate(value: string) {
  return value || "";
}

function total(document: TradeDocument) {
  return document.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
}

function grossWeight(document: TradeDocument) {
  return document.items.reduce((sum, item) => sum + Number(item.weightKg || 0), 0);
}

function packageCount(document: TradeDocument) {
  return document.items.reduce((sum, item) => sum + Number(item.packageCount || 0), 0);
}

function contactEmail(value: string) {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

function contactPhone(value: string) {
  return value.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0]?.trim() || "";
}

function contactName(value: string) {
  const email = contactEmail(value);
  const phone = contactPhone(value);
  return value
    .replace(email, "")
    .replace(phone, "")
    .replace(/[|/,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function documentPlaceholderValues(document: TradeDocument): Record<string, PlaceholderValue> {
  const firstItem = document.items[0] || { product: "", model: "", material: "", finish: "", hsCode: "", quantity: 0, unit: "", unitPrice: 0, originCountry: "" };
  return {
    "buyer.address": document.buyerAddress,
    "buyer.company": document.buyer,
    "buyer.contact": contactName(document.buyerContact),
    "buyer.email": contactEmail(document.buyerContact),
    "buyer.phone": contactPhone(document.buyerContact),
    "document.bankInfo": document.bankInfo,
    "document.currency": document.currency,
    "document.customerCode": "",
    "document.grossWeight": grossWeight(document),
    "document.incoterm": document.incoterm,
    "document.issueDate": document.issueDate,
    "document.notes": document.notes,
    "document.number": document.number,
    "document.packageCount": packageCount(document),
    "document.paymentTerm": document.paymentTerm,
    "document.portDischarge": document.portDischarge,
    "document.portLoading": document.portLoading,
    "document.revision": document.revision || 1,
    "document.shippingCost": 0,
    "document.shippingMethod": document.shippingMethod,
    "document.subtotal": total(document),
    "document.title": document.title,
    "document.total": total(document),
    "document.validityDate": document.validityDate,
    "item.amount": Number(firstItem.quantity || 0) * Number(firstItem.unitPrice || 0),
    "item.hsCode": firstItem.hsCode,
    "item.index": firstItem.product ? 1 : "",
    "item.material": firstItem.material || "",
    "item.finish": firstItem.finish || "",
    "item.model": firstItem.model,
    "item.originCountry": firstItem.originCountry,
    "item.product": firstItem.product,
    "item.quantity": Number(firstItem.quantity || 0),
    "item.unit": firstItem.unit,
    "item.unitPrice": Number(firstItem.unitPrice || 0),
    "seller.address": document.sellerAddress,
    "seller.company": document.seller,
    "seller.contact": "",
    "seller.salesPerson": ""
  };
}

function loadXml(files: Record<string, Uint8Array>, filePath: string) {
  const bytes = files[filePath];
  if (!bytes) throw new Error(`模板结构缺失：${filePath}`);
  const $ = cheerio.load(strFromU8(bytes), { xmlMode: true });
  return {
    $,
    save: () => { files[filePath] = strToU8($.xml()); }
  };
}

function cellRow(reference: string) {
  const match = reference.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function cellColumn(reference: string) {
  return reference.replace(/\d+$/, "");
}

function rowNode($: XmlApi, rowNumber: number) {
  let row = $(xmlAttrTag("row", `r="${rowNumber}"`)).first();
  if (row.length) return row;
  const rowTag = xmlNode($, "row");
  const created = $(`<${rowTag}></${rowTag}>`).attr("r", String(rowNumber));
  const next = $(xmlTag("sheetData")).children(xmlTag("row")).filter((_, element) => Number($(element).attr("r") || 0) > rowNumber).first();
  if (next.length) next.before(created);
  else $(xmlTag("sheetData")).append(created);
  row = $(xmlAttrTag("row", `r="${rowNumber}"`)).first();
  return row;
}

function cellNode($: XmlApi, reference: string) {
  let cell = $(xmlAttrTag("c", `r="${reference}"`)).first();
  if (cell.length) return cell;
  const row = rowNode($, cellRow(reference));
  const cellTag = xmlNode($, "c");
  const created = $(`<${cellTag}></${cellTag}>`).attr("r", reference);
  const column = cellColumn(reference);
  const next = row.children(xmlTag("c")).filter((_, element) => String($(element).attr("r") || "").replace(/\d+$/, "") > column).first();
  if (next.length) next.before(created);
  else row.append(created);
  cell = $(xmlAttrTag("c", `r="${reference}"`)).first();
  return cell;
}

function setText($: XmlApi, reference: string, value: unknown) {
  const cell = cellNode($, reference);
  cell.empty().attr("t", "inlineStr");
  const inlineTag = xmlNode($, "is");
  const textTag = xmlNode($, "t");
  const inline = $(`<${inlineTag}></${inlineTag}>`);
  inline.append($(`<${textTag}></${textTag}>`).attr("xml:space", "preserve").text(String(value ?? "")));
  cell.append(inline);
}

function setNumber($: XmlApi, reference: string, value: number) {
  const cell = cellNode($, reference);
  const valueTag = xmlNode($, "v");
  cell.empty().removeAttr("t").append($(`<${valueTag}></${valueTag}>`).text(String(Number.isFinite(value) ? value : 0)));
}

function setFormula($: XmlApi, reference: string, formula: string, cachedValue: number) {
  const cell = cellNode($, reference);
  cell.empty().removeAttr("t");
  const formulaTag = xmlNode($, "f");
  const valueTag = xmlNode($, "v");
  cell.append($(`<${formulaTag}></${formulaTag}>`).text(formula));
  cell.append($(`<${valueTag}></${valueTag}>`).text(String(Number.isFinite(cachedValue) ? cachedValue : 0)));
}

function shiftReference(reference: string, startRow: number, delta: number) {
  return reference.replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (_, column: string, rowText: string) => {
    const row = Number(rowText);
    return `${column}${row >= startRow ? row + delta : row}`;
  });
}

function expandRows($: XmlApi, itemStart: number, baseCapacity: number, itemCount: number) {
  const delta = Math.max(0, itemCount - baseCapacity);
  if (!delta) return 0;
  const shiftStart = itemStart + baseCapacity;
  const rows = $(xmlTag("sheetData")).children(xmlTag("row")).toArray().sort((left, right) => Number($(right).attr("r") || 0) - Number($(left).attr("r") || 0));
  rows.forEach((element) => {
    const row = $(element);
    const current = Number(row.attr("r") || 0);
    if (current < shiftStart) return;
    const next = current + delta;
    row.attr("r", String(next));
    row.children(xmlTag("c")).each((_, cellElement) => {
      const cell = $(cellElement);
      const reference = cell.attr("r") || "";
      cell.attr("r", `${cellColumn(reference)}${next}`);
      const formula = cell.children(xmlTag("f"));
      if (formula.length) formula.text(shiftReference(formula.text(), shiftStart, delta));
    });
  });
  $("[ref]").not(xmlTag("c")).each((_, element) => {
    const node = $(element);
    node.attr("ref", shiftReference(node.attr("ref") || "", shiftStart, delta));
  });
  $("[sqref]").each((_, element) => {
    const node = $(element);
    node.attr("sqref", shiftReference(node.attr("sqref") || "", shiftStart, delta));
  });
  const templateRow = $(xmlAttrTag("row", `r="${itemStart + baseCapacity - 1}"`)).first();
  for (let index = 0; index < delta; index += 1) {
    const targetRow = shiftStart + index;
    const clone = templateRow.clone();
    clone.attr("r", String(targetRow));
    clone.children(xmlTag("c")).each((_, cellElement) => {
      const cell = $(cellElement);
      cell.attr("r", `${cellColumn(cell.attr("r") || "A")}${targetRow}`);
      const formula = cell.children(xmlTag("f"));
      if (formula.length) formula.text(shiftReference(formula.text(), itemStart + baseCapacity - 1, targetRow - (itemStart + baseCapacity - 1)));
    });
    const previous = $(xmlAttrTag("row", `r="${targetRow - 1}"`)).first();
    previous.after(clone);
  }
  return delta;
}

function cleanLegacyCellImages(files: Record<string, Uint8Array>) {
  for (const [filePath, bytes] of Object.entries(files)) {
    if (!filePath.startsWith("xl/worksheets/") || !filePath.endsWith(".xml")) continue;
    const xml = strFromU8(bytes).replace(/<(?:[\w.-]+:)?f[^>]*>[^<]*(?:_xlfn\.)?DISPIMG[^<]*<\/(?:[\w.-]+:)?f>(?:<(?:[\w.-]+:)?v>[^<]*<\/(?:[\w.-]+:)?v>)?/g, "");
    files[filePath] = strToU8(xml);
  }
}

function replaceRemainingPlaceholders(files: Record<string, Uint8Array>, document: TradeDocument) {
  const values = documentPlaceholderValues(document);
  for (const [filePath, bytes] of Object.entries(files)) {
    if (!filePath.startsWith("xl/worksheets/") || !filePath.endsWith(".xml")) continue;
    const xml = strFromU8(bytes).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (placeholder, key: string) => {
      const normalized = key.trim();
      return Object.hasOwn(values, normalized) ? String(values[normalized] ?? "") : placeholder;
    });
    files[filePath] = strToU8(xml);
  }
}

function inlineCellText($: XmlApi, cell: cheerio.Cheerio<any>) {
  if (cell.attr("t") !== "inlineStr") return "";
  return cell.find(xmlTag("t")).map((_, element) => $(element).text()).get().join("");
}

function exactPlaceholder(value: string) {
  return value.match(/^\{\{\s*([^}]+?)\s*\}\}$/)?.[1]?.trim() || "";
}

function replaceTextPlaceholders(value: string, values: Record<string, PlaceholderValue>) {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (placeholder, key: string) => {
    const normalized = key.trim();
    return Object.hasOwn(values, normalized) ? String(values[normalized] ?? "") : placeholder;
  });
}

function replaceCellPlaceholders($: XmlApi, cells: cheerio.Cheerio<any>, values: Record<string, PlaceholderValue>) {
  cells.each((_, element) => {
    const cell = $(element);
    const reference = cell.attr("r") || "";
    const current = inlineCellText($, cell);
    if (!reference || !current.includes("{{")) return;
    const key = exactPlaceholder(current);
    if (key && typeof values[key] === "number") setNumber($, reference, Number(values[key]));
    else setText($, reference, replaceTextPlaceholders(current, values));
  });
}

function itemPlaceholderValues(item: TradeDocumentItem, index: number): Record<string, PlaceholderValue> {
  return {
    "item.amount": Number(item.quantity || 0) * Number(item.unitPrice || 0),
    "item.hsCode": item.hsCode,
    "item.index": index + 1,
    "item.material": item.material || "",
    "item.finish": item.finish || "",
    "item.model": item.model,
    "item.originCountry": item.originCountry,
    "item.product": item.product,
    "item.quantity": Number(item.quantity || 0),
    "item.unit": item.unit,
    "item.unitPrice": Number(item.unitPrice || 0)
  };
}

function variableItemRow($: XmlApi) {
  return $(xmlTag("row")).filter((_, row) => $(row).find(xmlTag("t")).toArray().some((textNode) => $(textNode).text().includes("{{item.index}}"))).first();
}

function variableCellReference($: XmlApi, key: string) {
  const marker = `{{${key}}}`;
  return $(xmlTag("c")).filter((_, cell) => inlineCellText($, $(cell)).trim() === marker).first().attr("r") || "";
}

function updateVariableTemplatePrintAreas(files: Record<string, Uint8Array>, deltas: number[]) {
  const xml = loadXml(files, "xl/workbook.xml");
  xml.$(xmlTag("definedName")).each((_, element) => {
    const node = xml.$(element);
    if (node.attr("name") !== "_xlnm.Print_Area") return;
    const sheetIndex = Number(node.attr("localSheetId") || 0);
    const delta = deltas[sheetIndex] || 0;
    if (delta) node.text(shiftReference(node.text(), 18, delta));
  });
  xml.save();
}

function updateVariableTemplatePageBreaks($: XmlApi, delta: number) {
  if (!delta) return;
  $(xmlTag("rowBreaks")).find(xmlTag("brk")).each((_, element) => {
    const node = $(element);
    const current = Number(node.attr("id") || 0);
    if (current >= 18) node.attr("id", String(current + delta));
  });
}

function imageDimensions(image: AdvancedDocumentImage) {
  const bytes = image.data;
  if (image.extension === "png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (image.extension === "jpg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < bytes.length) {
        return { height: (bytes[offset + 5] << 8) + bytes[offset + 6], width: (bytes[offset + 7] << 8) + bytes[offset + 8] };
      }
      offset += Math.max(2, length + 2);
    }
  }
  return { width: 1, height: 1 };
}

function fitImage(image: AdvancedDocumentImage, maxWidth: number, maxHeight: number) {
  const dimensions = imageDimensions(image);
  const scale = Math.min(maxWidth / Math.max(1, dimensions.width), maxHeight / Math.max(1, dimensions.height));
  return { width: Math.max(1, Math.round(dimensions.width * scale)), height: Math.max(1, Math.round(dimensions.height * scale)) };
}

function ensureImageContentType(files: Record<string, Uint8Array>, extension: "png" | "jpg") {
  const xml = loadXml(files, "[Content_Types].xml");
  const acceptedExtensions = extension === "png" ? ["png"] : ["jpg", "jpeg"];
  if (!acceptedExtensions.some((candidate) => xml.$(`${xmlTag("Default")}[Extension="${candidate}"]`).length)) {
    const tag = xmlNode(xml.$, "Default");
    xml.$(xmlTag("Types")).prepend(xml.$(`<${tag}></${tag}>`)
      .attr("Extension", extension)
      .attr("ContentType", extension === "png" ? "image/png" : "image/jpeg"));
    xml.save();
  }
}

function ensureWorksheetDrawing(files: Record<string, Uint8Array>, sheetNumber: number, drawingNumber: number) {
  const drawingPath = `xl/drawings/drawing${drawingNumber}.xml`;
  const drawingRelsPath = `xl/drawings/_rels/drawing${drawingNumber}.xml.rels`;
  if (!files[drawingPath]) {
    files[drawingPath] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>');
  }
  if (!files[drawingRelsPath]) {
    files[drawingRelsPath] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  }

  const contentTypes = loadXml(files, "[Content_Types].xml");
  const drawingPartName = `/xl/drawings/drawing${drawingNumber}.xml`;
  if (!contentTypes.$(`${xmlTag("Override")}[PartName="${drawingPartName}"]`).length) {
    const tag = xmlNode(contentTypes.$, "Override");
    contentTypes.$(xmlTag("Types")).append(contentTypes.$(`<${tag}></${tag}>`)
      .attr("PartName", drawingPartName)
      .attr("ContentType", "application/vnd.openxmlformats-officedocument.drawing+xml"));
    contentTypes.save();
  }

  const sheetPath = `xl/worksheets/sheet${sheetNumber}.xml`;
  const sheetRelsPath = `xl/worksheets/_rels/sheet${sheetNumber}.xml.rels`;
  const worksheet = loadXml(files, sheetPath);
  if (!worksheet.$(xmlTag("drawing")).length) {
    const relationships = files[sheetRelsPath]
      ? loadXml(files, sheetRelsPath)
      : (() => {
          files[sheetRelsPath] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
          return loadXml(files, sheetRelsPath);
        })();
    const relationshipId = nextRelationshipId(relationships.$);
    const relationshipTag = xmlNode(relationships.$, "Relationship");
    relationships.$(xmlTag("Relationships")).append(relationships.$(`<${relationshipTag}></${relationshipTag}>`)
      .attr("Id", relationshipId)
      .attr("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing")
      .attr("Target", `../drawings/drawing${drawingNumber}.xml`));
    relationships.save();
    worksheet.$(xmlTag("worksheet")).attr("xmlns:r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships");
    const drawingTag = xmlNode(worksheet.$, "drawing");
    worksheet.$(xmlTag("worksheet")).append(worksheet.$(`<${drawingTag}></${drawingTag}>`).attr("r:id", relationshipId));
    worksheet.save();
  }
}

function nextRelationshipId($: XmlApi) {
  const ids = $(xmlTag("Relationship")).map((_, element) => Number(($(element).attr("Id") || "").replace(/^rId/, "")) || 0).get();
  return `rId${Math.max(0, ...ids) + 1}`;
}

function nextDrawingObjectId($: XmlApi) {
  const ids = $("xdr\\:cNvPr, cNvPr").map((_, element) => Number($(element).attr("id") || 0)).get();
  return Math.max(0, ...ids) + 1;
}

function pictureAnchorXml(input: {
  relationshipId: string;
  objectId: number;
  name: string;
  column: number;
  row: number;
  columnOffsetPx: number;
  rowOffsetPx: number;
  widthPx: number;
  heightPx: number;
}) {
  const emu = (pixels: number) => Math.round(pixels * 9525);
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>${input.column}</xdr:col><xdr:colOff>${emu(input.columnOffsetPx)}</xdr:colOff><xdr:row>${input.row}</xdr:row><xdr:rowOff>${emu(input.rowOffsetPx)}</xdr:rowOff></xdr:from><xdr:ext cx="${emu(input.widthPx)}" cy="${emu(input.heightPx)}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${input.objectId}" name="${input.name}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${input.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(input.widthPx)}" cy="${emu(input.heightPx)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
}

function addDrawingImage(
  files: Record<string, Uint8Array>,
  drawingNumber: number,
  image: AdvancedDocumentImage,
  anchor: Omit<Parameters<typeof pictureAnchorXml>[0], "relationshipId" | "objectId">
) {
  ensureImageContentType(files, image.extension);
  const drawingPath = `xl/drawings/drawing${drawingNumber}.xml`;
  const relsPath = `xl/drawings/_rels/drawing${drawingNumber}.xml.rels`;
  const drawing = loadXml(files, drawingPath);
  const rels = loadXml(files, relsPath);
  const relationshipId = nextRelationshipId(rels.$);
  const mediaName = `goodjob-${drawingNumber}-${anchor.name.replace(/[^A-Za-z0-9_-]/g, "-")}.${image.extension}`;
  files[`xl/media/${mediaName}`] = image.data;
  const relationshipTag = xmlNode(rels.$, "Relationship");
  rels.$(xmlTag("Relationships")).append(rels.$(`<${relationshipTag}></${relationshipTag}>`)
    .attr("Id", relationshipId)
    .attr("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image")
    .attr("Target", `../media/${mediaName}`));
  const objectId = nextDrawingObjectId(drawing.$);
  drawing.$.root().children().first().append(pictureAnchorXml({ ...anchor, relationshipId, objectId }));
  rels.save();
  drawing.save();
}

interface DrawingPictureContext {
  column: number;
  row: number;
  name: string;
  description: string;
}

function removeDrawingPictures(
  files: Record<string, Uint8Array>,
  drawingNumber: number,
  shouldRemove: (context: DrawingPictureContext) => boolean
) {
  const drawingPath = `xl/drawings/drawing${drawingNumber}.xml`;
  const relsPath = `xl/drawings/_rels/drawing${drawingNumber}.xml.rels`;
  if (!files[drawingPath]) return;
  const drawing = loadXml(files, drawingPath);
  const rels = files[relsPath] ? loadXml(files, relsPath) : null;
  const removedRelationshipIds = new Set<string>();
  drawing.$("xdr\\:pic, pic").each((_, element) => {
    const picture = drawing.$(element);
    const anchor = picture.parent();
    const properties = picture.find("xdr\\:cNvPr, cNvPr").first();
    const anchorColumn = Number(anchor.find("xdr\\:from xdr\\:col, from col").first().text() || 0);
    const anchorRow = Number(anchor.find("xdr\\:from xdr\\:row, from row").first().text() || 0);
    if (!shouldRemove({
      column: anchorColumn,
      row: anchorRow,
      name: String(properties.attr("name") || ""),
      description: String(properties.attr("descr") || "")
    })) return;
    const relationshipId = String(picture.find("a\\:blip, blip").first().attr("r:embed") || "");
    if (relationshipId) removedRelationshipIds.add(relationshipId);
    if (anchor.is("xdr\\:oneCellAnchor, oneCellAnchor") || anchor.is("xdr\\:twoCellAnchor, twoCellAnchor") || anchor.is("xdr\\:absoluteAnchor, absoluteAnchor")) anchor.remove();
    else picture.remove();
  });
  drawing.save();
  if (!rels || !removedRelationshipIds.size) return;
  removedRelationshipIds.forEach((relationshipId) => {
    if (drawing.$(`a\\:blip[r\\:embed="${relationshipId}"], blip[r\\:embed="${relationshipId}"]`).length) return;
    const relationship = rels.$(xmlAttrTag("Relationship", `Id="${relationshipId}"`)).first();
    const target = String(relationship.attr("Target") || "");
    relationship.remove();
    if (target) {
      const sourcePart = relsPath.replace("/_rels/", "/").replace(/\.rels$/u, "");
      const mediaPath = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), target));
      delete files[mediaPath];
    }
  });
  rels.save();
}

function removeExistingDrawingPictures(files: Record<string, Uint8Array>, drawingNumber: number, beforeRow?: number) {
  removeDrawingPictures(files, drawingNumber, ({ row }) => beforeRow === undefined || row < beforeRow);
}

function removeLegacyTemplateBranding(templateId: string, files: Record<string, Uint8Array>) {
  if (templateId === "packing-list-sample") {
    removeDrawingPictures(files, 1, ({ column, description }) => column >= 20 || /logo/iu.test(description));
  }
  if (templateId === "supplier-work-order-zh") {
    removeDrawingPictures(files, 1, () => true);
  }
}

function sanitizeWorkbookBranding(files: Record<string, Uint8Array>) {
  Object.entries(files).forEach(([filePath, bytes]) => {
    if (!filePath.endsWith(".xml")) return;
    const source = strFromU8(bytes);
    const sanitized = source
      .replace(/ProtoTech Machining Co\., Ltd\./giu, "GoodJob CRM")
      .replace(/ProtoTech/giu, "GoodJob")
      .replace(/©\s*2013\s+Spreadsheet123(?:\.com)?(?:\s+LTD)?(?:\.\s*All rights reserved)?/giu, "Generated by GoodJob CRM")
      .replace(/Spreadsheet123(?:\.com)?(?:\s+LTD)?/giu, "GoodJob CRM")
      .replace(/VNN\.R9/giu, "GoodJob CRM")
      .replace(/huawei/giu, "GoodJob CRM");
    if (sanitized !== source) files[filePath] = strToU8(sanitized);
  });
  const corePath = "docProps/core.xml";
  if (files[corePath]) {
    const core = loadXml(files, corePath);
    const setProperty = (selector: string, value: string) => {
      const node = core.$(selector).first();
      if (node.length) node.text(value);
    };
    setProperty("dc\\:creator, creator", "GoodJob CRM");
    setProperty("cp\\:lastModifiedBy, lastModifiedBy", "GoodJob CRM");
    setProperty("dc\\:title, title", "GoodJob CRM Trade Document");
    setProperty("dc\\:description, description", "Generated by GoodJob CRM");
    core.save();
  }
}

function removeUnreferencedMedia(files: Record<string, Uint8Array>) {
  const referenced = new Set<string>();
  Object.entries(files).forEach(([filePath, bytes]) => {
    if (!filePath.endsWith(".rels")) return;
    const $ = cheerio.load(strFromU8(bytes), { xmlMode: true });
    const sourcePart = filePath.replace("/_rels/", "/").replace(/\.rels$/u, "");
    $("Relationship").each((_, element) => {
      const target = String($(element).attr("Target") || "");
      if (!target || /^[a-z]+:/iu.test(target)) return;
      referenced.add(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), target)));
    });
  });
  Object.keys(files).forEach((filePath) => {
    if (filePath.startsWith("xl/media/") && !referenced.has(filePath)) delete files[filePath];
  });
}

function setRowHeight(files: Record<string, Uint8Array>, sheetNumber: number, rowNumber: number, heightPoints: number) {
  const xml = loadXml(files, `xl/worksheets/sheet${sheetNumber}.xml`);
  rowNode(xml.$, rowNumber).attr("ht", String(heightPoints)).attr("customHeight", "1");
  xml.save();
}

function shrinkCellsToFit(files: Record<string, Uint8Array>, $: XmlApi, references: string[]) {
  const styles = loadXml(files, "xl/styles.xml");
  const cellFormats = styles.$(xmlTag("cellXfs"));
  const cache = new Map<string, string>();
  references.forEach((reference) => {
    const cell = cellNode($, reference);
    const sourceIndex = cell.attr("s") || "0";
    let targetIndex = cache.get(sourceIndex);
    if (!targetIndex) {
      const source = cellFormats.children(xmlTag("xf")).eq(Number(sourceIndex));
      if (!source.length) return;
      const clone = source.clone().attr("applyAlignment", "1");
      let alignment = clone.children(xmlTag("alignment")).first();
      if (!alignment.length) {
        const tag = xmlNode(styles.$, "alignment");
        clone.append(styles.$(`<${tag}></${tag}>`));
        alignment = clone.children(xmlTag("alignment")).first();
      }
      alignment.attr("shrinkToFit", "1");
      targetIndex = String(cellFormats.children(xmlTag("xf")).length);
      cellFormats.append(clone);
      cache.set(sourceIndex, targetIndex);
    }
    cell.attr("s", targetIndex);
  });
  cellFormats.attr("count", String(cellFormats.children(xmlTag("xf")).length));
  styles.save();
}

function wrapCells(files: Record<string, Uint8Array>, $: XmlApi, references: string[]) {
  const styles = loadXml(files, "xl/styles.xml");
  const cellFormats = styles.$(xmlTag("cellXfs"));
  const cache = new Map<string, string>();
  references.forEach((reference) => {
    const cell = cellNode($, reference);
    const sourceIndex = cell.attr("s") || "0";
    let targetIndex = cache.get(sourceIndex);
    if (!targetIndex) {
      const source = cellFormats.children(xmlTag("xf")).eq(Number(sourceIndex));
      if (!source.length) return;
      const clone = source.clone().attr("applyAlignment", "1");
      let alignment = clone.children(xmlTag("alignment")).first();
      if (!alignment.length) {
        const tag = xmlNode(styles.$, "alignment");
        clone.append(styles.$(`<${tag}></${tag}>`));
        alignment = clone.children(xmlTag("alignment")).first();
      }
      alignment.attr("wrapText", "1").attr("vertical", "center").removeAttr("shrinkToFit");
      targetIndex = String(cellFormats.children(xmlTag("xf")).length);
      cellFormats.append(clone);
      cache.set(sourceIndex, targetIndex);
    }
    cell.attr("s", targetIndex);
  });
  cellFormats.attr("count", String(cellFormats.children(xmlTag("xf")).length));
  styles.save();
}

interface TemplateImageSheetLayout {
  sheetNumber: number;
  drawingNumber: number;
  removeHeaderPicturesBeforeRow?: number;
  logo?: { column: number; row: number; columnOffsetPx: number; rowOffsetPx: number; maxWidthPx: number; maxHeightPx: number; zoneWidthPx?: number; zoneHeightPx?: number };
  product?: { column: number; startRow: number; cellWidthPx: number; cellHeightPx: number; maxWidthPx: number; maxHeightPx: number; excelStartRow: number; rowHeightPoints?: number };
  stamp?: { column: number; row: number; columnOffsetPx: number; rowOffsetPx: number; maxWidthPx: number; maxHeightPx: number; zoneWidthPx?: number; zoneHeightPx?: number; shiftByDelta?: boolean };
  signature?: { column: number; row: number; columnOffsetPx: number; rowOffsetPx: number; maxWidthPx: number; maxHeightPx: number; shiftByDelta?: boolean };
}

const TEMPLATE_IMAGE_LAYOUTS: Record<string, TemplateImageSheetLayout[]> = {
  "packing-list-sample": [{
    sheetNumber: 1, drawingNumber: 1, removeHeaderPicturesBeforeRow: 3,
    logo: { column: 0, row: 0, columnOffsetPx: 4, rowOffsetPx: 2, maxWidthPx: 70, maxHeightPx: 20, zoneWidthPx: 70, zoneHeightPx: 20 },
    product: { column: 2, startRow: 7, cellWidthPx: 86, cellHeightPx: 84, maxWidthPx: 72, maxHeightPx: 68, excelStartRow: 8 },
    stamp: { column: 2, row: 19, columnOffsetPx: 8, rowOffsetPx: 16, maxWidthPx: 68, maxHeightPx: 68, shiftByDelta: true },
    signature: { column: 1, row: 20, columnOffsetPx: 8, rowOffsetPx: 10, maxWidthPx: 100, maxHeightPx: 34, shiftByDelta: true }
  }],
  "proforma-invoice-dual-currency": [1, 2].map((sheetNumber) => ({
    sheetNumber, drawingNumber: sheetNumber, removeHeaderPicturesBeforeRow: 8,
    logo: { column: 0, row: 3, columnOffsetPx: 34, rowOffsetPx: 2, maxWidthPx: 190, maxHeightPx: 42 },
    product: { column: 2, startRow: 16, cellWidthPx: 100, cellHeightPx: 60, maxWidthPx: 90, maxHeightPx: 50, excelStartRow: 17 },
    stamp: { column: 0, row: 38, columnOffsetPx: 42, rowOffsetPx: 1, maxWidthPx: 82, maxHeightPx: 74, shiftByDelta: true },
    signature: { column: 2, row: 39, columnOffsetPx: 10, rowOffsetPx: 5, maxWidthPx: 115, maxHeightPx: 34, shiftByDelta: true }
  })),
  "proforma-invoice-variable-base": [1, 2].map((sheetNumber) => ({
    sheetNumber, drawingNumber: sheetNumber, removeHeaderPicturesBeforeRow: 8,
    logo: { column: 0, row: 3, columnOffsetPx: 34, rowOffsetPx: 2, maxWidthPx: 190, maxHeightPx: 42 },
    product: { column: 2, startRow: 16, cellWidthPx: 100, cellHeightPx: 60, maxWidthPx: 90, maxHeightPx: 50, excelStartRow: 17 },
    stamp: { column: 0, row: 38, columnOffsetPx: 42, rowOffsetPx: 1, maxWidthPx: 82, maxHeightPx: 74, shiftByDelta: true },
    signature: { column: 2, row: 39, columnOffsetPx: 10, rowOffsetPx: 5, maxWidthPx: 115, maxHeightPx: 34, shiftByDelta: true }
  })),
  "quotation-blue": [{
    sheetNumber: 1, drawingNumber: 1, removeHeaderPicturesBeforeRow: 3,
    logo: { column: 6, row: 0, columnOffsetPx: 8, rowOffsetPx: 3, maxWidthPx: 124, maxHeightPx: 32 },
    product: { column: 3, startRow: 14, cellWidthPx: 92, cellHeightPx: 86, maxWidthPx: 78, maxHeightPx: 72, excelStartRow: 15 },
    stamp: { column: 6, row: 42, columnOffsetPx: 8, rowOffsetPx: 2, maxWidthPx: 70, maxHeightPx: 52 },
    signature: { column: 4, row: 43, columnOffsetPx: 8, rowOffsetPx: 5, maxWidthPx: 110, maxHeightPx: 32 }
  }],
  "universal-trade-document": [{
    sheetNumber: 1, drawingNumber: 1, removeHeaderPicturesBeforeRow: 3,
    logo: { column: 6, row: 0, columnOffsetPx: 8, rowOffsetPx: 3, maxWidthPx: 124, maxHeightPx: 32 },
    product: { column: 3, startRow: 14, cellWidthPx: 92, cellHeightPx: 86, maxWidthPx: 78, maxHeightPx: 72, excelStartRow: 15 },
    stamp: { column: 6, row: 42, columnOffsetPx: 8, rowOffsetPx: 2, maxWidthPx: 70, maxHeightPx: 52, shiftByDelta: true },
    signature: { column: 4, row: 43, columnOffsetPx: 8, rowOffsetPx: 5, maxWidthPx: 110, maxHeightPx: 32, shiftByDelta: true }
  }],
  "supplier-work-order-zh": [{
    sheetNumber: 1, drawingNumber: 1, removeHeaderPicturesBeforeRow: 3,
    logo: { column: 6, row: 0, columnOffsetPx: 8, rowOffsetPx: 2, maxWidthPx: 118, maxHeightPx: 24 },
    product: { column: 3, startRow: 6, cellWidthPx: 110, cellHeightPx: 18, maxWidthPx: 42, maxHeightPx: 16, excelStartRow: 7 },
    stamp: { column: 6, row: 24, columnOffsetPx: 22, rowOffsetPx: 10, maxWidthPx: 64, maxHeightPx: 50 },
    signature: { column: 4, row: 25, columnOffsetPx: 8, rowOffsetPx: 4, maxWidthPx: 108, maxHeightPx: 30 }
  }],
  "purchase-contract-blue-gray": [{
    sheetNumber: 1, drawingNumber: 1,
    logo: { column: 7, row: 1, columnOffsetPx: 4, rowOffsetPx: 1, maxWidthPx: 112, maxHeightPx: 28 },
    stamp: { column: 2, row: 47, columnOffsetPx: 8, rowOffsetPx: 6, maxWidthPx: 64, maxHeightPx: 46, shiftByDelta: true },
    signature: { column: 5, row: 48, columnOffsetPx: 6, rowOffsetPx: 4, maxWidthPx: 110, maxHeightPx: 32, shiftByDelta: true }
  }]
};

const TEMPLATE_POSITION_CELL_WIDTH_PX = 80;
const TEMPLATE_POSITION_ROW_HEIGHT_PX = 20;

function positionedAssetAnchor(
  base: { column: number; row: number; columnOffsetPx: number; rowOffsetPx: number; maxWidthPx: number; maxHeightPx: number; zoneWidthPx?: number; zoneHeightPx?: number },
  image: AdvancedDocumentImage,
  placement: DocumentAssetPlacement | undefined,
  rowDelta = 0
) {
  const baseSize = fitImage(image, base.maxWidthPx, base.maxHeightPx);
  const normalized = placement || { horizontal: "template", vertical: "template", offsetX: 0, offsetY: 0, scale: 100 };
  if (normalized.horizontal === "template" && normalized.vertical === "template" && normalized.offsetX === 0 && normalized.offsetY === 0 && normalized.scale === 100) {
    return { ...base, row: base.row + rowDelta, widthPx: baseSize.width, heightPx: baseSize.height };
  }
  const zoneWidth = Math.max(base.maxWidthPx, base.zoneWidthPx || base.maxWidthPx + 80);
  const zoneHeight = Math.max(base.maxHeightPx, base.zoneHeightPx || base.maxHeightPx + 30);
  const size = fitImage(
    image,
    Math.min(zoneWidth, Math.max(1, Math.round(base.maxWidthPx * normalized.scale / 100))),
    Math.min(zoneHeight, Math.max(1, Math.round(base.maxHeightPx * normalized.scale / 100)))
  );
  const x = normalized.horizontal === "right" ? zoneWidth - size.width : normalized.horizontal === "center" ? Math.round((zoneWidth - size.width) / 2) : 0;
  const y = normalized.vertical === "bottom" ? zoneHeight - size.height : normalized.vertical === "middle" ? Math.round((zoneHeight - size.height) / 2) : 0;
  const safeX = Math.max(0, Math.min(Math.max(0, zoneWidth - size.width), x + normalized.offsetX));
  const safeY = Math.max(0, Math.min(Math.max(0, zoneHeight - size.height), y + normalized.offsetY));
  const absoluteX = base.columnOffsetPx + safeX;
  const absoluteY = base.rowOffsetPx + safeY;
  return {
    column: base.column + Math.floor(absoluteX / TEMPLATE_POSITION_CELL_WIDTH_PX),
    row: base.row + rowDelta + Math.floor(absoluteY / TEMPLATE_POSITION_ROW_HEIGHT_PX),
    columnOffsetPx: absoluteX % TEMPLATE_POSITION_CELL_WIDTH_PX,
    rowOffsetPx: absoluteY % TEMPLATE_POSITION_ROW_HEIGHT_PX,
    widthPx: size.width,
    heightPx: size.height
  };
}

function addTemplateImages(
  templateId: string,
  files: Record<string, Uint8Array>,
  document: TradeDocument,
  assets: AdvancedDocumentAssets,
  deltas: number[]
) {
  const layouts = TEMPLATE_IMAGE_LAYOUTS[templateId] || [];
  layouts.forEach((layout, layoutIndex) => {
    if (!assets.logo && !assets.stamp && !assets.signature && !Object.keys(assets.productImages || {}).length) return;
    ensureWorksheetDrawing(files, layout.sheetNumber, layout.drawingNumber);
    if (assets.logo && layout.logo) {
      removeExistingDrawingPictures(files, layout.drawingNumber, layout.removeHeaderPicturesBeforeRow);
      const anchor = positionedAssetAnchor(layout.logo, assets.logo, assets.logoPlacement);
      addDrawingImage(files, layout.drawingNumber, assets.logo, {
        name: `GoodJobLetterheadLogo${layout.sheetNumber}`,
        column: anchor.column, row: anchor.row,
        columnOffsetPx: anchor.columnOffsetPx, rowOffsetPx: anchor.rowOffsetPx,
        widthPx: anchor.widthPx, heightPx: anchor.heightPx
      });
    }
    if (layout.product) {
      document.items.forEach((item, index) => {
        const image = assets.productImages?.[item.id || item.productId || `item-${index + 1}`]
          || (item.productId ? assets.productImages?.[item.productId] : undefined);
        if (!image) return;
        if (layout.product?.rowHeightPoints) setRowHeight(files, layout.sheetNumber, layout.product.excelStartRow + index, layout.product.rowHeightPoints);
        const size = fitImage(image, layout.product!.maxWidthPx, layout.product!.maxHeightPx);
        addDrawingImage(files, layout.drawingNumber, image, {
          name: `GoodJobProduct${index + 1}`,
          column: layout.product!.column,
          row: layout.product!.startRow + index,
          columnOffsetPx: Math.max(0, Math.round((layout.product!.cellWidthPx - size.width) / 2)),
          rowOffsetPx: Math.max(0, Math.round((layout.product!.cellHeightPx - size.height) / 2)),
          widthPx: size.width, heightPx: size.height
        });
      });
    }
    if (assets.stamp && layout.stamp) {
      const delta = layout.stamp.shiftByDelta ? (deltas[layoutIndex] || 0) : 0;
      const anchor = positionedAssetAnchor(layout.stamp, assets.stamp, assets.stampPlacement, delta);
      addDrawingImage(files, layout.drawingNumber, assets.stamp, {
        name: `GoodJobStamp${layout.sheetNumber}`,
        column: anchor.column, row: anchor.row,
        columnOffsetPx: anchor.columnOffsetPx, rowOffsetPx: anchor.rowOffsetPx,
        widthPx: anchor.widthPx, heightPx: anchor.heightPx
      });
    }
    if (assets.signature && layout.signature) {
      const size = fitImage(assets.signature, layout.signature.maxWidthPx, layout.signature.maxHeightPx);
      addDrawingImage(files, layout.drawingNumber, assets.signature, {
        name: `GoodJobSignature${layout.sheetNumber}`,
        column: layout.signature.column,
        row: layout.signature.row + (layout.signature.shiftByDelta ? (deltas[layoutIndex] || 0) : 0),
        columnOffsetPx: layout.signature.columnOffsetPx,
        rowOffsetPx: layout.signature.rowOffsetPx,
        widthPx: size.width,
        heightPx: size.height
      });
    }
  });
}

function buildVariablePiSheet(files: Record<string, Uint8Array>, document: TradeDocument, sheetPath: string) {
  const xml = loadXml(files, sheetPath);
  const { $ } = xml;
  const templateRow = variableItemRow($);
  const itemStart = Number(templateRow.attr("r") || 0);
  if (!itemStart) throw new Error("变量模板缺少 {{item.index}} 明细行");
  const count = Math.max(1, document.items.length);
  const delta = expandRows($, itemStart, 1, count);

  document.items.forEach((item, index) => {
    const row = itemStart + index;
    const rowCells = rowNode($, row).children(xmlTag("c"));
    const amountReference = rowCells.filter((_, cell) => inlineCellText($, $(cell)).trim() === "{{item.amount}}").first().attr("r") || "";
    replaceCellPlaceholders($, rowCells, itemPlaceholderValues(item, index));
    if (amountReference) setFormula($, amountReference, `G${row}*F${row}`, Number(item.quantity || 0) * Number(item.unitPrice || 0));
  });

  const subtotalReference = variableCellReference($, "document.subtotal");
  const shippingReference = variableCellReference($, "document.shippingCost");
  const totalReference = variableCellReference($, "document.total");
  replaceCellPlaceholders($, $(xmlTag("c")), documentPlaceholderValues(document));
  const lastItemRow = itemStart + document.items.length - 1;
  if (subtotalReference) setFormula($, subtotalReference, `SUM(H${itemStart}:H${lastItemRow})`, total(document));
  if (shippingReference) setNumber($, shippingReference, 0);
  if (totalReference && subtotalReference && shippingReference) {
    setFormula($, totalReference, `SUM(${subtotalReference}:${shippingReference})`, total(document));
  }
  updateVariableTemplatePageBreaks($, delta);
  xml.save();
  return delta;
}

function buildVariableProformaInvoice(files: Record<string, Uint8Array>, document: TradeDocument) {
  const deltas = [
    buildVariablePiSheet(files, document, "xl/worksheets/sheet1.xml"),
    buildVariablePiSheet(files, document, "xl/worksheets/sheet2.xml")
  ];
  updateVariableTemplatePrintAreas(files, deltas);
  return deltas;
}

function assertNoUnresolvedPlaceholders(files: Record<string, Uint8Array>) {
  const unresolved = new Set<string>();
  for (const [filePath, bytes] of Object.entries(files)) {
    if (!filePath.endsWith(".xml") && !filePath.endsWith(".rels")) continue;
    for (const match of strFromU8(bytes).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) unresolved.add(match[1].trim());
  }
  if (unresolved.size) throw new Error(`模板存在未识别变量：${[...unresolved].join("、")}`);
}

function writeItems(
  $: XmlApi,
  document: TradeDocument,
  startRow: number,
  capacity: number,
  writer: (item: TradeDocumentItem, index: number, row: number) => void
) {
  for (let index = 0; index < capacity; index += 1) {
    const item = document.items[index];
    const row = startRow + index;
    if (item) writer(item, index, row);
    else writer({ id: "", product: "", model: "", material: "", finish: "", hsCode: "", quantity: 0, unit: "", unitPrice: 0, originCountry: "", weightKg: 0, packageCount: 0 }, index, row);
  }
}

function updatePackingListLayout(files: Record<string, Uint8Array>, delta: number) {
  if (!delta) return;
  const workbook = loadXml(files, "xl/workbook.xml");
  workbook.$(xmlTag("definedName")).each((_, element) => {
    const node = workbook.$(element);
    if (node.attr("name") === "_xlnm.Print_Area") {
      node.text(shiftReference(node.text(), 11, delta));
    }
  });
  if (!workbook.$(`${xmlTag("definedName")}[name="_xlnm.Print_Titles"]`).length) {
    const tag = xmlNode(workbook.$, "definedName");
    workbook.$(xmlTag("definedNames")).append(
      workbook.$(`<${tag}></${tag}>`)
        .attr("name", "_xlnm.Print_Titles")
        .attr("localSheetId", "0")
        .text("'PACKING LIST (Sample Shipment)'!$7:$7")
    );
  }
  workbook.save();

  const drawingPath = "xl/drawings/drawing1.xml";
  if (!files[drawingPath]) return;
  const drawing = loadXml(files, drawingPath);
  drawing.$("xdr\\:from xdr\\:row, from row, xdr\\:to xdr\\:row, to row")
    .each((_, element) => {
      const row = drawing.$(element);
      const current = Number(row.text() || 0);
      if (current >= 12) row.text(String(current + delta));
    });
  drawing.save();
}

function buildPackingList(files: Record<string, Uint8Array>, document: TradeDocument) {
  const xml = loadXml(files, "xl/worksheets/sheet1.xml");
  const { $ } = xml;
  const count = Math.max(1, document.items.length);
  const delta = expandRows($, 8, 3, count);
  setText($, "A2", `${document.seller || "Seller Company"}               PACKING LIST`);
  setText($, "A4", `Attention:\n${document.buyerContact || ""}\n${document.buyer || "Buyer Company"}\n${document.buyerAddress || ""}`);
  setText($, "D4", `PO#\n${document.number}`);
  setText($, "E4", `PO DATE:\n${excelDate(document.issueDate)}`);
  setText($, "D5", `DOCUMENT#\n${document.number}`);
  setText($, "E5", `SHIPPING DATE:\n${excelDate(document.validityDate || document.issueDate)}`);
  setText($, "D6", `Notes: ${document.notes || ""}`);
  writeItems($, document, 8, count, (item, index, row) => {
    setNumber($, `A${row}`, item.product ? index + 1 : 0);
    setText($, `B${row}`, item.product);
    setText($, `C${row}`, "");
    setText($, `D${row}`, item.model || item.hsCode);
    setText($, `E${row}`, item.originCountry);
    setNumber($, `F${row}`, Number(item.quantity || 0));
  });
  const totalRow = 11 + delta;
  const packingRow = 13 + delta;
  setFormula($, `F${totalRow}`, `SUM(F8:F${7 + count})`, document.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0));
  setText($, `A${packingRow}`, `Box Type: Carton\nBox Qty: ${packageCount(document)}\nShipping: ${document.shippingMethod || ""}\nTotal Gross Weight: ${grossWeight(document)} KG`);
  setText($, `D${packingRow}`, "");
  $(xmlTag("rowBreaks")).find(xmlTag("brk")).each((_, element) => {
    const node = $(element);
    const current = Number(node.attr("id") || 0);
    if (current >= 11) node.attr("id", String(current + delta));
  });
  xml.save();
  updatePackingListLayout(files, delta);
  return [delta];
}

function buildPiSheet(files: Record<string, Uint8Array>, document: TradeDocument, sheetPath: string, euro: boolean) {
  const xml = loadXml(files, sheetPath);
  const { $ } = xml;
  const count = Math.max(1, document.items.length);
  const delta = expandRows($, 17, 1, count);
  setText($, "A1", document.seller || "Seller Company");
  setText($, "H4", excelDate(document.issueDate));
  setText($, "H5", excelDate(document.validityDate));
  setText($, "H6", document.number);
  setText($, "H7", "");
  setText($, "B10", document.buyerContact);
  setText($, "B11", document.buyer);
  setText($, "B12", document.buyerAddress);
  setText($, "B13", "");
  setText($, "B14", document.buyerContact);
  setText($, "G11", document.buyer);
  setText($, "G12", document.buyerAddress);
  writeItems($, document, 17, count, (item, index, row) => {
    const lineTotal = Number(item.quantity || 0) * Number(item.unitPrice || 0);
    setNumber($, `A${row}`, item.product ? index + 1 : 0);
    setText($, `B${row}`, item.product);
    setText($, `C${row}`, "");
    setText($, `D${row}`, item.model || item.hsCode);
    setText($, `E${row}`, item.originCountry);
    setNumber($, `F${row}`, Number(item.quantity || 0));
    setNumber($, `G${row}`, Number(item.unitPrice || 0));
    setFormula($, `H${row}`, `G${row}*F${row}`, lineTotal);
  });
  const lastItem = 16 + count;
  const baseNotes = euro ? 18 : 19;
  const baseSubtotal = euro ? 19 : 20;
  const baseBank = euro ? 20 : 21;
  const baseShipping = euro ? 20 : 21;
  const baseTotal = euro ? 21 : 22;
  setText($, `A${baseNotes + delta}`, `Notes: ${document.notes || ""}`);
  setText($, `A${baseBank + delta}`, document.bankInfo || "Bank information from CRM");
  setFormula($, `H${baseSubtotal + delta}`, `SUM(H17:H${lastItem})`, total(document));
  setText($, `G${baseShipping + delta}`, document.shippingMethod || "Shipping");
  setNumber($, `H${baseShipping + delta}`, 0);
  setFormula($, `H${baseTotal + delta}`, `SUM(H${baseSubtotal + delta}:H${baseShipping + delta})`, total(document));
  const infoRow = euro ? 33 : 34;
  setText($, `B${infoRow + delta}`, document.number);
  setText($, `B${infoRow + 1 + delta}`, excelDate(document.issueDate));
  setText($, `B${infoRow + 2 + delta}`, excelDate(document.validityDate));
  setText($, `B${infoRow + 3 + delta}`, document.paymentTerm);
  setText($, `D${infoRow + delta}`, document.shippingMethod);
  setText($, `D${infoRow + 1 + delta}`, document.incoterm);
  setText($, `H${infoRow + 1 + delta}`, document.buyerContact);
  setText($, `H${infoRow + 2 + delta}`, document.items[0]?.originCountry || "China");
  const footerRow = euro ? 42 : 43;
  setText($, `A${footerRow + delta}`, `Should you have any enquiries concerning this invoice, please contact ${document.seller}`);
  setText($, `A${footerRow + 1 + delta}`, document.sellerAddress);
  updateVariableTemplatePageBreaks($, delta);
  xml.save();
  return delta;
}

function buildProformaInvoice(files: Record<string, Uint8Array>, document: TradeDocument) {
  const deltas = [
    buildPiSheet(files, document, "xl/worksheets/sheet1.xml", true),
    buildPiSheet(files, document, "xl/worksheets/sheet2.xml", false)
  ];
  updateVariableTemplatePrintAreas(files, deltas);
  return deltas;
}

function buildQuote(files: Record<string, Uint8Array>, document: TradeDocument) {
  const xml = loadXml(files, "xl/worksheets/sheet1.xml");
  const { $ } = xml;
  setText($, "A1", document.seller || "Seller Company");
  setText($, "A2", document.sellerAddress || "Seller Address");
  setText($, "I3", excelDate(document.issueDate));
  setText($, "I4", excelDate(document.validityDate));
  setText($, "I5", document.number);
  setText($, "A8", `${document.buyer}\n${document.buyerAddress}\n${document.buyerContact}`);
  setText($, "F8", `${document.title}\n${document.notes || ""}`);
  writeItems($, document, 15, 11, (item, index, row) => {
    const lineTotal = Number(item.quantity || 0) * Number(item.unitPrice || 0);
    setNumber($, `A${row}`, item.product ? index + 1 : 0);
    setText($, `B${row}`, item.model);
    setText($, `C${row}`, item.product);
    setText($, `D${row}`, "");
    setText($, `E${row}`, item.material || "");
    setText($, `F${row}`, item.finish || "");
    setNumber($, `G${row}`, Number(item.quantity || 0));
    setNumber($, `H${row}`, Number(item.unitPrice || 0));
    setFormula($, `I${row}`, `H${row}*G${row}`, lineTotal);
    for (const column of ["J", "K", "L", "M", "N", "O", "P"]) setText($, `${column}${row}`, "");
  });
  wrapCells(files, $, document.items.flatMap((_, index) => [`E${15 + index}`, `F${15 + index}`]));
  setFormula($, "I27", "SUM(I15:I25)", total(document));
  setText($, "A28", document.notes);
  setText($, "D37", document.incoterm);
  setText($, "D38", document.portLoading);
  setText($, "D39", document.portDischarge);
  setText($, "D40", document.currency);
  setText($, "D41", document.paymentTerm);
  setText($, "D42", document.validityDate ? `Valid until ${document.validityDate}` : "");
  setText($, "A43", `For enquiries, please contact ${document.seller}`);
  xml.save();
}

const ALL_TRADE_DOCUMENT_TYPES: TradeDocument["type"][] = [
  "PI", "CI", "CUSTOMS", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING"
];

function advancedDocumentTypeLabel(type: TradeDocument["type"]) {
  return ({
    PI: "Proforma Invoice", CI: "Commercial Invoice", CUSTOMS: "Customs Clearance Document",
    PL: "Packing List", CONTRACT: "Sales Contract", QUOTATION: "Quotation",
    COO: "Certificate of Origin", SHIPPING: "Shipping Advice"
  } as Record<TradeDocument["type"], string>)[type];
}

function updateUniversalDocumentPrintArea(files: Record<string, Uint8Array>, delta: number) {
  if (!delta) return;
  const workbook = loadXml(files, "xl/workbook.xml");
  workbook.$(xmlTag("definedName")).each((_, element) => {
    const node = workbook.$(element);
    if (node.attr("name") === "_xlnm.Print_Area") node.text(shiftReference(node.text(), 26, delta));
  });
  workbook.save();
}

function buildUniversalTradeDocument(files: Record<string, Uint8Array>, document: TradeDocument) {
  const xml = loadXml(files, "xl/worksheets/sheet1.xml");
  const { $ } = xml;
  const rowCount = Math.max(11, document.items.length);
  const delta = expandRows($, 15, 11, rowCount);
  const totalRow = 27 + delta;
  const notesRow = 28 + delta;
  const typeLabel = advancedDocumentTypeLabel(document.type);
  setText($, "A1", document.seller || "Seller Company");
  setText($, "A2", document.sellerAddress || "Seller Address");
  setText($, "H3", "Date");
  setText($, "I3", excelDate(document.issueDate));
  setText($, "H4", "Valid Until");
  setText($, "I4", excelDate(document.validityDate));
  setText($, "H5", "Document No.");
  setText($, "I5", document.number);
  setText($, "A7", "Customer");
  setText($, "F7", `${typeLabel} / Description`);
  setText($, "A8", `${document.buyer}\n${document.buyerAddress}\n${document.buyerContact}`);
  setText($, "F8", `${document.title}\n${document.notes || ""}`);
  setText($, "A14", "No.");
  setText($, "B14", "Model");
  setText($, "C14", "Description");
  setText($, "D14", "Image");
  setText($, "E14", "Material\nHS Code");
  setText($, "F14", "Finish\nOrigin");
  setText($, "G14", "Qty");
  setText($, "H14", "Unit Price");
  setText($, "I14", "Amount");
  writeItems($, document, 15, document.items.length, (item, index, row) => {
    const lineTotal = Number(item.quantity || 0) * Number(item.unitPrice || 0);
    setNumber($, `A${row}`, item.product ? index + 1 : 0);
    setText($, `B${row}`, item.model);
    setText($, `C${row}`, item.product);
    setText($, `D${row}`, "");
    setText($, `E${row}`, [item.material, item.hsCode].filter(Boolean).join("\n"));
    setText($, `F${row}`, [item.finish, item.originCountry].filter(Boolean).join("\n"));
    setNumber($, `G${row}`, Number(item.quantity || 0));
    setNumber($, `H${row}`, Number(item.unitPrice || 0));
    setFormula($, `I${row}`, `H${row}*G${row}`, lineTotal);
    for (const column of ["J", "K", "L", "M", "N", "O", "P"]) setText($, `${column}${row}`, "");
  });
  rowNode($, 14).attr("ht", "30").attr("customHeight", "1");
  wrapCells(files, $, ["E14", "F14", ...document.items.flatMap((_, index) => [`E${15 + index}`, `F${15 + index}`])]);
  for (let row = 15 + document.items.length; row <= 25 + delta; row += 1) {
    rowNode($, row).attr("hidden", "1");
    for (const column of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"]) setText($, `${column}${row}`, "");
  }
  setFormula($, `I${totalRow}`, `SUM(I15:I${14 + document.items.length})`, total(document));
  setText($, `A${notesRow}`, [
    document.notes,
    `Type: ${typeLabel}`,
    `Unit / package details: ${document.items.map((item) => `${item.product}: ${item.quantity} ${item.unit || "PCS"}, ${item.weightKg || 0} kg, ${item.packageCount || 0} pkg`).join("; ")}`
  ].filter(Boolean).join("\n"));
  setText($, `D${37 + delta}`, document.incoterm);
  setText($, `D${38 + delta}`, document.portLoading);
  setText($, `D${39 + delta}`, document.portDischarge);
  setText($, `D${40 + delta}`, document.currency);
  setText($, `D${41 + delta}`, document.paymentTerm);
  setText($, `D${42 + delta}`, document.shippingMethod);
  setText($, `A${43 + delta}`, `For enquiries, please contact ${document.seller}`);
  $(xmlTag("rowBreaks")).remove();
  xml.save();
  updateUniversalDocumentPrintArea(files, delta);
  return [delta];
}

function buildSupplierOrder(files: Record<string, Uint8Array>, document: TradeDocument) {
  const xml = loadXml(files, "xl/worksheets/sheet1.xml");
  const { $ } = xml;
  setText($, "B2", document.buyer || "供应商");
  setText($, "D2", document.number);
  setText($, "F2", document.issueDate);
  setText($, "H2", document.validityDate || "待确认");
  setText($, "B3", document.seller || "采购方");
  setText($, "D3", document.number);
  setText($, "F3", document.buyerContact);
  setText($, "H3", `v${document.revision || 1}`);
  writeItems($, document, 7, 8, (item, index, row) => {
    setNumber($, `A${row}`, item.product ? index + 1 : 0);
    setText($, `B${row}`, item.model);
    setText($, `C${row}`, item.product);
    setText($, `D${row}`, "");
    setText($, `E${row}`, item.hsCode);
    setText($, `F${row}`, item.originCountry);
    setNumber($, `G${row}`, Number(item.quantity || 0));
    setText($, `H${row}`, "");
  });
  setText($, "A15", `总备注：${document.notes || ""}`);
  shrinkCellsToFit(files, $, ["B2", "D2", "F2", "H2", "B3", "D3", "F3", "H3"]);
  xml.save();
}

function buildPurchaseContract(files: Record<string, Uint8Array>, document: TradeDocument) {
  const xml = loadXml(files, "xl/worksheets/sheet1.xml");
  const { $ } = xml;
  const count = Math.max(1, document.items.length);
  const delta = expandRows($, 8, 1, count);
  setText($, "A3", `合同编号：${document.number}`);
  setText($, "F3", `签订日期：${document.issueDate}`);
  setText($, "A4", `甲方（采购方）：${document.seller || "采购方"}    |    乙方（供货方）：${document.buyer || "供货方"}`);
  writeItems($, document, 8, count, (item, index, row) => {
    const lineTotal = Number(item.quantity || 0) * Number(item.unitPrice || 0);
    setNumber($, `A${row}`, item.product ? index + 1 : 0);
    setText($, `B${row}`, item.product);
    setText($, `C${row}`, item.model);
    setText($, `D${row}`, item.hsCode);
    setText($, `E${row}`, item.originCountry);
    setText($, `F${row}`, item.unit);
    setNumber($, `G${row}`, Number(item.quantity || 0));
    setNumber($, `H${row}`, Number(item.unitPrice || 0));
    setFormula($, `I${row}`, `G${row}*H${row}`, lineTotal);
  });
  setText($, `A${9 + delta}`, `合同总金额：${document.currency} ${total(document).toFixed(2)}`);
  setNumber($, `H${9 + delta}`, total(document));
  for (let row = 11; row <= 15; row += 1) setText($, `A${row + delta}`, "");
  setText($, `A${18 + delta}`, `乙方应严格按照甲方订单（合同编号：${document.number}）及双方确认资料供货。`);
  setText($, `A${22 + delta}`, document.sellerAddress || "交货地址待确认");
  setText($, `A${26 + delta}`, document.paymentTerm || "付款方式由双方另行确认。");
  setText($, `A${45 + delta}`, `单位名称：${document.seller || "采购方"}`);
  setText($, `F${45 + delta}`, `单位名称：${document.buyer || "供货方"}`);
  setText($, `A${46 + delta}`, "授权代表：");
  setText($, `F${46 + delta}`, `授权代表：${document.buyerContact || ""}`);
  setText($, `A${47 + delta}`, "联系电话：");
  setText($, `F${47 + delta}`, "联系电话：");
  setText($, `A${48 + delta}`, `单位地址：${document.sellerAddress || ""}`);
  setText($, `F${48 + delta}`, `单位地址：${document.buyerAddress || ""}`);
  setText($, `A${49 + delta}`, `签订日期：${document.issueDate}`);
  setText($, `F${49 + delta}`, `签订日期：${document.issueDate}`);
  xml.save();
  return [delta];
}

const INTERNAL_TEMPLATES: InternalTemplate[] = [
  {
    id: "universal-trade-document",
    name: "通用动态单据 Excel",
    category: "sales",
    description: "适用于导入、转换和手工创建的所有单据，直接使用当前单据数据并动态扩展商品明细。",
    fileName: "Trade-Document.xlsx",
    assetName: "quotation.xlsx",
    recommendedTypes: ALL_TRADE_DOCUMENT_TYPES,
    maxItems: 80,
    compatibility: "full",
    warnings: ["预览、修改和正式导出使用同一份已保存数据", "报关专属字段仍需在正式申报前人工复核"],
    assetCapabilities: ["letterhead", "productImages", "stamp", "signature"],
    build: buildUniversalTradeDocument
  },
  {
    id: "packing-list-sample",
    name: "样品订单装箱单",
    category: "shipping",
    description: "紫色标题带、包装汇总与动态商品明细，适合样品及批量发货。",
    fileName: "Packing-List.xlsx",
    assetName: "packing-list.xlsx",
    recommendedTypes: ["PL", "SHIPPING"],
    maxItems: 80,
    dynamicItems: true,
    compatibility: "full",
    warnings: ["支持抬头、产品示例图和盖章", "商品明细、合计与打印区域自动扩展"],
    assetCapabilities: ["letterhead", "productImages", "stamp", "signature"],
    build: buildPackingList
  },
  {
    id: "proforma-invoice-dual-currency",
    name: "形式发票（美元 / 欧元）",
    category: "sales",
    description: "保留美元和欧元两个工作表，自动填充客户、条款、银行信息并动态扩展商品明细。",
    fileName: "Proforma-Invoice.xlsx",
    assetName: "proforma-invoice.xlsx",
    recommendedTypes: ["PI", "CI"],
    maxItems: 80,
    compatibility: "full",
    warnings: ["支持抬头、产品示例图和盖章"],
    assetCapabilities: ["letterhead", "productImages", "stamp", "signature"],
    build: buildProformaInvoice
  },
  {
    id: "proforma-invoice-variable-base",
    name: "形式发票变量模板",
    category: "sales",
    description: "由原始 PI 复制的独立变量模板，按 {{变量}} 填充客户、条款和动态商品明细。",
    fileName: "Proforma-Invoice-Variable.xlsx",
    assetName: "proforma-invoice-variable-base.xlsx",
    recommendedTypes: ["PI", "CI"],
    maxItems: 80,
    compatibility: "full",
    warnings: ["支持抬头、产品示例图、盖章和动态明细", "变量基础模板独立维护，不影响原始 PI 模板"],
    assetCapabilities: ["letterhead", "productImages", "stamp", "signature"],
    build: buildVariableProformaInvoice
  },
  {
    id: "quotation-blue",
    name: "专业蓝色报价单",
    category: "sales",
    description: "深蓝商务报价版式，支持最多 11 项商品及金额公式。",
    fileName: "Quotation.xlsx",
    assetName: "quotation.xlsx",
    recommendedTypes: ["QUOTATION", "PI"],
    maxItems: 11,
    compatibility: "full",
    warnings: ["支持抬头、产品示例图和盖章", "内部核价辅助列已清空"],
    assetCapabilities: ["letterhead", "productImages", "stamp", "signature"],
    build: buildQuote
  },
  {
    id: "supplier-work-order-zh",
    name: "供应商加工任务单",
    category: "procurement",
    description: "中文生产协同模板，包含加工重点、生产确认、质检及包装要求。",
    fileName: "Supplier-Work-Order.xlsx",
    assetName: "supplier-work-order.xlsx",
    recommendedTypes: ["CONTRACT"],
    maxItems: 8,
    compatibility: "partial",
    warnings: ["支持抬头、产品示例图和盖章", "当前 CRM 尚无图纸版本、材料和表面处理专用字段"],
    assetCapabilities: ["letterhead", "productImages", "stamp", "signature"],
    build: buildSupplierOrder
  },
  {
    id: "purchase-contract-blue-gray",
    name: "专业蓝灰采购合同",
    category: "procurement",
    description: "包含物料明细、交付、质量、保密和签章条款的采购合同。",
    fileName: "Purchase-Contract.xlsx",
    assetName: "purchase-contract.xlsx",
    recommendedTypes: ["CONTRACT"],
    maxItems: 10,
    compatibility: "partial",
    warnings: ["支持抬头和盖章；原模板无商品图片栏", "正式签署前需人工复核合同条款"],
    assetCapabilities: ["letterhead", "stamp", "signature"],
    build: buildPurchaseContract
  }
];

export function listAdvancedDocumentTemplates(): AdvancedDocumentTemplate[] {
  return INTERNAL_TEMPLATES.map(({ assetName: _assetName, build: _build, ...template }) => template);
}

export async function exportAdvancedDocumentTemplate(templateId: string, document: TradeDocument, assets: AdvancedDocumentAssets = {}) {
  const template = INTERNAL_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new Error("Excel 模板不存在");
  if (!document.items.length) throw new Error("当前单据没有商品明细");
  if (!template.dynamicItems && document.items.length > template.maxItems) throw new Error(`该模板最多支持 ${template.maxItems} 项商品，当前为 ${document.items.length} 项`);
  const source = await readFile(path.join(TEMPLATE_ROOT, template.assetName));
  const files = unzipSync(new Uint8Array(source));
  const resolvedAssets = assets.logo ? assets : {
    ...assets,
    logo: {
      data: new Uint8Array(await readFile(path.join(TEMPLATE_ROOT, DEFAULT_LOGO_ASSET))),
      extension: "png" as const
    },
    logoPlacement: undefined
  };
  removeLegacyTemplateBranding(template.id, files);
  sanitizeWorkbookBranding(files);
  const deltas = template.build(files, document) || [];
  addTemplateImages(template.id, files, document, resolvedAssets, deltas);
  replaceRemainingPlaceholders(files, document);
  assertNoUnresolvedPlaceholders(files);
  removeUnreferencedMedia(files);
  return { template, buffer: Buffer.from(zipSync(files, { level: 6, mtime: new Date("2000-01-01T00:00:00.000Z") })) };
}
