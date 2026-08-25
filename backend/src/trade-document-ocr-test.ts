import assert from "node:assert/strict";
import { recognizeTradeDocument } from "./trade-document-ocr.js";
import type { AiModelConfig } from "./types.js";

const config: AiModelConfig = {
  id: "ai_test_ocr",
  provider: "openai",
  protocol: "openai-compatible",
  name: "OCR test model",
  baseUrl: "https://api.example.com/v1",
  model: "vision-test",
  apiKey: "test-key",
  enabled: true,
  temperature: 0.1,
  useLeadFinder: true,
  useWebsiteParse: true,
  useScoring: true,
  useEmailDraft: true,
  useExam: false,
  ownerId: "user_1",
  teamId: "team_1",
  updatedAt: new Date().toISOString()
};

const response = new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({
    confidence: 86,
    fieldConfidence: { seller: 94, "items.0.product": 91 },
    document: {
      type: "PI",
      title: "Proforma Invoice",
      number: "PI-1001",
      issueDate: "2026-08-23",
      seller: "Example Export Ltd.",
      buyer: "Example Buyer Inc.",
      currency: "USD",
      totalAmount: 250,
      items: [{ product: "LED Lamp", model: "L-01", material: "Aluminum", finish: "Anodized", quantity: 10, unit: "PCS", amount: 250 }]
    }
  }) } }]
}), { status: 200, headers: { "content-type": "application/json" } });

const parsed = await recognizeTradeDocument(
  "data:image/png;base64,iVBORw0KGgo=",
  "image/png",
  "pi-photo.png",
  config,
  async () => response.clone()
);

assert.equal(parsed.draft.type, "PI");
assert.equal(parsed.draft.number, "PI-1001");
assert.equal(parsed.draft.items.length, 1);
assert.equal(parsed.draft.items[0]?.material, "Aluminum");
assert.equal(parsed.draft.items[0]?.finish, "Anodized");
assert.equal(parsed.draft.items[0]?.unitPrice, 25);
assert.equal(parsed.declaredTotal, 250);
assert.equal(parsed.calculatedTotal, 250);
assert.ok(parsed.evidence.some((item) => item.field === "items.0.product" && item.confidence > 0.9));
assert.ok(parsed.warnings.some((item) => item.includes("单价由金额和数量计算")));
console.log("trade-document-ocr test passed");
