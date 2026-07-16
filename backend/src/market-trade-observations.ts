import { randomUUID } from "node:crypto";
import { canSeeOwner } from "./auth.js";
import type { TradeObservation } from "./provider-contract.js";
import type { CrmStore } from "./store.js";
import type { MarketTradeObservation, SessionUser } from "./types.js";

export interface UpsertMarketTradeObservationsInput {
  teamId: string;
  ownerId: string;
  campaignId: string;
  providerId: string;
  observations: TradeObservation[];
  persist?: boolean;
}

function requiredIdentifier(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > 80) throw new Error(`${label}超过允许长度`);
  return normalized;
}

function normalizedObservationKeyPart(value: string) {
  return value.trim().normalize("NFKC").toLowerCase();
}

export function marketTradeObservationIdentity(item: Pick<
  MarketTradeObservation,
  | "teamId"
  | "ownerId"
  | "campaignId"
  | "providerId"
  | "reporterCountry"
  | "partnerCountry"
  | "tradeFlow"
  | "classification"
  | "commodityCode"
  | "period"
>) {
  return [
    item.teamId,
    item.ownerId,
    item.campaignId,
    item.providerId,
    item.reporterCountry,
    item.partnerCountry,
    item.tradeFlow,
    item.classification,
    item.commodityCode,
    item.period
  ].map(normalizedObservationKeyPart).join("\u001f");
}

function privateObservation(
  context: Omit<UpsertMarketTradeObservationsInput, "observations">,
  observation: TradeObservation,
  existing?: MarketTradeObservation
): MarketTradeObservation {
  return {
    id: existing?.id || `mto_${randomUUID()}`,
    teamId: context.teamId,
    ownerId: context.ownerId,
    campaignId: context.campaignId,
    providerId: context.providerId,
    reporterCountry: observation.reporterCountry.trim(),
    partnerCountry: observation.partnerCountry.trim(),
    reporterCode: observation.reporterCode.trim(),
    partnerCode: observation.partnerCode.trim(),
    tradeFlow: observation.tradeFlow,
    classification: observation.classification.trim(),
    commodityCode: observation.commodityCode.trim(),
    commodityDescription: observation.commodityDescription.trim(),
    period: observation.period.trim(),
    tradeValueUsd: observation.tradeValueUsd,
    netWeightKg: observation.netWeightKg,
    quantity: observation.quantity,
    quantityUnit: observation.quantityUnit?.trim() || "",
    isAggregate: observation.isAggregate,
    suppressed: observation.suppressed,
    statusFlags: [...observation.statusFlags],
    rawRecordId: observation.providerRecordId.trim(),
    payloadHash: observation.payloadHash,
    adapterVersion: observation.adapterVersion,
    sourceRevision: observation.sourceRevision?.trim() || "",
    observedAt: observation.fetchedAt,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
}

export function applyMarketTradeObservations(
  store: CrmStore,
  input: UpsertMarketTradeObservationsInput
) {
  const context = {
    teamId: requiredIdentifier(input.teamId, "团队 ID"),
    ownerId: requiredIdentifier(input.ownerId, "负责人 ID"),
    campaignId: requiredIdentifier(input.campaignId, "项目 ID"),
    providerId: requiredIdentifier(input.providerId, "Provider ID")
  };
  const owner = store.users.find((item) => item.id === context.ownerId && item.status === "active");
  if (!owner || owner.teamId !== context.teamId) {
    throw new Error("贸易观测负责人不存在、已停用或不属于当前团队");
  }

  const existingByKey = new Map(
    store.marketTradeObservations.map((item) => [marketTradeObservationIdentity(item), item])
  );
  const affectedByKey = new Map<string, { item: MarketTradeObservation; created: boolean }>();

  for (const observation of input.observations) {
    const candidate = privateObservation(context, observation);
    const key = marketTradeObservationIdentity(candidate);
    const existing = existingByKey.get(key);
    const next = privateObservation(context, observation, existing);
    if (existing) {
      Object.assign(existing, next);
      affectedByKey.set(key, {
        item: existing,
        created: affectedByKey.get(key)?.created || false
      });
    } else {
      store.marketTradeObservations.unshift(next);
      existingByKey.set(key, next);
      affectedByKey.set(key, { item: next, created: true });
    }
  }

  const affected = [...affectedByKey.values()];
  return {
    observations: affected.map(({ item }) => item),
    createdCount: affected.filter(({ created }) => created).length,
    updatedCount: affected.filter(({ created }) => !created).length
  };
}

export async function upsertMarketTradeObservations(
  store: CrmStore,
  input: UpsertMarketTradeObservationsInput
) {
  const result = applyMarketTradeObservations(store, input);
  if (result.observations.length && input.persist !== false) await store.persist();
  return result;
}

export function visibleMarketTradeObservations(
  store: CrmStore,
  user: SessionUser,
  campaignId: string
) {
  return store.marketTradeObservations.filter((item) =>
    item.campaignId === campaignId
    && canSeeOwner(user, item.ownerId, item.teamId)
  );
}
