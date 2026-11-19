import assert from "node:assert/strict";
import {
  collectLeadAdsFields,
  hasLeadAdsContent,
  leadAdsExternalId,
  leadAdsFieldKey,
  normalizeLeadAdsPayload
} from "./lead-ads-ingress.js";
import {
  generateLeadAdsIngressToken,
  leadAdsTokenMatches
} from "./lead-ads-ingress-settings.js";

// ---------------------------------------------------------------------------
// 广告表单入站：字段归一化 / 三种载荷结构 / 确定性去重 ID / 令牌比较
//
// 全部纯函数，不连库、不发请求。
// ---------------------------------------------------------------------------

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
}

// 1. 扁平对象（Make / Zapier 常见形态）
const flat = normalizeLeadAdsPayload({
  full_name: "Jane Doe",
  email: "Jane.Doe@Example.com",
  phone_number: "+1 (415) 555-0134",
  company: "Acme Scale Ltd",
  country: "United States",
  message: "Need a 200t truck scale, delivery to Long Beach.",
  leadgen_id: "1234567890",
  form_name: "Truck Scale Inquiry",
  campaign_name: "US Weighing Q4"
});
ok(flat.contact === "Jane Doe", "扁平载荷：联系人");
ok(flat.email === "Jane.Doe@Example.com", "扁平载荷：邮箱保留原文大小写");
ok(flat.phone.includes("415"), "扁平载荷：电话");
ok(flat.company === "Acme Scale Ltd", "扁平载荷：公司");
ok(flat.country === "United States", "扁平载荷：国家");
ok(flat.externalId === "fb:1234567890", "扁平载荷：优先使用平台 leadgen_id");
ok(flat.sourceCampaign === "US Weighing Q4", "扁平载荷：广告系列");
ok(flat.inquiryContent.includes("truck scale"), "扁平载荷：询盘内容");

// 2. Meta 原始 field_data 结构
const meta = normalizeLeadAdsPayload({
  field_data: [
    { name: "full_name", values: ["Li Wei"] },
    { name: "email", values: ["li.wei@factory.cn"] },
    { name: "phone_number", values: ["+86 138 0000 0000"] },
    { name: "company_name", values: ["Zhongshan Precision"] },
    { name: "country", values: ["China"] }
  ],
  form_id: "987654321",
  leadgen_id: "555000111"
});
ok(meta.contact === "Li Wei", "field_data：联系人");
ok(meta.email === "li.wei@factory.cn", "field_data：邮箱");
ok(meta.company === "Zhongshan Precision", "field_data：公司名别名");
ok(meta.externalId === "fb:555000111", "field_data：leadgen_id");
ok(!meta.inquiryContent.includes("values="), "field_data：不把 values/name 当业务字段收进询盘内容");
ok(!meta.inquiryContent.includes("Italy"), "field_data：国家字段不进其它答案");

// 3. Graph API 的 data 数组包装
const graph = normalizeLeadAdsPayload({
  data: [{
    field_data: [
      { name: "full_name", values: ["Marco Rossi"] },
      { name: "email", values: ["m.rossi@pesatura.it"] }
    ]
  }]
});
ok(graph.contact === "Marco Rossi", "data 包装：联系人");
ok(graph.email === "m.rossi@pesatura.it", "data 包装：邮箱");

// 4. 带空格 / 中文的键名
ok(leadAdsFieldKey("Full Name") === "fullname", "键归一化：空格");
ok(leadAdsFieldKey("公司名称") === "公司名称", "键归一化：中文保留");

const chinese = normalizeLeadAdsPayload({
  "公司名称": "宁波衡器有限公司",
  "联系人": "王磊",
  "邮箱": "sales@nb-scale.com",
  "电话": "0574-88886666",
  "需求": "需要 3 台电子秤"
});
ok(chinese.company === "宁波衡器有限公司", "中文键：公司");
ok(chinese.contact === "王磊", "中文键：联系人");
ok(chinese.phone.startsWith("0574"), "中文键：电话");

// 5. 邮箱非法不进 email 字段，但保留在备注里可追溯
const badEmail = normalizeLeadAdsPayload({
  email: "not-an-email",
  full_name: "Test User"
});
ok(badEmail.email === "", "非法邮箱不写入 email");
ok(badEmail.remark.includes("not-an-email"), "非法邮箱原文保留在备注");

// 6. 缺公司时回退：表单名 → 兜底文案
const byForm = normalizeLeadAdsPayload({ form_name: "Instagram 表单", email: "a@b.com" });
ok(byForm.company === "Instagram 表单", "缺公司：回退表单名");
const fallback = normalizeLeadAdsPayload({ email: "a@b.com" });
ok(fallback.company === "Facebook 广告表单线索", "缺公司：兜底文案");

// 7. 没有平台 ID 时，去重键必须确定且随邮箱变化
const bucketA = collectLeadAdsFields({ email: "same@example.com", phone_number: "+1 415 555 0100", form_id: "f1" });
const bucketB = collectLeadAdsFields({ email: "SAME@example.com", phone_number: "14155550100", form_id: "f1" });
const bucketC = collectLeadAdsFields({ email: "other@example.com", phone_number: "+1 415 555 0100", form_id: "f1" });
ok(leadAdsExternalId(bucketA) === leadAdsExternalId(bucketB), "去重键：大小写/格式差异视为同一条");
ok(leadAdsExternalId(bucketA) !== leadAdsExternalId(bucketC), "去重键：不同邮箱视为不同线索");
ok(leadAdsExternalId(bucketA).startsWith("fbhash:"), "去重键：无平台 ID 时用哈希");

// 8. 未识别字段进询盘内容，不丢
const extra = normalizeLeadAdsPayload({
  form_name: "Contact us",
  email: "buyer@example.com",
  "Annual volume": "500 units"
});
ok(extra.inquiryContent.includes("Annual volume"), "未识别字段进入询盘内容");

// 9. 令牌比较：常数时间且不接受空值
const token = generateLeadAdsIngressToken();
ok(token.startsWith("gjla_") && token.length >= 32, "令牌格式");
ok(leadAdsTokenMatches(token, token), "令牌：相同通过");
ok(!leadAdsTokenMatches(token, `${token}x`), "令牌：不同拒绝");
ok(!leadAdsTokenMatches(token, ""), "令牌：空值拒绝");
ok(!leadAdsTokenMatches("", ""), "令牌：未配置拒绝");

// 10. 空载荷防护：normalize 的 company 有兜底文案，必须单独判内容
ok(!hasLeadAdsContent({}), "空对象：无可用内容");
ok(!hasLeadAdsContent(null), "null：无可用内容");
ok(!hasLeadAdsContent({ leadgen_id: "123456" }), "只有 leadgen_id：无可用内容");
ok(!hasLeadAdsContent({ platform: "fb", form_id: "999" }), "只有元信息：无可用内容");
ok(hasLeadAdsContent({ email: "a@b.com" }), "仅邮箱：有内容");
ok(hasLeadAdsContent({ phone_number: "+39 02 1234" }), "仅电话：有内容");
ok(hasLeadAdsContent({ full_name: "Marco" }), "仅姓名：有内容");
ok(hasLeadAdsContent({ company_name: "ACME" }), "仅公司：有内容");
ok(hasLeadAdsContent({ message: "need pricing" }), "仅留言：有内容");
ok(normalizeLeadAdsPayload({}).company === "Facebook 广告表单线索", "空对象归一化会产出兜底公司名（因此不能只看 company）");

console.log(`lead-ads-ingress-test: ${passed} assertions passed`);
