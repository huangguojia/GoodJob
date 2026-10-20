import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { io } from "socket.io-client";
import type { RealtimeEvent } from "@shared/types";
import { api } from "./api";

const pluginBasePath = import.meta.env.BASE_URL.replace(/\/$/u, "");

export const queryKeys = {
  health: ["health"] as const,
  commercialReadiness: ["commercial-readiness"] as const,
  capabilities: ["capabilities"] as const,
  accounts: ["accounts"] as const,
  contacts: (accountId?: string) => ["contacts", accountId ?? "all"] as const,
  conversations: (accountId?: string) => ["conversations", accountId ?? "all"] as const,
  messages: (conversationId?: string) => ["messages", conversationId ?? "none"] as const,
  intelligence: (conversationId?: string) => ["intelligence", conversationId ?? "none"] as const,
  preference: ["translation-preference"] as const,
  aiProviders: ["ai-providers"] as const,
  integrationPreference: ["integration-preference"] as const,
  mediaRetention: ["media-retention"] as const,
  metaApps: ["meta-apps"] as const,
  metaConfigurations: ["meta-configurations"] as const,
  routingRules: ["routing-rules"] as const,
  crmContacts: ["crm-contacts"] as const,
  crmCustomers: ["crm-customers"] as const,
  crmTodos: ["crm-todos"] as const,
  automation: ["automation"] as const,
  automationRuns: ["automation-runs"] as const,
  followupSyncRuns: ["followup-sync-runs"] as const,
  trainingProfiles: ["training-profiles"] as const,
  trainingLibrary: ["training-library"] as const,
  /**
   * 候选池是 `trainingLibrary` 的**子键**（故意）：
   * invalidateQueries({ queryKey: ["training-library"] }) 按前缀失效，一次能刷到两个列表。
   */
  trainingLibraryCandidates: ["training-library", "candidate"] as const,
  autoChatSettings: (accountId?: string) => ["auto-chat-settings", accountId ?? "all"] as const,
  autoChatEngine: ["auto-chat-engine"] as const,
  autoChatDrafts: (status?: string) => ["auto-chat-drafts", status ?? "all"] as const
};

export function useAccounts() {
  return useQuery({ queryKey: queryKeys.accounts, queryFn: api.accounts, refetchInterval: 15_000 });
}

export function useCapabilities() {
  return useQuery({ queryKey: queryKeys.capabilities, queryFn: api.capabilities, staleTime: 60_000 });
}

export function useIntegrationPreference() {
  return useQuery({ queryKey: queryKeys.integrationPreference, queryFn: api.integrationPreference });
}

export function useMetaApps() {
  return useQuery({ queryKey: queryKeys.metaApps, queryFn: api.metaApps });
}

export function useMetaConfigurations() {
  return useQuery({ queryKey: queryKeys.metaConfigurations, queryFn: api.metaConfigurations });
}

export function useRealtimeInvalidation(onEvent?: (event: RealtimeEvent) => void): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = io({ path: `${pluginBasePath}/socket.io` });
    socket.on("plugin:event", (event: RealtimeEvent) => {
      onEvent?.(event);
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      if (event.eventType.startsWith("message.") || event.eventType.startsWith("translation.")) {
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      }
      if (event.eventType.startsWith("conversation.analysis.")) {
        void queryClient.invalidateQueries({ queryKey: ["intelligence"] });
      }
      if (event.eventType.startsWith("contact.") || event.eventType.startsWith("crm.")) {
        void queryClient.invalidateQueries({ queryKey: ["contacts"] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.crmContacts });
      }
      if (event.eventType === "translation.preference.changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.preference });
      }
      if (event.eventType.startsWith("auto.chat.")) {
        void queryClient.invalidateQueries({ queryKey: ["auto-chat-drafts"] });
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      }
      if (event.eventType.startsWith("integration.") || event.eventType.startsWith("meta.")) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.integrationPreference });
        void queryClient.invalidateQueries({ queryKey: queryKeys.metaApps });
        void queryClient.invalidateQueries({ queryKey: queryKeys.metaConfigurations });
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [onEvent, queryClient]);
}
