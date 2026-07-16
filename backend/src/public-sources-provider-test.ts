import assert from "node:assert/strict";
import { ASSISTED_SOURCE_PROVIDERS } from "./assisted-source-providers.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import {
  FR_COMPANY_SEARCH_PROVIDER,
  NPPES_PROVIDER,
  OPENFDA_510K_PROVIDER,
  PUBLIC_COMPANY_PROVIDERS,
  ROR_PROVIDER
} from "./public-company-providers.js";
import {
  BRAZIL_PNCP_PROVIDER,
  FMCSA_QCMOBILE_PROVIDER,
  MEXICO_DENUE_PROVIDER,
  PUBLIC_PROCUREMENT_PROVIDERS,
  SAM_OPPORTUNITIES_PROVIDER,
  SINGAPORE_GEBIZ_PROVIDER,
  UK_FIND_A_TENDER_PROVIDER,
  USASPENDING_AWARDS_PROVIDER
} from "./public-procurement-providers.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import {
  normalizeProviderPage,
  normalizeProviderQuery,
  ProviderContractError,
  type LeadProvider
} from "./provider-contract.js";
import {
  createProviderHttpClient,
  setProviderHttpTestTransport
} from "./provider-http-client.js";
import { assertProviderOperationPolicy } from "./provider-runtime.js";

function query(country: string, productKeywords = "solar pump") {
  return normalizeProviderQuery({
    goal: `find ${productKeywords} buyers`,
    productKeywords,
    countries: country,
    industry: "industrial equipment",
    customerType: "buyer",
    excludeKeywords: "consulting",
    limit: 5
  });
}

function tools(provider: LeadProvider) {
  return { http: createProviderHttpClient(provider.networkPolicy) };
}

async function searchWithMock(input: {
  provider: LeadProvider;
  country: string;
  payload: unknown;
  apiKey?: string;
  productKeywords?: string;
  status?: number;
  assertRequest?: (url: string, init: RequestInit) => void;
}) {
  let calls = 0;
  setProviderHttpTestTransport(async (url, init) => {
    calls += 1;
    input.assertRequest?.(url, init);
    return new Response(JSON.stringify(input.payload), {
      status: input.status || 200,
      headers: { "content-type": "application/json" }
    });
  });
  assert.ok(input.provider.search, `${input.provider.id} should support search`);
  const page = await input.provider.search!(
    {
      query: query(input.country, input.productKeywords),
      cursor: ""
    },
    { apiKey: input.apiKey || "" },
    tools(input.provider)
  );
  assert.equal(calls, 1, `${input.provider.id} should issue one request`);
  return page;
}

const francePage = await searchWithMock({
  provider: FR_COMPANY_SEARCH_PROVIDER,
  country: "France",
  payload: {
    results: [{
      nom_complet: "Pompes Solaires France",
      siren: "123456789",
      activite_principale: "28.13Z",
      etat_administratif: "A",
      siege: {
        adresse: "1 Rue Exemple",
        code_postal: "75001",
        libelle_commune: "Paris",
        siret: "12345678900011"
      }
    }],
    total_results: 1,
    page: 1,
    per_page: 5,
    total_pages: 1
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "recherche-entreprises.api.gouv.fr");
    assert.equal(parsed.searchParams.get("q"), "solar pump");
    assert.equal(parsed.searchParams.get("per_page"), "5");
  }
});
assert.equal(francePage.records[0]?.company, "Pompes Solaires France");
assert.equal(francePage.records[0]?.providerRecordId, "SIREN:123456789");

const rorPage = await searchWithMock({
  provider: ROR_PROVIDER,
  country: "",
  payload: {
    number_of_results: 1,
    items: [{
      id: "https://ror.org/01example01",
      names: [{ value: "Global Solar Research Institute", types: ["ror_display"], lang: "en" }],
      locations: [{ geonames_details: { country_name: "Germany", country_code: "DE", name: "Berlin" } }],
      types: ["Education"],
      links: [{ type: "website", value: "https://solar.example.org" }]
    }]
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "api.ror.org");
    assert.equal(parsed.searchParams.get("page"), "1");
    assert.match(parsed.searchParams.get("query") || "", /solar pump/);
  }
});
assert.equal(rorPage.records[0]?.company, "Global Solar Research Institute");
assert.equal(rorPage.records[0]?.officialWebsite, "https://solar.example.org");

const nppesPage = await searchWithMock({
  provider: NPPES_PROVIDER,
  country: "United States",
  productKeywords: "medical pump",
  payload: {
    result_count: 1,
    results: [{
      number: "1234567890",
      basic: {
        organization_name: "Example Medical Center",
        status: "A",
        authorized_official_first_name: "Jane",
        authorized_official_last_name: "Buyer",
        authorized_official_telephone_number: "2025550100"
      },
      addresses: [{
        address_purpose: "LOCATION",
        address_1: "1 Health Ave",
        city: "Boston",
        state: "MA",
        postal_code: "02101",
        country_name: "United States",
        telephone_number: "2025550101"
      }],
      taxonomies: [{ desc: "Hospital", primary: true }]
    }]
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("enumeration_type"), "NPI-2");
    assert.equal(parsed.searchParams.get("organization_name"), "medical pump");
  }
});
assert.equal(nppesPage.records[0]?.company, "Example Medical Center");
assert.equal(nppesPage.records[0]?.providerRecordId, "NPI:1234567890");

const openFdaPage = await searchWithMock({
  provider: OPENFDA_510K_PROVIDER,
  country: "United States",
  productKeywords: "infusion pump",
  payload: {
    meta: { results: { skip: 0, limit: 5, total: 1 } },
    results: [{
      k_number: "K260001",
      applicant: "Example Medical Devices Inc",
      device_name: "Infusion Pump",
      decision_date: "20260701",
      contact: "Jane Regulatory",
      address_1: "2 Device Road",
      city: "Austin",
      state: "TX",
      country_code: "US",
      zip_code: "73301"
    }]
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/device/510k.json");
    assert.match(parsed.searchParams.get("search") || "", /device_name:"infusion pump/);
  }
});
assert.equal(openFdaPage.records[0]?.company, "Example Medical Devices Inc");
assert.equal(openFdaPage.records[0]?.providerRecordId, "FDA510K:K260001");

const usaSpendingPage = await searchWithMock({
  provider: USASPENDING_AWARDS_PROVIDER,
  country: "USA",
  payload: {
    page_metadata: { page: 1, hasNext: false },
    results: [{
      internal_id: "award-1",
      "Award ID": "W91234-26-C-0001",
      "Recipient Name": "Example Pump Systems LLC",
      "Award Amount": 125000,
      Description: "Supply of solar pump systems",
      "Start Date": "2026-07-01",
      "End Date": "2027-06-30",
      "Awarding Agency": "Department of Energy",
      generated_internal_id: "CONT_AWD_EXAMPLE"
    }]
  },
  assertRequest(url, init) {
    assert.equal(url, "https://api.usaspending.gov/api/v2/search/spending_by_award/");
    assert.equal(init.method, "POST");
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.filters.keywords, ["solar", "pump"]);
    assert.equal(body.page, 1);
  }
});
assert.equal(usaSpendingPage.records[0]?.company, "Example Pump Systems LLC");
assert.equal(usaSpendingPage.records[0]?.recordType, "business_signal");

const findTenderPage = await searchWithMock({
  provider: UK_FIND_A_TENDER_PROVIDER,
  country: "United Kingdom",
  payload: {
    links: {},
    releases: [{
      ocid: "ocds-example-1",
      id: "notice-001",
      date: "2026-07-15T00:00:00Z",
      tag: ["tender"],
      buyer: { id: "buyer-1", name: "Example Water Authority" },
      tender: {
        title: "Solar pump framework",
        description: "Supply and installation of solar pump equipment",
        status: "active",
        procurementMethodDetails: "Open procedure"
      },
      parties: [{
        id: "buyer-1",
        name: "Example Water Authority",
        roles: ["buyer"],
        address: { countryName: "United Kingdom", locality: "London" },
        contactPoint: { name: "Jane Buyer", email: "buyer@example.gov.uk", telephone: "02070000000" },
        details: { url: "https://water.example.gov.uk" }
      }]
    }]
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "www.find-tender.service.gov.uk");
    assert.equal(parsed.searchParams.get("limit"), "100");
    assert.ok(parsed.searchParams.has("updatedFrom"));
  }
});
assert.equal(findTenderPage.records[0]?.company, "Example Water Authority");
assert.equal(findTenderPage.records[0]?.contactInfo, "buyer@example.gov.uk");

const samPage = await searchWithMock({
  provider: SAM_OPPORTUNITIES_PROVIDER,
  country: "United States",
  apiKey: "sam-test-key",
  payload: {
    totalRecords: 1,
    limit: 5,
    offset: 0,
    opportunitiesData: [{
      noticeId: "sam-notice-1",
      title: "Solar pump systems",
      solicitationNumber: "DOE-SOLAR-001",
      department: "Department of Energy",
      office: "Renewable Procurement Office",
      postedDate: "2026-07-01",
      responseDeadLine: "2026-08-01",
      type: "Solicitation",
      uiLink: "https://sam.gov/opp/sam-notice-1/view",
      pointOfContact: [{ fullName: "Jane Buyer", email: "buyer@example.gov", phone: "2025550102" }]
    }]
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("api_key"), "sam-test-key");
    assert.equal(parsed.searchParams.get("title"), "solar pump");
  }
});
assert.equal(samPage.records[0]?.company, "Renewable Procurement Office");
assert.equal(samPage.records[0]?.contactInfo, "buyer@example.gov");

const pncpPage = await searchWithMock({
  provider: BRAZIL_PNCP_PROVIDER,
  country: "Brazil",
  payload: {
    data: [{
      numeroControlePNCP: "12345678000100-1-000001/2026",
      objetoCompra: "Aquisição de solar pump para abastecimento",
      dataPublicacaoPncp: "2026-07-01",
      dataEncerramentoProposta: "2026-08-01",
      modalidadeNome: "Pregão Eletrônico",
      valorTotalEstimado: 500000,
      linkSistemaOrigem: "https://compras.example.gov.br/tender/1",
      orgaoEntidade: { razaoSocial: "Município de Exemplo", cnpj: "12345678000100" },
      unidadeOrgao: { ufNome: "São Paulo", ufSigla: "SP", municipioNome: "Exemplo", nomeUnidade: "Compras" }
    }],
    totalRegistros: 1,
    totalPaginas: 1,
    numeroPagina: 1,
    paginasRestantes: 0,
    empty: false
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "pncp.gov.br");
    assert.equal(parsed.searchParams.get("pagina"), "1");
    assert.equal(parsed.searchParams.get("tamanhoPagina"), "50");
  }
});
assert.equal(pncpPage.records[0]?.company, "Município de Exemplo");
assert.equal(pncpPage.records[0]?.recordType, "business_signal");

const denuePage = await searchWithMock({
  provider: MEXICO_DENUE_PROVIDER,
  country: "Mexico",
  apiKey: "denue-test-token",
  payload: [{
    Id: "denue-1",
    Nombre: "Bombas Ejemplo",
    Razon_social: "Bombas Solares Ejemplo SA de CV",
    Clase_actividad: "Fabricación de bombas",
    Estrato: "51 a 100 personas",
    Tipo_vialidad: "Calle",
    Calle: "Industrial",
    Num_Exterior: "10",
    Colonia: "Centro",
    CP: "01000",
    Municipio: "Ciudad de México",
    Entidad: "CDMX",
    Telefono: "55550000",
    Correo_e: "ventas@example.mx",
    Sitio_internet: "https://example.mx"
  }],
  assertRequest(url) {
    assert.match(url, /Buscar\/solar%20pump\/00\/1\/5\/denue-test-token$/);
  }
});
assert.equal(denuePage.records[0]?.company, "Bombas Solares Ejemplo SA de CV");
assert.equal(denuePage.records[0]?.officialWebsite, "https://example.mx");

const fmcsaPage = await searchWithMock({
  provider: FMCSA_QCMOBILE_PROVIDER,
  country: "United States",
  apiKey: "fmcsa-test-key",
  productKeywords: "logistics",
  payload: {
    content: [{
      carrier: {
        dotNumber: 1234567,
        legalName: "Example Logistics LLC",
        dbaName: "Example Freight",
        allowedToOperate: "Y",
        statusCode: "A",
        phyCountry: "US",
        phyState: "CA",
        phyCity: "Los Angeles",
        phyStreet: "1 Freight Way",
        telephone: "3105550100",
        emailAddress: "dispatch@example.com"
      }
    }]
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "mobile.fmcsa.dot.gov");
    assert.equal(parsed.searchParams.get("webKey"), "fmcsa-test-key");
    assert.match(decodeURIComponent(parsed.pathname), /logistics/);
  }
});
assert.equal(fmcsaPage.records[0]?.company, "Example Logistics LLC");
assert.equal(fmcsaPage.records[0]?.providerRecordId, "USDOT:1234567");

const gebizPage = await searchWithMock({
  provider: SINGAPORE_GEBIZ_PROVIDER,
  country: "Singapore",
  payload: {
    success: true,
    result: {
      total: 1,
      limit: 5,
      records: [{
        _id: 1,
        tender_no: "PUB-2026-001",
        tender_description: "Supply of solar pump equipment",
        agency: "Public Utilities Board",
        award_date: "2026-07-01",
        tender_detail_status: "Awarded",
        supplier_name: "Example Engineering Pte Ltd",
        awarded_amt: "250000"
      }]
    }
  },
  assertRequest(url) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "data.gov.sg");
    assert.equal(parsed.searchParams.get("resource_id"), "d_acde1106003906a75c3fa052592f2fcb");
    assert.equal(parsed.searchParams.get("q"), "solar pump");
  }
});
assert.equal(gebizPage.records[0]?.company, "Example Engineering Pte Ltd");
assert.equal(gebizPage.records[0]?.recordType, "business_signal");

const executableProviders = [
  ...PUBLIC_COMPANY_PROVIDERS,
  ...PUBLIC_PROCUREMENT_PROVIDERS
];
const providerPages = new Map<string, Awaited<ReturnType<typeof searchWithMock>>>([
  [FR_COMPANY_SEARCH_PROVIDER.id, francePage],
  [ROR_PROVIDER.id, rorPage],
  [NPPES_PROVIDER.id, nppesPage],
  [OPENFDA_510K_PROVIDER.id, openFdaPage],
  [USASPENDING_AWARDS_PROVIDER.id, usaSpendingPage],
  [UK_FIND_A_TENDER_PROVIDER.id, findTenderPage],
  [SAM_OPPORTUNITIES_PROVIDER.id, samPage],
  [BRAZIL_PNCP_PROVIDER.id, pncpPage],
  [MEXICO_DENUE_PROVIDER.id, denuePage],
  [FMCSA_QCMOBILE_PROVIDER.id, fmcsaPage],
  [SINGAPORE_GEBIZ_PROVIDER.id, gebizPage]
]);
const catalog = createDefaultProviderCatalog();

for (const provider of executableProviders) {
  assert.equal(provider.accessMode, "api");
  assert.equal(LEAD_PROVIDERS.includes(provider), true);
  const catalogItem = catalog.find((item) => item.code === provider.id);
  assert.ok(catalogItem, `${provider.id} should be registered in provider catalog`);
  assert.doesNotThrow(() => assertProviderOperationPolicy(provider, catalogItem!, "search"));
  const page = providerPages.get(provider.id);
  assert.ok(page, `${provider.id} should have a contract test page`);
  const normalized = normalizeProviderPage({
    provider,
    catalogPolicyVersion: catalogItem!.version,
    sourceLevel: catalogItem!.sourceLevel,
    allowedFields: catalogItem!.allowedFields,
    retentionPolicy: catalogItem!.retentionPolicy,
    page: page!
  });
  assert.equal(normalized.validCount, 1, `${provider.id} should normalize one valid record`);
}

for (const provider of ASSISTED_SOURCE_PROVIDERS) {
  assert.equal(LEAD_PROVIDERS.includes(provider), true);
  assert.notEqual(provider.accessMode, "api");
  const catalogItem = catalog.find((item) => item.code === provider.id);
  assert.ok(catalogItem, `${provider.id} should be registered in provider catalog`);
  assert.throws(
    () => assertProviderOperationPolicy(provider, catalogItem!, "search"),
    (error: unknown) => error instanceof ProviderContractError
      && error.code === "PROVIDER_POLICY_BLOCKED"
  );
}

let skippedCalls = 0;
setProviderHttpTestTransport(async () => {
  skippedCalls += 1;
  return new Response("{}");
});
const skippedFrance = await FR_COMPANY_SEARCH_PROVIDER.search!(
  { query: query("Germany"), cursor: "" },
  { apiKey: "" },
  tools(FR_COMPANY_SEARCH_PROVIDER)
);
assert.equal(skippedCalls, 0);
assert.equal(skippedFrance.records.length, 0);
assert.equal(skippedFrance.usage?.requestCount, 0);

setProviderHttpTestTransport(async () =>
  new Response(JSON.stringify({ number_of_results: "invalid", items: {} }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })
);
await assert.rejects(
  () => ROR_PROVIDER.search!(
    { query: query(""), cursor: "" },
    { apiKey: "" },
    tools(ROR_PROVIDER)
  ),
  (error: unknown) => error instanceof ProviderContractError
    && error.code === "PROVIDER_SCHEMA_CHANGED"
);

setProviderHttpTestTransport(async () =>
  new Response(JSON.stringify({ message: "rate limited" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "60" }
  })
);
await assert.rejects(
  () => USASPENDING_AWARDS_PROVIDER.search!(
    { query: query("USA"), cursor: "" },
    { apiKey: "" },
    tools(USASPENDING_AWARDS_PROVIDER)
  ),
  (error: unknown) => error instanceof Error && /HTTP 429/.test(error.message)
);

setProviderHttpTestTransport(null);
console.log(JSON.stringify({
  ok: true,
  executableSources: executableProviders.length,
  assistedSources: ASSISTED_SOURCE_PROVIDERS.length
}, null, 2));
