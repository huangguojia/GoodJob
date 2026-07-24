import { type FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  HardDrive,
  LogOut,
  MessageSquareText,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  Settings2,
  ShieldAlert,
  Smartphone,
  Trash2
} from "lucide-react";
import type { ChannelAccount, ProviderKind } from "@shared/types";
import { api } from "../api";
import { queryKeys, useAccounts, useCapabilities, useIntegrationPreference } from "../data";
import { EmptyState, Modal, Spinner, StatusBadge } from "../components/ui";

interface Props {
  selectedAccountId?: string;
  onSelectAccount(id: string): void;
  onOpenWorkspace(): void;
  onOpenAccessSettings(): void;
}

export function AccountsPage({ selectedAccountId, onSelectAccount, onOpenWorkspace, onOpenAccessSettings }: Props) {
  const queryClient = useQueryClient();
  const accountsQuery = useAccounts();
  const capabilitiesQuery = useCapabilities();
  const integrationPreferenceQuery = useIntegrationPreference();
  const mediaRetentionQuery = useQuery({ queryKey: queryKeys.mediaRetention, queryFn: api.mediaRetention });
  const [showCreate, setShowCreate] = useState(false);
  const [qrAccountId, setQrAccountId] = useState<string | null>(null);
  const [dismissedQrAccountId, setDismissedQrAccountId] = useState<string | null>(null);
  const [loginSuccess, setLoginSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retentionMode, setRetentionMode] = useState<"immediate" | "days">("immediate");
  const [retentionDays, setRetentionDays] = useState(30);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
  const updateAccountCache = (account: ChannelAccount) => {
    queryClient.setQueryData<ChannelAccount[]>(queryKeys.accounts, (current = []) => current.some((item) => item.id === account.id)
      ? current.map((item) => item.id === account.id ? account : item)
      : [...current, account]);
  };
  const connect = useMutation({
    mutationFn: api.connectAccount,
    onSuccess: (account) => {
      setError(null);
      onSelectAccount(account.id);
      updateAccountCache(account);
      if (account.provider === "baileys") setQrAccountId(account.id);
      if (account.provider === "meta" && account.status === "connected") {
        setLoginSuccess(`官方账号“${account.name}”配置验证通过并已连接。`);
      }
      refresh();
    },
    onError: (reason) => setError(reason.message)
  });
  const reconnectForQr = useMutation({
    mutationFn: async (accountId: string) => {
      await api.logoutAccount(accountId);
      return api.connectAccount(accountId);
    },
    onSuccess: (account) => {
      setError(null);
      onSelectAccount(account.id);
      updateAccountCache(account);
      setQrAccountId(account.id);
      refresh();
    },
    onError: (reason) => setError(reason.message)
  });
  const logout = useMutation({
    mutationFn: api.logoutAccount,
    onSuccess: refresh,
    onError: (reason) => setError(reason.message)
  });
  const remove = useMutation({
    mutationFn: api.deleteAccount,
    onSuccess: refresh,
    onError: (reason) => setError(reason.message)
  });
  const saveMediaRetention = useMutation({
    mutationFn: api.updateMediaRetention,
    onSuccess: (policy) => {
      queryClient.setQueryData(queryKeys.mediaRetention, policy);
      setLoginSuccess(policy.mode === "immediate" ? "附件本地副本将在发送完成后立即清理。" : `附件本地副本将保留 ${policy.days} 天。`);
    },
    onError: (reason) => setError(reason.message)
  });

  const accounts = accountsQuery.data ?? [];
  const selectedQrAccount = qrAccountId ? accounts.find((account) => account.id === qrAccountId) : undefined;
  const qrAccount = selectedQrAccount?.provider === "baileys" ? selectedQrAccount : null;
  const savedRetention = mediaRetentionQuery.data;
  const retentionDirty = Boolean(savedRetention) && (
    retentionMode !== savedRetention?.mode
    || (retentionMode === "days" && Math.min(365, Math.max(1, retentionDays || 1)) !== savedRetention.days)
  );

  useEffect(() => {
    const policy = mediaRetentionQuery.data;
    if (!policy) return;
    setRetentionMode(policy.mode);
    if (policy.days > 0) setRetentionDays(policy.days);
  }, [mediaRetentionQuery.data]);

  useEffect(() => {
    if (dismissedQrAccountId) {
      const dismissedAccount = accounts.find((account) => account.id === dismissedQrAccountId);
      if (!dismissedAccount || dismissedAccount.status !== "waiting_qr" || !dismissedAccount.qrDataUrl) {
        setDismissedQrAccountId(null);
      }
    }
    if (!qrAccountId) {
      const waitingAccount = accounts.find((account) =>
        account.status === "waiting_qr"
        && Boolean(account.qrDataUrl)
        && account.id !== dismissedQrAccountId
      );
      if (waitingAccount) setQrAccountId(waitingAccount.id);
    }
  }, [accounts, dismissedQrAccountId, qrAccountId]);

  useEffect(() => {
    if (!qrAccountId) return;

    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    }, 1_000);

    if (!selectedQrAccount) {
      setQrAccountId(null);
      window.clearInterval(timer);
      return undefined;
    }

    if (selectedQrAccount.status === "connected") {
      setQrAccountId(null);
      setLoginSuccess(`账号“${selectedQrAccount.name}”已登录并在线。`);
      window.clearInterval(timer);
      return undefined;
    }

    return () => window.clearInterval(timer);
  }, [qrAccountId, queryClient, selectedQrAccount]);

  const openQr = (accountId: string) => {
    setLoginSuccess(null);
    setDismissedQrAccountId(null);
    setQrAccountId(accountId);
  };

  const closeQr = () => {
    setDismissedQrAccountId(qrAccountId);
    setQrAccountId(null);
  };

  const startQrLogin = (account: ChannelAccount) => {
    setLoginSuccess(null);
    setError(null);
    setDismissedQrAccountId(null);
    setQrAccountId(account.id);
    if (["connecting", "reconnecting", "degraded"].includes(account.status)) {
      reconnectForQr.mutate(account.id);
      return;
    }
    connect.mutate(account.id);
  };

  return (
    <div className="page page-accounts">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CHANNEL ACCOUNTS</span>
          <h1>Communication 账号</h1>
          <p>每个账号独立保存会话、联系人、权限和连接状态。</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" onClick={refresh} title="刷新账号状态">
            <RefreshCw size={16} /> 刷新
          </button>
          <button className="button primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> 添加账号
          </button>
        </div>
      </div>

      <div className="notice warning-notice">
        <ShieldAlert size={18} />
        <div><strong>Baileys 是非官方通道</strong><span>适合本机验证和已接受风险的业务场景，无法承诺永久在线或零封号风险。</span></div>
      </div>
      <section className="media-retention-bar">
        <div className="media-retention-title"><HardDrive size={18} /><span><strong>附件保留</strong><small>仅控制 CRM 本地副本</small></span></div>
        <div className="media-retention-controls">
          <select value={retentionMode} onChange={(event) => setRetentionMode(event.target.value as "immediate" | "days")} aria-label="附件保留方式">
            <option value="immediate">发送后立即清理</option>
            <option value="days">保留指定天数</option>
          </select>
          {retentionMode === "days" && <label className="retention-days"><input type="number" min="1" max="365" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} aria-label="附件保留天数" /><span>天</span></label>}
          <button className="button secondary" disabled={saveMediaRetention.isPending || !retentionDirty} onClick={() => saveMediaRetention.mutate({ mode: retentionMode, days: retentionMode === "immediate" ? 0 : Math.min(365, Math.max(1, retentionDays || 1)) })}>{saveMediaRetention.isPending ? <Spinner /> : <Save size={15} />} 保存</button>
        </div>
      </section>
      {loginSuccess && <div className="notice success-notice" role="status"><CheckCircle2 size={18} /><div><strong>操作成功</strong><span>{loginSuccess}</span></div><button onClick={() => setLoginSuccess(null)}>关闭</button></div>}
      {error && <div className="notice error-notice"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div>}

      {accountsQuery.isLoading ? (
        <div className="center-loading"><Spinner /> 正在读取账号池</div>
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={24} />}
          title="还没有 WhatsApp 账号"
          description="创建 Baileys 账号扫码登录，或创建 Meta 官方账号完成配置。"
          action={<button className="button primary" onClick={() => setShowCreate(true)}><Plus size={16} /> 添加账号</button>}
        />
      ) : (
        <div className="account-table-wrap">
          <table className="data-table account-table">
            <thead>
              <tr><th>账号</th><th>通道</th><th>用途与地区</th><th>状态</th><th>最近事件</th><th className="align-right">操作</th></tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className={selectedAccountId === account.id ? "is-selected" : ""}>
                  <td data-label="账号">
                    <button className="account-identity" onClick={() => onSelectAccount(account.id)}>
                      <span className="avatar account-avatar">{account.name.slice(0, 2)}</span>
                      <span><strong>{account.name}</strong><small>{account.phone ?? "等待登录后获取号码"}</small></span>
                    </button>
                  </td>
                  <td data-label="通道"><span className={`provider-label provider-${account.provider}`}>{account.provider === "baileys" ? "Baileys" : account.provider === "demo" ? "Demo" : "Meta"}</span></td>
                  <td data-label="用途"><strong className="cell-main">{account.purposeLabel || "未设置用途"}</strong><small>{account.region || "不限地区"} · {account.leadTypes.join(" / ") || "未设置线索类型"}</small></td>
                  <td data-label="状态"><StatusBadge status={account.status} />{account.lastError && <small className="error-text">{account.lastError}</small>}</td>
                  <td data-label="最近事件"><span className="muted">{account.lastEventAt ? new Date(account.lastEventAt).toLocaleString("zh-CN") : "暂无"}</span></td>
                  <td data-label="操作">
                    <div className="row-actions">
                      {account.status === "waiting_qr" && account.qrDataUrl && <button className="icon-button" title="查看登录二维码" onClick={() => openQr(account.id)}><QrCode size={17} /></button>}
                      {account.provider === "meta" && <button className="icon-button" title="配置 Meta 官方 API" onClick={() => { onSelectAccount(account.id); onOpenAccessSettings(); }}><Settings2 size={17} /></button>}
                      {account.provider === "baileys" && account.status !== "connected" && account.status !== "waiting_qr" && (
                        <button className="button compact" disabled={connect.isPending || reconnectForQr.isPending} onClick={() => startQrLogin(account)}>
                          {connect.isPending || reconnectForQr.isPending ? <Spinner /> : <QrCode size={15} />} {["connecting", "reconnecting", "degraded"].includes(account.status) ? "重新扫码" : "扫码登录"}
                        </button>
                      )}
                      {account.provider !== "baileys" && !(account.provider === "demo" && !capabilitiesQuery.data?.demoProviderEnabled) && account.status !== "connected" && account.status !== "waiting_qr" && (
                        <button className="button compact" disabled={connect.isPending} onClick={() => connect.mutate(account.id)}>
                          {connect.isPending ? <Spinner /> : account.provider === "meta" ? <Cloud size={15} /> : <QrCode size={15} />} {account.provider === "demo" ? "连接" : "验证连接"}
                        </button>
                      )}
                      {!(account.provider === "demo" && !capabilitiesQuery.data?.demoProviderEnabled) && account.status === "waiting_qr" && account.qrDataUrl && <button className="button compact" onClick={() => openQr(account.id)}><QrCode size={15} /> 扫码</button>}
                      {!(account.provider === "demo" && !capabilitiesQuery.data?.demoProviderEnabled) && account.status === "connected" && <button className="icon-button" title="打开会话" onClick={() => { onSelectAccount(account.id); onOpenWorkspace(); }}><MessageSquareText size={17} /></button>}
                      {!["unconfigured", "logged_out"].includes(account.status) && <button className="icon-button" title={account.provider === "meta" ? "停用本地连接" : "退出登录"} onClick={() => logout.mutate(account.id)}><LogOut size={17} /></button>}
                      <button className="icon-button danger" title="删除账号" onClick={() => window.confirm(`确认删除账号“${account.name}”及本机测试数据？`) && remove.mutate(account.id)}><Trash2 size={17} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateAccountModal demoProviderEnabled={capabilitiesQuery.data?.demoProviderEnabled ?? false} defaultProvider={integrationPreferenceQuery.data?.defaultProvider ?? "baileys"} onClose={() => setShowCreate(false)} onCreated={(account) => {
        setShowCreate(false);
        onSelectAccount(account.id);
        updateAccountCache(account);
        if (account.provider === "baileys") startQrLogin(account);
        else if (account.provider === "meta") onOpenAccessSettings();
        else refresh();
      }} />}
      {qrAccount && (
        <Modal title={`登录 ${qrAccount.name}`} onClose={closeQr} width="420px">
          <div className="qr-login">
            {qrAccount.status === "waiting_qr" && qrAccount.qrDataUrl ? (
              <><img src={qrAccount.qrDataUrl} alt={`${qrAccount.name} WhatsApp 登录二维码`} /><ol><li>手机打开 WhatsApp</li><li>进入“设置 → 已关联的设备”</li><li>选择“关联设备”并扫描此二维码</li></ol><div className="notice subtle-notice"><AlertTriangle size={16} /><span>二维码只用于当前授权弹窗，请勿截图或转发。</span></div></>
            ) : connect.isPending || reconnectForQr.isPending || ["connecting", "reconnecting", "waiting_qr"].includes(qrAccount.status) ? (
              <div className="qr-result-state"><Spinner /><strong>正在生成登录二维码</strong><span>二维码生成后会自动显示，请保持此窗口打开。</span></div>
            ) : (
              <div className="qr-result-state is-error"><AlertTriangle size={24} /><strong>登录尚未完成</strong><span>{qrAccount.lastError ?? `当前状态：${qrAccount.status}`}</span><div className="modal-actions"><button className="button secondary" onClick={closeQr}>关闭</button><button className="button primary" disabled={connect.isPending || reconnectForQr.isPending} onClick={() => startQrLogin(qrAccount)}>{connect.isPending || reconnectForQr.isPending ? <Spinner /> : <RefreshCw size={16} />} 重新扫码</button></div></div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateAccountModal({ demoProviderEnabled, defaultProvider, onClose, onCreated }: { demoProviderEnabled: boolean; defaultProvider: "baileys" | "meta"; onClose(): void; onCreated(account: ChannelAccount): void }) {
  const [provider, setProvider] = useState<ProviderKind>(defaultProvider);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({ mutationFn: api.createAccount, onSuccess: onCreated, onError: (reason) => setError(reason.message) });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      name: form.get("name"), provider, phone: form.get("phone") || undefined,
      purposeLabel: form.get("purposeLabel") || undefined, region: form.get("region") || undefined,
      leadTypes: String(form.get("leadTypes") ?? "").split(/[，,]/u).map((item) => item.trim()).filter(Boolean),
      riskAccepted: provider !== "baileys" || riskAccepted
    });
  };

  return (
    <Modal title="添加 WhatsApp 账号" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label><span>通道</span><select value={provider} onChange={(event) => setProvider(event.target.value as ProviderKind)}><option value="baileys">Baileys 免费非官方通道</option><option value="meta">Meta Cloud API 官方通道</option>{demoProviderEnabled && <option value="demo">Demo 测试通道</option>}</select></label>
        <div className="form-grid two"><label><span>账号名称</span><input name="name" required placeholder="例如：北美销售" /></label><label><span>号码（可选）</span><input name="phone" placeholder="登录后可自动获取" /></label></div>
        <div className="form-grid two"><label><span>用途标签</span><input name="purposeLabel" placeholder="例如：批发询盘" /></label><label><span>地区</span><input name="region" placeholder="例如：北美" /></label></div>
        <label><span>线索类型</span><input name="leadTypes" placeholder="批发，经销商，样品" /><small>使用逗号分隔，用于后续账号路由。</small></label>
        {provider === "baileys" && <label className="check-row"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} /><span>我已了解该通道并非 Meta 官方 API，可能需要重新登录或因平台策略中断。</span></label>}
        {provider === "meta" && <div className="notice info-notice"><ExternalLink size={16} /><span>账号创建后保持“未配置”，接着在接入设置中绑定 Meta App、WABA、Phone Number ID 和 Access Token。</span></div>}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={create.isPending || (provider === "baileys" && !riskAccepted)}>{create.isPending ? <Spinner /> : <Plus size={16} />} 创建账号</button></div>
      </form>
    </Modal>
  );
}
