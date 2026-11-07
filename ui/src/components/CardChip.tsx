import { SUIT_SYMBOL, type Card } from '../lib/cards';

const SUIT_COLOR: Record<Card['suit'], string> = {
  s: 'var(--suit-spades)',
  h: 'var(--suit-hearts)',
  d: 'var(--suit-diamonds)',
  c: 'var(--suit-clubs)',
};

export function CardChip({ card, size = 'md' }: { card: Card; size?: 'sm' | 'md' | 'lg' }) {
  const dims =
    size === 'lg'
      ? 'h-14 w-11 text-xl'
      : size === 'sm'
        ? 'h-8 w-6 text-xs'
        : 'h-11 w-9 text-base';
  return (
    <span
      className={`inline-flex ${dims} flex-col items-center justify-center rounded-md border border-navy-700 bg-navy-850 font-semibold shadow-panel`}
      style={{ color: SUIT_COLOR[card.suit] }}
      aria-label={`${card.rank} of ${card.suit}`}
    >
      <span className="leading-none">{card.rank}</span>
      <span className="leading-none">{SUIT_SYMBOL[card.suit]}</span>
    </span>
  );
}

export function CardRow({ cards, size = 'md' }: { cards: Card[]; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className="inline-flex gap-1">
      {cards.map((c) => (
        <CardChip key={c.label} card={c} size={size} />
      ))}
    </span>
  );
}
