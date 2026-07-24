import { type PropsWithChildren, type ReactNode, useId } from "react";
import { X } from "lucide-react";
import type { AccountStatus } from "@shared/types";

export function StatusBadge({ status }: { status: AccountStatus }) {
  const labels: Record<AccountStatus, string> = {
    unconfigured: "未配置",
    waiting_qr: "等待扫码",
    connecting: "连接中",
    connected: "在线",
    reconnecting: "重连中",
    logged_out: "已退出",
    credential_invalid: "凭据失效",
    degraded: "异常"
  };
  return <span className={`status-badge status-${status}`}>{labels[status]}</span>;
}

export function Modal({
  title,
  children,
  onClose,
  width = "520px"
}: PropsWithChildren<{ title: string; onClose(): void; width?: string }>) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width }}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <span>{description}</span>
      {action}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="加载中" />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(checked: boolean): void; label: string }) {
  const labelId = useId();

  return (
    <div className="toggle-row">
      <span id={labelId}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        className={`toggle ${checked ? "is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
