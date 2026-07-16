export interface LeadSourceAvailability {
  id: string;
  ready: boolean;
  enabled: boolean;
  accessMode: "api" | "bulk_file" | "website_controlled" | "manual_assisted" | "disabled";
  recommended?: boolean;
}

export type LeadSourceBlockReason = "missing" | "not_ready" | "disabled" | "not_executable";

export interface BlockedLeadSource {
  id: string;
  reason: LeadSourceBlockReason;
}

export interface LeadSourceResolution {
  sources: string[];
  blocked: BlockedLeadSource[];
  requiresSelection: boolean;
}

export function isLeadSourceExecutable(provider: LeadSourceAvailability | undefined) {
  return Boolean(provider?.accessMode === "api" && provider.ready && provider.enabled);
}

export function resolveLeadSearchSources(
  providers: LeadSourceAvailability[],
  selectedIds: string[],
  selectionTouched: boolean
): LeadSourceResolution {
  if (!selectionTouched) {
    return {
      sources: providers
        .filter((provider) =>
          provider.id !== "ai_search"
          && provider.recommended
          && isLeadSourceExecutable(provider)
        )
        .map((provider) => provider.id),
      blocked: [],
      requiresSelection: false
    };
  }

  const uniqueSelectedIds = [...new Set(selectedIds)];
  if (!uniqueSelectedIds.length) {
    return { sources: [], blocked: [], requiresSelection: true };
  }

  const blocked: BlockedLeadSource[] = [];
  const sources: string[] = [];
  for (const id of uniqueSelectedIds) {
    const provider = providers.find((item) => item.id === id);
    if (!provider) {
      blocked.push({ id, reason: "missing" });
    } else if (provider.accessMode !== "api") {
      blocked.push({ id, reason: "not_executable" });
    } else if (!provider.ready) {
      blocked.push({ id, reason: "not_ready" });
    } else if (!provider.enabled) {
      blocked.push({ id, reason: "disabled" });
    } else {
      sources.push(id);
    }
  }

  return {
    sources: blocked.length ? [] : sources,
    blocked,
    requiresSelection: false
  };
}
