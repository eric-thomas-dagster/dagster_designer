import type { LucideIcon } from 'lucide-react';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

interface NoticeProps {
  /** Defaults to AlertTriangle; pass e.g. Info for a less alarming notice. */
  icon?: LucideIcon;
  children: ReactNode;
  /** Optional trailing action (a button, typically) inline with the text. */
  action?: ReactNode;
  className?: string;
}

/**
 * A single consistent amber warning/notice banner. Several pages
 * (Alerts, Runs, GitCommitDialog) each hand-rolled their own version of
 * this with slightly different padding, text size, and border shade --
 * this is the one to reach for instead so they all match.
 */
export function Notice({ icon: Icon = AlertTriangle, children, action, className = '' }: NoticeProps) {
  return (
    <div className={`p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900 flex items-start gap-2 ${className}`}>
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600" />
      <div className="flex-1 min-w-0">{children}</div>
      {action}
    </div>
  );
}
