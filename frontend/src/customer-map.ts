import { geoCentroid } from "d3-geo";
import Globe, { type GlobeInstance } from "globe.gl";
import isoCountries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import zhLocale from "i18n-iso-countries/langs/zh.json";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import countriesTopology from "world-atlas/countries-110m.json";

export interface CustomerMapRecord {
  id: string;
  company: string;
  country: string;
  contact: string;
  ownerName?: string;
  grade?: "A" | "B" | "C" | "D";
  health: number;
  stage: string;
  amount: number;
  pipelineStage?: string;
  pipelineAmount?: number;
  activeDealCount?: number;
  hasWonDeal?: boolean;
  wonDealCount?: number;
}

export interface CustomerMapRegion {
  id: string;
  name: string;
  center: { lat: number; lng: number };
  customers: CustomerMapRecord[];
}

export interface CustomerMapController {
  update(customers: CustomerMapRecord[]): void;
  resize(): void;
  reset(): void;
  focusCountry(country: string): boolean;
  setActive(active: boolean): void;
  destroy(): void;
}

interface CustomerMapOptions {
  host: HTMLElement;
  customers: CustomerMapRecord[];
  onRegionSelect(region: CustomerMapRegion | null): void;
}

type CountryProperties = { name?: string };
type CountryFeature = Feature<Polygon | MultiPolygon, CountryProperties>;
type CountryTopology = Topology<{ countries: GeometryCollection<CountryProperties> }>;

interface CountryPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  customers: CustomerMapRecord[];
}

isoCountries.registerLocale(zhLocale);
isoCountries.registerLocale(enLocale);

const countryAliases: Record<string, string> = {
  "中国大陆": "CN",
  "中国香港": "HK",
  "中国澳门": "MO",
  "中国台湾": "CN",
  "香港": "HK",
  "澳门": "MO",
  "台湾": "CN",
  "美国": "US",
  "英国": "GB",
  "德国": "DE",
  "法国": "FR",
  "瑞典": "SE",
  "日本": "JP",
  "韩国": "KR",
  "新加坡": "SG",
  "阿联酋": "AE",
  "越南": "VN",
  "泰国": "TH",
  "马来西亚": "MY",
  "印度尼西亚": "ID",
  "俄罗斯": "RU",
  "捷克": "CZ",
  "荷兰": "NL",
  "西班牙": "ES",
  "意大利": "IT",
  "加拿大": "CA",
  "墨西哥": "MX",
  "巴西": "BR",
  "澳大利亚": "AU",
  "新西兰": "NZ",
  "南非": "ZA",
  "沙特": "SA",
  "沙特阿拉伯": "SA",
  "土耳其": "TR",
  "TW": "CN",
  "UK": "GB",
  "UAE": "AE"
};

const CHINA_NUMERIC_ID = "156";
const TAIWAN_SOURCE_NUMERIC_ID = "158";
const mapColors = {
  background: "#050A12",
  land: "rgba(255, 255, 255, .035)",
  marketLow: "rgba(54, 214, 165, .58)",
  marketMedium: "rgba(24, 174, 130, .7)",
  marketHigh: "rgba(5, 116, 87, .78)",
  marketPoint: "#42D9AA",
  won: "#F5B942",
  selected: "rgba(83, 108, 255, .82)",
  atmosphere: "#6AAED0"
};

function numericCountryCode(rawCountry: string) {
  const country = rawCountry.trim();
  if (!country) return "";
  const alias = countryAliases[country] || countryAliases[country.toUpperCase()];
  const alpha2 = alias
    || (/^[a-z]{2}$/i.test(country) ? country.toUpperCase() : "")
    || isoCountries.getAlpha2Code(country, "zh")
    || isoCountries.getAlpha2Code(country, "en")
    || (/^[a-z]{3}$/i.test(country) ? isoCountries.alpha3ToAlpha2(country.toUpperCase()) : "");
  const numeric = alpha2 ? isoCountries.alpha2ToNumeric(alpha2) : undefined;
  const normalized = numeric ? String(numeric).padStart(3, "0") : "";
  return normalized === TAIWAN_SOURCE_NUMERIC_ID ? CHINA_NUMERIC_ID : normalized;
}

function labelNode(title: string, detail: string) {
  const node = document.createElement("div");
  node.className = "customer-map-tooltip";
  const strong = document.createElement("strong");
  const span = document.createElement("span");
  strong.textContent = title;
  span.textContent = detail;
  node.append(strong, span);
  return node;
}

function sourceCountryId(item: CountryFeature) {
  return String(item.id || "").padStart(3, "0");
}

function countryId(item: CountryFeature) {
  const id = sourceCountryId(item);
  return id === TAIWAN_SOURCE_NUMERIC_ID ? CHINA_NUMERIC_ID : id;
}

function countryDisplayName(item: CountryFeature) {
  return countryId(item) === CHINA_NUMERIC_ID ? "中国" : item.properties?.name || "";
}

function countryCenter(item: CountryFeature) {
  const [lng, lat] = geoCentroid(item);
  return { lat, lng };
}

export function createCustomerMap(options: CustomerMapOptions): CustomerMapController {
  const topology = countriesTopology as unknown as CountryTopology;
  const countryCollection = feature(topology, topology.objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon, CountryProperties>;
  const countryFeatures = countryCollection.features as CountryFeature[];
  const featureById = new Map<string, CountryFeature>();
  countryFeatures.forEach((item) => {
    const id = countryId(item);
    if (!featureById.has(id) || sourceCountryId(item) === id) featureById.set(id, item);
  });
  let customersByCountry = new Map<string, CustomerMapRecord[]>();
  let points: CountryPoint[] = [];
  let selectedCountryId = "";
  let hoveredCountryId = "";
  let active = true;
  let resumeTimer = 0;

  const globe: GlobeInstance = new Globe(options.host, { animateIn: false, waitForGlobeReady: true })
    .backgroundColor(mapColors.background)
    .globeImageUrl("/assets/map/earth-blue-marble.jpg")
    .showAtmosphere(true)
    .atmosphereColor(mapColors.atmosphere)
    .atmosphereAltitude(0.14)
    .showGraticules(false)
    .polygonsData(countryFeatures)
    .polygonStrokeColor(() => "rgba(232, 241, 248, .28)")
    .polygonSideColor(() => "rgba(16, 30, 43, .18)")
    .polygonCapCurvatureResolution(3)
    .polygonsTransitionDuration(240)
    .pointAltitude((item) => 0.035 + Math.min((item as CountryPoint).customers.length, 12) * 0.004)
    .pointRadius((item) => 0.19 + Math.min((item as CountryPoint).customers.length, 12) * 0.018)
    .pointResolution(18)
    .pointColor((item) => (item as CountryPoint).customers.some((customer) => customer.hasWonDeal) ? mapColors.won : mapColors.marketPoint)
    .pointLabel((item) => {
      const point = item as CountryPoint;
      return labelNode(point.name, `${point.customers.length} 家客户`);
    })
    .polygonLabel((item) => {
      const country = item as CountryFeature;
      const group = customersByCountry.get(countryId(country)) || [];
      return labelNode(countryDisplayName(country), group.length ? `${group.length} 家客户` : "暂无客户");
    })
    .onPolygonHover((item) => {
      hoveredCountryId = item ? countryId(item as CountryFeature) : "";
      applyPolygonStyle();
    })
    .onPolygonClick((item) => selectCountry(item as CountryFeature))
    .onPointClick((item) => {
      const country = featureById.get((item as CountryPoint).id);
      if (country) selectCountry(country);
    });

  const globeMaterial = globe.globeMaterial();
  globeMaterial.color.set("#FFFFFF");
  globeMaterial.emissive.set("#06101C");
  globeMaterial.emissiveIntensity = 0.08;
  globeMaterial.opacity = 1;
  globeMaterial.transparent = false;
  globeMaterial.shininess = 5;

  const controls = globe.controls();
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 0.42;
  controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  globe.pointOfView({ lat: 18, lng: 20, altitude: 2.15 }, 0);

  function polygonColor(item: CountryFeature) {
    const id = countryId(item);
    if (id === selectedCountryId) return mapColors.selected;
    if (id === hoveredCountryId) return customersByCountry.has(id) ? "rgba(89, 229, 184, .72)" : "rgba(255, 255, 255, .16)";
    const count = customersByCountry.get(id)?.length || 0;
    if (count >= 8) return mapColors.marketHigh;
    if (count >= 4) return mapColors.marketMedium;
    if (count > 0) return mapColors.marketLow;
    return mapColors.land;
  }

  function polygonStroke(item: CountryFeature) {
    return countryId(item) === selectedCountryId ? "rgba(255, 255, 255, .96)" : "rgba(232, 241, 248, .28)";
  }

  function polygonAltitude(item: CountryFeature) {
    const id = countryId(item);
    if (id === selectedCountryId) return 0.024;
    if (id === hoveredCountryId) return 0.012;
    return customersByCountry.has(id) ? 0.007 : 0.002;
  }

  function applyPolygonStyle() {
    globe
      .polygonCapColor((item) => polygonColor(item as CountryFeature))
      .polygonStrokeColor((item) => polygonStroke(item as CountryFeature))
      .polygonAltitude((item) => polygonAltitude(item as CountryFeature));
  }

  function selectCountry(country: CountryFeature) {
    selectedCountryId = countryId(country);
    controls.autoRotate = false;
    window.clearTimeout(resumeTimer);
    applyPolygonStyle();
    const center = countryCenter(country);
    globe.pointOfView({ ...center, altitude: 1.48 }, 720);
    options.onRegionSelect({
      id: selectedCountryId,
      name: countryDisplayName(country),
      center,
      customers: customersByCountry.get(selectedCountryId) || []
    });
  }

  function update(customers: CustomerMapRecord[]) {
    customersByCountry = new Map();
    customers.forEach((customer) => {
      const id = numericCountryCode(customer.country);
      if (!id || !featureById.has(id)) return;
      const group = customersByCountry.get(id) || [];
      group.push(customer);
      customersByCountry.set(id, group);
    });
    points = Array.from(customersByCountry.entries()).map(([id, group]) => {
      const country = featureById.get(id)!;
      const center = countryCenter(country);
      return {
        id,
        name: id === CHINA_NUMERIC_ID ? "中国" : group[0]?.country || countryDisplayName(country),
        ...center,
        customers: group
      };
    });
    globe.pointsData(points);
    if (selectedCountryId) {
      const selected = featureById.get(selectedCountryId);
      if (!selected || !customersByCountry.has(selectedCountryId)) {
        selectedCountryId = "";
        options.onRegionSelect(null);
      } else if (selected) {
        const center = countryCenter(selected);
        options.onRegionSelect({
          id: selectedCountryId,
          name: countryDisplayName(selected),
          center,
          customers: customersByCountry.get(selectedCountryId) || []
        });
      }
    }
    applyPolygonStyle();
  }

  function resize() {
    const width = Math.max(320, options.host.clientWidth);
    const height = Math.max(420, options.host.clientHeight);
    globe.width(width).height(height);
  }

  function reset() {
    selectedCountryId = "";
    applyPolygonStyle();
    options.onRegionSelect(null);
    globe.pointOfView({ lat: 18, lng: 20, altitude: 2.15 }, 720);
    if (active && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      resumeTimer = window.setTimeout(() => { controls.autoRotate = true; }, 800);
    }
  }

  function pauseForInteraction() {
    controls.autoRotate = false;
    window.clearTimeout(resumeTimer);
  }

  function resumeAfterInteraction() {
    window.clearTimeout(resumeTimer);
    if (!active || selectedCountryId || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    resumeTimer = window.setTimeout(() => { controls.autoRotate = true; }, 4500);
  }

  function onVisibilityChange() {
    if (document.hidden || !active) controls.autoRotate = false;
    else resumeAfterInteraction();
  }

  options.host.addEventListener("pointerdown", pauseForInteraction);
  options.host.addEventListener("pointerup", resumeAfterInteraction);
  options.host.addEventListener("wheel", resumeAfterInteraction, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(options.host);
  update(options.customers);
  resize();

  return {
    update,
    resize,
    reset,
    focusCountry(country) {
      const item = featureById.get(numericCountryCode(country));
      if (!item) return false;
      selectCountry(item);
      return true;
    },
    setActive(nextActive) {
      active = nextActive;
      if (!active) controls.autoRotate = false;
      else {
        resize();
        resumeAfterInteraction();
      }
    },
    destroy() {
      window.clearTimeout(resumeTimer);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      options.host.removeEventListener("pointerdown", pauseForInteraction);
      options.host.removeEventListener("pointerup", resumeAfterInteraction);
      options.host.removeEventListener("wheel", resumeAfterInteraction);
      globe._destructor();
    }
  };
}
