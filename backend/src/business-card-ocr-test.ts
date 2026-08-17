import assert from "node:assert/strict";
import {
  parseBusinessCardRecognition,
  recognizeBusinessCard
} from "./business-card-ocr.js";
import type { AiModelConfig } from "./types.js";

const config: AiModelConfig = {
  id: "ocr-test",
  provider: "openai",
  protocol: "openai-compatible",
  name: "OCR test",
  baseUrl: "https://api.example.com/v1",
  model: "vision-test",
  apiKey: "test-key",
  enabled: true,
  temperature: 0.1,
  useLeadFinder: false,
  useWebsiteParse: false,
  useScoring: false,
  useEmailDraft: false,
  useExam: false,
  ownerId: "u_test",
  teamId: "t_test",
  updatedAt: new Date().toISOString()
};

const parsed = parseBusinessCardRecognition(`\n\`\`\`json\n{
  "confidence": 93.6,
  "fields": {
    "company": " Example Lighting GmbH ",
    "contact": "Alex Buyer",
    "title": "Purchasing Manager",
    "email": "alex@example.test",
    "whatsapp": "+49 123 456",
    "wechat": "",
    "phone": "+49 123 456",
    "country": "Germany",
    "city": "Hamburg"
  }
}\n\`\`\``);
assert.equal(parsed.confidence, 94);
assert.equal(parsed.fields.company, "Example Lighting GmbH");
assert.equal(parsed.fields.contact, "Alex Buyer");

let requestBody: Record<string, any> | null = null;
const recognized = await recognizeBusinessCard(
  "data:image/png;base64,iVBORw0KGgo=",
  "image/png",
  config,
  async (_url, init) => {
    requestBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            confidence: 88,
            fields: { company: "Vision Co.", contact: "Mia", email: "mia@example.test" }
          })
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
);
assert.equal(recognized.fields.company, "Vision Co.");
assert.equal(recognized.fields.contact, "Mia");
assert.equal(recognized.confidence, 88);
assert.equal(requestBody?.messages?.[1]?.content?.[1]?.type, "image_url");

assert.throws(
  () => parseBusinessCardRecognition('{"confidence":90,"fields":{}}'),
  /未识别到清晰的名片信息/
);

console.log(JSON.stringify({
  ok: true,
  parsedCompany: parsed.fields.company,
  recognizedCompany: recognized.fields.company,
  imageInputSent: requestBody?.messages?.[1]?.content?.[1]?.type === "image_url"
}, null, 2));
