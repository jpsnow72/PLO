// Shared styling for solver actions.

export type ActionKind = 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'other';

export function actionKind(label: string): ActionKind {
  if (label === 'Check') return 'check';
  if (label === 'Fold') return 'fold';
  if (label === 'Call') return 'call';
  if (label.startsWith('Bet')) return 'bet';
  if (label.startsWith('Raise')) return 'raise';
  return 'other';
}

export const ACTION_COLOR: Record<ActionKind, string> = {
  check: 'var(--action-check)',
  bet: 'var(--action-bet)',
  call: 'var(--action-call)',
  raise: 'var(--action-raise)',
  fold: 'var(--action-fold)',
  other: '#7a8aa0',
};

export function actionColor(label: string): string {
  return ACTION_COLOR[actionKind(label)];
}

/** Short label for tight spaces: "Bet(75)" -> "Bet 75". */
export function prettyAction(label: string): string {
  return label.replace(/\((.+)\)/, ' $1');
}
