import { type FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  Check,
  ContactRound,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  UserPlus,
  Users,
  Zap
} from "lucide-react";
import type { Contact } from "@shared/types";
import { api } from "../api";
import { queryKeys, useAccounts } from "../data";
import { EmptyState, Modal, Spinner, StatusBadge, Toggle } from "../components/ui";

interface Props {
  selectedAccountId?: string;
  onSelectAccount(id: string): void;
  onOpenConversation(accountId: string, conversationId: string): void;
}

const originLabels: Record<Contact["origin"], string> = {
  whatsapp_sync: "WhatsApp 同步",
  inbound_message: "客户来信",
  manual: "手动添加",
  crm_import: "CRM 导入"
};

type ContactAccountOption = { id: string; name: string; provider: string; status: string };

function canProvisionContact(account: ContactAccountOption): boolean {
  return account.provider !== "baileys" || account.status === "connected";
}

export function ContactsPage({ selectedAccountId, onSelectAccount, onOpenConversation }: Props) {
  const queryClient = useQueryClient();
  const accountsQuery = useAccounts();
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<Contact["origin"] | "all">("all");
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [showCrmImport, setShowCrmImport] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contactsQuery = useQuery({
    queryKey: queryKeys.contacts(selectedAccountId),
    queryFn: () => api.contacts(selectedAccountId),
    enabled: Boolean(selectedAccountId)
  });
  const crmQuery = useQuery({ queryKey: queryKeys.crmContacts, queryFn: api.crmContacts });
  const preferenceQuery = useQuery({ queryKey: queryKeys.preference, queryFn: api.translationPreference });
  const sync = useMutation({
    mutationFn: () => api.syncContacts(selectedAccountId!),
    onSuccess: (result) => {
      setError(null);
      setFeedback(`已刷新当前账号收到的联系人，共 ${result.count} 条。`);
      void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (reason) => setError(reason.message)
  });
  const createCrm = useMutation({
    mutationFn: api.createCrmContact,
    onSuccess: () => {
      setError(null);
      setFeedback("联系人已创建并关联到 CRM Sandbox。");
      void queryClient.invalidateQueries({ queryKey: ["contacts"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.crmContacts });
    },
    onError: (reason) => setError(reason.message)
  });
  const updatePreference = useMutation({
    mutationFn: api.updateTranslationPreference,
    onSuccess: (preference) => {
      setError(null);
      setFeedback(preference.crmAutoCreate ? "新入站联系人自动建档已开启。" : "新入站联系人自动建档已关闭。");
      void queryClient.invalidateQueries({ queryKey: queryKeys.preference });
    },
    onError: (reason) => setError(reason.message)
  });
  const startConversation = useMutation({
    mutationFn: api.createContactConversation,
    onSuccess: (conversation) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations(conversation.accountId) });
      onOpenConversation(conversation.accountId, conversation.id);
    },
    onError: (reason) => setError(reason.message)
  });

  const account = accountsQuery.data?.find((item) => item.id === selectedAccountId);
  const provisionableAccounts = (accountsQuery.data ?? []).filter(canProvisionContact);
  const contacts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (contactsQuery.data ?? []).filter((item) => {
      const matchesSearch = !needle || item.displayName.toLowerCase().includes(needle) || item.phone.includes(needle);
      return matchesSearch && (origin === "all" || item.origin === origin);
    });
  }, [contactsQuery.data, origin, search]);

  return (
    <div className="page page-contacts">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONTACT OPERATIONS</span>
          <h1>联系人与 CRM 建档</h1>
          <p>WhatsApp、手动录入和 CRM 导入按账号隔离，并统一使用 E.164 手机号匹配。</p>
        </div>
        <div className="heading-actions">
          <select value={selectedAccountId ?? ""} onChange={(event) => onSelectAccount(event.target.value)}>
            {accountsQuery.data?.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.provider}</option>)}
          </select>
          <button className="button secondary" disabled={!account || account.status !== "connected" || sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? <Spinner /> : <RefreshCw size={16} />} 刷新同步结果
          </button>
          <button className="button secondary" disabled={provisionableAccounts.length === 0 || !crmQuery.data?.length} onClick={() => setShowCrmImport(true)}>
            <ArrowDownToLine size={16} /> 从 CRM 导入
          </button>
          <button className="button primary" disabled={provisionableAccounts.length === 0} onClick={() => setShowManualAdd(true)}>
            <UserPlus size={16} /> 手动添加
          </button>
        </div>
      </div>

      <div className="notice info-notice">
        <Zap size={18} />
        <div>
          <strong>联系人由事件自动写入</strong>
          <span>Baileys 在登录历史、联系人变更和客户来信时增量写入；“刷新同步结果”只重新读取已收到的数据，不承诺主动拉取完整手机通讯录。</span>
        </div>
      </div>
      {feedback && <div className="notice success-notice" role="status"><Check size={18} /><span>{feedback}</span><button onClick={() => setFeedback(null)}>关闭</button></div>}
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div>}

      <div className="summary-strip">
        <div><Users size={18} /><span><strong>{contactsQuery.data?.length ?? 0}</strong> 当前账号联系人</span></div>
        <div><ContactRound size={18} /><span><strong>{crmQuery.data?.length ?? 0}</strong> CRM Sandbox 联系人</span></div>
        <div><StatusBadge status={account?.status ?? "unconfigured"} /><span>{account?.provider === "meta" ? "官方基础 API 仅获取发生互动的客户" : account?.provider === "baileys" ? "同步范围取决于 WhatsApp Web 下发" : "Demo 数据已就绪"}</span></div>
      </div>

      <section className="contact-policy-bar" aria-label="联系人自动建档策略">
        <div><Sparkles size={17} /><span><strong>新入站联系人自动建档</strong><small>开启后，首次收到客户消息时自动创建或复用 CRM Sandbox 联系人。</small></span></div>
        {preferenceQuery.data && (
          <Toggle
            checked={preferenceQuery.data.crmAutoCreate}
            onChange={(crmAutoCreate) => updatePreference.mutate({ crmAutoCreate })}
            label={preferenceQuery.data.crmAutoCreate ? "已开启" : "已关闭"}
          />
        )}
      </section>

      <div className="table-toolbar">
        <div className="contact-filters">
          <div className="search-box wide"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索联系人姓名或号码" /></div>
          <select value={origin} onChange={(event) => setOrigin(event.target.value as Contact["origin"] | "all")} aria-label="筛选联系人来源">
            <option value="all">全部来源</option>
            {Object.entries(originLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <span className="muted">同一号码可存在于不同账号；会话固定到创建它的账号</span>
      </div>

      {contactsQuery.isLoading ? (
        <div className="center-loading"><Spinner /> 正在读取联系人</div>
      ) : contacts.length === 0 ? (
        <EmptyState
          icon={<ContactRound size={24} />}
          title="没有符合条件的联系人"
          description="等待 WhatsApp 事件自动写入，或手动添加一个 E.164 号码开始联系。"
          action={<button className="button primary" disabled={provisionableAccounts.length === 0} onClick={() => setShowManualAdd(true)}><Plus size={16} /> 手动添加</button>}
        />
      ) : (
        <div className="account-table-wrap">
          <table className="data-table contact-table">
            <thead><tr><th>联系人</th><th>WhatsApp 号码</th><th>来源</th><th>最近同步</th><th>CRM 状态</th><th className="align-right">操作</th></tr></thead>
            <tbody>{contacts.map((contact) => (
              <tr key={contact.id}>
                <td><div className="identity-cell"><span className="avatar">{contact.displayName.slice(0, 2)}</span><span><strong>{contact.displayName}</strong><small className="mono clamp-id">{contact.providerContactId}</small></span></div></td>
                <td><span className="mono">{contact.phone}</span></td>
                <td><div className="contact-origin"><span className={`provider-label provider-${contact.source}`}>{contact.source}</span><span className={`origin-label origin-${contact.origin}`}>{originLabels[contact.origin]}</span></div></td>
                <td>{contact.lastSeenAt ? new Date(contact.lastSeenAt).toLocaleString("zh-CN") : "暂无"}</td>
                <td>{contact.crmContactId ? <span className="linked-pill"><Check size={13} /> 已关联</span> : <span className="pending-pill">待建档</span>}</td>
                <td><div className="row-actions">
                  {!contact.crmContactId && <button className="button compact" disabled={createCrm.isPending} onClick={() => createCrm.mutate(contact.id)}><UserPlus size={15} /> 建到 CRM</button>}
                  <button className="button compact" disabled={startConversation.isPending} onClick={() => startConversation.mutate(contact.id)}><MessageSquarePlus size={15} /> 发消息</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {showManualAdd && selectedAccountId && (
        <ManualContactModal
          accounts={accountsQuery.data ?? []}
          defaultAccountId={selectedAccountId}
          onClose={() => setShowManualAdd(false)}
          onCreated={(result) => {
            setShowManualAdd(false);
            setError(null);
            setFeedback(result.crmContact ? "联系人和 CRM Sandbox 建档已创建。" : "联系人已添加，可从列表发起会话。");
            onSelectAccount(result.contact.accountId);
            void queryClient.invalidateQueries({ queryKey: ["contacts"] });
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });
            void queryClient.invalidateQueries({ queryKey: queryKeys.crmContacts });
          }}
        />
      )}
      {showCrmImport && selectedAccountId && (
        <CrmImportModal
          accounts={accountsQuery.data ?? []}
          crmContacts={crmQuery.data ?? []}
          defaultAccountId={selectedAccountId}
          onClose={() => setShowCrmImport(false)}
          onImported={(result) => {
            setShowCrmImport(false);
            setError(null);
            setFeedback("CRM Sandbox 联系人已导入当前 WhatsApp 账号，可从列表发起会话。");
            onSelectAccount(result.contact.accountId);
            void queryClient.invalidateQueries({ queryKey: ["contacts"] });
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          }}
        />
      )}
    </div>
  );
}

function CrmImportModal({
  accounts,
  crmContacts,
  defaultAccountId,
  onClose,
  onImported
}: {
  accounts: ContactAccountOption[];
  crmContacts: Array<{ id: string; name: string; phone: string }>;
  defaultAccountId: string;
  onClose(): void;
  onImported(result: Awaited<ReturnType<typeof api.importCrmContact>>): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const eligibleAccounts = accounts.filter(canProvisionContact);
  const initialAccountId = eligibleAccounts.some((account) => account.id === defaultAccountId)
    ? defaultAccountId
    : eligibleAccounts[0]?.id ?? "";
  const importContact = useMutation({ mutationFn: api.importCrmContact, onSuccess: onImported, onError: (reason) => setError(reason.message) });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    importContact.mutate({ crmContactId: String(form.get("crmContactId")), accountId: String(form.get("accountId")) });
  };

  return (
    <Modal title="从 CRM Sandbox 导入联系人" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label><span>CRM 联系人</span><select name="crmContactId" required>{crmContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name} · {contact.phone}</option>)}</select></label>
        <label><span>目标 WhatsApp 账号</span><select name="accountId" defaultValue={initialAccountId} disabled={eligibleAccounts.length === 0}>{accounts.map((account) => <option key={account.id} value={account.id} disabled={!canProvisionContact(account)}>{account.name} · {account.provider} · {canProvisionContact(account) ? account.status === "connected" ? "在线" : "可先建档" : "需先连接"}</option>)}</select></label>
        <div className="notice subtle-notice"><ArrowDownToLine size={16} /><span>导入会校验号码并创建账号级渠道身份与会话；CRM 主联系人仍按 E.164 手机号复用，不复制客户档案。</span></div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={importContact.isPending || eligibleAccounts.length === 0}>{importContact.isPending ? <Spinner /> : <ArrowDownToLine size={16} />} 导入联系人</button></div>
      </form>
    </Modal>
  );
}

function ManualContactModal({
  accounts,
  defaultAccountId,
  onClose,
  onCreated
}: {
  accounts: ContactAccountOption[];
  defaultAccountId: string;
  onClose(): void;
  onCreated(result: Awaited<ReturnType<typeof api.createContact>>): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const eligibleAccounts = accounts.filter(canProvisionContact);
  const initialAccountId = eligibleAccounts.some((account) => account.id === defaultAccountId)
    ? defaultAccountId
    : eligibleAccounts[0]?.id ?? "";
  const create = useMutation({ mutationFn: api.createContact, onSuccess: onCreated, onError: (reason) => setError(reason.message) });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      accountId: String(form.get("accountId")),
      displayName: String(form.get("displayName")),
      phone: String(form.get("phone")),
      createCrmContact: form.get("createCrmContact") === "on"
    });
  };

  return (
    <Modal title="手动添加 WhatsApp 联系人" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label><span>发送账号</span><select name="accountId" defaultValue={initialAccountId} disabled={eligibleAccounts.length === 0}>{accounts.map((account) => <option key={account.id} value={account.id} disabled={!canProvisionContact(account)}>{account.name} · {account.provider} · {canProvisionContact(account) ? account.status === "connected" ? "在线" : "可先建档" : "需先连接"}</option>)}</select></label>
        <div className="form-grid two">
          <label><span>联系人姓名</span><input name="displayName" required maxLength={80} placeholder="例如：Maria Garcia" /></label>
          <label><span>WhatsApp 号码</span><input name="phone" required inputMode="tel" placeholder="例如：+34612123456" /><small>必须包含国家区号，服务端按 E.164 校验；真实 Baileys 账号还会检查该号码是否注册 WhatsApp。</small></label>
        </div>
        <label className="check-row"><input name="createCrmContact" type="checkbox" /><span>同时创建或关联 CRM Sandbox 联系人</span></label>
        <div className="notice subtle-notice"><ContactRound size={16} /><span>重复提交同一账号和号码会更新现有联系人，不会重复创建会话；不同账号可保留各自的渠道身份。</span></div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={create.isPending || eligibleAccounts.length === 0}>{create.isPending ? <Spinner /> : <UserPlus size={16} />} 添加联系人</button></div>
      </form>
    </Modal>
  );
}
