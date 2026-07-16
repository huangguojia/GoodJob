import assert from "node:assert/strict";
import { publicUser, signToken } from "./auth.js";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { createOpenApiDocument } from "./swagger.js";
import type {
  Organization,
  OrganizationIdentityConflict,
  User,
  WebsiteOpportunity
} from "./types.js";

const store = getStore();
const usersById = new Map(store.users.map((user) => [user.id, user]));

function requiredUser(id: string): User {
  const user = usersById.get(id);
  if (!user) throw new Error(`Missing identity review test user: ${id}`);
  return user;
}

const salesToken = signToken(publicUser(requiredUser("u_sales_shirley")));
const managerToken = signToken(publicUser(requiredUser("u_manager_alex")));
const adminToken = signToken(publicUser(requiredUser("u_admin")));
const superAdminToken = signToken(publicUser(requiredUser("u_super_admin")));

const initialLengths = {
  organizations: store.organizations.length,
  conflicts: store.organizationIdentityConflicts.length,
  reviews: store.organizationIdentityConflictReviews.length,
  mappings: store.organizationCanonicalMappings.length,
  opportunities: store.websiteOpportunities.length
};

function organization(id: string, teamId: string, legalName: string): Organization {
  return {
    id,
    teamId,
    scopeType: "team",
    scopeId: teamId,
    status: "active",
    legalName,
    normalizedName: legalName.toLowerCase(),
    organizationHash: `${id}-hash`,
    createdAt: "2026-07-15T08:00:00.000Z"
  };
}

function conflict(
  id: string,
  teamId: string,
  ownerId: string,
  organizationIds: string[]
): OrganizationIdentityConflict {
  return {
    id,
    resolutionId: `${id}-resolution`,
    teamId,
    ownerId,
    rawRecordId: `${id}-raw`,
    conflictType: "identifier_split",
    organizationIds,
    identifierKeys: [`vat:${id}`],
    status: "open",
    relationHash: `${id}-relation-hash`,
    conflictHash: `${id}-conflict-hash`,
    createdAt: "2026-07-15T08:00:00.000Z"
  };
}

const canonicalId = "org_identity_review_canonical";
const aliasId = "org_identity_review_alias";
const keepLeftId = "org_identity_review_keep_left";
const keepRightId = "org_identity_review_keep_right";
const hiddenLeftId = "org_identity_review_hidden_left";
const hiddenRightId = "org_identity_review_hidden_right";
const mergeConflictId = "oic_identity_review_merge";
const keepConflictId = "oic_identity_review_keep";
const hiddenConflictId = "oic_identity_review_hidden";
const opportunityId = "web_identity_review_projection";

store.organizations.push(
  organization(canonicalId, "europe", "Identity Review Canonical Ltd"),
  organization(aliasId, "europe", "Identity Review Alias Ltd"),
  organization(keepLeftId, "europe", "Identity Review Independent A Ltd"),
  organization(keepRightId, "europe", "Identity Review Independent B Ltd"),
  organization(hiddenLeftId, "identity-review-hidden-team", "Hidden A Ltd"),
  organization(hiddenRightId, "identity-review-hidden-team", "Hidden B Ltd")
);
store.organizationIdentityConflicts.push(
  conflict(
    mergeConflictId,
    "europe",
    "u_sales_shirley",
    [canonicalId, aliasId]
  ),
  conflict(
    keepConflictId,
    "europe",
    "u_sales_mia",
    [keepLeftId, keepRightId]
  ),
  conflict(
    hiddenConflictId,
    "identity-review-hidden-team",
    "hidden-owner",
    [hiddenLeftId, hiddenRightId]
  )
);

const projectedOpportunity: WebsiteOpportunity = {
  id: opportunityId,
  company: "Identity Review Buyer",
  business: "Industrial sourcing",
  country: "DE",
  website: "https://identity-review.example.test",
  contact: "Buyer",
  contactInfo: "buyer@identity-review.example.test",
  description: "Identity review projection fixture",
  ownerId: "u_sales_shirley",
  teamId: "europe",
  status: "preview",
  organizationId: aliasId,
  createdAt: "2026-07-15T08:00:00.000Z"
};
store.websiteOpportunities.push(projectedOpportunity);

const immutableBusinessState = structuredClone({
  leads: store.leads,
  customers: store.customers,
  deals: store.deals,
  todos: store.todos,
  websiteOpportunities: store.websiteOpportunities,
  identityConflicts: store.organizationIdentityConflicts,
  identityEvents: store.organizationIdentityEvents,
  sourceBindings: store.organizationSourceBindings,
  evidence: store.prospectEvidence
});

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start organization identity review test server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(
  path: string,
  token: string | null,
  options: RequestInit = {}
) {
  const headers = new Headers(options.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers
  });
  return {
    response,
    json: await response.json().catch(() => ({}))
  };
}

function reviewRequest(
  conflictId: string,
  token: string,
  ifMatch: string | null,
  body: Record<string, unknown>
) {
  const headers: Record<string, string> = {};
  if (ifMatch) headers["if-match"] = ifMatch;
  return request(
    `/api/organization-identity-conflicts/${conflictId}/review`,
    token,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    }
  );
}

try {
  const anonymous = await request(
    "/api/organization-identity-conflicts",
    null
  );
  assert.equal(anonymous.response.status, 401);

  const sales = await request(
    "/api/organization-identity-conflicts",
    salesToken
  );
  assert.equal(sales.response.status, 403);
  assert.equal(sales.json.errorCode, "IDENTITY_REVIEW_FORBIDDEN");

  const superAdmin = await request(
    "/api/organization-identity-conflicts",
    superAdminToken
  );
  assert.equal(superAdmin.response.status, 403);
  assert.equal(superAdmin.json.errorCode, "IDENTITY_REVIEW_FORBIDDEN");

  const managerList = await request(
    "/api/organization-identity-conflicts?status=open",
    managerToken
  );
  assert.equal(managerList.response.status, 200);
  assert.equal(
    managerList.json.conflicts.some(
      (item: { id: string }) => item.id === mergeConflictId
    ),
    true
  );
  assert.equal(
    managerList.json.conflicts.some(
      (item: { id: string }) => item.id === hiddenConflictId
    ),
    false
  );
  const mergeListItem = managerList.json.conflicts.find(
    (item: { id: string }) => item.id === mergeConflictId
  );
  assert.equal(mergeListItem.etag, `"organization-identity-conflict:${mergeConflictId}:1"`);

  const adminList = await request(
    "/api/organization-identity-conflicts?status=open",
    adminToken
  );
  assert.equal(adminList.response.status, 200);
  const keepListItem = adminList.json.conflicts.find(
    (item: { id: string }) => item.id === keepConflictId
  );
  assert.ok(keepListItem);

  const crossTeamReview = await reviewRequest(
    hiddenConflictId,
    managerToken,
    `"organization-identity-conflict:${hiddenConflictId}:1"`,
    {
      action: "keep_separate",
      note: "跨团队复核必须被隐藏"
    }
  );
  assert.equal(crossTeamReview.response.status, 404);
  assert.equal(
    crossTeamReview.json.errorCode,
    "IDENTITY_CONFLICT_NOT_FOUND"
  );

  const missingIfMatch = await reviewRequest(
    mergeConflictId,
    managerToken,
    null,
    {
      action: "merge",
      canonicalOrganizationId: canonicalId,
      note: "缺少并发版本"
    }
  );
  assert.equal(missingIfMatch.response.status, 428);
  assert.equal(missingIfMatch.json.errorCode, "PRECONDITION_REQUIRED");

  const staleIfMatch = await reviewRequest(
    mergeConflictId,
    managerToken,
    `"organization-identity-conflict:${mergeConflictId}:0"`,
    {
      action: "merge",
      canonicalOrganizationId: canonicalId,
      note: "过期并发版本"
    }
  );
  assert.equal(staleIfMatch.response.status, 412);
  assert.equal(
    staleIfMatch.json.errorCode,
    "IDENTITY_CONFLICT_REVISION_CONFLICT"
  );

  const invalidCanonical = await reviewRequest(
    mergeConflictId,
    managerToken,
    mergeListItem.etag,
    {
      action: "merge",
      canonicalOrganizationId: keepLeftId,
      note: "规范企业不属于当前冲突"
    }
  );
  assert.equal(invalidCanonical.response.status, 400);
  assert.equal(invalidCanonical.json.errorCode, "IDENTITY_REVIEW_INVALID");

  const merged = await reviewRequest(
    mergeConflictId,
    managerToken,
    mergeListItem.etag,
    {
      action: "merge",
      canonicalOrganizationId: canonicalId,
      note: "依据同一已核验强标识，人工确认规范企业"
    }
  );
  assert.equal(merged.response.status, 200);
  assert.equal(merged.json.review.action, "merge");
  assert.equal(merged.json.review.reviewedBy, "u_manager_alex");
  assert.equal(merged.json.mappings.length, 1);
  assert.equal(merged.json.mappings[0].sourceOrganizationId, aliasId);
  assert.equal(merged.json.mappings[0].canonicalOrganizationId, canonicalId);
  assert.equal(
    merged.response.headers.get("etag"),
    `"organization-identity-conflict:${mergeConflictId}:2"`
  );

  const firstReviewSnapshot = structuredClone(merged.json.review);
  const secondReview = await reviewRequest(
    mergeConflictId,
    adminToken,
    merged.json.etag,
    {
      action: "keep_separate",
      note: "尝试覆盖已有结论"
    }
  );
  assert.equal(secondReview.response.status, 409);
  assert.equal(
    secondReview.json.errorCode,
    "IDENTITY_CONFLICT_ALREADY_REVIEWED"
  );
  assert.deepEqual(
    store.organizationIdentityConflictReviews.find(
      (item) => item.conflictId === mergeConflictId
    ),
    firstReviewSnapshot
  );

  const keptSeparate = await reviewRequest(
    keepConflictId,
    adminToken,
    keepListItem.etag,
    {
      action: "keep_separate",
      note: "主体证据不同，人工确认继续保持独立"
    }
  );
  assert.equal(keptSeparate.response.status, 200);
  assert.equal(keptSeparate.json.review.action, "keep_separate");
  assert.equal(keptSeparate.json.review.reviewedBy, "u_admin");
  assert.deepEqual(keptSeparate.json.mappings, []);

  const openAfterReview = await request(
    "/api/organization-identity-conflicts?status=open",
    managerToken
  );
  assert.equal(
    openAfterReview.json.conflicts.some(
      (item: { id: string }) => item.id === mergeConflictId
    ),
    false
  );
  const resolvedAfterReview = await request(
    "/api/organization-identity-conflicts?status=resolved",
    managerToken
  );
  assert.equal(
    resolvedAfterReview.json.conflicts.some(
      (item: { id: string }) => item.id === mergeConflictId
    ),
    true
  );
  assert.equal(
    store.organizationIdentityConflicts.find(
      (item) => item.id === mergeConflictId
    )?.status,
    "open"
  );

  const projected = await request(
    "/api/tools/website-opportunities",
    managerToken
  );
  assert.equal(projected.response.status, 200);
  assert.equal(
    projected.json.opportunities.find(
      (item: { id: string }) => item.id === opportunityId
    )?.organizationId,
    canonicalId
  );
  assert.equal(projectedOpportunity.organizationId, aliasId);

  assert.deepEqual(
    {
      leads: store.leads,
      customers: store.customers,
      deals: store.deals,
      todos: store.todos,
      websiteOpportunities: store.websiteOpportunities,
      identityConflicts: store.organizationIdentityConflicts,
      identityEvents: store.organizationIdentityEvents,
      sourceBindings: store.organizationSourceBindings,
      evidence: store.prospectEvidence
    },
    immutableBusinessState
  );

  const document = createOpenApiDocument(app) as Record<string, any>;
  const reviewOperation =
    document.paths["/api/organization-identity-conflicts/{id}/review"].post;
  const ifMatchParameter = reviewOperation.parameters.find(
    (item: { name?: string; in?: string }) =>
      item.name === "If-Match" && item.in === "header"
  );
  assert.equal(ifMatchParameter?.required, true);
  assert.deepEqual(
    reviewOperation.requestBody.content["application/json"].schema.required,
    ["action", "note"]
  );
  for (const status of ["409", "412", "428"]) {
    assert.ok(reviewOperation.responses[status]);
  }
  assert.match(reviewOperation.description, /历史候选/);
  assert.match(reviewOperation.description, /不自动创建或合并线索、客户、商机/);

  console.log(
    "Organization identity conflict review permissions, isolation, immutable history, projection and Swagger tests passed"
  );
} finally {
  store.organizations.splice(initialLengths.organizations);
  store.organizationIdentityConflicts.splice(initialLengths.conflicts);
  store.organizationIdentityConflictReviews.splice(initialLengths.reviews);
  store.organizationCanonicalMappings.splice(initialLengths.mappings);
  store.websiteOpportunities.splice(initialLengths.opportunities);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
