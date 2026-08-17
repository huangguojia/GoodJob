import { type PropsWithChildren, type ReactNode, useEffect, useId, useRef } from "react";
import { AlertTriangle, Trash2, X } from "lucide-react";
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
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width }}>
        <header className="modal-header">
          <div className="modal-title-group"><span className="modal-title-mark" aria-hidden="true" /><h2>{title}</h2></div>
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭弹窗">
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

export function ConfirmModal({
  title,
  message,
  consequences,
  confirmLabel = "确认删除",
  pending = false,
  onClose,
  onConfirm
}: {
  title: string;
  message: string;
  consequences: string[];
  confirmLabel?: string;
  pending?: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  return (
    <Modal title={title} width="440px" onClose={() => !pending && onClose()}>
      <div className="confirm-content">
        <div className="confirm-alert-icon" aria-hidden="true"><AlertTriangle size={20} /></div>
        <div className="confirm-content-copy">
          <p>{message}</p>
          <div className="confirm-impact">
            <strong>确认后将发生</strong>
            <ul>{consequences.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        </div>
      </div>
      <div className="modal-actions confirm-actions">
        <button type="button" className="button secondary" disabled={pending} onClick={onClose}>取消</button>
        <button type="button" className="button danger" disabled={pending} aria-busy={pending} onClick={onConfirm}>
          {pending ? <Spinner /> : <Trash2 size={16} />} {pending ? "正在删除" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="加载中" />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-list" role="status" aria-label="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton-avatar" />
          <span className="skeleton-copy"><i /><i /></span>
          <span className="skeleton-action" />
        </div>
      ))}
    </div>
  );
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
