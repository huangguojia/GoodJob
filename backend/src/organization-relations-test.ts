import assert from "node:assert/strict";
import { publicUser, signToken } from "./auth.js";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { createOpenApiDocument } from "./swagger.js";
import type {
  Organization,
  OrganizationCanonicalMapping,
  User
} from "./types.js";

const store = getStore();
const usersById = new Map(store.users.map((user) => [user.id, user]));

function requiredUser(id: string): User {
  const user = usersById.get(id);
  if (!user) throw new Error(`Missing organization relation test user: ${id}`);
  return user;
}

const salesToken = signToken(publicUser(requiredUser("u_sales_shirley")));
const managerToken = signToken(publicUser(requiredUser("u_manager_alex")));
const adminToken = signToken(publicUser(requiredUser("u_admin")));
const superAdminToken = signToken(publicUser(requiredUser("u_super_admin")));

const initialLengths = {
  organizations: store.organizations.length,
  mappings: store.organizationCanonicalMappings.length,
  aliases: store.organizationAliasFacts.length,
  relations: store.organizationRelationFacts.length
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

const childId = "org_relation_child";
const childAliasId = "org_relation_child_alias";
const parentId = "org_relation_parent";
const otherParentId = "org_relation_other_parent";
const hiddenId = "org_relation_hidden";

store.organizations.push(
  organization(childId, "europe", "Relation Child GmbH"),
  organization(childAliasId, "europe", "Relation Child Trading GmbH"),
  organization(parentId, "europe", "Relation Parent Holding AG"),
  organization(otherParentId, "europe", "Relation Other Holding AG"),
  organization(hiddenId, "organization-relation-hidden-team", "Hidden Ltd")
);

const canonicalMapping: OrganizationCanonicalMapping = {
  id: "ocm_relation_test",
  conflictId: "oic_relation_test",
  teamId: "europe",
  sourceOrganizationId: childAliasId,
  canonicalOrganizationId: childId,
  createdBy: "u_manager_alex",
  mappingHash: "organization-relation-test-mapping-hash",
  createdAt: "2026-07-15T08:00:00.000Z"
};
store.organizationCanonicalMappings.push(canonicalMapping);

const protectedBusinessState = structuredClone({
  leads: store.leads,
  leadActivities: store.leadActivities,
  customers: store.customers,
  customerActivities: store.customerActivities,
  deals: store.deals,
  dealEvents: store.dealEvents,
  todos: store.todos,
  websiteOpportunities: store.websiteOpportunities,
  tenantProspects: store.tenantProspects
});

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start organization relation test server");
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

function post(
  path: string,
  token: string,
  body: Record<string, unknown>
) {
  return request(path, token, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

const aliasBody = {
  aliasType: "trading_name",
  aliasName: "Relation Child Export",
  locale: "en",
  jurisdiction: "DE",
  sourceLabel: "German commercial register",
  sourceReference: "relation-test-alias-1",
  evidenceSummary: "Registered trading name observed in the public record",
  verificationStatus: "verified"
};

const parentRelationBody = {
  sourceOrganizationId: childAliasId,
  targetOrganizationId: parentId,
  relationType: "direct_parent",
  sourceLabel: "German commercial register",
  sourceReference: "relation-test-parent-1",
  evidenceSummary: "Shareholding record identifies the direct parent",
  verificationStatus: "verified"
};

try {
  const anonymous = await request(
    `/api/organizations/${childId}/identity-profile`,
    null
  );
  assert.equal(anonymous.response.status, 401);

  const emptyProfile = await request(
    `/api/organizations/${childId}/identity-profile`,
    salesToken
  );
  assert.equal(emptyProfile.response.status, 200);
  assert.equal(emptyProfile.json.profile.organization.id, childId);
  assert.deepEqual(emptyProfile.json.profile.aliases, []);
  assert.deepEqual(emptyProfile.json.profile.relations, []);

  const superAdminRead = await request(
    `/api/organizations/${childId}/identity-profile`,
    superAdminToken
  );
  assert.equal(superAdminRead.response.status, 403);
  assert.equal(
    superAdminRead.json.errorCode,
    "ORGANIZATION_PROFILE_FORBIDDEN"
  );

  const crossTeamRead = await request(
    `/api/organizations/${hiddenId}/identity-profile`,
    managerToken
  );
  assert.equal(crossTeamRead.response.status, 404);
  assert.equal(crossTeamRead.json.errorCode, "ORGANIZATION_NOT_FOUND");

  const salesWrite = await post(
    `/api/organizations/${childId}/aliases`,
    salesToken,
    aliasBody
  );
  assert.equal(salesWrite.response.status, 403);
  assert.equal(
    salesWrite.json.errorCode,
    "ORGANIZATION_FACT_WRITE_FORBIDDEN"
  );

  const crossTeamWrite = await post(
    `/api/organizations/${hiddenId}/aliases`,
    managerToken,
    aliasBody
  );
  assert.equal(crossTeamWrite.response.status, 404);
  assert.equal(crossTeamWrite.json.errorCode, "ORGANIZATION_NOT_FOUND");

  const aliasCreated = await post(
    `/api/organizations/${childAliasId}/aliases`,
    managerToken,
    aliasBody
  );
  assert.equal(aliasCreated.response.status, 201);
  assert.equal(aliasCreated.json.replayed, false);
  assert.equal(aliasCreated.json.alias.organizationId, childId);
  assert.equal(aliasCreated.json.alias.createdBy, "u_manager_alex");
  assert.match(aliasCreated.json.alias.observedAt, /Z$/);
  assert.equal(
    aliasCreated.response.headers.get("idempotency-replayed"),
    "false"
  );

  const aliasReplay = await post(
    `/api/organizations/${childAliasId}/aliases`,
    managerToken,
    aliasBody
  );
  assert.equal(aliasReplay.response.status, 200);
  assert.equal(aliasReplay.json.replayed, true);
  assert.equal(aliasReplay.json.alias.id, aliasCreated.json.alias.id);
  assert.equal(store.organizationAliasFacts.length, initialLengths.aliases + 1);

  const adminAlias = await post(
    `/api/organizations/${parentId}/aliases`,
    adminToken,
    {
      ...aliasBody,
      aliasType: "brand",
      aliasName: "Relation Group",
      sourceReference: "relation-test-alias-2"
    }
  );
  assert.equal(adminAlias.response.status, 201);
  assert.equal(adminAlias.json.alias.createdBy, "u_admin");

  const relationCreated = await post(
    "/api/organization-relations",
    managerToken,
    parentRelationBody
  );
  assert.equal(relationCreated.response.status, 201);
  assert.equal(relationCreated.json.relation.sourceOrganizationId, childId);
  assert.equal(relationCreated.json.relation.targetOrganizationId, parentId);

  const relationReplay = await post(
    "/api/organization-relations",
    managerToken,
    parentRelationBody
  );
  assert.equal(relationReplay.response.status, 200);
  assert.equal(relationReplay.json.replayed, true);
  assert.equal(
    relationReplay.json.relation.id,
    relationCreated.json.relation.id
  );

  const conflictingParent = await post(
    "/api/organization-relations",
    managerToken,
    {
      ...parentRelationBody,
      targetOrganizationId: otherParentId,
      sourceReference: "relation-test-parent-conflict"
    }
  );
  assert.equal(conflictingParent.response.status, 409);
  assert.equal(
    conflictingParent.json.errorCode,
    "ORGANIZATION_RELATION_CONFLICT"
  );

  const selfRelation = await post(
    "/api/organization-relations",
    managerToken,
    {
      ...parentRelationBody,
      targetOrganizationId: childId,
      sourceReference: "relation-test-self"
    }
  );
  assert.equal(selfRelation.response.status, 400);
  assert.equal(
    selfRelation.json.errorCode,
    "ORGANIZATION_RELATION_INVALID"
  );

  const cycle = await post(
    "/api/organization-relations",
    adminToken,
    {
      ...parentRelationBody,
      sourceOrganizationId: parentId,
      targetOrganizationId: childId,
      sourceReference: "relation-test-cycle"
    }
  );
  assert.equal(cycle.response.status, 409);
  assert.equal(cycle.json.errorCode, "ORGANIZATION_RELATION_CYCLE");

  const profile = await request(
    `/api/organizations/${childAliasId}/identity-profile`,
    salesToken
  );
  assert.equal(profile.response.status, 200);
  assert.equal(profile.json.profile.organization.id, childId);
  assert.equal(profile.json.profile.aliases.length, 1);
  assert.equal(profile.json.profile.relations.length, 1);
  assert.equal(profile.json.profile.relations[0].direction, "outbound");
  assert.equal(
    profile.json.profile.relations[0].relatedOrganization.id,
    parentId
  );

  const parentProfile = await request(
    `/api/organizations/${parentId}/identity-profile`,
    managerToken
  );
  assert.equal(parentProfile.response.status, 200);
  assert.equal(parentProfile.json.profile.relations[0].direction, "inbound");
  assert.equal(
    parentProfile.json.profile.relations[0].relatedOrganization.id,
    childId
  );

  assert.deepEqual(
    {
      leads: store.leads,
      leadActivities: store.leadActivities,
      customers: store.customers,
      customerActivities: store.customerActivities,
      deals: store.deals,
      dealEvents: store.dealEvents,
      todos: store.todos,
      websiteOpportunities: store.websiteOpportunities,
      tenantProspects: store.tenantProspects
    },
    protectedBusinessState
  );

  const document = createOpenApiDocument(app) as Record<string, any>;
  const aliasOperation =
    document.paths["/api/organizations/{id}/aliases"].post;
  const relationOperation =
    document.paths["/api/organization-relations"].post;
  assert.deepEqual(
    aliasOperation.requestBody.content["application/json"].schema.required,
    ["aliasType", "aliasName", "sourceLabel", "evidenceSummary"]
  );
  assert.deepEqual(
    relationOperation.requestBody.content["application/json"].schema.required,
    [
      "sourceOrganizationId",
      "targetOrganizationId",
      "relationType",
      "sourceLabel",
      "evidenceSummary"
    ]
  );
  assert.ok(aliasOperation.responses["201"]);
  assert.ok(relationOperation.responses["409"]);
  assert.match(aliasOperation.description, /当前团队共享/);
  assert.match(relationOperation.description, /不自动创建或修改线索/);

  console.log(
    "Organization alias and group relation permissions, isolation, idempotency, hierarchy and Swagger tests passed"
  );
} finally {
  store.organizations.splice(initialLengths.organizations);
  store.organizationCanonicalMappings.splice(initialLengths.mappings);
  store.organizationAliasFacts.splice(initialLengths.aliases);
  store.organizationRelationFacts.splice(initialLengths.relations);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
