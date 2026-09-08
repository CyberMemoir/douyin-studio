import { useEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { AlertCircle, LoaderCircle, X } from 'lucide-react';

export function Button({
  children,
  className = '',
  tone = 'default',
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'primary' | 'ghost'; busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`button ${tone} ${className}`}
      aria-busy={busy || undefined}
    >
      {busy && <LoaderCircle size={17} className="spin" />}
      {children}
    </button>
  );
}
export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="error-notice">
      <AlertCircle size={19} />
      <span>{children}</span>
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const elements = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input,select,video[controls],[tabindex="0"]',
        ) || []),
      ];
      if (!elements.length) return;
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <Button tone="ghost" onClick={onClose} aria-label="关闭弹窗">
            <X size={21} />
          </Button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function FilmSearchIcon() {
  return (
    <svg
      width="108"
      height="104"
      viewBox="0 0 108 104"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M69 80H13a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4h72a4 4 0 0 1 4 4v22M21 4v76M77 4v23M9 20h12M9 36h12M9 52h12M9 68h12M77 19h12M22 53h25" />
      <circle cx="76" cy="58" r="22" />
      <path d="m92 75 17 18" />
    </svg>
  );
}
