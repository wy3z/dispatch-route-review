import type { ReactNode } from "react";

type Props = {
  href: string | null;
  children: ReactNode;
  className?: string;
  label?: string;
};

export function AutotaskLink({
  href,
  children,
  className = "",
  label,
}: Props) {
  if (!href) {
    return (
      <span className={className}>
        <span className="autotask-link-content">{children}</span>
      </span>
    );
  }

  return (
    <a
      aria-label={label}
      className={`autotask-link ${className}`.trim()}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      <span className="autotask-link-content">{children}</span>
    </a>
  );
}
