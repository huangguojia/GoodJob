import {
  defineProvider,
  type LeadProvider
} from "./provider-contract.js";
import type { ProviderAccessMode } from "./types.js";

interface AssistedSourceDefinition {
  id: string;
  name: string;
  accessMode: Exclude<ProviderAccessMode, "api" | "disabled">;
  docsUrl: string;
  baseUrl: string;
  costNote: string;
  capabilities: string[];
}

function assistedSource(definition: AssistedSourceDefinition) {
  const host = new URL(definition.baseUrl).hostname;
  return defineProvider({
    id: definition.id,
    name: definition.name,
    adapterVersion: "1.0.0",
    tier: "free",
    category: "company",
    requiresKey: false,
    capabilities: definition.capabilities,
    docsUrl: definition.docsUrl,
    keyHint: "该来源不支持当前系统直接自动调用，请从官方入口核实后将企业或结果链接交给系统解析。",
    defaultBaseUrl: definition.baseUrl,
    costNote: definition.costNote,
    accessMode: definition.accessMode,
    networkPolicy: {
      allowedHosts: [host],
      allowedPathPrefixes: ["/"],
      allowedMethods: ["GET"]
    },
    async health() {
      return { ok: true, message: "辅助来源无需 API 连接配置，请使用官方入口核实后返回解析结果链接" };
    }
  });
}

export const CANADABUYS_OPEN_DATA_PROVIDER = assistedSource({
  id: "canadabuys_open_data",
  name: "CanadaBuys 开放采购数据",
  accessMode: "bulk_file",
  docsUrl: "https://canadabuys.canada.ca/en/open-data",
  baseUrl: "https://canadabuys.canada.ca",
  costNote: "加拿大政府开放采购数据，当前使用官方下载文件人工筛选，再将核实后的企业或结果链接交给系统解析。",
  capabilities: ["company", "procurement", "import"]
});

export const EPREL_PROVIDER = assistedSource({
  id: "eprel",
  name: "欧盟 EPREL 产品库",
  accessMode: "website_controlled",
  docsUrl: "https://eprel.ec.europa.eu/screen/product",
  baseUrl: "https://eprel.ec.europa.eu",
  costNote: "欧盟能效产品注册库，适合按产品类别人工核验制造商和型号。",
  capabilities: ["company", "product", "manual_research"]
});

export const EU_ECOLABEL_PROVIDER = assistedSource({
  id: "eu_ecolabel",
  name: "欧盟 Ecolabel 产品目录",
  accessMode: "website_controlled",
  docsUrl: "https://environment.ec.europa.eu/topics/circular-economy/eu-ecolabel-home/business/ecat_en",
  baseUrl: "https://environment.ec.europa.eu",
  costNote: "欧盟生态标签官方目录，适合人工查找获认证的企业和产品。",
  capabilities: ["company", "product", "certification", "manual_research"]
});

export const CHINA_CUSTOMS_STATISTICS_PROVIDER = assistedSource({
  id: "china_customs_statistics",
  name: "中国海关统计",
  accessMode: "website_controlled",
  docsUrl: "http://stats.customs.gov.cn/",
  baseUrl: "https://stats.customs.gov.cn",
  costNote: "中国海关官方统计查询，当前作为市场验证入口，不自动采集企业级明细。",
  capabilities: ["market_trade", "manual_research"]
});

export const IMPORTYETI_PROVIDER = assistedSource({
  id: "importyeti",
  name: "ImportYeti 进口商检索",
  accessMode: "manual_assisted",
  docsUrl: "https://www.importyeti.com/",
  baseUrl: "https://www.importyeti.com",
  costNote: "可免费人工检索美国海运提单关系；遵守站点规则，核实后再导入 CRM。",
  capabilities: ["company", "trade_relationship", "manual_research"]
});

export const KONEPS_PROVIDER = assistedSource({
  id: "koneps",
  name: "韩国 KONEPS 采购平台",
  accessMode: "website_controlled",
  docsUrl: "https://www.g2b.go.kr/",
  baseUrl: "https://www.g2b.go.kr",
  costNote: "韩国国家电子采购平台，使用官方门户人工检索，再将核实后的企业或结果链接交给系统解析。",
  capabilities: ["company", "procurement", "manual_research"]
});

export const SBIR_AWARDS_PROVIDER = assistedSource({
  id: "sbir_awards",
  name: "美国 SBIR/STTR 获奖企业",
  accessMode: "manual_assisted",
  docsUrl: "https://www.sbir.gov/awards",
  baseUrl: "https://www.sbir.gov",
  costNote: "官方检索入口目前不作为稳定自动 API；可人工发现有研发项目和政府资助记录的企业。",
  capabilities: ["company", "innovation", "manual_research"]
});

export const ASSISTED_SOURCE_PROVIDERS: LeadProvider[] = [
  CANADABUYS_OPEN_DATA_PROVIDER,
  EPREL_PROVIDER,
  EU_ECOLABEL_PROVIDER,
  CHINA_CUSTOMS_STATISTICS_PROVIDER,
  IMPORTYETI_PROVIDER,
  KONEPS_PROVIDER,
  SBIR_AWARDS_PROVIDER
];
