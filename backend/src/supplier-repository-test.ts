import assert from "node:assert/strict";
import {
  nextSupplierCode,
  normalizeLeadTimeDays,
  normalizeSupplierCode,
  normalizeSupplierGrade,
  normalizeSupplierInput,
  normalizeSupplierStatus,
  supplierCodeFromSequence,
  supplierCodeSequence,
  supplierDuplicateKey,
  supplierFromRow,
  type Supplier
} from "./supplier-repository.js";

// ---------------------------------------------------------------------------
// 供应商管理：入库归一 / 行映射 / 重复判定 / 交期兜底
//
// 全部纯函数，不连库。仓库类的 SQL 由「路由探针 + 真实增删改」验证。
// ---------------------------------------------------------------------------

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
}

function existing(): Supplier {
  return {
    id: "sup_1",
    ownerId: "u_1",
    teamId: "team_1",
    code: "SUP-0007",
    company: "Acme Sensors",
    companyFullName: "Acme Sensors GmbH",
    country: "Germany",
    category: "称重传感器",
    contact: "Hans",
    phone: "+49 1",
    email: "hans@acme.de",
    wechat: "",
    website: "https://acme.de",
    address: "Hamburg",
    paymentTerm: "T/T 30% deposit",
    leadTimeDays: 30,
    grade: "B",
    status: "active",
    source: "展会",
    remark: "合作 3 年",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z"
  };
}

// —— 新建：空白全名回落简称，避免单据抬头空白 ——
const created = normalizeSupplierInput({ company: "  Acme Sensors  " });
ok(created.company === "Acme Sensors", "公司名要做 trim，不能把首尾空格存进库");
ok(created.companyFullName === "Acme Sensors", "全名留空时必须回落简称（单据抬头不能为空）");
ok(created.grade === "C", "未指定分级默认 C，与客户口径一致");
ok(created.status === "active", "未指定状态默认 active");
ok(created.leadTimeDays === 0, "未登记交期应为 0，而不是 NaN");
ok(created.country === "" && created.contact === "", "缺省文本字段应为空串，不能是 undefined");

// —— 编辑：未提交的字段保留原值（PATCH 语义）——
const patched = normalizeSupplierInput({ phone: "  +49 40 123  " }, existing());
ok(patched.phone === "+49 40 123", "提交的字段要 trim 后写入");
ok(patched.company === "Acme Sensors", "未提交的 company 不能被清空");
ok(patched.companyFullName === "Acme Sensors GmbH", "未提交的全名要保留原值");
ok(patched.leadTimeDays === 30 && patched.grade === "B" && patched.status === "active",
  "未提交的交期/分级/状态要保留原值");

// —— 显式清空全名 = 回落简称，不是留空 ——
const cleared = normalizeSupplierInput({ companyFullName: "" }, existing());
ok(cleared.companyFullName === "Acme Sensors", "主动清空全名时回落简称，不能存空串");

// —— 分级 / 状态归一 ——
ok(normalizeSupplierGrade("a") === "A", "小写分级要能识别");
ok(normalizeSupplierGrade("X") === "C", "非法分级回落 C，不能把脏值写库");
ok(normalizeSupplierGrade(undefined) === "C", "缺省分级回落 C");
ok(normalizeSupplierStatus("EVALUATING") === "evaluating", "状态大小写不敏感");
ok(normalizeSupplierStatus("deleted") === "active", "非法状态回落 active");

// —— 交期兜底 ——
ok(normalizeLeadTimeDays(-5) === 0, "负数交期归 0");
ok(normalizeLeadTimeDays("15") === 15, "字符串数字要能转（表单值都是字符串）");
ok(normalizeLeadTimeDays(Number.NaN) === 0, "NaN 交期归 0，别把 NaN 写进 INT 列");
ok(normalizeLeadTimeDays(99999) === 3650, "交期封顶 3650 天，挡住手滑多打几位");
ok(normalizeLeadTimeDays(12.7) === 12, "交期取整，不写小数进 INT 列");

// —— 行映射：snake_case → camelCase，Date → ISO ——
const row = supplierFromRow({
  id: "sup_9",
  owner_id: "u_9",
  team_id: "team_9",
  company: "Nordic Scale",
  company_full_name: "Nordic Scale AB",
  country: "Sweden",
  category: "工业秤",
  contact: "Lars",
  phone: "+46 8",
  email: "lars@nordic.se",
  wechat: "",
  website: "nordic.se",
  address: "Stockholm",
  payment_term: "T/T 100%",
  lead_time_days: 21,
  grade: "A",
  status: "paused",
  source: "官网",
  remark: "",
  created_at: new Date("2026-10-03T00:00:00.000Z"),
  updated_at: new Date("2026-10-04T00:00:00.000Z")
});
ok(row.ownerId === "u_9" && row.teamId === "team_9", "归属字段要映射到 ownerId/teamId");
ok(row.companyFullName === "Nordic Scale AB" && row.paymentTerm === "T/T 100%", "snake_case 列名要正确映射");
ok(row.leadTimeDays === 21 && row.grade === "A" && row.status === "paused", "数值/枚举列要正确还原");
ok(row.createdAt === "2026-10-03T00:00:00.000Z", "DATETIME 要转成 ISO 字符串给前端");

// —— 缺列 / 脏行不能抛错 ——
const sparse = supplierFromRow({});
ok(sparse.id === "" && sparse.company === "" && sparse.grade === "C" && sparse.status === "active",
  "空行要回落安全默认值而不是抛错");

// —— 重复判定：大小写 / 空格 / 国家 ——
ok(supplierDuplicateKey("Acme  Sensors", "Germany") === supplierDuplicateKey("acme sensors", "germany"),
  "大小写与多余空格不能绕过重复拦截");
ok(supplierDuplicateKey("Acme Sensors", "Germany") !== supplierDuplicateKey("Acme Sensors", "Austria"),
  "同名不同国家视为两家（集团子公司很常见）");
ok(supplierDuplicateKey("", "") === "|", "空值也要稳定，不能返回 undefined");

// —— 供应商编码：清洗 / 顺延 / 人工码兼容 ——
ok(normalizeSupplierCode("  sup-0012 ") === "SUP-0012", "编码要去空格并统一大写");
ok(normalizeSupplierCode("acme_01.x") === "ACME_01.X", "点/下划线/连字符属于合法编码字符");
ok(normalizeSupplierCode("供应商 12") === "12", "中文等非法字符要剔除，只留 ASCII");
ok(normalizeSupplierCode(null) === "" && normalizeSupplierCode(undefined) === "",
  "未填编码返回空串（由仓库自动生成），不能变成字符串 \"null\"");
ok(normalizeSupplierCode("x".repeat(60)).length === 40, "编码超长要截断到 40 位（列宽上限）");

ok(supplierCodeSequence("SUP-0007") === 7, "自动码要能解析出序号");
ok(supplierCodeSequence("ACME-01") === 0 && supplierCodeSequence("SUP-ABC") === 0,
  "人工码不参与自动顺延，否则会算出莫名奇妙的号");
ok(supplierCodeFromSequence(1) === "SUP-0001" && supplierCodeFromSequence(42) === "SUP-0042",
  "自动码固定四位补零");
ok(supplierCodeFromSequence(0) === "SUP-0001", "0/负数要兜到 1，不能生成 SUP-0000");
ok(nextSupplierCode([]) === "SUP-0001", "空库第一家从 0001 起");
ok(nextSupplierCode(["SUP-0002", "ACME-99"]) === "SUP-0003", "人工码不能把自动序号顶高");
ok(nextSupplierCode(["SUP-0009", "SUP-0003"]) === "SUP-0010", "取当前最大号 +1，不是取数量");
ok(nextSupplierCode(["SUP-9999"]) === "SUP-10000", "超过四位数自然进位，不能截断");

// 新建：留空交给仓库生成；编辑：留空不能把已有编码清掉
const fresh = normalizeSupplierInput({ company: "New Supplier" });
ok(fresh.code === "", "新建留空编码，交给仓库按团队顺延");
const codePatched = normalizeSupplierInput({ code: "  acme-1 " }, existing());
ok(codePatched.code === "ACME-1", "人工改码要清洗后生效");
const codeKept = normalizeSupplierInput({ code: "  " }, existing());
ok(codeKept.code === "SUP-0007", "编辑时把编码清空要保留原值，不能改成空串");
const codeIgnored = normalizeSupplierInput({ phone: "+49 2" }, existing());
ok(codeIgnored.code === "SUP-0007", "未提交 code 时要保留原编码");
ok(supplierFromRow({ supplier_code: "SUP-0042" }).code === "SUP-0042", "supplier_code 列要映射到 code");
ok(sparse.code === "", "缺列的行编码为空串（老库尚未回填时也不能抛错）");

console.log(JSON.stringify({ ok: true, checked: passed }, null, 2));