import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  wide?: boolean;
  navigation?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
}

export function VoiceDialog({ title, subtitle, wide, navigation, footer, children, onClose, closeDisabled }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const dismiss = () => {
    if (!closeDisabled) onClose();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="voice-dialog"
      data-wide={wide}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className="dialog-shell">
        <header className="dialog-header">
          <div className="dialog-heading">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p title={subtitle}>{subtitle}</p>}
          </div>
          <button type="button" className="voice-button icon-button" aria-label={"关闭" + title}
            onClick={dismiss} disabled={closeDisabled}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        {navigation}
        <div className="dialog-body">{children}</div>
        <footer className="dialog-footer">{footer}</footer>
      </div>
    </dialog>
  );
}
