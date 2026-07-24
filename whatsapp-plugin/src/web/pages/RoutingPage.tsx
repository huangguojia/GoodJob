import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  FlaskConical,
  Network,
  Pencil,
  Plus,
  Route,
  Trash2,
  X
} from "lucide-react";
import type { RoutingResolution, RoutingRule } from "@shared/types";
import { api } from "../api";
import { queryKeys, useAccounts } from "../data";
import { EmptyState, Spinner, StatusBadge } from "../components/ui";

interface RoutingRuleInput {
  name: string;
  leadType: string;
  region: string;
  preferredAccountId: string;
  fallbackAccountId: string | null;
  priority: number;
  enabled: boolean;
}

function ruleInput(form: FormData): RoutingRuleInput {
  return {
    name: String(form.get("name") ?? ""),
    leadType: String(form.get("leadType") ?? ""),
    region: String(form.get("region") ?? ""),
    preferredAccountId: String(form.get("preferredAccountId") ?? ""),
    fallbackAccountId: String(form.get("fallbackAccountId") ?? "") || null,
    priority: Number(form.get("priority") || 100),
    enabled: form.get("enabled") === "on"
  };
}

export function RoutingPage() {
  const queryClient = useQueryClient();
  const accountsQuery = useAccounts();
  const rulesQuery = useQuery({ queryKey: queryKeys.routingRules, queryFn: api.routingRules });
  const [editingRule, setEditingRule] = useState<RoutingRule | null>(null);
  const [testResult, setTestResult] = useState<RoutingResolution>();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: ({ id, input }: { id?: string; input: RoutingRuleInput }) => id
      ? api.updateRoutingRule({ id, input })
      : api.createRoutingRule(input),
    onSuccess: (rule) => {
      setError(null);
      setFeedback(editingRule ? `路由规则“${rule.name}”已更新。` : `路由规则“${rule.name}”已创建。`);
      setEditingRule(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.routingRules });
    },
    onError: (reason) => setError(reason.message)
  });
  const remove = useMutation({
    mutationFn: api.deleteRoutingRule,
    onSuccess: () => {
      setError(null);
      setFeedback("路由规则已删除，旧账号现在可以继续停用或删除。");
      setEditingRule(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.routingRules });
    },
    onError: (reason) => setError(reason.message)
  });
  const resolve = useMutation({
    mutationFn: ({ leadType, region }: { leadType: string; region: string }) => api.resolveRouting(leadType, region),
    onSuccess: (result) => {
      setError(null);
      setTestResult(result);
    },
    onError: (reason) => setError(reason.message)
  });

  const accounts = accountsQuery.data ?? [];
  const accountName = (id: string | null) => accounts.find((item) => item.id === id)?.name ?? "未配置";
  const submitRule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({ id: editingRule?.id, input: ruleInput(new FormData(event.currentTarget)) });
  };
  const testRule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    resolve.mutate({ leadType: String(form.get("leadType") ?? ""), region: String(form.get("region") ?? "") });
  };

  return (
    <div className="page page-routing">
      <div className="page-heading">
        <div>
          <span className="eyebrow">LEAD ROUTING</span>
          <h1>线索账号路由</h1>
          <p>首次建会话优先选择在线首选账号；首选离线时使用已配置且在线的备用账号。</p>
        </div>
      </div>

      {feedback && <div className="notice success-notice" role="status"><CheckCircle2 size={17} /><span>{feedback}</span><button onClick={() => setFeedback(null)}>关闭</button></div>}
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div>}

      <div className="routing-layout">
        <section className="settings-section">
          <header><Route size={18} /><div><h2>路由规则</h2><p>优先级数值越小越先匹配；已有会话不会因规则变更静默换号。</p></div></header>
          {(rulesQuery.data?.length ?? 0) === 0 ? (
            <EmptyState icon={<Network size={22} />} title="暂无路由规则" description="在右侧创建第一条规则。" />
          ) : (
            <div className="rule-list">
              {rulesQuery.data?.map((rule) => (
                <div key={rule.id} className="rule-row">
                  <span className="rule-priority">{rule.priority}</span>
                  <div className="rule-copy"><strong>{rule.name}</strong><span>{rule.leadType || "任意类型"} · {rule.region || "任意地区"}</span></div>
                  <div className="rule-route"><span>{accountName(rule.preferredAccountId)}</span><ArrowRight size={15} /><span className="muted">{rule.fallbackAccountId ? accountName(rule.fallbackAccountId) : "无备用"}</span></div>
                  <span className={rule.enabled ? "linked-pill" : "provider-label"}>{rule.enabled ? <><CheckCircle2 size={13} /> 启用</> : "停用"}</span>
                  <div className="row-actions rule-actions">
                    <button className="icon-button" title="编辑路由规则" onClick={() => setEditingRule(rule)}><Pencil size={15} /></button>
                    <button className="icon-button danger" title="删除路由规则" disabled={remove.isPending} onClick={() => window.confirm(`确认删除路由规则“${rule.name}”？`) && remove.mutate(rule.id)}><Trash2 size={15} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="routing-sidebar">
          <form key={editingRule?.id ?? "new"} className="settings-section form-stack" onSubmit={submitRule}>
            <header>
              {editingRule ? <Pencil size={18} /> : <Plus size={18} />}
              <div><h2>{editingRule ? "编辑规则" : "新增规则"}</h2><p>更新账号引用后即可安全停用旧通道。</p></div>
              {editingRule && <button type="button" className="icon-button form-header-action" title="取消编辑" onClick={() => setEditingRule(null)}><X size={15} /></button>}
            </header>
            <label><span>规则名称</span><input name="name" required defaultValue={editingRule?.name ?? ""} placeholder="例如：北美批发线索" /></label>
            <div className="form-grid two">
              <label><span>线索类型</span><input name="leadType" defaultValue={editingRule?.leadType ?? ""} placeholder="批发" /></label>
              <label><span>地区</span><input name="region" defaultValue={editingRule?.region ?? ""} placeholder="北美" /></label>
            </div>
            <label><span>首选账号</span><select name="preferredAccountId" required defaultValue={editingRule?.preferredAccountId ?? accounts[0]?.id}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
            <label><span>备用账号</span><select name="fallbackAccountId" defaultValue={editingRule?.fallbackAccountId ?? ""}><option value="">不配置备用账号</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
            <label><span>优先级</span><input type="number" name="priority" defaultValue={editingRule?.priority ?? 100} min="0" /></label>
            <label className="check-row"><input name="enabled" type="checkbox" defaultChecked={editingRule?.enabled ?? true} /><span>启用这条规则</span></label>
            <button className="button primary full" disabled={save.isPending || accounts.length === 0}>{save.isPending ? <Spinner /> : editingRule ? <Pencil size={16} /> : <Plus size={16} />} {editingRule ? "更新规则" : "保存规则"}</button>
          </form>
        </aside>
      </div>

      <section className="route-tester">
        <div className="tester-heading"><FlaskConical size={18} /><div><h2>命中测试</h2><p>只测试首次建会话的账号选择，不改变已有绑定。</p></div></div>
        <form onSubmit={testRule}><input name="leadType" placeholder="线索类型，例如：批发" /><input name="region" placeholder="地区，例如：欧洲" /><button className="button secondary" disabled={resolve.isPending}>{resolve.isPending ? <Spinner /> : <FlaskConical size={16} />} 测试路由</button></form>
        {testResult && (
          <div className="route-result">
            {!testResult.rule ? <span>未命中规则，需要用户手动选择账号。</span> : (
              <>
                <div><small>命中规则</small><strong>{testResult.rule.name}</strong></div>
                <ArrowRight size={18} />
                <div><small>配置首选</small><strong>{testResult.preferred?.name ?? "账号不存在"}</strong>{testResult.preferred && <StatusBadge status={testResult.preferred.status} />}</div>
                <ArrowRight size={18} />
                <div>
                  <small>{testResult.selectionReason === "fallback_online" ? "已选在线备用" : "实际选择"}</small>
                  <strong>{testResult.account?.name ?? "无在线可用账号"}</strong>
                  {testResult.account && <StatusBadge status={testResult.account.status} />}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
