import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Building2, CheckCircle2, ClipboardCheck, RefreshCw, ShieldCheck } from "lucide-react";
import type { CommercialReadinessCheck } from "@shared/types";
import { api } from "../api";
import { queryKeys } from "../data";
import { Spinner } from "../components/ui";

type ActionView = NonNullable<CommercialReadinessCheck["actionView"]>;

export function CommercialReadinessPage({ onNavigate }: { onNavigate(view: ActionView): void }) {
  const query = useQuery({ queryKey: queryKeys.commercialReadiness, queryFn: api.commercialReadiness, refetchInterval: 30_000 });
  const readiness = query.data;
  const blocking = readiness?.checks.filter((check) => check.status === "blocking").length ?? 0;
  const warnings = readiness?.checks.filter((check) => check.status === "warning").length ?? 0;

  return <div className="page page-readiness">
    <div className="page-heading"><div><span className="eyebrow">COMMERCIAL READINESS</span><h1>商业上线检查</h1><p>把 Meta 注册、真实收件、客户分析、CRM 待办和数据治理集中验证。</p></div><button className="button secondary" disabled={query.isFetching} onClick={() => query.refetch()}>{query.isFetching ? <Spinner /> : <RefreshCw size={16} />}重新检查</button></div>
    {query.isLoading ? <div className="center-loading"><Spinner />正在检查商业链路</div> : query.isError ? <div className="notice error-notice"><AlertTriangle size={18} /><span>{query.error.message}</span></div> : readiness && <>
      <section className={`readiness-hero ${readiness.readyForCommercialUse ? "is-ready" : ""}`}><div className="readiness-hero-icon">{readiness.readyForCommercialUse ? <ShieldCheck size={27} /> : <ClipboardCheck size={27} />}</div><div><span>当前结论</span><h2>{readiness.readyForCommercialUse ? "商业闭环已具备" : blocking ? `还有 ${blocking} 项阻断条件` : "可以进入受控商业试运行"}</h2><p>{readiness.readyForMetaRegistration ? "Meta 企业资产就绪后可以直接提交正式回调和号码配置。" : "先处理 Meta 注册阻断项，再申请或绑定企业资产。"}</p></div><div className="readiness-score"><strong>{readiness.checks.filter((check) => check.status === "pass").length}/{readiness.checks.length}</strong><span>检查通过</span><small>{warnings} 项建议优化</small></div></section>
      <div className="readiness-gates"><div className={readiness.readyForMetaRegistration ? "pass" : "blocking"}><Building2 size={18} /><span><strong>Meta 注册条件</strong><small>{readiness.readyForMetaRegistration ? "已满足" : "尚未满足"}</small></span></div><div className={readiness.readyForCommercialUse ? "pass" : "blocking"}><ShieldCheck size={18} /><span><strong>商业运行条件</strong><small>{readiness.readyForCommercialUse ? "已满足" : "仍有阻断项"}</small></span></div></div>
      <section className="settings-section readiness-section"><header><ClipboardCheck size={18} /><div><h2>闭环检查清单</h2><p>阻断项必须处理；建议项不会阻止测试，但会影响商业质量。</p></div><time>{new Date(readiness.checkedAt).toLocaleString("zh-CN")}</time></header><div className="readiness-list">{readiness.checks.map((check) => <article className={check.status} key={check.key}><span className="readiness-check-icon">{check.status === "pass" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div><span className="readiness-label">{check.status === "pass" ? "已通过" : check.status === "warning" ? "建议优化" : "需处理"}</span>{check.actionView && check.status !== "pass" && <button className="button compact secondary" onClick={() => onNavigate(check.actionView!)}>去处理</button>}</article>)}</div></section>
    </>}
  </div>;
}
