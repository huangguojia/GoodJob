import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  AppWindow,
  Check,
  ClipboardCopy,
  Cloud,
  KeyRound,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  Webhook,
  Zap
} from "lucide-react";
import {
  api,
  type IntegrationPreference,
  type IntegrationStrategy,
  type MetaAccountConfiguration,
  type MetaAppConfig
} from "../api";
import {
  queryKeys,
  useAccounts,
  useIntegrationPreference,
  useMetaApps,
  useMetaConfigurations
} from "../data";
import { EmptyState, Spinner, StatusBadge } from "../components/ui";

interface Props {
  selectedAccountId?: string;
  onManageAccounts(): void;
}

const strategyOptions: Array<{
  id: IntegrationStrategy;
  label: string;
  description: string;
  icon: typeof Zap;
}> = [
  { id: "free_first", label: "免费优先", description: "默认新建 Baileys 账号", icon: Zap },
  { id: "official_first", label: "官方优先", description: "默认新建 Meta 账号", icon: ShieldCheck },
  { id: "hybrid", label: "混合共存", description: "按账号与线索分别路由", icon: Network }
];

const comparisonRows = [
  {
    capability: "接入身份",
    baileys: "手机扫码关联 WhatsApp Web 会话",
    meta: "Meta App、WABA、Phone Number ID 与 Access Token"
  },
  {
    capability: "费用构成",
    baileys: "无 Meta Cloud API 消息费；仍有服务器、维护与 AI 翻译成本",
    meta: "按 Meta 当前计费规则承担模板/消息费用，并有服务器与运维成本"
  },
  {
    capability: "联系人与历史",
    baileys: "读取 WhatsApp Web 实际下发的联系人和增量事件，范围不保证完整",
    meta: "标准 Cloud API 不提供通用通讯录；通常从互动与 Webhook 建档"
  },
  {
    capability: "主动联系",
    baileys: "可直接发起，但属于非官方协议行为，需自行限频和承担账号风险",
    meta: "24 小时窗口内可发自由文本；窗口外可按名称发送已审核模板，并遵循用户同意规则"
  },
  {
    capability: "稳定性与合规",
    baileys: "可能因协议升级、重登或平台风控中断，无官方 SLA",
    meta: "官方支持路径，规则清晰；Token、Webhook、模板与版本仍需持续维护"
  },
  {
    capability: "多账号",
    baileys: "每个号码独立扫码、AuthState、连接与数据分区",
    meta: "每个号码独立绑定 Phone Number ID，可共用或拆分 Meta App"
  },
  {
    capability: "同一号码共存",
    baileys: "不可把普通 Baileys 登录视为官方同号共存方案",
    meta: "仅符合 Meta 官方 Business App Coexistence 资格并按官方流程接入时可行"
  }
];

const migrationRows = [
  {
    from: "免费",
    to: "官方",
    title: "新建 Meta 渠道身份，保留旧数据只读可查",
    detail: "Baileys AuthState、二维码会话和 Provider 消息 ID 不能迁移到 Cloud API。旧联系人与会话可留在插件数据库，但新消息必须绑定新的 Meta 账号；号码接入、模板与 24 小时窗口需要重新验收。"
  },
  {
    from: "官方",
    to: "免费",
    title: "先停用官方账号，再重新扫码建立免费会话",
    detail: "在插件停用官方账号后，新入站不会再写入联系人、CRM 或 AI 翻译，只保留迟到的消息状态回执；Meta 后台订阅、Token 和号码注册不会自动撤销。官方模板状态、送达语义和历史不会复制到 Web 会话。"
  },
  {
    from: "混合",
    to: "共存",
    title: "优先使用不同号码，按账号固定路由",
    detail: "Baileys 与 Meta 账号可在同一插件中同时在线，联系人、会话、消息和幂等键按 accountId 隔离。线索一旦建立会话，应继续使用原账号，避免重复收件、错号发送和客户身份误合并。"
  }
];

export function AccessSettingsPage({ selectedAccountId, onManageAccounts }: Props) {
  const queryClient = useQueryClient();
  const accountsQuery = useAccounts();
  const preferenceQuery = useIntegrationPreference();
  const metaAppsQuery = useMetaApps();
  const metaConfigurationsQuery = useMetaConfigurations();
  const appFormRef = useRef<HTMLFormElement>(null);
  const [selectedMetaAccountId, setSelectedMetaAccountId] = useState<string>();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const metaAccounts = useMemo(
    () => (accountsQuery.data ?? []).filter((account) => account.provider === "meta"),
    [accountsQuery.data]
  );
  const metaApps = metaAppsQuery.data ?? [];
  const metaConfigurations = metaConfigurationsQuery.data ?? [];

  useEffect(() => {
    const preferredAccount = metaAccounts.find((account) => account.id === selectedAccountId);
    if (preferredAccount && preferredAccount.id !== selectedMetaAccountId) {
      setSelectedMetaAccountId(preferredAccount.id);
      return;
    }
    if (!selectedMetaAccountId || !metaAccounts.some((account) => account.id === selectedMetaAccountId)) {
      setSelectedMetaAccountId(metaAccounts[0]?.id);
    }
  }, [metaAccounts, selectedAccountId, selectedMetaAccountId]);

  const selectedMetaAccount = metaAccounts.find((account) => account.id === selectedMetaAccountId);
  const selectedMetaConfiguration = metaConfigurations.find((config) => config.accountId === selectedMetaAccountId);

  const updatePreference = useMutation({
    mutationFn: api.updateIntegrationPreference,
    onSuccess: (preference) => {
      setError(null);
      setFeedback("接入策略已保存；现有账号、登录状态和历史数据均未改动。");
      queryClient.setQueryData(queryKeys.integrationPreference, preference);
    },
    onError: (reason) => setError(reason.message)
  });
  const createMetaApp = useMutation({
    mutationFn: api.createMetaApp,
    onSuccess: (app) => {
      setError(null);
      setFeedback(`Meta App“${app.name}”已保存，密钥仅保留脱敏结果。`);
      appFormRef.current?.reset();
      queryClient.setQueryData<MetaAppConfig[]>(queryKeys.metaApps, (current = []) => [...current, app]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.metaApps });
    },
    onError: (reason) => setError(reason.message)
  });
  const saveMetaConfiguration = useMutation({
    mutationFn: ({ accountId, input }: {
      accountId: string;
      input: { appConfigId: string; wabaId: string; phoneNumberId: string; accessToken: string; graphApiVersion: string };
    }) => api.updateMetaAccountConfiguration(accountId, input),
    onSuccess: (configuration) => {
      setError(null);
      setFeedback("Meta 账号配置已加密保存；请执行连接验证并确认 Webhook 状态。");
      queryClient.setQueryData<MetaAccountConfiguration[]>(queryKeys.metaConfigurations, (current = []) => [
        ...current.filter((item) => item.accountId !== configuration.accountId),
        configuration
      ]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.metaConfigurations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    },
    onError: (reason) => setError(reason.message)
  });
  const verifyMetaConnection = useMutation({
    mutationFn: api.connectAccount,
    onSuccess: (account) => {
      setError(null);
      setFeedback(account.status === "connected" ? `官方账号“${account.name}”验证通过并已连接。` : `“${account.name}”验证请求已完成，当前状态：${account.status}。`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      void queryClient.invalidateQueries({ queryKey: queryKeys.metaConfigurations });
    },
    onError: (reason) => setError(reason.message)
  });

  const selectStrategy = (strategy: IntegrationStrategy) => {
    const preference = preferenceQuery.data;
    if (!preference || updatePreference.isPending) return;
    const defaultProvider = strategy === "free_first"
      ? "baileys"
      : strategy === "official_first"
        ? "meta"
        : preference.defaultProvider;
    updatePreference.mutate({ strategy, defaultProvider });
  };

  const selectDefaultProvider = (defaultProvider: IntegrationPreference["defaultProvider"]) => {
    const preference = preferenceQuery.data;
    if (!preference || preference.strategy !== "hybrid" || updatePreference.isPending) return;
    updatePreference.mutate({ strategy: preference.strategy, defaultProvider });
  };

  const submitMetaApp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createMetaApp.mutate({
      name: String(form.get("name") ?? "").trim(),
      appId: String(form.get("appId") ?? "").trim(),
      appSecret: String(form.get("appSecret") ?? ""),
      verifyToken: String(form.get("verifyToken") ?? "")
    });
  };

  const submitMetaConfiguration = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedMetaAccountId) return;
    const form = new FormData(event.currentTarget);
    saveMetaConfiguration.mutate({
      accountId: selectedMetaAccountId,
      input: {
        appConfigId: String(form.get("appConfigId") ?? ""),
        wabaId: String(form.get("wabaId") ?? "").trim(),
        phoneNumberId: String(form.get("phoneNumberId") ?? "").trim(),
        accessToken: String(form.get("accessToken") ?? ""),
        graphApiVersion: String(form.get("graphApiVersion") ?? "").trim()
      }
    });
  };

  const refresh = () => {
    setError(null);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts }),
      queryClient.invalidateQueries({ queryKey: queryKeys.integrationPreference }),
      queryClient.invalidateQueries({ queryKey: queryKeys.metaApps }),
      queryClient.invalidateQueries({ queryKey: queryKeys.metaConfigurations })
    ]);
  };

  const copyWebhook = async (app: MetaAppConfig) => {
    if (!app.webhookPath) return;
    try {
      await navigator.clipboard.writeText(resolveWebhookUrl(app.webhookPath));
      setFeedback(`“${app.name}”的 Webhook 回调地址已复制。`);
    } catch {
      setError("浏览器未允许复制，请手动选择回调地址。");
    }
  };

  const queryError = preferenceQuery.error ?? metaAppsQuery.error ?? metaConfigurationsQuery.error ?? accountsQuery.error;
  const visibleError = error ?? queryError?.message;

  return (
    <div className="page page-access-settings">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CHANNEL ACCESS</span>
          <h1>Communication 接入设置</h1>
          <p>管理免费非官方通道、Meta 官方 API 与多账号混合运行策略。</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" onClick={refresh}><RefreshCw size={16} /> 刷新配置</button>
          <button className="button primary" onClick={onManageAccounts}><Smartphone size={16} /> 账号管理</button>
        </div>
      </div>

      {feedback && <div className="notice success-notice" role="status"><Check size={18} /><span>{feedback}</span><button onClick={() => setFeedback(null)}>关闭</button></div>}
      {visibleError && <div className="notice error-notice" role="alert"><AlertTriangle size={18} /><span>{visibleError}</span><button onClick={() => { setError(null); refresh(); }}>重试</button></div>}

      <div className="access-layout">
        <div className="settings-column">
          <section className="settings-section">
            <header><Settings2 size={18} /><div><h2>默认接入策略</h2><p>策略只决定后续默认选择，不替代账号级 Provider 配置</p></div></header>
            <div className="strategy-settings">
              {preferenceQuery.isLoading ? <div className="center-loading"><Spinner /> 读取接入策略</div> : !preferenceQuery.data ? <div className="empty-inline"><AlertTriangle size={20} /><span>接入策略暂不可用，请重试。</span></div> : (
                <>
                  <div className="strategy-segments" role="group" aria-label="接入策略">
                    {strategyOptions.map((option) => {
                      const Icon = option.icon;
                      const selected = preferenceQuery.data.strategy === option.id;
                      return (
                        <button key={option.id} type="button" className={selected ? "is-selected" : ""} aria-pressed={selected} disabled={updatePreference.isPending} onClick={() => selectStrategy(option.id)}>
                          <Icon size={17} /><span><strong>{option.label}</strong><small>{option.description}</small></span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="default-provider-row">
                    <span><strong>默认新建通道</strong><small>{preferenceQuery.data.strategy === "hybrid" ? "混合模式可选择账号创建时的推荐项" : "当前策略已固定默认通道；不会改变现有账号"}</small></span>
                    <select value={preferenceQuery.data.defaultProvider} onChange={(event) => selectDefaultProvider(event.target.value as IntegrationPreference["defaultProvider"])} disabled={updatePreference.isPending || preferenceQuery.data.strategy !== "hybrid"}>
                      <option value="baileys">Baileys 免费通道</option>
                      <option value="meta">Meta 官方 API</option>
                    </select>
                  </div>
                  <div className="behavior-note"><strong>无损切换边界</strong><span>保存策略不会自动登出、迁移、合并或删除任何账号。发送身份仍由会话绑定的 accountId 决定。</span></div>
                </>
              )}
            </div>
          </section>

          <section className="settings-section">
            <header><Network size={18} /><div><h2>通道能力差别</h2><p>“免费”指不产生 Meta Cloud API 消息费，不代表零运维成本或官方授权</p></div></header>
            <div className="comparison-table-wrap">
              <table className="data-table capability-comparison">
                <thead><tr><th>能力</th><th><span className="provider-label provider-baileys">Baileys 免费</span></th><th><span className="provider-label provider-meta">Meta 标准 API</span></th></tr></thead>
                <tbody>{comparisonRows.map((row) => <tr key={row.capability}><td><strong>{row.capability}</strong></td><td>{row.baileys}</td><td>{row.meta}</td></tr>)}</tbody>
              </table>
            </div>
          </section>

          <section className="settings-section">
            <header><Link2 size={18} /><div><h2>接入操作步骤</h2><p>先完成账号级验证，再把通过验收的账号加入线索路由</p></div></header>
            <div className="setup-tracks">
              <div className="setup-track">
                <div className="setup-track-title"><Zap size={17} /><span><strong>Baileys 免费通道</strong><small>二维码关联 WhatsApp Web</small></span></div>
                <ol>
                  <li><span>1</span><div><strong>创建免费账号</strong><small>在账号管理选择 Baileys，并确认非官方协议风险。</small></div></li>
                  <li><span>2</span><div><strong>连接并扫码</strong><small>手机进入“已关联的设备”，扫描插件生成的当前二维码。</small></div></li>
                  <li><span>3</span><div><strong>验证数据范围</strong><small>检查联系人增量、双向消息、翻译和重启后的会话恢复。</small></div></li>
                  <li><span>4</span><div><strong>限制业务风险</strong><small>按账号隔离、控制发送频率，并准备重新登录与官方切换预案。</small></div></li>
                </ol>
              </div>
              <div className="setup-track">
                <div className="setup-track-title"><Cloud size={17} /><span><strong>Meta 官方 API</strong><small>Cloud API 标准接入</small></span></div>
                <ol>
                  <li><span>1</span><div><strong>准备 Meta 资产</strong><small>完成 Business Portfolio、WABA、业务号码与 Meta App 的权限配置。</small></div></li>
                  <li><span>2</span><div><strong>保存 App 凭据</strong><small>在右侧录入 App ID、App Secret 与自定义 Verify Token，取得回调地址。</small></div></li>
                  <li><span>3</span><div><strong>配置官方账号</strong><small>绑定 WABA ID、Phone Number ID、长期 Token 与仍受支持的 Graph API 版本。</small></div></li>
                  <li><span>4</span><div><strong>订阅并验证</strong><small>在 Meta 后台配置回调并订阅 messages，验证窗口内文本和已审核模板；当前模板入口支持 Body 文本变量。</small></div></li>
                </ol>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <header><RefreshCw size={18} /><div><h2>切换与共存影响</h2><p>Provider 凭据、消息标识和平台规则不同，不做隐式跨通道迁移</p></div></header>
            <div className="migration-list">
              {migrationRows.map((row) => (
                <div className="migration-row" key={`${row.from}-${row.to}`}>
                  <div className="migration-direction"><span>{row.from}</span><strong>→</strong><span>{row.to}</span></div>
                  <div><strong>{row.title}</strong><p>{row.detail}</p></div>
                </div>
              ))}
            </div>
            <div className="notice warning-notice coexistence-warning">
              <AlertTriangle size={17} />
              <div><strong>同号共存不是 Baileys 与 Cloud API 任意并行登录</strong><span>插件默认阻止同一号码在两个活跃通道中同时运行；切换前必须先停用旧账号。同一号码只有在具备 Meta 官方 WhatsApp Business App Coexistence 资格，并通过官方 Embedded Signup/合作伙伴流程接入时，才能按官方规则保留 Business App。混合模式默认使用不同号码。</span></div>
            </div>
          </section>
        </div>

        <div className="settings-column access-config-column">
          <section className="settings-section">
            <header><AppWindow size={18} /><div><h2>Meta App</h2><p>服务端加密保存凭据，浏览器只接收掩码和 Webhook 路径</p></div></header>
            <form ref={appFormRef} className="settings-fields" onSubmit={submitMetaApp}>
              <label><span>配置名称</span><input name="name" required placeholder="例如：正式环境 Meta App" /></label>
              <label><span>App ID</span><input name="appId" required inputMode="numeric" autoComplete="off" placeholder="Meta App ID" /></label>
              <label><span>App Secret</span><input name="appSecret" type="password" required autoComplete="new-password" placeholder="仅本次提交，不会回显" /></label>
              <label><span>Webhook Verify Token</span><input name="verifyToken" type="password" required autoComplete="new-password" placeholder="自行生成的高强度随机值" /><small>该值用于 Meta 首次验证回调，不是 Access Token。</small></label>
              <button className="button primary" disabled={createMetaApp.isPending}>{createMetaApp.isPending ? <Spinner /> : <Plus size={16} />} 保存 Meta App</button>
            </form>
            <div className="meta-app-list">
              {metaAppsQuery.isLoading ? <div className="center-loading"><Spinner /> 读取 App</div> : metaApps.length === 0 ? <div className="empty-inline"><AppWindow size={21} /><span>尚未保存 Meta App</span></div> : metaApps.map((app) => (
                <div className="meta-app-row" key={app.id}>
                  <div className="meta-app-heading"><span className="provider-icon"><AppWindow size={16} /></span><span><strong>{app.name}</strong><small>App ID {app.appId}</small></span></div>
                  <dl>
                    <div><dt>App Secret</dt><dd className="secret-mask">{app.appSecretMask}</dd></div>
                    <div><dt>Verify Token</dt><dd className="secret-mask">{app.verifyTokenMask}</dd></div>
                    <div className="webhook-address"><dt>Webhook 回调</dt><dd><code>{app.webhookPath ? resolveWebhookUrl(app.webhookPath) : "保存后生成"}</code>{app.webhookPath && <button className="icon-button" title="复制 Webhook 回调地址" onClick={() => void copyWebhook(app)}><ClipboardCopy size={15} /></button>}</dd></div>
                  </dl>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <header><Server size={18} /><div><h2>Meta 账号配置</h2><p>每个官方账号独立绑定号码资源、Token 和 API 版本</p></div></header>
            {metaAccounts.length === 0 ? (
              <EmptyState icon={<Cloud size={23} />} title="还没有 Meta 账号" description="先在账号管理创建 Meta Cloud API 账号，再返回这里完成官方配置。" action={<button className="button primary" onClick={onManageAccounts}><Plus size={16} /> 创建 Meta 账号</button>} />
            ) : (
              <>
                <div className="meta-account-selector">
                  <label><span>选择官方账号</span><select value={selectedMetaAccountId ?? ""} onChange={(event) => setSelectedMetaAccountId(event.target.value)}>{metaAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.status}</option>)}</select></label>
                  {selectedMetaAccount && <StatusBadge status={selectedMetaAccount.status} />}
                </div>
                {metaApps.length === 0 ? (
                  <div className="notice warning-notice meta-prerequisite"><AlertTriangle size={17} /><span>请先保存一个 Meta App，再配置账号。</span></div>
                ) : (
                  <form
                    key={`${selectedMetaAccountId ?? "none"}:${selectedMetaConfiguration?.updatedAt ?? "new"}:${metaApps.length}`}
                    className="settings-fields meta-account-form"
                    onSubmit={submitMetaConfiguration}
                  >
                    <label><span>Meta App</span><select name="appConfigId" required defaultValue={selectedMetaConfiguration?.appConfigId ?? metaApps[0]?.id}>{metaApps.map((app) => <option key={app.id} value={app.id}>{app.name} · {app.appId}</option>)}</select></label>
                    <label><span>WABA ID</span><input name="wabaId" required inputMode="numeric" autoComplete="off" defaultValue={selectedMetaConfiguration?.wabaId ?? ""} placeholder="WhatsApp Business Account ID" /></label>
                    <label><span>Phone Number ID</span><input name="phoneNumberId" required inputMode="numeric" autoComplete="off" defaultValue={selectedMetaConfiguration?.phoneNumberId ?? ""} placeholder="发送号码资源 ID，不是手机号" /></label>
                    <label><span>System User Access Token</span><input name="accessToken" type="password" required autoComplete="new-password" placeholder="每次保存必须重新输入，不会回显" />{selectedMetaConfiguration?.accessTokenMask && <small>当前已保存：<span className="secret-mask">{selectedMetaConfiguration.accessTokenMask}</span></small>}</label>
                    <label><span>Graph API 版本</span><input name="graphApiVersion" required autoComplete="off" defaultValue={selectedMetaConfiguration?.graphApiVersion ?? ""} placeholder="例如 vXX.X，请使用 Meta 当前支持版本" /></label>
                    <div className="meta-config-actions">
                      <button className="button primary" disabled={saveMetaConfiguration.isPending}>{saveMetaConfiguration.isPending ? <Spinner /> : <Save size={16} />} 保存配置</button>
                      <button type="button" className="button secondary" disabled={!selectedMetaConfiguration || verifyMetaConnection.isPending} onClick={() => selectedMetaAccountId && verifyMetaConnection.mutate(selectedMetaAccountId)}>{verifyMetaConnection.isPending ? <Spinner /> : <ShieldCheck size={16} />} 验证连接</button>
                    </div>
                  </form>
                )}
                {selectedMetaConfiguration && <MetaRuntimeDetails configuration={selectedMetaConfiguration} />}
              </>
            )}
          </section>

          <section className="settings-section">
            <header><KeyRound size={18} /><div><h2>凭据边界</h2><p>配置切换不复制或降级密钥</p></div></header>
            <div className="credential-rules">
              <div><Check size={15} /><span>App Secret、Verify Token、Access Token 仅提交到服务端加密存储。</span></div>
              <div><Check size={15} /><span>编辑时只展示掩码；需要更新 Token 时必须重新输入完整值。</span></div>
              <div><Check size={15} /><span>Baileys AuthState 与 Meta Token 独立保存，不在 Provider 之间复制。</span></div>
              <div><Check size={15} /><span>停用 Meta 账号会暂停新入站建档和翻译，但不会删除 Token、撤销 Meta 后台 Webhook 或注销号码。</span></div>
              <div><Webhook size={15} /><span>生产环境需使用 HTTPS 回调、Webhook 验签、最小权限和 Token 轮换。</span></div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function MetaRuntimeDetails({ configuration }: { configuration: MetaAccountConfiguration }) {
  const fields = [
    ["验证名称", configuration.verifiedName ?? "尚未验证"],
    ["显示号码", configuration.displayPhoneNumber ?? "尚未获取"],
    ["质量评级", configuration.qualityRating ?? "尚未获取"],
    ["最近验证", formatTime(configuration.lastVerifiedAt)],
    ["最近 Webhook", formatTime(configuration.lastWebhookAt)],
    ["API 版本", configuration.graphApiVersion]
  ];
  return <dl className="meta-runtime-grid">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function formatTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "暂无";
}

function resolveWebhookUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}
