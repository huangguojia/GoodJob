import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  ProspectRunShard,
  ProspectSearchRun,
  ProspectStrategySourcePosition
} from "./types.js";

export type ProspectStrategySourcePositionIdentity = Pick<
  ProspectStrategySourcePosition,
  | "teamId"
  | "ownerId"
  | "campaignId"
  | "campaignVersion"
  | "strategyId"
  | "providerCode"
  | "queryFingerprint"
  | "connectionId"
  | "endpointCode"
  | "adapterVersion"
  | "contractVersion"
  | "catalogVersion"
  | "timeWindowMode"
  | "timeWindowFrom"
  | "timeWindowTo"
>;

export function prospectStrategySourcePositionIdentity(input: {
  run: ProspectSearchRun;
  shard: ProspectRunShard;
  connectionId: string;
  endpointCode: string;
}): ProspectStrategySourcePositionIdentity {
  const timeWindow = input.run.executionSnapshot.resolvedQuery.timeWindow;
  return {
    teamId: input.run.teamId,
    ownerId: input.run.ownerId,
    campaignId: input.run.campaignId,
    campaignVersion: input.run.campaignVersion,
    strategyId: input.run.strategyId,
    providerCode: input.shard.providerCode,
    queryFingerprint: input.run.queryFingerprint,
    connectionId: input.connectionId,
    endpointCode: input.endpointCode,
    adapterVersion: input.shard.adapterVersion,
    contractVersion: input.shard.contractVersion,
    catalogVersion: input.shard.catalogVersion,
    timeWindowMode: timeWindow.mode,
    timeWindowFrom: timeWindow.from,
    timeWindowTo: timeWindow.to
  };
}

export function prospectStrategySourcePositionIdentityHash(
  identity: ProspectStrategySourcePositionIdentity
) {
  const canonicalIdentity: ProspectStrategySourcePositionIdentity = {
    teamId: identity.teamId,
    ownerId: identity.ownerId,
    campaignId: identity.campaignId,
    campaignVersion: identity.campaignVersion,
    strategyId: identity.strategyId,
    providerCode: identity.providerCode,
    queryFingerprint: identity.queryFingerprint,
    connectionId: identity.connectionId,
    endpointCode: identity.endpointCode,
    adapterVersion: identity.adapterVersion,
    contractVersion: identity.contractVersion,
    catalogVersion: identity.catalogVersion,
    timeWindowMode: identity.timeWindowMode,
    timeWindowFrom: identity.timeWindowFrom,
    timeWindowTo: identity.timeWindowTo
  };
  return createHash("sha256")
    .update(canonicalJsonStringify(canonicalIdentity))
    .digest("hex");
}
