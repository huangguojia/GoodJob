import { geoCentroid } from "d3-geo";
import Globe, { type GlobeInstance } from "globe.gl";
import isoCountries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import zhLocale from "i18n-iso-countries/langs/zh.json";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import countriesTopology from "world-atlas/countries-110m.json";

export type ProspectRadarFrameKind = "source" | "candidate" | "evidence" | "relation" | "verification" | "complete";
export type ProspectRadarFrameTone = "live" | "gain" | "review" | "failed" | "complete";

export interface ProspectRadarCandidate {
  id: string;
  candidateId: string;
  company: string;
  country: string;
  website: string;
  createdAt: string;
  kind: "candidate" | "related";
  verificationScore: number;
}

export interface ProspectRadarRelation {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
  confidence: number;
  verified: boolean;
  createdAt: string;
}

export interface ProspectRadarFrame {
  id: string;
  at: string;
  kind: ProspectRadarFrameKind;
  tone: ProspectRadarFrameTone;
  source: string;
  title: string;
  detail: string;
  result: string;
  country?: string;
  candidateId?: string;
  relationId?: string;
}

export interface ProspectRadarModel {
  title: string;
  live: boolean;
  frames: ProspectRadarFrame[];
  candidates: ProspectRadarCandidate[];
  relations: ProspectRadarRelation[];
  focusCountries: string[];
}

export interface ProspectRadarController {
  update(model: ProspectRadarModel): void;
  replay(): void;
  pause(): void;
  resume(): void;
  resize(): void;
  destroy(): void;
}

interface ProspectRadarOptions {
  host: HTMLElement;
  model: ProspectRadarModel;
  onFrameChange(frame: ProspectRadarFrame, index: number, total: number): void;
  onPlaybackChange(playing: boolean): void;
}

type CountryProperties = { name?: string };
type CountryFeature = Feature<Polygon | MultiPolygon, CountryProperties>;
type CountryTopology = Topology<{ countries: GeometryCollection<CountryProperties> }>;

interface RadarPoint {
  id: string;
  candidateId: string;
  company: string;
  country: string;
  website: string;
  kind: "candidate" | "related";
  score: number;
  lat: number;
  lng: number;
}

interface RadarArc {
  id: string;
  relationType: string;
  confidence: number;
  verified: boolean;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
}

interface RadarRing {
  lat: number;
  lng: number;
  tone: ProspectRadarFrameTone;
}

type CaptureFeedTone = "candidate" | "related" | "milestone";

interface CaptureFeedEntry {
  id: string;
  tone: CaptureFeedTone;
  title: string;
  detail: string;
}

interface CaptureFeedController {
  addCandidate(point: RadarPoint): void;
  reset(): void;
  destroy(): void;
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
const FRAME_INTERVAL_MS = 1480;

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

function sourceCountryId(item: CountryFeature) {
  return String(item.id || "").padStart(3, "0");
}

function countryId(item: CountryFeature) {
  const id = sourceCountryId(item);
  return id === TAIWAN_SOURCE_NUMERIC_ID ? CHINA_NUMERIC_ID : id;
}

function countryCenter(item: CountryFeature) {
  const [lng, lat] = geoCentroid(item);
  return { lat, lng };
}

function timestamp(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function stableJitter(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    lat: ((hash >>> 3) % 11 - 5) * 0.42,
    lng: ((hash >>> 9) % 13 - 6) * 0.48
  };
}

function pointLabel(item: RadarPoint) {
  const node = document.createElement("div");
  node.className = "prospect-radar-tooltip";
  const company = document.createElement("strong");
  const detail = document.createElement("span");
  company.textContent = item.company;
  detail.textContent = [item.country, item.kind === "related" ? "关系企业" : "候选企业", item.score ? `验证 ${item.score} 分` : ""].filter(Boolean).join(" / ");
  node.append(company, detail);
  return node;
}

function companyMarker(item: RadarPoint) {
  const node = document.createElement("div");
  node.className = "prospect-radar-company-label";
  const company = document.createElement("strong");
  const detail = document.createElement("span");
  company.textContent = item.company;
  detail.textContent = [item.country, item.score ? `验证 ${item.score} 分` : "待验证"].filter(Boolean).join(" / ");
  node.append(company, detail);
  return node;
}

function arcLabel(item: RadarArc) {
  const node = document.createElement("div");
  node.className = "prospect-radar-tooltip";
  const relation = document.createElement("strong");
  const detail = document.createElement("span");
  relation.textContent = item.relationType || "已发现企业关系";
  detail.textContent = `${item.verified ? "已验证" : "待交叉验证"} / 置信度 ${Math.round(item.confidence)} 分`;
  node.append(relation, detail);
  return node;
}

function captureMilestone(count: number) {
  if (count === 5) return "已捕获 5 家，继续筛选高匹配企业";
  if (count === 10) return "10 家候选进入视野，正在压低重复与噪声";
  if (count === 20) return "20 家企业完成初筛，证据链继续补齐";
  if (count % 10 === 0) return `${count} 家候选已记录，继续寻找更高匹配`;
  return "";
}

function createCaptureFeed(host: HTMLElement): CaptureFeedController {
  const maxRows = 7;
  const rowHeight = 46;
  const shell = document.createElement("aside");
  shell.className = "prospect-radar-capture-feed";
  shell.setAttribute("aria-label", "实时捕获的候选企业");

  const head = document.createElement("div");
  head.className = "prospect-radar-capture-head";
  const heading = document.createElement("span");
  heading.textContent = "实时捕获";
  const count = document.createElement("b");
  count.textContent = "已捕获 0 家";
  head.append(heading, count);

  const list = document.createElement("div");
  list.className = "prospect-radar-capture-list";
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");
  list.setAttribute("aria-relevant", "additions text");
  shell.append(head, list);
  host.append(shell);

  const entries: CaptureFeedEntry[] = [];
  const seenCandidates = new Set<string>();
  const nodes = new Map<string, HTMLElement>();

  function render() {
    const startRow = Math.max(0, maxRows - entries.length);
    entries.forEach((entry, index) => {
      const node = nodes.get(entry.id);
      if (!node) return;
      const distance = entries.length - index - 1;
      const offset = (startRow + index) * rowHeight;
      node.style.transform = `translate3d(0, ${offset}px, 0)`;
      node.style.opacity = String(Math.max(0.14, 0.98 - distance * 0.14));
      node.style.zIndex = String(maxRows - distance);
    });
  }

  function createEntryNode(entry: CaptureFeedEntry) {
    const node = document.createElement("article");
    node.className = `prospect-radar-capture-item is-${entry.tone}`;
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const detail = document.createElement("span");
    detail.textContent = entry.detail;
    node.append(title, detail);
    return node;
  }

  function addEntry(entry: CaptureFeedEntry) {
    if (nodes.has(entry.id)) return;
    entries.push(entry);
    const node = createEntryNode(entry);
    nodes.set(entry.id, node);
    list.append(node);
    node.classList.add("is-new");
    window.setTimeout(() => node.classList.remove("is-new"), 720);
    while (entries.length > maxRows) {
      const removed = entries.shift();
      if (!removed) break;
      nodes.get(removed.id)?.remove();
      nodes.delete(removed.id);
    }
    render();
    count.textContent = `已捕获 ${seenCandidates.size} 家`;
  }

  return {
    addCandidate(point) {
      const key = point.candidateId || point.id;
      if (!key || seenCandidates.has(key)) return;
      seenCandidates.add(key);
      addEntry({
        id: `candidate:${key}`,
        tone: point.kind === "related" ? "related" : "candidate",
        title: point.company,
        detail: [point.country, point.score ? `验证 ${point.score} 分` : "候选已记录"].join(" / ")
      });
      const milestone = captureMilestone(seenCandidates.size);
      if (milestone) {
        addEntry({
          id: `milestone:${seenCandidates.size}`,
          tone: "milestone",
          title: milestone,
          detail: "搜索继续推进，结果会按真实事件逐条进入"
        });
      }
    },
    reset() {
      entries.length = 0;
      seenCandidates.clear();
      nodes.clear();
      list.replaceChildren();
      count.textContent = "已捕获 0 家";
    },
    destroy() {
      shell.remove();
      entries.length = 0;
      seenCandidates.clear();
      nodes.clear();
    }
  };
}

export function createProspectRadar(options: ProspectRadarOptions): ProspectRadarController {
  const topology = countriesTopology as unknown as CountryTopology;
  const collection = feature(topology, topology.objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon, CountryProperties>;
  const countries = collection.features as CountryFeature[];
  const countryById = new Map<string, CountryFeature>();
  countries.forEach((country) => {
    const id = countryId(country);
    if (!countryById.has(id) || sourceCountryId(country) === id) countryById.set(id, country);
  });

  let model = options.model;
  let currentIndex = -1;
  let playing = false;
  let destroyed = false;
  let timer = 0;
  let focusedCountryId = "";
  let visibleMarketIds = new Set<string>();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const globe: GlobeInstance = new Globe(options.host, { animateIn: false, waitForGlobeReady: true })
    .backgroundColor("#07100f")
    .showAtmosphere(true)
    .atmosphereColor("#6bc69b")
    .atmosphereAltitude(0.16)
    .showGraticules(true)
    .polygonsData(countries)
    .polygonStrokeColor(() => "rgba(161, 190, 176, .18)")
    .polygonSideColor(() => "rgba(14, 32, 27, .7)")
    .polygonAltitude((item) => countryId(item as CountryFeature) === focusedCountryId ? 0.018 : 0.003)
    .polygonCapColor((item) => {
      const id = countryId(item as CountryFeature);
      if (id === focusedCountryId) return "rgba(114, 211, 164, .82)";
      if (visibleMarketIds.has(id)) return "rgba(67, 126, 99, .76)";
      return "rgba(19, 42, 34, .94)";
    })
    .polygonsTransitionDuration(420)
    .pointLat((item) => (item as RadarPoint).lat)
    .pointLng((item) => (item as RadarPoint).lng)
    .pointAltitude((item) => (item as RadarPoint).kind === "related" ? 0.035 : 0.055)
    .pointRadius((item) => 0.18 + Math.min(0.18, (item as RadarPoint).score / 500))
    .pointResolution(20)
    .pointColor((item) => (item as RadarPoint).kind === "related" ? "rgba(218, 232, 225, .9)" : "#72d3a4")
    .pointLabel((item) => pointLabel(item as RadarPoint))
    .arcStartLat((item) => (item as RadarArc).startLat)
    .arcStartLng((item) => (item as RadarArc).startLng)
    .arcEndLat((item) => (item as RadarArc).endLat)
    .arcEndLng((item) => (item as RadarArc).endLng)
    .arcAltitude((item) => 0.12 + Math.min(0.18, (item as RadarArc).confidence / 500))
    .arcStroke((item) => (item as RadarArc).verified ? 0.5 : 0.28)
    .arcColor((item: object) => (item as RadarArc).verified ? "rgba(114, 211, 164, .9)" : "rgba(213, 229, 221, .5)")
    .arcDashLength(0.34)
    .arcDashGap(0.18)
    .arcDashAnimateTime(reducedMotion ? 0 : 1700)
    .arcLabel((item) => arcLabel(item as RadarArc))
    .ringLat((item) => (item as RadarRing).lat)
    .ringLng((item) => (item as RadarRing).lng)
    .ringAltitude(0.018)
    .ringColor(() => (progress: number) => `rgba(114, 211, 164, ${Math.max(0, 0.72 - progress * 0.68)})`)
    .ringMaxRadius(4.4)
    .ringPropagationSpeed(reducedMotion ? 0 : 2.2)
    .ringRepeatPeriod(reducedMotion ? 0 : 720)
    .htmlLat((item) => (item as RadarPoint).lat)
    .htmlLng((item) => (item as RadarPoint).lng)
    .htmlAltitude(0.09)
    .htmlTransitionDuration(reducedMotion ? 0 : 240)
    .htmlElement((item) => companyMarker(item as RadarPoint));

  const globeMaterial = globe.globeMaterial();
  globeMaterial.color.set("#102b22");
  globeMaterial.emissive.set("#0d241c");
  globeMaterial.emissiveIntensity = 0.7;
  globeMaterial.shininess = 1.4;

  const controls = globe.controls();
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 0.36;
  controls.autoRotate = !reducedMotion;
  globe.pointOfView({ lat: 18, lng: 16, altitude: 2.05 }, 0);
  const captureFeed = createCaptureFeed(options.host);

  function pointForCandidate(candidate: ProspectRadarCandidate): RadarPoint | null {
    const country = countryById.get(numericCountryCode(candidate.country));
    if (!country) return null;
    const center = countryCenter(country);
    const jitter = stableJitter(candidate.id);
    return {
      id: candidate.id,
      candidateId: candidate.candidateId,
      company: candidate.company,
      country: candidate.country,
      website: candidate.website,
      kind: candidate.kind,
      score: candidate.verificationScore,
      lat: Math.max(-78, Math.min(78, center.lat + jitter.lat)),
      lng: center.lng + jitter.lng
    };
  }

  function visibleAt(value: string, frameAt: string) {
    const valueTime = timestamp(value);
    const frameTime = timestamp(frameAt);
    return !valueTime || !frameTime || valueTime <= frameTime;
  }

  function drawFrame(frame: ProspectRadarFrame, index: number) {
    currentIndex = Math.max(0, Math.min(index, model.frames.length - 1));
    const isFinal = frame.kind === "complete" || currentIndex === model.frames.length - 1;
    const candidateRows = (isFinal ? model.candidates : model.candidates.filter((item) => visibleAt(item.createdAt, frame.at)))
      .map(pointForCandidate)
      .filter((item): item is RadarPoint => Boolean(item));
    const pointById = new Map(candidateRows.map((item) => [item.id, item]));
    const relationRows = (isFinal ? model.relations : model.relations.filter((item) => visibleAt(item.createdAt, frame.at)))
      .map((relation): RadarArc | null => {
        const from = pointById.get(relation.fromId);
        const to = pointById.get(relation.toId);
        if (!from || !to) return null;
        return {
          ...relation,
          startLat: from.lat,
          startLng: from.lng,
          endLat: to.lat,
          endLng: to.lng
        };
      })
      .filter((item): item is RadarArc => Boolean(item));
    const focusedPoint = frame.candidateId ? pointById.get(frame.candidateId) : null;
    const focusedArc = frame.relationId ? relationRows.find((item) => item.id === frame.relationId) : null;
    const fallbackCountry = frame.country ? countryById.get(numericCountryCode(frame.country)) : null;
    const fallbackCenter = fallbackCountry ? countryCenter(fallbackCountry) : null;
    const focus = focusedPoint
      || (focusedArc ? { lat: focusedArc.endLat, lng: focusedArc.endLng } : null)
      || fallbackCenter;
    focusedCountryId = numericCountryCode(frame.country || focusedPoint?.country || "");
    visibleMarketIds = new Set(candidateRows.map((item) => numericCountryCode(item.country)).filter(Boolean));
    globe
      .pointsData(candidateRows)
      .arcsData(relationRows)
      .ringsData(focus ? [{ lat: focus.lat, lng: focus.lng, tone: frame.tone } satisfies RadarRing] : [])
      .htmlElementsData(focusedPoint ? [focusedPoint] : []);
    if (frame.kind === "candidate" && focusedPoint) captureFeed.addCandidate(focusedPoint);
    globe.polygonCapColor(globe.polygonCapColor()).polygonAltitude(globe.polygonAltitude());
    if (focus) {
      controls.autoRotate = false;
      globe.pointOfView({ lat: focus.lat, lng: focus.lng, altitude: 1.5 }, reducedMotion ? 0 : 760);
    } else if (!reducedMotion) {
      controls.autoRotate = true;
    }
    options.onFrameChange(frame, currentIndex, model.frames.length);
  }

  function clearTimer() {
    window.clearTimeout(timer);
    timer = 0;
  }

  function scheduleNext() {
    clearTimer();
    if (!playing || destroyed) return;
    if (currentIndex < model.frames.length - 1) {
      timer = window.setTimeout(() => {
        const next = model.frames[currentIndex + 1];
        if (next) drawFrame(next, currentIndex + 1);
        scheduleNext();
      }, FRAME_INTERVAL_MS);
      return;
    }
    if (model.live) {
      timer = window.setTimeout(scheduleNext, FRAME_INTERVAL_MS);
      return;
    }
    playing = false;
    options.onPlaybackChange(false);
  }

  function setPlaying(next: boolean) {
    playing = next;
    options.onPlaybackChange(playing);
    if (playing) scheduleNext();
    else clearTimer();
  }

  function resize() {
    const width = Math.max(320, options.host.clientWidth);
    const height = Math.max(360, options.host.clientHeight);
    globe.width(width).height(height);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(options.host);
  resize();

  const controller: ProspectRadarController = {
    update(nextModel) {
      const currentId = model.frames[currentIndex]?.id;
      model = nextModel;
      const nextIndex = currentId ? model.frames.findIndex((item) => item.id === currentId) : -1;
      currentIndex = nextIndex >= 0 ? nextIndex : Math.min(currentIndex, model.frames.length - 1);
      if (reducedMotion) {
        const last = model.frames[model.frames.length - 1];
        if (last) drawFrame(last, model.frames.length - 1);
        setPlaying(false);
      } else if (currentIndex >= 0 && model.frames[currentIndex]) {
        drawFrame(model.frames[currentIndex], currentIndex);
      }
    },
    replay() {
      if (!model.frames.length) return;
      captureFeed.reset();
      drawFrame(model.frames[0], 0);
      setPlaying(!reducedMotion && model.frames.length > 1);
    },
    pause() {
      setPlaying(false);
    },
    resume() {
      if (currentIndex >= model.frames.length - 1 && !model.live) currentIndex = -1;
      const next = model.frames[Math.max(0, currentIndex)];
      if (next && currentIndex < 0) drawFrame(next, 0);
      setPlaying(!reducedMotion && model.frames.length > 1);
    },
    resize,
    destroy() {
      destroyed = true;
      setPlaying(false);
      resizeObserver.disconnect();
      controls.autoRotate = false;
      captureFeed.destroy();
      globe._destructor();
    }
  };

  if (reducedMotion) {
    const last = model.frames[model.frames.length - 1];
    if (last) drawFrame(last, model.frames.length - 1);
  } else {
    controller.replay();
  }
  return controller;
}
