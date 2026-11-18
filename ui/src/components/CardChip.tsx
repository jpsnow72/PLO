import type { CSSProperties } from 'react';
import { cardName, SUIT_SYMBOL, type Card } from '../lib/cards';

/**
 * The one graphical playing-card component (rebrand slice 1, issue #13).
 *
 * Four-colour deck in the pattern of the captured reference (GTO Wizard
 * Appearance > Cards): the TILE carries the suit colour — spades grey,
 * hearts red, diamonds blue, clubs green (the existing --suit-* tokens) —
 * with the rank and suit glyph in deep navy on top. Our take on it: a
 * subtle top sheen on the tile, a corner index on the larger sizes with
 * the classic rotated index in the opposite corner, and our navy edge.
 * Navy #0A1628 on each suit colour measures >= 5:1 contrast (WCAG AA for
 * the bold rank text at every size) — see CARDS-NOTES.md.
 */
export const SUIT_COLOR: Record<Card['suit'], string> = {
  s: 'var(--suit-spades)',
  h: 'var(--suit-hearts)',
  d: 'var(--suit-diamonds)',
  c: 'var(--suit-clubs)',
};

export type CardSize = 'xs' | 'sm' | 'md' | 'lg';

const DIMS: Record<CardSize, string> = {
  xs: 'h-7 w-5 text-[10px]',
  sm: 'h-8 w-6 text-xs',
  md: 'h-11 w-9 text-base',
  lg: 'h-14 w-11 text-xl',
};

/** Suit-coloured tile with a soft top sheen; shared by the face + picker. */
function tileStyle(suit: Card['suit']): CSSProperties {
  return {
    background: `linear-gradient(165deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0) 52%), ${SUIT_COLOR[suit]}`,
    color: '#0A1628',
  };
}

export function CardChip({
  card,
  size = 'md',
  className = '',
  style,
}: {
  card: Card;
  size?: CardSize;
  className?: string;
  style?: CSSProperties;
}) {
  const name = cardName(card);
  const glyph = SUIT_SYMBOL[card.suit];
  const cornered = size === 'md' || size === 'lg';
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={`relative inline-flex shrink-0 select-none overflow-hidden rounded-md border border-black/30 font-bold shadow-panel ${DIMS[size]} ${className}`}
      style={{ ...tileStyle(card.suit), ...style }}
    >
      {cornered ? (
        <>
          {/* Corner index, top-left; the same index rotated into the
              bottom-right corner, like a real card. */}
          <span className="absolute left-[3px] top-[2px] flex flex-col items-center leading-none">
            <span>{card.rank}</span>
            <span className={size === 'lg' ? 'text-sm' : 'text-[10px]'}>{glyph}</span>
          </span>
          <span className="absolute bottom-[2px] right-[3px] flex rotate-180 flex-col items-center leading-none">
            <span>{card.rank}</span>
            <span className={size === 'lg' ? 'text-sm' : 'text-[10px]'}>{glyph}</span>
          </span>
        </>
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center leading-none">
          <span>{card.rank}</span>
          <span>{glyph}</span>
        </span>
      )}
    </span>
  );
}

/**
 * Face-down card in our palette: deep-navy back with a card-table-green
 * lattice. No surface renders unknown cards yet — this is here for the
 * Explorer Table view (slice 2) so it builds on the same component.
 */
export function CardBack({
  size = 'md',
  className = '',
  style,
}: {
  size?: CardSize;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      role="img"
      aria-label="Face-down card"
      title="Face-down card"
      className={`inline-flex shrink-0 select-none rounded-md border border-navy-600 ${DIMS[size]} ${className}`}
      style={{
        backgroundColor: '#12233C',
        backgroundImage:
          'repeating-linear-gradient(45deg, rgba(46,158,107,0.28) 0 2px, transparent 2px 8px), repeating-linear-gradient(-45deg, rgba(46,158,107,0.28) 0 2px, transparent 2px 8px)',
        boxShadow: 'inset 0 0 0 3px #0A1628, inset 0 0 0 4px rgba(46,158,107,0.45)',
        ...style,
      }}
    />
  );
}

export function CardRow({
  cards,
  size = 'md',
  className = '',
}: {
  cards: Card[];
  size?: CardSize;
  className?: string;
}) {
  return (
    <span className={`inline-flex gap-1 ${className}`}>
      {cards.map((c) => (
        <CardChip key={c.label} card={c} size={size} />
      ))}
    </span>
  );
}
