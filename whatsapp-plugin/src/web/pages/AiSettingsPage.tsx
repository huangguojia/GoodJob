import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, FlaskConical, KeyRound, Languages, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { api } from "../api";
import { queryKeys } from "../data";
import { Modal, Spinner, Toggle } from "../components/ui";

const languages = [
  ["zh-CN", "简体中文"], ["en", "English"], ["es", "Español"], ["pt", "Português"], ["fr", "Français"], ["de", "Deutsch"], ["ja", "日本語"]
];

export function AiSettingsPage() {
  const queryClient = useQueryClient();
  const preferenceQuery = useQuery({ queryKey: queryKeys.preference, queryFn: api.translationPreference });
  const providersQuery = useQuery({ queryKey: queryKeys.aiProviders, queryFn: api.aiProviders });
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; text?: string; error?: string }>();
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const update = useMutation({ mutationFn: api.updateTranslationPreference, onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.preference }) });
  const create = useMutation({ mutationFn: api.createAiProvider, onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.aiProviders }) });
  const test = useMutation({ mutationFn: async (id: string) => ({ id, ...(await api.testAiProvider(id)) }), onSuccess: (result) => { setTestResult(result); void queryClient.invalidateQueries({ queryKey: queryKeys.aiProviders }); }, onError: (error, id) => setTestResult({ id, ok: false, error: error.message }) });
  const remove = useMutation({
    mutationFn: api.deleteAiProvider,
    onSuccess: () => {
      setDeleteCandidateId(null);
      setTestResult(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiProviders });
      void queryClient.invalidateQueries({ queryKey: queryKeys.preference });
    }
  });
  const preference = preferenceQuery.data;
  const providers = providersQuery.data ?? [];
  const deleteCandidate = deleteCandidateId ? providers.find((provider) => provider.id === deleteCandidateId) : undefined;
  const visibleError = update.error ?? preferenceQuery.error ?? providersQuery.error;

  const submitProvider = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); create.mutate({ name: form.get("name"), baseUrl: form.get("baseUrl"), apiKey: form.get("apiKey"), model: form.get("model") }, { onSuccess: () => formElement.reset() }); };

  return <div className="page page-ai"><div className="page-heading"><div><span className="eyebrow">AI TRANSLATION</span><h1>AI 翻译</h1><p>译文作为原消息的派生记录保存；自动翻译关闭后不产生后台模型请求。</p></div></div>
    {visibleError && <div className="notice error-notice" role="alert"><span>{visibleError.message}</span><button onClick={() => { update.reset(); void preferenceQuery.refetch(); void providersQuery.refetch(); }}>重试</button></div>}
    <div className="ai-layout"><div className="settings-column">
      <section className="settings-section"><header><Languages size={18} /><div><h2>翻译偏好</h2><p>用户级设置优先于账号默认值。</p></div></header>{preferenceQuery.isLoading ? <div className="center-loading"><Spinner /> 加载设置</div> : preference ? <div className="settings-fields"><Toggle checked={preference.autoTranslate} onChange={(autoTranslate) => update.mutate({ autoTranslate })} label="自动翻译所有非目标语言消息" /><label><span>目标语言</span><select value={preference.targetLanguage} disabled={update.isPending} onChange={(event) => update.mutate({ targetLanguage: event.target.value })}>{languages.map(([value, label]) => <option key={value} value={value}>{label} · {value}</option>)}</select></label><label><span>默认 AI Provider</span><select value={preference.providerId && providers.some((provider) => provider.id === preference.providerId) ? preference.providerId : ""} disabled={update.isPending || providers.length === 0} onChange={(event) => event.target.value && update.mutate({ providerId: event.target.value })}><option value="" disabled>尚未配置 AI Provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select><small>{providers.length === 0 ? "请先在右侧添加 OpenAI 兼容模型。" : "自动和手动翻译均使用此 Provider。"}</small></label><div className="behavior-note"><strong>{preference.autoTranslate ? "开启后的行为" : "关闭后的行为"}</strong><span>{preference.autoTranslate ? "新收到和新同步的非目标语言消息异步翻译，原文先显示，译文随后出现在下方。" : "不创建后台翻译任务；每条可翻译消息下方显示单次“翻译”操作。"}</span></div></div> : <div className="empty-inline"><XCircle size={20} /><span>翻译偏好暂不可用</span></div>}</section>
      <section className="settings-section"><header><Bot size={18} /><div><h2>Provider 列表</h2><p>浏览器只读取密钥掩码。</p></div></header><div className="provider-list">{providers.length === 0 ? <div className="empty-inline"><Bot size={20} /><span>尚未配置 AI Provider</span></div> : providers.map((provider) => <div className="provider-row" key={provider.id}><span className={`provider-icon ${provider.kind}`}><Bot size={17} /></span><div className="provider-copy"><strong>{provider.name}</strong><span>{provider.kind === "mock" ? "本机内置 Mock" : provider.baseUrl} · {provider.model}</span></div><span className="secret-mask">{provider.apiKeyMask ?? "无密钥"}</span><span className={`test-status test-${provider.lastTestStatus}`}>{provider.lastTestStatus === "success" ? <CheckCircle2 size={14} /> : provider.lastTestStatus === "failed" ? <XCircle size={14} /> : <FlaskConical size={14} />}{provider.lastTestStatus === "success" ? "正常" : provider.lastTestStatus === "failed" ? "失败" : "未测试"}</span><div className="provider-actions"><button className="button compact" disabled={test.isPending || remove.isPending} onClick={() => test.mutate(provider.id)}>{test.isPending && test.variables === provider.id ? <Spinner /> : <FlaskConical size={15} />} 测试</button><button className="icon-button danger" type="button" title="删除 Provider" aria-label={`删除 ${provider.name}`} disabled={remove.isPending} onClick={() => { remove.reset(); setDeleteCandidateId(provider.id); }}><Trash2 size={16} /></button></div>{testResult?.id === provider.id && <div className={`provider-test-result ${testResult.ok ? "success" : "error"}`}>{testResult.ok ? testResult.text : testResult.error}</div>}</div>)}</div></section>
    </div><aside className="settings-column">
      <form className="settings-section form-stack" onSubmit={submitProvider}><header><Plus size={18} /><div><h2>添加 OpenAI 兼容模型</h2><p>支持标准 Chat Completions 协议。</p></div></header><label><span>配置名称</span><input name="name" required placeholder="例如：公司翻译模型" /></label><label><span>Base URL</span><input name="baseUrl" type="url" required placeholder="https://api.example.com/v1" /></label><label><span>API Key</span><div className="input-with-icon"><KeyRound size={15} /><input name="apiKey" type="password" autoComplete="new-password" required placeholder="仅提交到插件服务端" /></div></label><label><span>Model</span><input name="model" required placeholder="例如：gpt-4.1-mini" /></label><div className="notice subtle-notice"><ShieldCheck size={16} /><span>API Key 使用 AES-256-GCM 加密落库，不会在后续 API 响应或浏览器存储中返回。</span></div>{create.error && <div className="form-error">{create.error.message}</div>}<button className="button primary full" disabled={create.isPending}>{create.isPending ? <Spinner /> : <Plus size={16} />} 保存 Provider</button></form>
    </aside></div>
    {deleteCandidate && <Modal title="删除翻译 Provider" width="420px" onClose={() => !remove.isPending && setDeleteCandidateId(null)}>
      <div className="revoke-confirm"><div className="revoke-confirm-icon"><AlertTriangle size={20} /></div><div><strong>确认删除“{deleteCandidate.name}”？</strong><p>{preference?.providerId === deleteCandidate.id ? "该 Provider 当前为默认项，删除后自动翻译将关闭。" : "密钥会被清除，历史译文仍会保留。"}</p></div></div>
      {remove.isError && <div className="form-error">{remove.error.message}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={remove.isPending} onClick={() => setDeleteCandidateId(null)}>取消</button><button type="button" className="button danger" disabled={remove.isPending} onClick={() => remove.mutate(deleteCandidate.id)}>{remove.isPending ? <Spinner /> : <Trash2 size={16} />} 删除</button></div>
    </Modal>}
  </div>;
}
