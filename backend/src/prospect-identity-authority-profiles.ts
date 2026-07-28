import type { ProviderRecord } from "./provider-contract.js";
import type {
  OrganizationIdentityAuthorityProfile,
  OrganizationIdentityClaimInput
} from "./organization-strong-identity.js";

const COMPANY_ENDPOINT = "company-search";

export const PROSPECT_IDENTITY_AUTHORITY_PROFILES: OrganizationIdentityAuthorityProfile[] = [{
  profileCode: "gleif-company-identity",
  profileVersion: "v1",
  providerCode: "gleif",
  endpointCode: COMPANY_ENDPOINT,
  allowMultiIdentifierSubjectBinding: true,
  rules: [{
    kind: "lei",
    scheme: "iso-17442",
    jurisdictions: ["GLOBAL"],
    entityTypes: ["legal_entity"],
    normalizerVersions: ["gleif-lei-normalizer-v1"],
    validatorVersions: ["iso-17442-mod97-v1"]
  }]
}, {
  profileCode: "companies-house-company-identity",
  profileVersion: "v1",
  providerCode: "companies_house",
  endpointCode: COMPANY_ENDPOINT,
  allowMultiIdentifierSubjectBinding: true,
  rules: [{
    kind: "registration_number",
    scheme: "uk-companies-house",
    jurisdictions: ["GB"],
    entityTypes: ["legal_entity"],
    normalizerVersions: ["companies-house-registration-normalizer-v1"],
    validatorVersions: ["companies-house-provider-record-v1"]
  }]
}, {
  profileCode: "sec-edgar-company-identity",
  profileVersion: "v1",
  providerCode: "sec_edgar",
  endpointCode: COMPANY_ENDPOINT,
  allowMultiIdentifierSubjectBinding: true,
  rules: [{
    kind: "registration_number",
    scheme: "us-sec-cik",
    jurisdictions: ["US"],
    entityTypes: ["legal_entity"],
    normalizerVersions: ["sec-cik-normalizer-v1"],
    validatorVersions: ["sec-provider-record-v1"]
  }]
}, {
  profileCode: "fr-siren-company-identity",
  profileVersion: "v1",
  providerCode: "fr_company_search",
  endpointCode: COMPANY_ENDPOINT,
  allowMultiIdentifierSubjectBinding: true,
  rules: [{
    kind: "registration_number",
    scheme: "fr-siren",
    jurisdictions: ["FR"],
    entityTypes: ["legal_entity"],
    normalizerVersions: ["fr-siren-normalizer-v1"],
    validatorVersions: ["fr-government-provider-record-v1"]
  }]
}];

export interface ProspectOfficialIdentityMatch {
  profile: OrganizationIdentityAuthorityProfile;
  subjectRef: string;
  identifierClaim: OrganizationIdentityClaimInput;
}

export function validLei(value: string) {
  const normalized = value.trim().toLocaleUpperCase("en-US");
  if (!/^[A-Z0-9]{20}$/u.test(normalized)) return false;
  const expanded = normalized
    .split("")
    .map((character) => /[A-Z]/u.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character)
    .join("");
  let remainder = 0;
  for (const character of expanded) {
    remainder = (remainder * 10 + Number(character)) % 97;
  }
  return remainder === 1;
}

export function prospectOfficialIdentityMatch(
  providerCode: string,
  endpointCode: string,
  record: ProviderRecord
): ProspectOfficialIdentityMatch | null {
  if (endpointCode !== COMPANY_ENDPOINT) return null;
  const observedAt = new Date(record.fetchedAt).toISOString();
  if (providerCode === "gleif") {
    const lei = record.providerRecordId.trim().toLocaleUpperCase("en-US");
    if (!validLei(lei)) return null;
    return {
      profile: PROSPECT_IDENTITY_AUTHORITY_PROFILES[0]!,
      subjectRef: `gleif:${lei}`,
      identifierClaim: {
        kind: "lei",
        value: lei,
        entityType: "legal_entity",
        subjectRef: `gleif:${lei}`,
        normalizerVersion: "gleif-lei-normalizer-v1",
        validatorVersion: "iso-17442-mod97-v1",
        observedAt
      }
    };
  }
  if (providerCode === "companies_house") {
    const companyNumber = record.providerRecordId.trim().toLocaleUpperCase("en-US");
    if (!/^[A-Z0-9]{6,10}$/u.test(companyNumber)) return null;
    return {
      profile: PROSPECT_IDENTITY_AUTHORITY_PROFILES[1]!,
      subjectRef: `companies-house:${companyNumber}`,
      identifierClaim: {
        kind: "registration_number",
        value: companyNumber,
        normalizedValue: companyNumber,
        scheme: "uk-companies-house",
        jurisdiction: "GB",
        entityType: "legal_entity",
        subjectRef: `companies-house:${companyNumber}`,
        normalizerVersion: "companies-house-registration-normalizer-v1",
        validatorVersion: "companies-house-provider-record-v1",
        observedAt
      }
    };
  }
  if (providerCode === "sec_edgar") {
    const match = record.providerRecordId.trim().toLocaleUpperCase("en-US").match(/^CIK:(\d{10})$/u);
    if (!match) return null;
    return {
      profile: PROSPECT_IDENTITY_AUTHORITY_PROFILES[2]!,
      subjectRef: `sec-cik:${match[1]}`,
      identifierClaim: {
        kind: "registration_number",
        value: record.providerRecordId,
        normalizedValue: match[1],
        scheme: "us-sec-cik",
        jurisdiction: "US",
        entityType: "legal_entity",
        subjectRef: `sec-cik:${match[1]}`,
        normalizerVersion: "sec-cik-normalizer-v1",
        validatorVersion: "sec-provider-record-v1",
        observedAt
      }
    };
  }
  if (providerCode === "fr_company_search") {
    const match = record.providerRecordId.trim().toLocaleUpperCase("en-US").match(/^SIREN:(\d{9})$/u);
    if (!match) return null;
    return {
      profile: PROSPECT_IDENTITY_AUTHORITY_PROFILES[3]!,
      subjectRef: `fr-siren:${match[1]}`,
      identifierClaim: {
        kind: "registration_number",
        value: record.providerRecordId,
        normalizedValue: match[1],
        scheme: "fr-siren",
        jurisdiction: "FR",
        entityType: "legal_entity",
        subjectRef: `fr-siren:${match[1]}`,
        normalizerVersion: "fr-siren-normalizer-v1",
        validatorVersion: "fr-government-provider-record-v1",
        observedAt
      }
    };
  }
  return null;
}
