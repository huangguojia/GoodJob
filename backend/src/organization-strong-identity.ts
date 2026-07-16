import {
  createHash,
  createHmac
} from "node:crypto";
import { domainToASCII } from "node:url";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  readProspectSourceRawRecord
} from "./prospect-source-raw.js";
import type { CrmStore } from "./store.js";
import type {
  Organization,
  OrganizationAcceptedIdentifier,
  OrganizationIdentityClaim,
  OrganizationIdentityClaimKind,
  OrganizationIdentityConflict,
  OrganizationIdentityEntityType,
  OrganizationIdentityEvent,
  OrganizationIdentityResolution,
  OrganizationSourceBinding,
  OrganizationStrongIdentifierKind
} from "./types.js";

export const ORGANIZATION_STRONG_IDENTITY_CONTRACT =
  "organization-strong-identity-v1";

const MAX_CLAIMS = 200;
const MAX_TEXT_LENGTH = 2_000;
const activeTeamLocks = new Set<string>();

export interface OrganizationIdentityClaimInput {
  kind: OrganizationIdentityClaimKind;
  value: string;
  normalizedValue?: string;
  scheme?: string;
  jurisdiction?: string;
  entityType?: OrganizationIdentityEntityType;
  subjectRef?: string;
  normalizerVersion: string;
  validatorVersion: string;
  observedAt: string;
}

export interface OrganizationIdentityAuthorityRule {
  kind: OrganizationStrongIdentifierKind;
  scheme: string;
  jurisdictions: string[];
  entityTypes: OrganizationIdentityEntityType[];
  normalizerVersions: string[];
  validatorVersions: string[];
}

export interface OrganizationIdentityAuthorityProfile {
  profileCode: string;
  profileVersion: string;
  providerCode: string;
  endpointCode: string;
  allowMultiIdentifierSubjectBinding: boolean;
  rules: OrganizationIdentityAuthorityRule[];
}

export interface ResolveOrganizationStrongIdentityInput {
  teamId: string;
  ownerId: string;
  rawRecordId: string;
  resolverVersion: typeof ORGANIZATION_STRONG_IDENTITY_CONTRACT;
  parserVersion: string;
  normalizerVersion: string;
  resolvedAt: string;
  envelopeSecret: string;
  identitySecret: string;
  processingSecret?: string;
  deterministicIdSecret?: string;
  identifierLookupSecret?: string;
  factIntegritySecret?: string;
  authorityProfile: OrganizationIdentityAuthorityProfile;
  claims: OrganizationIdentityClaimInput[];
}

export type ResolveOrganizationStrongIdentityPersistedInput = Omit<
  ResolveOrganizationStrongIdentityInput,
  | "envelopeSecret"
  | "identitySecret"
  | "processingSecret"
  | "deterministicIdSecret"
  | "identifierLookupSecret"
  | "factIntegritySecret"
  | "authorityProfile"
> & {
  authorityProfileCode: string;
  authorityProfileVersion: string;
};

export interface ResolveOrganizationStrongIdentityResult {
  idempotent: boolean;
  resolution: OrganizationIdentityResolution;
  createdOrganization: Organization | null;
  claims: OrganizationIdentityClaim[];
  createdIdentifiers: OrganizationAcceptedIdentifier[];
  binding: OrganizationSourceBinding | null;
  conflict: OrganizationIdentityConflict | null;
  events: OrganizationIdentityEvent[];
}

export class OrganizationStrongIdentityError extends Error {
  constructor(
    public readonly code:
      | "IDENTITY_INVALID"
      | "IDENTITY_CLAIM_REPLAY_CONFLICT"
      | "IDENTITY_IDENTIFIER_HASH_COLLISION"
      | "IDENTITY_FACT_CONFLICT"
      | "IDENTITY_TEAM_BUSY"
      | "IDENTITY_MYSQL_TRANSACTION_REQUIRED"
      | "IDENTITY_CONFIGURATION_INVALID"
      | "IDENTITY_DATA_INTEGRITY_VIOLATION"
      | "IDENTITY_CONCURRENCY_RETRY_EXHAUSTED"
      | "IDENTITY_CACHE_UNAVAILABLE"
      | "IDENTITY_COMMIT_OUTCOME_UNKNOWN",
    message: string
  ) {
    super(message);
    this.name = "OrganizationStrongIdentityError";
  }
}

type NormalizedClaim = {
  kind: OrganizationIdentityClaimKind;
  originalValue: string;
  normalizedValue: string;
  scheme: string;
  jurisdiction: string;
  entityType: OrganizationIdentityEntityType;
  subjectRef: string;
  normalizerVersion: string;
  validatorVersion: string;
  observedAt: string;
  authorityEligible: boolean;
};

type IdentifierKey = {
  kind: OrganizationStrongIdentifierKind;
  scheme: string;
  jurisdiction: string;
  normalizedValue: string;
  normalizedValueHash: string;
};

export type OrganizationIdentityResolutionIdentifierRelation = {
  identifierId: string;
  role: "matched_existing" | "accepted_existing" | "accepted_new";
  ordinal: number;
};

export type OrganizationIdentityResolutionBindingRelation = {
  bindingId: string;
  role: "reused_existing" | "created_new";
  ordinal: number;
};

export type OrganizationIdentityConflictOrganizationRelation = {
  organizationId: string;
  role: "identifier_match" | "existing_binding";
  ordinal: number;
};

export type OrganizationIdentityConflictKeyRelation = {
  identifierKey: string;
  keyType: "identifier_exact" | "identifier_slot" | "raw_binding";
  ordinal: number;
};

function invalid(message: string): never {
  throw new OrganizationStrongIdentityError("IDENTITY_INVALID", message);
}

function factConflict(message: string): never {
  throw new OrganizationStrongIdentityError(
    "IDENTITY_FACT_CONFLICT",
    message
  );
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    invalid("企业身份事实包含不可序列化的数据");
  }
  return result;
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function hmac(secret: string, value: unknown) {
  return createHmac("sha256", secret)
    .update(canonical(value))
    .digest("hex");
}

function factHash(secret: string | undefined, value: unknown) {
  return secret ? hmac(secret, value) : sha256(value);
}

function requireText(value: string, label: string, max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string"
    || !value.trim()
    || value.length > max) {
    invalid(`${label} 无效`);
  }
  return value.trim();
}

function normalizeIso(value: string, label: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) invalid(`${label} 不是有效时间`);
  return new Date(time).toISOString();
}

function normalizeName(value: string) {
  return requireText(value, "企业法定名称")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeDomain(value: string) {
  const raw = requireText(value, "企业官网域名", 4_096);
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)
        ? raw
        : `https://${raw}`
    );
    if (!["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.port) {
      invalid("企业官网只允许无凭据、无端口的 HTTP(S) 主机");
    }
    const ascii = domainToASCII(url.hostname.replace(/\.$/u, ""))
      .toLocaleLowerCase("en-US");
    if (!ascii
      || ascii.length > 253
      || !/^[a-z0-9.-]+$/u.test(ascii)
      || ascii.startsWith(".")
      || ascii.endsWith(".")
      || ascii.includes("..")) {
      invalid("企业官网域名无效");
    }
    return ascii;
  } catch (error) {
    if (error instanceof OrganizationStrongIdentityError) throw error;
    invalid("企业官网域名无效");
  }
}

function normalizeNamespace(value: string, label: string) {
  const normalized = requireText(value, label, 200)
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(normalized)) {
    invalid(`${label} 格式无效`);
  }
  return normalized;
}

function normalizeJurisdiction(value: string) {
  const normalized = requireText(value, "企业标识辖区", 100)
    .normalize("NFC")
    .toLocaleUpperCase("en-US");
  if (!/^[A-Z0-9][A-Z0-9._:-]*$/u.test(normalized)) {
    invalid("企业标识辖区格式无效");
  }
  return normalized;
}

function normalizeCanonicalIdentifier(value: string) {
  return requireText(value, "企业标识规范化值", 500)
    .normalize("NFC");
}

function validLei(value: string) {
  if (!/^[A-Z0-9]{20}$/u.test(value)) return false;
  const expanded = value
    .split("")
    .map((character) =>
      /[A-Z]/u.test(character)
        ? String(character.charCodeAt(0) - 55)
        : character
    )
    .join("");
  let remainder = 0;
  for (const character of expanded) {
    remainder = (remainder * 10 + Number(character)) % 97;
  }
  return remainder === 1;
}

export function normalizeOrganizationIdentityAuthorityProfile(
  profile: OrganizationIdentityAuthorityProfile
) {
  const normalized = {
    profileCode: requireText(profile.profileCode, "权威配置编码", 200),
    profileVersion: requireText(profile.profileVersion, "权威配置版本", 200),
    providerCode: requireText(profile.providerCode, "权威来源编码", 200),
    endpointCode: requireText(profile.endpointCode, "权威来源端点", 200),
    allowMultiIdentifierSubjectBinding:
      profile.allowMultiIdentifierSubjectBinding === true,
    rules: profile.rules
  };
  if (!Array.isArray(profile.rules)
    || !profile.rules.length
    || profile.rules.length > 100) {
    invalid("权威配置标识规则无效");
  }
  const rules = profile.rules.map((rule) => {
    if (!["lei", "registration_number", "vat"].includes(rule.kind)
      || !Array.isArray(rule.jurisdictions)
      || !rule.jurisdictions.length
      || !Array.isArray(rule.entityTypes)
      || !rule.entityTypes.length
      || !Array.isArray(rule.normalizerVersions)
      || !rule.normalizerVersions.length
      || !Array.isArray(rule.validatorVersions)
      || !rule.validatorVersions.length) {
      invalid("权威配置标识规则不完整");
    }
    return {
      kind: rule.kind,
      scheme: normalizeNamespace(rule.scheme, "权威标识体系"),
      jurisdictions: [...new Set(rule.jurisdictions.map((item) =>
        item === "*" ? "*" : normalizeJurisdiction(item)
      ))].sort(),
      entityTypes: [...new Set(rule.entityTypes)].sort(),
      normalizerVersions: [...new Set(rule.normalizerVersions.map((item) =>
        requireText(item, "权威规范化器版本", 200)
      ))].sort(),
      validatorVersions: [...new Set(rule.validatorVersions.map((item) =>
        requireText(item, "权威校验器版本", 200)
      ))].sort()
    };
  }).sort((left, right) => canonical(left).localeCompare(canonical(right)));
  return {
    ...normalized,
    rules
  };
}

export function organizationIdentityAuthorityProfileHash(
  profile: OrganizationIdentityAuthorityProfile
) {
  return sha256({
    contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    profileVersion: "organization-identity-authority-profile-v1",
    profile: normalizeOrganizationIdentityAuthorityProfile(profile)
  });
}

function matchingAuthorityRule(
  profile: ReturnType<typeof normalizeOrganizationIdentityAuthorityProfile>,
  claim: Omit<NormalizedClaim, "authorityEligible">,
  sourceMatches: boolean
) {
  if (!sourceMatches
    || !["lei", "registration_number", "vat"].includes(claim.kind)
    || !claim.subjectRef
    || claim.entityType !== "legal_entity") {
    return false;
  }
  return profile.rules.some((rule) =>
    rule.kind === claim.kind
    && rule.scheme === claim.scheme
    && (rule.jurisdictions.includes("*")
      || rule.jurisdictions.includes(claim.jurisdiction))
    && rule.entityTypes.includes(claim.entityType)
    && rule.normalizerVersions.includes(claim.normalizerVersion)
    && rule.validatorVersions.includes(claim.validatorVersion)
  );
}

function normalizeClaims(
  claims: OrganizationIdentityClaimInput[],
  profile: ReturnType<typeof normalizeOrganizationIdentityAuthorityProfile>,
  source: {
    providerCode: string;
    endpointCode: string;
  }
) {
  if (!Array.isArray(claims) || claims.length > MAX_CLAIMS) {
    invalid("企业身份声明数量无效或超过上限");
  }
  const sourceMatches =
    profile.providerCode === source.providerCode
    && profile.endpointCode === source.endpointCode;
  const prepared = claims.map((claim): NormalizedClaim => {
    if (!claim || typeof claim !== "object") {
      invalid("企业身份声明结构无效");
    }
    const originalValue = requireText(claim.value, "企业身份声明值");
    const normalizerVersion = requireText(
      claim.normalizerVersion,
      "声明规范化器版本",
      200
    );
    const validatorVersion = requireText(
      claim.validatorVersion,
      "声明校验器版本",
      200
    );
    const observedAt = normalizeIso(claim.observedAt, "声明采集时间");
    const subjectRef = typeof claim.subjectRef === "string"
      ? claim.subjectRef.trim().slice(0, 500)
      : "";
    let normalizedValue = "";
    let scheme = "";
    let jurisdiction = "";
    let entityType: OrganizationIdentityEntityType =
      claim.entityType || "unknown";
    if (claim.kind === "legal_name") {
      normalizedValue = normalizeName(originalValue);
      jurisdiction = claim.jurisdiction
        ? normalizeJurisdiction(claim.jurisdiction)
        : "";
      entityType = claim.entityType || "legal_entity";
    } else if (claim.kind === "official_domain") {
      normalizedValue = normalizeDomain(originalValue);
      scheme = "dns";
      entityType = claim.entityType || "unknown";
    } else if (claim.kind === "lei") {
      normalizedValue = originalValue
        .normalize("NFC")
        .toLocaleUpperCase("en-US");
      scheme = "iso-17442";
      jurisdiction = "GLOBAL";
      entityType = claim.entityType || "legal_entity";
    } else if (claim.kind === "registration_number"
      || claim.kind === "vat") {
      normalizedValue = normalizeCanonicalIdentifier(
        claim.normalizedValue || ""
      );
      scheme = normalizeNamespace(
        claim.scheme || "",
        "企业标识体系"
      );
      jurisdiction = normalizeJurisdiction(claim.jurisdiction || "");
    } else {
      invalid("企业身份声明类型无效");
    }
    const base = {
      kind: claim.kind,
      originalValue,
      normalizedValue,
      scheme,
      jurisdiction,
      entityType,
      subjectRef,
      normalizerVersion,
      validatorVersion,
      observedAt
    };
    const formatValid = claim.kind !== "lei" || validLei(normalizedValue);
    return {
      ...base,
      authorityEligible: formatValid
        && matchingAuthorityRule(profile, base, sourceMatches)
    };
  });

  const initiallyEligible = prepared.filter((claim) =>
    claim.authorityEligible
  );
  if (initiallyEligible.length > 1) {
    const subjects = new Set(initiallyEligible.map((claim) =>
      claim.subjectRef
    ));
    if (!profile.allowMultiIdentifierSubjectBinding
      || subjects.size !== 1) {
      for (const claim of prepared) claim.authorityEligible = false;
    }
  }

  const byCanonicalClaim = new Map<string, NormalizedClaim>();
  for (const claim of prepared) {
    const key = canonical({
      kind: claim.kind,
      normalizedValue: claim.normalizedValue,
      scheme: claim.scheme,
      jurisdiction: claim.jurisdiction,
      entityType: claim.entityType,
      subjectRef: claim.subjectRef,
      normalizerVersion: claim.normalizerVersion,
      validatorVersion: claim.validatorVersion,
      authorityEligible: claim.authorityEligible
    });
    const existing = byCanonicalClaim.get(key);
    if (!existing
      || canonical({
        originalValue: claim.originalValue,
        observedAt: claim.observedAt
      }) < canonical({
        originalValue: existing.originalValue,
        observedAt: existing.observedAt
      })) {
      byCanonicalClaim.set(key, claim);
    }
  }
  return [...byCanonicalClaim.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, claim]) => claim);
}

function claimSetHash(claims: readonly NormalizedClaim[]) {
  return sha256({
    contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    claims: claims.map((claim) => ({
      kind: claim.kind,
      normalizedValue: claim.normalizedValue,
      scheme: claim.scheme,
      jurisdiction: claim.jurisdiction,
      entityType: claim.entityType,
      subjectRef: claim.subjectRef,
      normalizerVersion: claim.normalizerVersion,
      validatorVersion: claim.validatorVersion,
      authorityEligible: claim.authorityEligible
    }))
  });
}

function identifierKey(
  claim: NormalizedClaim,
  teamId: string,
  lookupSecret?: string
): IdentifierKey {
  if (!["lei", "registration_number", "vat"].includes(claim.kind)) {
    invalid("非强标识不能建立企业身份索引");
  }
  return {
    kind: claim.kind as OrganizationStrongIdentifierKind,
    scheme: claim.scheme,
    jurisdiction: claim.jurisdiction,
    normalizedValue: claim.normalizedValue,
    normalizedValueHash: lookupSecret
      ? hmac(lookupSecret, {
          contract: "organization-identifier-lookup-v1",
          teamId,
          kind: claim.kind,
          scheme: claim.scheme,
          jurisdiction: claim.jurisdiction,
          normalizedValue: claim.normalizedValue
        })
      : sha256({
          version: "organization-identifier-value-v1",
          normalizedValue: claim.normalizedValue
        })
  };
}

function identifierSlotKey(value: Pick<
  IdentifierKey,
  "kind" | "scheme" | "jurisdiction"
>) {
  return canonical({
    kind: value.kind,
    scheme: value.scheme,
    jurisdiction: value.jurisdiction
  });
}

function identifierExactKey(value: IdentifierKey) {
  return canonical(value);
}

function organizationWithoutHash(organization: Organization) {
  const { organizationHash: _hash, ...withoutHash } = organization;
  return withoutHash;
}

function claimWithoutHash(claim: OrganizationIdentityClaim) {
  const { claimFactHash: _hash, ...withoutHash } = claim;
  return withoutHash;
}

function identifierWithoutHash(identifier: OrganizationAcceptedIdentifier) {
  const { identifierHash: _hash, ...withoutHash } = identifier;
  return withoutHash;
}

function resolutionWithoutHash(resolution: OrganizationIdentityResolution) {
  const { resolutionHash: _hash, ...withoutHash } = resolution;
  return withoutHash;
}

function bindingWithoutHash(binding: OrganizationSourceBinding) {
  const { bindingHash: _hash, ...withoutHash } = binding;
  return withoutHash;
}

function conflictWithoutHash(conflict: OrganizationIdentityConflict) {
  const { conflictHash: _hash, ...withoutHash } = conflict;
  return withoutHash;
}

export function organizationIdentityResolutionRelations(
  resolution: Pick<
    OrganizationIdentityResolution,
    | "matchedIdentifierIds"
    | "acceptedIdentifierIds"
    | "bindingId"
    | "bindingRelationRole"
  >
) {
  const matched = new Set(resolution.matchedIdentifierIds);
  const identifiers = [...new Set([
    ...resolution.matchedIdentifierIds,
    ...resolution.acceptedIdentifierIds
  ])]
    .sort()
    .map((
      identifierId,
      index
    ): OrganizationIdentityResolutionIdentifierRelation => ({
      identifierId,
      role: matched.has(identifierId)
        ? resolution.acceptedIdentifierIds.includes(identifierId)
          ? "accepted_existing"
          : "matched_existing"
        : "accepted_new",
      ordinal: index + 1
    }));
  const bindings: OrganizationIdentityResolutionBindingRelation[] =
    resolution.bindingId && resolution.bindingRelationRole
      ? [{
          bindingId: resolution.bindingId,
          role: resolution.bindingRelationRole,
          ordinal: 1
        }]
      : [];
  return { identifiers, bindings };
}

export function organizationIdentityResolutionRelationHash(
  resolution: Pick<
    OrganizationIdentityResolution,
    | "matchedIdentifierIds"
    | "acceptedIdentifierIds"
    | "bindingId"
    | "bindingRelationRole"
  >,
  integritySecret?: string
) {
  return factHash(integritySecret, {
    contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    relation: "resolution_relations",
    ...organizationIdentityResolutionRelations(resolution)
  });
}

function conflictKeyType(
  identifierKey: string
): OrganizationIdentityConflictKeyRelation["keyType"] {
  if (identifierKey.startsWith("raw-binding:")) return "raw_binding";
  try {
    const parsed = JSON.parse(identifierKey) as Record<string, unknown>;
    return Object.hasOwn(parsed, "normalizedValue")
      ? "identifier_exact"
      : "identifier_slot";
  } catch {
    return "identifier_slot";
  }
}

export function organizationIdentityConflictRelations(
  conflict: Pick<
    OrganizationIdentityConflict,
    "organizationIds" | "identifierKeys"
  >,
  matchedOrganizationIds: readonly string[],
  existingBindingOrganizationId: string
) {
  const organizations = [
    ...[...new Set(matchedOrganizationIds)].map((organizationId) => ({
      organizationId,
      role: "identifier_match" as const
    })),
    ...(existingBindingOrganizationId
      ? [{
          organizationId: existingBindingOrganizationId,
          role: "existing_binding" as const
        }]
      : [])
  ]
    .filter((item) => conflict.organizationIds.includes(item.organizationId))
    .sort((left, right) =>
      `${left.role}:${left.organizationId}`
        .localeCompare(`${right.role}:${right.organizationId}`)
    )
    .map((
      item,
      index
    ): OrganizationIdentityConflictOrganizationRelation => ({
      ...item,
      ordinal: index + 1
    }));
  const keys = [...new Set(conflict.identifierKeys)]
    .sort()
    .map((
      identifierKey,
      index
    ): OrganizationIdentityConflictKeyRelation => ({
      identifierKey,
      keyType: conflictKeyType(identifierKey),
      ordinal: index + 1
    }));
  return { organizations, keys };
}

export function organizationIdentityConflictRelationHash(
  relations: ReturnType<typeof organizationIdentityConflictRelations>,
  integritySecret?: string
) {
  return factHash(integritySecret, {
    contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    relation: "conflict_relations",
    ...relations
  });
}

function replayResult(
  store: CrmStore,
  resolution: OrganizationIdentityResolution,
  integritySecret?: string
): ResolveOrganizationStrongIdentityResult {
  if (resolution.resolutionHash !== factHash(integritySecret, {
    contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    fact: "resolution",
    ...resolutionWithoutHash(resolution)
  })) {
    factConflict("企业身份 Resolution 完整性校验失败");
  }
  const claims = store.organizationIdentityClaims
    .filter((item) => item.resolutionId === resolution.id)
    .sort((left, right) => left.ordinal - right.ordinal);
  const createdIdentifiers = store.organizationAcceptedIdentifiers
    .filter((item) => claims.some((claim) =>
      claim.id === item.sourceClaimId
    ));
  const binding = resolution.bindingId
    ? store.organizationSourceBindings.find((item) =>
        item.id === resolution.bindingId
        && item.teamId === resolution.teamId
        && item.ownerId === resolution.ownerId
      ) || null
    : null;
  const conflict = resolution.conflictId
    ? store.organizationIdentityConflicts.find((item) =>
        item.id === resolution.conflictId
        && item.teamId === resolution.teamId
        && item.ownerId === resolution.ownerId
      ) || null
    : null;
  const events = store.organizationIdentityEvents
    .filter((item) => item.resolutionId === resolution.id)
    .sort((left, right) => left.sequence - right.sequence);
  let previousEventHash = "";
  for (const event of events) {
    if (event.previousEventHash !== previousEventHash
      || event.eventHash !== factHash(integritySecret, {
        contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
        fact: "event",
        id: event.id,
        resolutionId: event.resolutionId,
        teamId: event.teamId,
        ownerId: event.ownerId,
        sequence: event.sequence,
        eventType: event.eventType,
        organizationId: event.organizationId,
        detailHash: event.detailHash,
        previousEventHash: event.previousEventHash,
        createdAt: event.createdAt
      })) {
      factConflict("企业身份 Event 链完整性校验失败");
    }
    previousEventHash = event.eventHash;
  }
  if (resolution.eventCount !== events.length
    || resolution.eventTailHash !== previousEventHash) {
    factConflict("企业身份 Resolution Event 摘要不一致");
  }
  const createdOrganization = resolution.result === "new_entity"
    ? store.organizations.find((item) =>
        item.id === resolution.organizationId
        && item.teamId === resolution.teamId
      ) || null
    : null;
  return structuredClone({
    idempotent: true,
    resolution,
    createdOrganization,
    claims,
    createdIdentifiers,
    binding,
    conflict,
    events
  });
}

function integrityViolation(message: string): never {
  throw new OrganizationStrongIdentityError(
    "IDENTITY_DATA_INTEGRITY_VIOLATION",
    message
  );
}

function assertUniqueIds(
  label: string,
  rows: readonly { id: string }[]
) {
  if (new Set(rows.map((item) => item.id)).size !== rows.length) {
    integrityViolation(`${label}存在重复主键`);
  }
}

export function validateOrganizationIdentityFacts(
  store: Pick<
    CrmStore,
    | "prospectSourceRawRecords"
    | "organizations"
    | "organizationIdentityClaims"
    | "organizationAcceptedIdentifiers"
    | "organizationIdentityResolutions"
    | "organizationSourceBindings"
    | "organizationIdentityConflicts"
    | "organizationIdentityEvents"
  >,
  integritySecret?: string
) {
  const groups = [
    ["Organization", store.organizations],
    ["Identity Claim", store.organizationIdentityClaims],
    ["Accepted Identifier", store.organizationAcceptedIdentifiers],
    ["Identity Resolution", store.organizationIdentityResolutions],
    ["Source Binding", store.organizationSourceBindings],
    ["Identity Conflict", store.organizationIdentityConflicts],
    ["Identity Event", store.organizationIdentityEvents]
  ] as const;
  for (const [label, rows] of groups) assertUniqueIds(label, rows);

  const rawByScope = new Map(store.prospectSourceRawRecords.map((item) => [
    `${item.teamId}\u0000${item.ownerId}\u0000${item.id}`,
    item
  ]));
  const organizationByScope = new Map(store.organizations.map((item) => [
    `${item.teamId}\u0000${item.id}`,
    item
  ]));
  const resolutionByScope = new Map(
    store.organizationIdentityResolutions.map((item) => [
      `${item.teamId}\u0000${item.ownerId}\u0000${item.id}`,
      item
    ])
  );
  const claimByScope = new Map(store.organizationIdentityClaims.map((item) => [
    `${item.teamId}\u0000${item.ownerId}\u0000${item.id}`,
    item
  ]));

  for (const organization of store.organizations) {
    if (organization.scopeType !== "team"
      || organization.scopeId !== organization.teamId
      || organization.organizationHash !== factHash(integritySecret, {
        contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
        fact: "organization",
        ...organizationWithoutHash(organization)
      })) {
      integrityViolation("Organization 作用域或完整性校验失败");
    }
  }

  for (const claim of store.organizationIdentityClaims) {
    if (!resolutionByScope.has(
      `${claim.teamId}\u0000${claim.ownerId}\u0000${claim.resolutionId}`
    )
      || !rawByScope.has(
        `${claim.teamId}\u0000${claim.ownerId}\u0000${claim.rawRecordId}`
      )
      || claim.claimFactHash !== factHash(integritySecret, {
        contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
        fact: "claim",
        ...claimWithoutHash(claim)
      })) {
      integrityViolation("Identity Claim 引用或完整性校验失败");
    }
  }

  for (const identifier of store.organizationAcceptedIdentifiers) {
    const claim = claimByScope.get(
      `${identifier.teamId}\u0000${identifier.sourceOwnerId}`
      + `\u0000${identifier.sourceClaimId}`
    );
    if (!organizationByScope.has(
      `${identifier.teamId}\u0000${identifier.organizationId}`
    )
      || !claim
      || claim.rawRecordId !== identifier.sourceRawRecordId
      || !rawByScope.has(
        `${identifier.teamId}\u0000${identifier.sourceOwnerId}`
        + `\u0000${identifier.sourceRawRecordId}`
      )
      || identifier.identifierHash !== factHash(integritySecret, {
        contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
        fact: "accepted_identifier",
        ...identifierWithoutHash(identifier)
      })) {
      integrityViolation("Accepted Identifier 引用或完整性校验失败");
    }
  }

  for (const binding of store.organizationSourceBindings) {
    if (!resolutionByScope.has(
      `${binding.teamId}\u0000${binding.ownerId}`
      + `\u0000${binding.resolutionId}`
    )
      || !organizationByScope.has(
        `${binding.teamId}\u0000${binding.organizationId}`
      )
      || !rawByScope.has(
        `${binding.teamId}\u0000${binding.ownerId}`
        + `\u0000${binding.rawRecordId}`
      )
      || binding.bindingHash !== factHash(integritySecret, {
        contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
        fact: "source_binding",
        ...bindingWithoutHash(binding)
      })) {
      integrityViolation("Source Binding 引用或完整性校验失败");
    }
  }

  for (const conflict of store.organizationIdentityConflicts) {
    if (!resolutionByScope.has(
      `${conflict.teamId}\u0000${conflict.ownerId}`
      + `\u0000${conflict.resolutionId}`
    )
      || !rawByScope.has(
        `${conflict.teamId}\u0000${conflict.ownerId}`
        + `\u0000${conflict.rawRecordId}`
      )
      || conflict.organizationIds.some((organizationId) =>
        !organizationByScope.has(`${conflict.teamId}\u0000${organizationId}`)
      )
      || conflict.conflictHash !== factHash(integritySecret, {
        contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
        fact: "conflict",
        ...conflictWithoutHash(conflict)
      })) {
      integrityViolation("Identity Conflict 引用或完整性校验失败");
    }
  }

  const processingKeys = new Set<string>();
  for (const resolution of store.organizationIdentityResolutions) {
    const processingScope = `${resolution.teamId}\u0000${resolution.ownerId}`
      + `\u0000${resolution.processingKeyHash}`;
    if (processingKeys.has(processingScope)) {
      integrityViolation("Identity Resolution 处理键不唯一");
    }
    processingKeys.add(processingScope);
    const claims = store.organizationIdentityClaims
      .filter((item) =>
        item.teamId === resolution.teamId
        && item.ownerId === resolution.ownerId
        && item.resolutionId === resolution.id
      )
      .sort((left, right) => left.ordinal - right.ordinal);
    if (!claims.length
      || claims.some((claim, index) =>
        claim.ordinal !== index + 1
        || claim.rawRecordId !== resolution.rawRecordId
        || claim.claimHash !== resolution.claimHash
      )) {
      integrityViolation("Identity Resolution Claim 图不完整");
    }
    const recomputedClaimHash = claimSetHash(claims.map((claim) => ({
      kind: claim.kind,
      originalValue: claim.originalValue,
      normalizedValue: claim.normalizedValue,
      scheme: claim.scheme,
      jurisdiction: claim.jurisdiction,
      entityType: claim.entityType,
      subjectRef: claim.subjectRef,
      normalizerVersion: claim.normalizerVersion,
      validatorVersion: claim.validatorVersion,
      observedAt: claim.observedAt,
      authorityEligible:
        claim.classification === "strong_identifier_eligible"
    })));
    if (recomputedClaimHash !== resolution.claimHash
      || resolution.relationHash
        !== organizationIdentityResolutionRelationHash(
          resolution,
          integritySecret
        )) {
      integrityViolation("Identity Resolution 声明或关系摘要不一致");
    }
    if (resolution.organizationId
      && !organizationByScope.has(
        `${resolution.teamId}\u0000${resolution.organizationId}`
      )) {
      integrityViolation("Identity Resolution Organization 引用无效");
    }
    if (resolution.bindingId
      && !store.organizationSourceBindings.some((item) =>
        item.id === resolution.bindingId
        && item.teamId === resolution.teamId
        && item.ownerId === resolution.ownerId
      )) {
      integrityViolation("Identity Resolution Binding 引用无效");
    }
    if (resolution.conflictId
      && !store.organizationIdentityConflicts.some((item) =>
        item.id === resolution.conflictId
        && item.teamId === resolution.teamId
        && item.ownerId === resolution.ownerId
      )) {
      integrityViolation("Identity Resolution Conflict 引用无效");
    }
    try {
      replayResult(store as CrmStore, resolution, integritySecret);
    } catch (error) {
      if (error instanceof OrganizationStrongIdentityError) {
        integrityViolation(error.message);
      }
      throw error;
    }
  }

  const resolutionIds = new Set(
    store.organizationIdentityResolutions.map((item) =>
      `${item.teamId}\u0000${item.ownerId}\u0000${item.id}`
    )
  );
  if (store.organizationIdentityEvents.some((event) =>
    !resolutionIds.has(
      `${event.teamId}\u0000${event.ownerId}\u0000${event.resolutionId}`
    )
  )) {
    integrityViolation("Identity Event 存在孤立 Resolution 引用");
  }
}

function withTeamLock<T>(teamId: string, operation: () => T) {
  if (activeTeamLocks.has(teamId)) {
    throw new OrganizationStrongIdentityError(
      "IDENTITY_TEAM_BUSY",
      "当前团队正在提交企业身份事实"
    );
  }
  activeTeamLocks.add(teamId);
  try {
    return operation();
  } finally {
    activeTeamLocks.delete(teamId);
  }
}

function eventRows(input: {
  resolutionId: string;
  teamId: string;
  ownerId: string;
  organizationId: string;
  createdAt: string;
  integritySecret?: string;
  events: Array<{
    eventType: OrganizationIdentityEvent["eventType"];
    detail: unknown;
  }>;
}) {
  let previousEventHash = "";
  return input.events.map((event, index): OrganizationIdentityEvent => {
    const row: OrganizationIdentityEvent = {
      id: `oie_${sha256({
      version: "organization-identity-event-id-v1",
      resolutionId: input.resolutionId,
      sequence: index + 1
    }).slice(0, 40)}`,
    resolutionId: input.resolutionId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    sequence: index + 1,
    eventType: event.eventType,
    organizationId: input.organizationId,
    detailHash: sha256({
      contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
      eventType: event.eventType,
      detail: event.detail
    }),
    previousEventHash,
    eventHash: "",
    createdAt: input.createdAt
    };
    row.eventHash = factHash(input.integritySecret, {
      contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
      fact: "event",
      id: row.id,
      resolutionId: row.resolutionId,
      teamId: row.teamId,
      ownerId: row.ownerId,
      sequence: row.sequence,
      eventType: row.eventType,
      organizationId: row.organizationId,
      detailHash: row.detailHash,
      previousEventHash: row.previousEventHash,
      createdAt: row.createdAt
    });
    previousEventHash = row.eventHash;
    return row;
  });
}

function commitFacts(
  store: CrmStore,
  facts: {
    organizations: Organization[];
    claims: OrganizationIdentityClaim[];
    identifiers: OrganizationAcceptedIdentifier[];
    resolutions: OrganizationIdentityResolution[];
    bindings: OrganizationSourceBinding[];
    conflicts: OrganizationIdentityConflict[];
    events: OrganizationIdentityEvent[];
  }
) {
  const lengths = {
    organizations: store.organizations.length,
    claims: store.organizationIdentityClaims.length,
    identifiers: store.organizationAcceptedIdentifiers.length,
    resolutions: store.organizationIdentityResolutions.length,
    bindings: store.organizationSourceBindings.length,
    conflicts: store.organizationIdentityConflicts.length,
    events: store.organizationIdentityEvents.length
  };
  try {
    store.organizations.push(...facts.organizations);
    store.organizationIdentityClaims.push(...facts.claims);
    store.organizationAcceptedIdentifiers.push(...facts.identifiers);
    store.organizationIdentityResolutions.push(...facts.resolutions);
    store.organizationSourceBindings.push(...facts.bindings);
    store.organizationIdentityConflicts.push(...facts.conflicts);
    store.organizationIdentityEvents.push(...facts.events);
  } catch (error) {
    store.organizations.splice(lengths.organizations);
    store.organizationIdentityClaims.splice(lengths.claims);
    store.organizationAcceptedIdentifiers.splice(lengths.identifiers);
    store.organizationIdentityResolutions.splice(lengths.resolutions);
    store.organizationSourceBindings.splice(lengths.bindings);
    store.organizationIdentityConflicts.splice(lengths.conflicts);
    store.organizationIdentityEvents.splice(lengths.events);
    throw error;
  }
}

export function resolveOrganizationStrongIdentity(
  store: CrmStore,
  rawInput: ResolveOrganizationStrongIdentityInput
): ResolveOrganizationStrongIdentityResult {
  if (store.mode === "mysql") {
    throw new OrganizationStrongIdentityError(
      "IDENTITY_MYSQL_TRANSACTION_REQUIRED",
      "MySQL 企业身份事实只能通过专用事务提交"
    );
  }
  if (rawInput.resolverVersion !== ORGANIZATION_STRONG_IDENTITY_CONTRACT) {
    invalid("企业强身份 Resolver 合同版本无效");
  }
  const identitySecret = requireText(
    rawInput.identitySecret,
    "企业身份幂等密钥",
    10_000
  );
  if (Buffer.byteLength(identitySecret, "utf8") < 32) {
    invalid("企业身份幂等密钥至少需要 32 字节");
  }
  const processingSecret = rawInput.processingSecret || identitySecret;
  const deterministicIdSecret =
    rawInput.deterministicIdSecret || identitySecret;
  const identifierLookupSecret = rawInput.identifierLookupSecret;
  const factIntegritySecret = rawInput.factIntegritySecret;
  const teamId = requireText(rawInput.teamId, "企业身份团队", 200);
  const ownerId = requireText(rawInput.ownerId, "企业身份负责人", 200);
  const rawRecordId = requireText(
    rawInput.rawRecordId,
    "Provider 原始记录标识",
    500
  );
  const parserVersion = requireText(
    rawInput.parserVersion,
    "企业身份解析器版本",
    200
  );
  const normalizerVersion = requireText(
    rawInput.normalizerVersion,
    "企业身份规范化版本",
    200
  );
  const resolvedAt = normalizeIso(rawInput.resolvedAt, "企业身份处理时间");
  const authorityProfile = normalizeOrganizationIdentityAuthorityProfile(
    rawInput.authorityProfile
  );
  const authorityProfileHash = organizationIdentityAuthorityProfileHash(
    authorityProfile
  );
  const rawSnapshot = readProspectSourceRawRecord(store, {
    teamId,
    ownerId,
    recordId: rawRecordId,
    envelopeSecret: rawInput.envelopeSecret
  });
  const immutableRaw = structuredClone(rawSnapshot.record);
  const normalizedClaims = normalizeClaims(
    rawInput.claims,
    authorityProfile,
    immutableRaw
  );
  const claimHash = claimSetHash(normalizedClaims);
  const processingKeyHash = hmac(processingSecret, {
    contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    derivationVersion: "organization-processing-key-v1",
    teamId,
    ownerId,
    rawRecordId,
    rawArtifactHash: immutableRaw.artifactHash,
    resolverVersion: rawInput.resolverVersion,
    parserVersion,
    normalizerVersion,
    authorityProfileCode: authorityProfile.profileCode,
    authorityProfileVersion: authorityProfile.profileVersion,
    authorityProfileCanonicalHash: authorityProfileHash
  });

  return withTeamLock(teamId, () => {
    const existingResolutions =
      store.organizationIdentityResolutions.filter((item) =>
        item.processingKeyHash === processingKeyHash
        && item.teamId === teamId
        && item.ownerId === ownerId
      );
    if (existingResolutions.length > 1) {
      factConflict("同一企业身份处理键存在多个 Resolution");
    }
    if (existingResolutions.length === 1) {
      const existing = existingResolutions[0]!;
      if (existing.claimHash !== claimHash) {
        throw new OrganizationStrongIdentityError(
          "IDENTITY_CLAIM_REPLAY_CONFLICT",
          "同一 Provider 原始工件在相同处理版本下产生了不同身份声明"
        );
      }
      return replayResult(store, existing, factIntegritySecret);
    }

    const resolutionId = `oir_${processingKeyHash.slice(0, 40)}`;
    if (store.organizationIdentityResolutions.some((item) =>
      item.id === resolutionId
    )) {
      factConflict("企业身份 Resolution 标识已被其它事实占用");
    }

    const claimRows = normalizedClaims.map((
      claim,
      index
    ): OrganizationIdentityClaim => {
      const row: OrganizationIdentityClaim = {
        id: `oic_${sha256({
        version: "organization-identity-claim-id-v1",
        resolutionId,
        ordinal: index + 1
      }).slice(0, 40)}`,
      resolutionId,
      teamId,
      ownerId,
      rawRecordId,
      ordinal: index + 1,
      kind: claim.kind,
      originalValue: claim.originalValue,
      normalizedValue: claim.normalizedValue,
      scheme: claim.scheme,
      jurisdiction: claim.jurisdiction,
      entityType: claim.entityType,
      subjectRef: claim.subjectRef,
      classification: ["legal_name", "official_domain"].includes(claim.kind)
        ? "association_fact"
        : claim.authorityEligible
          ? "strong_identifier_eligible"
          : "strong_identifier_unverified",
      normalizerVersion: claim.normalizerVersion,
      validatorVersion: claim.validatorVersion,
      authorityProfileCode: authorityProfile.profileCode,
      observedAt: claim.observedAt,
      claimHash,
      claimFactHash: "",
      createdAt: resolvedAt
      };
      row.claimFactHash = factHash(factIntegritySecret, {
        contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
        fact: "claim",
        ...claimWithoutHash(row)
      });
      return row;
    });
    const eligibleClaims = normalizedClaims.filter((claim) =>
      claim.authorityEligible
    );
    const eligibleKeys = eligibleClaims.map((claim) =>
      identifierKey(claim, teamId, identifierLookupSecret)
    );
    const exactKeyToClaim = new Map<string, OrganizationIdentityClaim>();
    for (const claim of claimRows) {
      if (claim.classification !== "strong_identifier_eligible") continue;
      const normalized = normalizedClaims[claim.ordinal - 1]!;
      exactKeyToClaim.set(
        identifierExactKey(identifierKey(
          normalized,
          teamId,
          identifierLookupSecret
        )),
        claim
      );
    }

    const existingBindings = store.organizationSourceBindings.filter((item) =>
      item.teamId === teamId
      && item.ownerId === ownerId
      && item.rawRecordId === rawRecordId
      && item.status === "active"
    );
    if (existingBindings.length > 1) {
      factConflict("同一 Provider 原始记录存在多个活动企业绑定");
    }
    const existingBinding = existingBindings[0] || null;

    const matchedIdentifiers: OrganizationAcceptedIdentifier[] = [];
    const matchedOrganizationIds = new Set<string>();
    for (const key of eligibleKeys) {
      const hashMatches = store.organizationAcceptedIdentifiers.filter((item) =>
        item.teamId === teamId
        && item.status === "active"
        && item.kind === key.kind
        && item.scheme === key.scheme
        && item.jurisdiction === key.jurisdiction
        && item.normalizedValueHash === key.normalizedValueHash
      );
      for (const identifier of hashMatches) {
        if (identifier.normalizedValue !== key.normalizedValue) {
          throw new OrganizationStrongIdentityError(
            "IDENTITY_IDENTIFIER_HASH_COLLISION",
            "企业强标识摘要冲突，已拒绝自动合并"
          );
        }
        matchedIdentifiers.push(identifier);
        matchedOrganizationIds.add(identifier.organizationId);
      }
    }
    const duplicateStoredIdentifier = matchedIdentifiers.some((
      identifier,
      index
    ) => matchedIdentifiers.some((other, otherIndex) =>
      otherIndex !== index
      && other.id !== identifier.id
      && other.teamId === identifier.teamId
      && other.kind === identifier.kind
      && other.scheme === identifier.scheme
      && other.jurisdiction === identifier.jurisdiction
      && other.normalizedValue === identifier.normalizedValue
    ));
    if (duplicateStoredIdentifier) {
      factConflict("企业强标识唯一索引存在重复事实");
    }

    let conflictType: OrganizationIdentityConflict["conflictType"] | "" = "";
    const conflictKeys = new Set<string>();
    const incomingBySlot = new Map<string, Set<string>>();
    for (const key of eligibleKeys) {
      const slot = identifierSlotKey(key);
      const values = incomingBySlot.get(slot) || new Set<string>();
      values.add(key.normalizedValue);
      incomingBySlot.set(slot, values);
      if (values.size > 1) {
        conflictType = "identifier_slot_conflict";
        conflictKeys.add(slot);
      }
    }
    if (matchedOrganizationIds.size > 1) {
      conflictType = "identifier_split";
      for (const key of eligibleKeys) {
        conflictKeys.add(identifierExactKey(key));
      }
    }
    if (existingBinding
      && (matchedOrganizationIds.size > 1
        || (matchedOrganizationIds.size === 1
          && !matchedOrganizationIds.has(existingBinding.organizationId)))) {
      conflictType = "binding_conflict";
      conflictKeys.add(`raw-binding:${existingBinding.id}`);
    }

    let targetOrganizationId = "";
    if (!conflictType && existingBinding) {
      targetOrganizationId = existingBinding.organizationId;
    } else if (!conflictType && matchedOrganizationIds.size === 1) {
      targetOrganizationId = [...matchedOrganizationIds][0]!;
    }
    if (!conflictType && targetOrganizationId) {
      const existingTarget = store.organizations.filter((item) =>
        item.id === targetOrganizationId
        && item.teamId === teamId
        && item.status === "active"
      );
      if (existingTarget.length !== 1) {
        factConflict("企业强标识引用的 Organization 不存在或不唯一");
      }
      const targetIdentifiers =
        store.organizationAcceptedIdentifiers.filter((item) =>
          item.organizationId === targetOrganizationId
          && item.teamId === teamId
          && item.status === "active"
        );
      for (const key of eligibleKeys) {
        const slot = identifierSlotKey(key);
        const incompatible = targetIdentifiers.some((item) =>
          identifierSlotKey(item) === slot
          && item.normalizedValue !== key.normalizedValue
        );
        if (incompatible) {
          conflictType = "identifier_slot_conflict";
          conflictKeys.add(slot);
        }
      }
    }

    const facts = {
      organizations: [] as Organization[],
      claims: claimRows,
      identifiers: [] as OrganizationAcceptedIdentifier[],
      resolutions: [] as OrganizationIdentityResolution[],
      bindings: [] as OrganizationSourceBinding[],
      conflicts: [] as OrganizationIdentityConflict[],
      events: [] as OrganizationIdentityEvent[]
    };
    let result: OrganizationIdentityResolution["result"];
    let decisionReasonCode = "";
    let conflictId = "";
    let binding = existingBinding;

    if (!eligibleClaims.length) {
      result = "insufficient_identity";
      decisionReasonCode = "NO_AUTHORIZED_STRONG_IDENTIFIER";
    } else if (conflictType) {
      result = "conflict";
      decisionReasonCode = conflictType.toLocaleUpperCase("en-US");
      conflictId = `oif_${sha256({
        version: "organization-identity-conflict-id-v1",
        resolutionId
      }).slice(0, 40)}`;
      const conflict: OrganizationIdentityConflict = {
        id: conflictId,
        resolutionId,
        teamId,
        ownerId,
        rawRecordId,
        conflictType,
        organizationIds: [...new Set([
          ...matchedOrganizationIds,
          ...(existingBinding ? [existingBinding.organizationId] : [])
        ])].sort(),
        identifierKeys: [...conflictKeys].sort(),
        status: "open",
        relationHash: "",
        conflictHash: "",
        createdAt: resolvedAt
      };
      conflict.relationHash = organizationIdentityConflictRelationHash(
        organizationIdentityConflictRelations(
          conflict,
          [...matchedOrganizationIds],
          existingBinding?.organizationId || ""
        ),
        factIntegritySecret
      );
      conflict.conflictHash = factHash(factIntegritySecret, {
        contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
        fact: "conflict",
        ...conflictWithoutHash(conflict)
      });
      facts.conflicts.push(conflict);
    } else {
      if (!targetOrganizationId) {
        const firstKey = [...eligibleKeys]
          .sort((left, right) =>
            identifierExactKey(left).localeCompare(identifierExactKey(right))
          )[0]!;
        targetOrganizationId = `org_${hmac(deterministicIdSecret, {
          version: "organization-id-v1",
          teamId,
          firstIdentifier: firstKey
        }).slice(0, 40)}`;
        if (store.organizations.some((item) =>
          item.id === targetOrganizationId
        )) {
          factConflict("Organization 标识已被其它事实占用");
        }
        const subjectRef = eligibleClaims[0]?.subjectRef || "";
        const nameClaim = normalizedClaims.find((claim) =>
          claim.kind === "legal_name"
          && (!subjectRef || claim.subjectRef === subjectRef)
        ) || normalizedClaims.find((claim) =>
          claim.kind === "legal_name"
        );
        const organization: Organization = {
          id: targetOrganizationId,
          teamId,
          scopeType: "team",
          scopeId: teamId,
          status: "active",
          legalName: nameClaim?.originalValue || "",
          normalizedName: nameClaim?.normalizedValue || "",
          organizationHash: "",
          createdAt: resolvedAt
        };
        organization.organizationHash = factHash(factIntegritySecret, {
          contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
          fact: "organization",
          ...organizationWithoutHash(organization)
        });
        facts.organizations.push(organization);
        result = "new_entity";
        decisionReasonCode = "AUTHORIZED_STRONG_IDENTIFIER_NEW_ENTITY";
      } else {
        result = "exact_match";
        decisionReasonCode = "AUTHORIZED_STRONG_IDENTIFIER_EXACT_MATCH";
      }

      for (const key of eligibleKeys) {
        const existing = matchedIdentifiers.find((item) =>
          item.organizationId === targetOrganizationId
          && item.kind === key.kind
          && item.scheme === key.scheme
          && item.jurisdiction === key.jurisdiction
          && item.normalizedValue === key.normalizedValue
        );
        if (existing) continue;
        const sourceClaim = exactKeyToClaim.get(identifierExactKey(key));
        if (!sourceClaim) {
          factConflict("企业强标识缺少对应来源 Claim");
        }
        const identifier: OrganizationAcceptedIdentifier = {
          id: `oai_${hmac(deterministicIdSecret, {
            version: "organization-accepted-identifier-id-v1",
            teamId,
            key
          }).slice(0, 40)}`,
          organizationId: targetOrganizationId,
          teamId,
          kind: key.kind,
          scheme: key.scheme,
          jurisdiction: key.jurisdiction,
          normalizedValue: key.normalizedValue,
          normalizedValueHash: key.normalizedValueHash,
          sourceClaimId: sourceClaim.id,
          sourceRawRecordId: rawRecordId,
          sourceOwnerId: ownerId,
          authorityProfileCode: authorityProfile.profileCode,
          authorityProfileVersion: authorityProfile.profileVersion,
          status: "active",
          identifierHash: "",
          createdAt: resolvedAt
        };
        if (store.organizationAcceptedIdentifiers.some((item) =>
          item.id === identifier.id
        )) {
          factConflict("企业强标识标识符已被其它事实占用");
        }
        identifier.identifierHash = factHash(factIntegritySecret, {
          contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
          fact: "accepted_identifier",
          ...identifierWithoutHash(identifier)
        });
        facts.identifiers.push(identifier);
      }

      if (!binding) {
        const bindingId = `osb_${hmac(deterministicIdSecret, {
          version: "organization-source-binding-id-v1",
          teamId,
          ownerId,
          rawRecordId
        }).slice(0, 40)}`;
        if (store.organizationSourceBindings.some((item) =>
          item.id === bindingId
        )) {
          factConflict("Provider 原始记录绑定标识已被其它事实占用");
        }
        binding = {
          id: bindingId,
          organizationId: targetOrganizationId,
          resolutionId,
          teamId,
          ownerId,
          rawRecordId,
          status: "active",
          bindingHash: "",
          createdAt: resolvedAt
        };
        binding.bindingHash = factHash(factIntegritySecret, {
          contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
          fact: "source_binding",
          ...bindingWithoutHash(binding)
        });
        facts.bindings.push(binding);
      }
    }

    const acceptedIdentifierIds = [...new Set([
      ...matchedIdentifiers
        .filter((item) => item.organizationId === targetOrganizationId)
        .map((item) => item.id),
      ...facts.identifiers.map((item) => item.id)
    ])].sort();
    const resolution: OrganizationIdentityResolution = {
      id: resolutionId,
      teamId,
      ownerId,
      rawRecordId,
      rawArtifactHash: immutableRaw.artifactHash,
      processingKeyHash,
      claimHash,
      resolverContractVersion: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
      parserVersion,
      normalizerVersion,
      authorityProfileCode: authorityProfile.profileCode,
      authorityProfileVersion: authorityProfile.profileVersion,
      authorityProfileHash,
      result,
      decisionReasonCode,
      organizationId: result === "new_entity" || result === "exact_match"
        ? targetOrganizationId
        : "",
      bindingId: result === "new_entity" || result === "exact_match"
        ? binding?.id || ""
        : "",
      conflictId,
      matchedIdentifierIds: [...new Set(
        matchedIdentifiers.map((item) => item.id)
      )].sort(),
      acceptedIdentifierIds,
      bindingRelationRole:
        (result === "new_entity" || result === "exact_match") && binding
        ? facts.bindings.length
          ? "created_new"
          : "reused_existing"
        : "",
      relationHash: "",
      eventCount: 0,
      eventTailHash: "",
      resolutionHash: "",
      createdAt: resolvedAt
    };
    resolution.relationHash = organizationIdentityResolutionRelationHash(
      resolution,
      factIntegritySecret
    );

    const stagedEvents: Parameters<typeof eventRows>[0]["events"] = [];
    if (result === "new_entity") {
      stagedEvents.push({
        eventType: "organization_created",
        detail: { organizationId: targetOrganizationId }
      });
    } else if (result === "exact_match") {
      stagedEvents.push({
        eventType: "organization_matched",
        detail: {
          organizationId: targetOrganizationId,
          matchedIdentifierIds: resolution.matchedIdentifierIds
        }
      });
    } else if (result === "insufficient_identity") {
      stagedEvents.push({
        eventType: "identity_insufficient",
        detail: { decisionReasonCode }
      });
    } else {
      stagedEvents.push({
        eventType: "identity_conflict_recorded",
        detail: { conflictId, decisionReasonCode }
      });
    }
    for (const identifier of facts.identifiers) {
      stagedEvents.push({
        eventType: "identifier_accepted",
        detail: {
          identifierId: identifier.id,
          organizationId: identifier.organizationId
        }
      });
    }
    if (facts.bindings.length) {
      stagedEvents.push({
        eventType: "source_bound",
        detail: {
          bindingId: facts.bindings[0]!.id,
          organizationId: targetOrganizationId
        }
      });
    }
    stagedEvents.push({
      eventType: "resolution_recorded",
      detail: {
        resolutionId,
        result,
        claimHash
      }
    });
    facts.events.push(...eventRows({
      resolutionId,
      teamId,
      ownerId,
      organizationId: resolution.organizationId,
      createdAt: resolvedAt,
      integritySecret: factIntegritySecret,
      events: stagedEvents
    }));
    resolution.eventCount = facts.events.length;
    resolution.eventTailHash =
      facts.events[facts.events.length - 1]?.eventHash || "";
    resolution.resolutionHash = factHash(factIntegritySecret, {
      contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
      fact: "resolution",
      ...resolutionWithoutHash(resolution)
    });
    facts.resolutions.push(resolution);

    commitFacts(store, facts);
    return structuredClone({
      idempotent: false,
      resolution,
      createdOrganization: facts.organizations[0] || null,
      claims: claimRows,
      createdIdentifiers: facts.identifiers,
      binding: resolution.bindingId ? binding || null : null,
      conflict: facts.conflicts[0] || null,
      events: facts.events
    });
  });
}
