import assert from "node:assert/strict";
import {
  ORGANIZATION_STRONG_IDENTITY_CONTRACT,
  OrganizationStrongIdentityError,
  resolveOrganizationStrongIdentity
} from "./organization-strong-identity.js";
import type {
  OrganizationIdentityAuthorityProfile,
  OrganizationIdentityClaimInput,
  ResolveOrganizationStrongIdentityInput
} from "./organization-strong-identity.js";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
  ProspectSourceRawError,
  appendProspectSourceRawBatch,
  prospectProviderRawArtifactHash
} from "./prospect-source-raw.js";
import type {
  ProspectProviderSourceRecordInput
} from "./prospect-source-raw.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";

const store = getStore();
const envelopeSecret = "organization-raw-envelope-secret-".repeat(2);
const rawIdentitySecret = "organization-raw-identity-secret-".repeat(2);
const organizationIdentitySecret =
  "organization-strong-identity-secret-".repeat(2);
const observedAt = "2026-07-14T02:00:00.000Z";
let sequence = 0;
let resolutionSequence = 0;

const rawArrayNames = [
  "prospectSourceRawBatches",
  "prospectSourceRawRecords",
  "prospectSourceRawHits"
] as const;
const identityArrayNames = [
  "organizations",
  "organizationIdentityClaims",
  "organizationAcceptedIdentifiers",
  "organizationIdentityResolutions",
  "organizationSourceBindings",
  "organizationIdentityConflicts",
  "organizationIdentityEvents"
] as const;
const protectedBusinessArrayNames = [
  "leads",
  "leadActivities",
  "customers",
  "customerActivities",
  "deals",
  "dealEvents",
  "websiteOpportunities",
  "prospectSearchRuns",
  "prospectExecutionKernelStates",
  "marketOpportunitySnapshots"
] as const;

type StoreArrayName =
  | typeof rawArrayNames[number]
  | typeof identityArrayNames[number]
  | typeof protectedBusinessArrayNames[number];

function snapshotArrays(names: readonly StoreArrayName[]) {
  return Object.fromEntries(names.map((name) => [
    name,
    structuredClone(store[name])
  ])) as Partial<Record<StoreArrayName, unknown[]>>;
}

function restoreArrays(
  names: readonly StoreArrayName[],
  snapshot: Partial<Record<StoreArrayName, unknown[]>>
) {
  for (const name of names) {
    const target = store[name] as unknown[];
    const values = snapshot[name];
    assert.ok(values, `Missing test snapshot for ${name}`);
    target.splice(0, target.length, ...values);
  }
}

function identityFacts(target: CrmStore = store) {
  return {
    organizations: structuredClone(target.organizations),
    claims: structuredClone(target.organizationIdentityClaims),
    identifiers: structuredClone(
      target.organizationAcceptedIdentifiers
    ),
    resolutions: structuredClone(
      target.organizationIdentityResolutions
    ),
    bindings: structuredClone(target.organizationSourceBindings),
    conflicts: structuredClone(target.organizationIdentityConflicts),
    events: structuredClone(target.organizationIdentityEvents)
  };
}

type RawFixture = {
  teamId: string;
  ownerId: string;
  recordId: string;
  providerCode: string;
  endpointCode: string;
};

function createRaw(
  teamId: string,
  ownerId: string,
  payload: unknown = {},
  sourceOverrides: Partial<ProspectProviderSourceRecordInput> = {},
  providerCode = "identity.test-provider",
  endpointCode = "company-identity"
): RawFixture {
  sequence += 1;
  const suffix = String(sequence).padStart(4, "0");
  const fetchedAt = new Date(
    Date.UTC(2026, 6, 14, 2, 0, sequence)
  ).toISOString();
  const sourceRecords: ProspectProviderSourceRecordInput[] = [{
    providerRecordId: `identity-record-${suffix}`,
    sourceUrl: `https://identity.example.test/company/${suffix}`,
    fetchedAt,
    payload,
    ...sourceOverrides
  }];
  const result = appendProspectSourceRawBatch(store, {
    teamId,
    ownerId,
    runId: `identity-run-${suffix}`,
    shardId: `identity-shard-${suffix}`,
    jobId: `identity-job-${suffix}`,
    attemptId: `identity-attempt-${suffix}`,
    ledgerId: `identity-ledger-${suffix}`,
    pageId: `identity-page-${suffix}`,
    providerCode,
    connectionId: `${providerCode}:default`,
    endpointCode,
    adapterVersion: "identity-test-adapter-v1",
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    responseHash: sequence.toString(16).padStart(64, "0"),
    settlementHash: (sequence + 10_000).toString(16).padStart(64, "0"),
    rawArtifactHash: prospectProviderRawArtifactHash(sourceRecords),
    sourceRecords,
    policy: {
      licensePolicy: "identity-test-public-api",
      retentionPolicy: "identity-test-30-days",
      retentionDays: 30
    },
    envelopeSecret,
    identitySecret: rawIdentitySecret,
    createdAt: fetchedAt
  });
  return {
    teamId,
    ownerId,
    recordId: result.records[0]!.id,
    providerCode,
    endpointCode
  };
}

function authorityProfile(
  overrides: Partial<OrganizationIdentityAuthorityProfile> = {}
): OrganizationIdentityAuthorityProfile {
  return {
    profileCode: "identity-authority-test",
    profileVersion: "v1",
    providerCode: "identity.test-provider",
    endpointCode: "company-identity",
    allowMultiIdentifierSubjectBinding: true,
    rules: [
      {
        kind: "lei",
        scheme: "iso-17442",
        jurisdictions: ["GLOBAL"],
        entityTypes: ["legal_entity"],
        normalizerVersions: ["claim-norm-v1"],
        validatorVersions: ["claim-validator-v1"]
      },
      {
        kind: "registration_number",
        scheme: "registry-a",
        jurisdictions: ["DE", "FR"],
        entityTypes: ["legal_entity"],
        normalizerVersions: ["claim-norm-v1"],
        validatorVersions: ["claim-validator-v1"]
      },
      {
        kind: "registration_number",
        scheme: "registry-b",
        jurisdictions: ["DE"],
        entityTypes: ["legal_entity"],
        normalizerVersions: ["claim-norm-v1"],
        validatorVersions: ["claim-validator-v1"]
      },
      {
        kind: "vat",
        scheme: "eu-vat",
        jurisdictions: ["DE"],
        entityTypes: ["legal_entity"],
        normalizerVersions: ["claim-norm-v1"],
        validatorVersions: ["claim-validator-v1"]
      }
    ],
    ...overrides
  };
}

function baseClaim(
  claim: Omit<
    OrganizationIdentityClaimInput,
    "normalizerVersion" | "validatorVersion" | "observedAt"
  >
): OrganizationIdentityClaimInput {
  return {
    ...claim,
    normalizerVersion: "claim-norm-v1",
    validatorVersion: "claim-validator-v1",
    observedAt
  };
}

function lei(
  value: string,
  subjectRef = "company"
): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "lei",
    value,
    entityType: "legal_entity",
    subjectRef
  });
}

function registration(
  value: string,
  jurisdiction = "DE",
  scheme = "registry-a",
  subjectRef = "company"
): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "registration_number",
    value,
    normalizedValue: value,
    scheme,
    jurisdiction,
    entityType: "legal_entity",
    subjectRef
  });
}

function vat(
  value: string,
  entityType: OrganizationIdentityClaimInput["entityType"],
  subjectRef = "company"
): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "vat",
    value,
    normalizedValue: value,
    scheme: "eu-vat",
    jurisdiction: "DE",
    entityType,
    subjectRef
  });
}

function legalName(
  value: string,
  subjectRef = "company"
): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "legal_name",
    value,
    jurisdiction: "DE",
    entityType: "legal_entity",
    subjectRef
  });
}

function officialDomain(
  value: string,
  subjectRef = "company"
): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "official_domain",
    value,
    entityType: "legal_entity",
    subjectRef
  });
}

function resolve(
  raw: RawFixture,
  claims: OrganizationIdentityClaimInput[],
  overrides: Partial<ResolveOrganizationStrongIdentityInput> = {},
  targetStore: CrmStore = store
) {
  resolutionSequence += 1;
  return resolveOrganizationStrongIdentity(targetStore, {
    teamId: raw.teamId,
    ownerId: raw.ownerId,
    rawRecordId: raw.recordId,
    resolverVersion: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    parserVersion: "identity-parser-v1",
    normalizerVersion: "identity-normalizer-v1",
    resolvedAt: new Date(
      Date.UTC(2026, 6, 14, 3, 0, resolutionSequence)
    ).toISOString(),
    envelopeSecret,
    identitySecret: organizationIdentitySecret,
    authorityProfile: authorityProfile(),
    claims,
    ...overrides
  });
}

function assertIdentityError(
  operation: () => unknown,
  code: OrganizationStrongIdentityError["code"]
) {
  assert.throws(operation, (error: unknown) =>
    error instanceof OrganizationStrongIdentityError
    && error.code === code
  );
}

const rawSnapshot = snapshotArrays(rawArrayNames);
const identitySnapshot = snapshotArrays(identityArrayNames);
const protectedBusinessSnapshot = snapshotArrays(
  protectedBusinessArrayNames
);

try {
  restoreArrays(rawArrayNames, Object.fromEntries(rawArrayNames.map(
    (name) => [name, []]
  )));
  restoreArrays(identityArrayNames, Object.fromEntries(
    identityArrayNames.map((name) => [name, []])
  ));

  const weakRaw = createRaw("identity-team-weak", "owner-a");
  const weakResult = resolve(weakRaw, [
    legalName("Association Facts GmbH"),
    officialDomain("https://association.example.test/path")
  ]);
  assert.equal(weakResult.resolution.result, "insufficient_identity");
  assert.equal(weakResult.createdOrganization, null);
  assert.equal(weakResult.binding, null);
  assert.deepEqual(weakResult.resolution.acceptedIdentifierIds, []);
  assert.equal(store.organizations.length, 0);

  const idempotentRaw = createRaw(
    "identity-team-idempotent",
    "owner-a"
  );
  const idempotentClaims = [
    legalName("Idempotent Lighting GmbH"),
    officialDomain("idempotent.example.test"),
    lei("5493001KJTIIGC8Y1R12")
  ];
  const firstResolution = resolve(idempotentRaw, idempotentClaims);
  assert.equal(firstResolution.resolution.result, "new_entity");
  assert.equal(firstResolution.createdIdentifiers.length, 1);
  assert.equal(
    firstResolution.createdIdentifiers[0]?.normalizedValue,
    "5493001KJTIIGC8Y1R12"
  );
  const factsAfterFirstResolution = identityFacts();
  const idempotentReplay = resolve(idempotentRaw, [
    lei("5493001KJTIIGC8Y1R12"),
    officialDomain("idempotent.example.test"),
    legalName("Idempotent Lighting GmbH"),
    lei("5493001KJTIIGC8Y1R12")
  ]);
  assert.equal(idempotentReplay.idempotent, true);
  assert.equal(
    idempotentReplay.resolution.claimHash,
    firstResolution.resolution.claimHash
  );
  assert.deepEqual(identityFacts(), factsAfterFirstResolution);

  const factsBeforeReplayConflict = identityFacts();
  assertIdentityError(
    () => resolve(idempotentRaw, [
      ...idempotentClaims,
      legalName("Changed Parser Output GmbH")
    ]),
    "IDENTITY_CLAIM_REPLAY_CONFLICT"
  );
  assert.deepEqual(identityFacts(), factsBeforeReplayConflict);

  const secondOwnerRaw = createRaw(
    "identity-team-idempotent",
    "owner-b"
  );
  const secondOwnerMatch = resolve(secondOwnerRaw, [
    legalName("Idempotent Lighting GmbH"),
    lei("5493001KJTIIGC8Y1R12")
  ]);
  assert.equal(secondOwnerMatch.resolution.result, "exact_match");
  assert.equal(secondOwnerMatch.createdOrganization, null);
  assert.equal(secondOwnerMatch.claims[0]?.ownerId, "owner-b");
  assert.equal(
    secondOwnerMatch.resolution.organizationId,
    firstResolution.resolution.organizationId
  );
  assert.equal(
    store.organizations.filter((item) =>
      item.teamId === "identity-team-idempotent"
    ).length,
    1
  );

  const crossTeamRaw = createRaw(
    "identity-team-cross",
    "owner-a"
  );
  const crossTeamResult = resolve(crossTeamRaw, [
    lei("5493001KJTIIGC8Y1R12")
  ]);
  assert.equal(crossTeamResult.resolution.result, "new_entity");
  assert.notEqual(
    crossTeamResult.resolution.organizationId,
    firstResolution.resolution.organizationId
  );

  const domainRawA = createRaw("identity-team-domain", "owner-a");
  const domainRawB = createRaw("identity-team-domain", "owner-b");
  const domainEntityA = resolve(domainRawA, [
    legalName("Shared Name GmbH"),
    officialDomain("shared-domain.example.test"),
    registration("REG-DOMAIN-100")
  ]);
  const domainEntityB = resolve(domainRawB, [
    legalName("Shared Name GmbH"),
    officialDomain("shared-domain.example.test"),
    registration("REG-DOMAIN-200")
  ]);
  assert.equal(domainEntityA.resolution.result, "new_entity");
  assert.equal(domainEntityB.resolution.result, "new_entity");
  assert.notEqual(
    domainEntityA.resolution.organizationId,
    domainEntityB.resolution.organizationId
  );

  const namespaceRawA = createRaw(
    "identity-team-namespace",
    "owner-a"
  );
  const namespaceRawB = createRaw(
    "identity-team-namespace",
    "owner-b"
  );
  const namespaceRawC = createRaw(
    "identity-team-namespace",
    "owner-c"
  );
  const namespaceEntityA = resolve(namespaceRawA, [
    registration("REG-SAME", "DE", "registry-a")
  ]);
  const namespaceEntityB = resolve(namespaceRawB, [
    registration("REG-SAME", "FR", "registry-a")
  ]);
  const namespaceEntityC = resolve(namespaceRawC, [
    registration("REG-SAME", "DE", "registry-b")
  ]);
  assert.equal(new Set([
    namespaceEntityA.resolution.organizationId,
    namespaceEntityB.resolution.organizationId,
    namespaceEntityC.resolution.organizationId
  ]).size, 3);

  const ambiguousVatRaw = createRaw(
    "identity-team-vat",
    "owner-a"
  );
  const ambiguousVatResult = resolve(ambiguousVatRaw, [
    vat("DE123456789", "vat_group", "vat-group"),
    vat("DE987654321", "branch", "branch")
  ]);
  assert.equal(
    ambiguousVatResult.resolution.result,
    "insufficient_identity"
  );
  assert.ok(ambiguousVatResult.claims.every((claim) =>
    claim.classification === "strong_identifier_unverified"
  ));

  const profileMismatchRaw = createRaw(
    "identity-team-profile",
    "owner-a"
  );
  const profileMismatchResult = resolve(profileMismatchRaw, [
    lei("213800D1EI4B9WTWWD28")
  ], {
    authorityProfile: authorityProfile({
      profileCode: "wrong-provider-profile",
      providerCode: "other.test-provider"
    })
  });
  assert.equal(
    profileMismatchResult.resolution.result,
    "insufficient_identity"
  );
  assert.equal(
    profileMismatchResult.claims[0]?.classification,
    "strong_identifier_unverified"
  );

  const invalidLeiRaw = createRaw(
    "identity-team-invalid-lei",
    "owner-a"
  );
  const invalidLeiResult = resolve(invalidLeiRaw, [
    lei("5493001KJTIIGC8Y1R13")
  ]);
  assert.equal(invalidLeiResult.resolution.result, "insufficient_identity");

  const multiSubjectRaw = createRaw(
    "identity-team-multi-subject",
    "owner-a"
  );
  const multiSubjectResult = resolve(multiSubjectRaw, [
    lei("213800D1EI4B9WTWWD28", "subject-a"),
    registration("MULTI-100", "DE", "registry-a", "subject-b")
  ]);
  assert.equal(
    multiSubjectResult.resolution.result,
    "insufficient_identity"
  );
  assert.ok(multiSubjectResult.claims.every((claim) =>
    claim.classification === "strong_identifier_unverified"
  ));

  const appendRawA = createRaw("identity-team-append", "owner-a");
  const appendRawB = createRaw("identity-team-append", "owner-b");
  const appendBase = resolve(appendRawA, [
    lei("213800D1EI4B9WTWWD28")
  ]);
  const appendMatch = resolve(appendRawB, [
    lei("213800D1EI4B9WTWWD28"),
    registration("APPEND-REG-100")
  ]);
  assert.equal(appendMatch.resolution.result, "exact_match");
  assert.equal(appendMatch.createdIdentifiers.length, 1);
  assert.equal(
    appendMatch.createdIdentifiers[0]?.kind,
    "registration_number"
  );
  assert.equal(
    appendMatch.createdIdentifiers[0]?.organizationId,
    appendBase.resolution.organizationId
  );

  const splitRawA = createRaw("identity-team-split", "owner-a");
  const splitRawB = createRaw("identity-team-split", "owner-b");
  const splitRawC = createRaw("identity-team-split", "owner-c");
  const splitEntityA = resolve(splitRawA, [
    lei("529900T8BM49AURSDO55")
  ]);
  const splitEntityB = resolve(splitRawB, [
    registration("SPLIT-REG-200")
  ]);
  const splitFactsBefore = identityFacts();
  const splitConflict = resolve(splitRawC, [
    lei("529900T8BM49AURSDO55"),
    registration("SPLIT-REG-200")
  ]);
  assert.equal(splitConflict.resolution.result, "conflict");
  assert.equal(splitConflict.conflict?.conflictType, "identifier_split");
  assert.deepEqual(splitConflict.resolution.acceptedIdentifierIds, []);
  assert.deepEqual(
    store.organizations,
    splitFactsBefore.organizations
  );
  assert.deepEqual(
    store.organizationAcceptedIdentifiers,
    splitFactsBefore.identifiers
  );
  assert.deepEqual(
    store.organizationSourceBindings,
    splitFactsBefore.bindings
  );
  assert.notEqual(
    splitEntityA.resolution.organizationId,
    splitEntityB.resolution.organizationId
  );

  const parserRaw = createRaw("identity-team-parser", "owner-a");
  const parserFirst = resolve(parserRaw, [
    registration("PARSER-REG-100")
  ]);
  const parserSecond = resolve(parserRaw, [
    registration("PARSER-REG-100")
  ], {
    parserVersion: "identity-parser-v2"
  });
  assert.equal(parserSecond.resolution.result, "exact_match");
  assert.equal(parserSecond.binding?.id, parserFirst.binding?.id);
  assert.equal(
    store.organizationSourceBindings.filter((item) =>
      item.rawRecordId === parserRaw.recordId
    ).length,
    1
  );

  const moveTargetRaw = createRaw(
    "identity-team-binding",
    "owner-target"
  );
  const moveSourceRaw = createRaw(
    "identity-team-binding",
    "owner-source"
  );
  const moveTarget = resolve(moveTargetRaw, [
    registration("MOVE-TARGET-200")
  ]);
  const moveSource = resolve(moveSourceRaw, [
    registration("MOVE-SOURCE-100")
  ]);
  const moveFactsBefore = identityFacts();
  const moveConflict = resolve(moveSourceRaw, [
    registration("MOVE-TARGET-200")
  ], {
    parserVersion: "identity-parser-v2"
  });
  assert.equal(moveConflict.resolution.result, "conflict");
  assert.equal(moveConflict.conflict?.conflictType, "binding_conflict");
  assert.equal(moveConflict.binding, null);
  const moveConflictReplay = resolve(moveSourceRaw, [
    registration("MOVE-TARGET-200")
  ], {
    parserVersion: "identity-parser-v2"
  });
  assert.equal(moveConflictReplay.idempotent, true);
  assert.equal(moveConflictReplay.binding, null);
  assert.deepEqual(moveConflictReplay.resolution, moveConflict.resolution);
  assert.deepEqual(moveConflictReplay.conflict, moveConflict.conflict);
  assert.equal(
    store.organizationSourceBindings.find((item) =>
      item.id === moveSource.binding?.id
    )?.organizationId,
    moveSource.resolution.organizationId
  );
  assert.notEqual(
    moveSource.resolution.organizationId,
    moveTarget.resolution.organizationId
  );
  assert.deepEqual(store.organizations, moveFactsBefore.organizations);
  assert.deepEqual(
    store.organizationAcceptedIdentifiers,
    moveFactsBefore.identifiers
  );
  assert.deepEqual(
    store.organizationSourceBindings,
    moveFactsBefore.bindings
  );

  const scopeRaw = createRaw("identity-team-scope", "owner-a");
  const factsBeforeScopeFailure = identityFacts();
  assert.throws(
    () => resolve(scopeRaw, [registration("SCOPE-REG-100")], {
      ownerId: "owner-b"
    }),
    (error: unknown) =>
      error instanceof ProspectSourceRawError
      && error.code === "PROSPECT_SOURCE_RAW_CONFLICT"
  );
  assert.deepEqual(identityFacts(), factsBeforeScopeFailure);

  const tamperRaw = createRaw("identity-team-tamper", "owner-a");
  const tamperRecord = store.prospectSourceRawRecords.find((item) =>
    item.id === tamperRaw.recordId
  )!;
  const originalEnvelope = tamperRecord.encryptedEnvelope;
  tamperRecord.encryptedEnvelope = `${
    originalEnvelope.slice(0, -1)
  }${originalEnvelope.endsWith("A") ? "B" : "A"}`;
  assert.throws(
    () => resolve(tamperRaw, [registration("TAMPER-REG-100")]),
    (error: unknown) =>
      error instanceof ProspectSourceRawError
      && error.code === "PROSPECT_SOURCE_RAW_ENVELOPE_INVALID"
  );
  tamperRecord.encryptedEnvelope = originalEnvelope;
  const originalRecordHash = tamperRecord.recordHash;
  tamperRecord.recordHash = "f".repeat(64);
  assert.throws(
    () => resolve(tamperRaw, [registration("TAMPER-REG-100")]),
    (error: unknown) =>
      error instanceof ProspectSourceRawError
      && error.code === "PROSPECT_SOURCE_RAW_ENVELOPE_INVALID"
  );
  tamperRecord.recordHash = originalRecordHash;

  const collisionRawA = createRaw(
    "identity-team-collision",
    "owner-a"
  );
  const collisionRawB = createRaw(
    "identity-team-collision",
    "owner-b"
  );
  const collisionSeed = resolve(collisionRawA, [
    registration("COLLISION-REG-100")
  ]);
  const collisionIdentifier =
    store.organizationAcceptedIdentifiers.find((item) =>
      item.organizationId === collisionSeed.resolution.organizationId
    )!;
  const originalNormalizedValue = collisionIdentifier.normalizedValue;
  collisionIdentifier.normalizedValue = "DIFFERENT-FULL-VALUE";
  const factsBeforeCollision = identityFacts();
  assertIdentityError(
    () => resolve(collisionRawB, [
      registration("COLLISION-REG-100")
    ]),
    "IDENTITY_IDENTIFIER_HASH_COLLISION"
  );
  assert.deepEqual(identityFacts(), factsBeforeCollision);
  collisionIdentifier.normalizedValue = originalNormalizedValue;

  const rollbackRaw = createRaw(
    "identity-team-rollback",
    "owner-a"
  );
  const rollbackEvents = structuredClone(
    store.organizationIdentityEvents
  );
  Object.defineProperty(rollbackEvents, "push", {
    configurable: true,
    value: () => {
      throw new Error("forced organization identity commit failure");
    }
  });
  const rollbackStore: CrmStore = {
    ...store,
    organizations: structuredClone(store.organizations),
    organizationIdentityClaims: structuredClone(
      store.organizationIdentityClaims
    ),
    organizationAcceptedIdentifiers: structuredClone(
      store.organizationAcceptedIdentifiers
    ),
    organizationIdentityResolutions: structuredClone(
      store.organizationIdentityResolutions
    ),
    organizationSourceBindings: structuredClone(
      store.organizationSourceBindings
    ),
    organizationIdentityConflicts: structuredClone(
      store.organizationIdentityConflicts
    ),
    organizationIdentityEvents: rollbackEvents
  };
  const rollbackFactsBefore = identityFacts(rollbackStore);
  assert.throws(
    () => resolve(
      rollbackRaw,
      [registration("ROLLBACK-REG-100")],
      {},
      rollbackStore
    ),
    /forced organization identity commit failure/u
  );
  assert.deepEqual(identityFacts(rollbackStore), rollbackFactsBefore);

  assert.deepEqual(
    snapshotArrays(protectedBusinessArrayNames),
    protectedBusinessSnapshot
  );
  console.log("Organization strong identity tests passed");
} finally {
  restoreArrays(rawArrayNames, rawSnapshot);
  restoreArrays(identityArrayNames, identitySnapshot);
}
