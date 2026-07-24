import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  ContactRound,
  MessageSquareText,
  Network,
  SlidersHorizontal,
  Smartphone,
  Wifi
} from "lucide-react";
import type { RealtimeEvent } from "@shared/types";
import { useAccounts, useRealtimeInvalidation } from "./data";
import { AccountsPage } from "./pages/AccountsPage";
import { AccessSettingsPage } from "./pages/AccessSettingsPage";
import { AiSettingsPage } from "./pages/AiSettingsPage";
import { ContactsPage } from "./pages/ContactsPage";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { RoutingPage } from "./pages/RoutingPage";
import { WorkspacePage } from "./pages/WorkspacePage";

type View = "accounts" | "workspace" | "contacts" | "routing" | "access" | "ai" | "diagnostics";

const views: Array<{ id: View; label: string; icon: typeof Smartphone }> = [
  { id: "accounts", label: "账号与扫码", icon: Smartphone },
  { id: "workspace", label: "会话", icon: MessageSquareText },
  { id: "contacts", label: "联系人", icon: ContactRound },
  { id: "routing", label: "线索路由", icon: Network },
  { id: "access", label: "接入设置", icon: SlidersHorizontal },
  { id: "ai", label: "AI 翻译", icon: Bot },
  { id: "diagnostics", label: "诊断", icon: Activity }
];

export function App() {
  const launchParams = new URLSearchParams(window.location.search);
  const embedded = launchParams.get("embedded") === "1";
  const requestedView = launchParams.get("view");
  const accountsQuery = useAccounts();
  const [view, setView] = useState<View>(() => views.some((item) => item.id === requestedView) ? requestedView as View : "workspace");
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(launchParams.get("accountId") || undefined);
  const [requestedConversationId, setRequestedConversationId] = useState<string | undefined>(launchParams.get("conversationId") || undefined);
  const [lastEvent, setLastEvent] = useState<RealtimeEvent | null>(null);
  const initialQrRouteHandled = useRef(false);
  const onEvent = useCallback((event: RealtimeEvent) => setLastEvent(event), []);
  const openConversation = useCallback((accountId: string, conversationId: string) => {
    setSelectedAccountId(accountId);
    setRequestedConversationId(conversationId);
    setView("workspace");
  }, []);
  const clearConversationRequest = useCallback(() => setRequestedConversationId(undefined), []);
  useRealtimeInvalidation(onEvent);

  useEffect(() => {
    if (!selectedAccountId && accountsQuery.data?.[0]) setSelectedAccountId(accountsQuery.data[0].id);
    if (selectedAccountId && accountsQuery.data && !accountsQuery.data.some((item) => item.id === selectedAccountId)) {
      setSelectedAccountId(accountsQuery.data[0]?.id);
    }
  }, [accountsQuery.data, selectedAccountId]);

  useEffect(() => {
    if (initialQrRouteHandled.current || !accountsQuery.data) return;
    initialQrRouteHandled.current = true;
    if (!requestedConversationId && accountsQuery.data.some((account) => account.status === "waiting_qr" && account.qrDataUrl)) {
      setView("accounts");
    }
  }, [accountsQuery.data, requestedConversationId]);

  const selectedAccount = accountsQuery.data?.find((item) => item.id === selectedAccountId);

  return (
    <div className={`app-shell ${embedded ? "is-embedded" : ""}`}>
      <header className="app-header">
        <div className="product-mark" aria-label="Communication">
          <span className="product-logo"><MessageSquareText size={19} /></span>
          <span className="product-name">Communication</span>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          {views.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                data-view={item.id}
                className={view === item.id ? "is-active" : ""}
                aria-label={item.label}
                aria-current={view === item.id ? "page" : undefined}
                title={item.label}
                onClick={() => setView(item.id)}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="header-status">
          <span className={`live-dot ${selectedAccount?.status === "connected" ? "is-online" : ""}`} />
          <span>{selectedAccount?.name ?? "未选择账号"}</span>
          <Wifi size={15} />
        </div>
      </header>

      <main className="app-main">
        {view === "accounts" && (
          <AccountsPage selectedAccountId={selectedAccountId} onSelectAccount={setSelectedAccountId} onOpenWorkspace={() => setView("workspace")} onOpenAccessSettings={() => setView("access")} />
        )}
        {view === "workspace" && (
          <WorkspacePage
            selectedAccountId={selectedAccountId}
            requestedConversationId={requestedConversationId}
            onRequestedConversationHandled={clearConversationRequest}
            onSelectAccount={setSelectedAccountId}
            onManageAccounts={() => setView("accounts")}
          />
        )}
        {view === "contacts" && <ContactsPage selectedAccountId={selectedAccountId} onSelectAccount={setSelectedAccountId} onOpenConversation={openConversation} />}
        {view === "routing" && <RoutingPage />}
        {view === "access" && <AccessSettingsPage selectedAccountId={selectedAccountId} onManageAccounts={() => setView("accounts")} />}
        {view === "ai" && <AiSettingsPage />}
        {view === "diagnostics" && <DiagnosticsPage lastEvent={lastEvent} />}
      </main>
    </div>
  );
}
