import { useEffect } from 'react';
import { RANKS_DESC, SUIT_SYMBOL, type Suit } from '../lib/cards';
import { SUIT_COLOR } from './CardChip';

const SUIT_ROWS: { suit: Suit; name: string }[] = [
  { suit: 's', name: 'Spades' },
  { suit: 'h', name: 'Hearts' },
  { suit: 'd', name: 'Diamonds' },
  { suit: 'c', name: 'Clubs' },
];

export interface CardPickerProps {
  title: string;
  caption?: string;
  /**
   * Card labels that can never be picked because they are already known
   * (board cards, the other street's runout). Rendered dimmed.
   */
  deadCards?: string[];
  /**
   * When non-null, ONLY these labels are pickable (Explorer runout mode:
   * the solve only contains subtrees for these cards). Every other live
   * card is rendered dimmed. Null = free pick (Solver board mode).
   */
  enabledCards?: string[] | null;
  /** Labels currently selected (Solver board mode). */
  selected?: string[];
  /** Fired for every enabled card click. The parent decides what a pick means. */
  onPick: (cardLabel: string) => void;
  /** Clear the current selection (board mode) — in runout mode, dismiss. */
  onClear?: () => void;
  /** Randomize: runout mode picks a random enabled card; board mode deals a random board. */
  onRandom?: () => void;
  /** When set, the footer shows an Apply button (board mode commits on Apply). */
  applyLabel?: string;
  onApply?: () => void;
  applyDisabled?: boolean;
  onClose: () => void;
}

/**
 * Card-picker modal: 4 suit rows x ranks A-2. Dead cards (already on the
 * board / known) are dimmed and disabled; in runout mode only the cards
 * the solve actually contains are enabled. Used for turn/river selection
 * in the Explorer and for the Solver's board selector.
 */
export function CardPicker({
  title,
  caption,
  deadCards = [],
  enabledCards = null,
  selected = [],
  onPick,
  onClear,
  onRandom,
  applyLabel,
  onApply,
  applyDisabled,
  onClose,
}: CardPickerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dead = new Set(deadCards);
  const enabled = enabledCards ? new Set(enabledCards) : null;
  const chosen = new Set(selected);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
          >
            Close ✕
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          {SUIT_ROWS.map(({ suit, name }) => (
            <div key={suit} className="flex items-center gap-1.5">
              <span
                className="w-5 shrink-0 text-center text-sm"
                style={{ color: SUIT_COLOR[suit] }}
                aria-label={name}
                title={name}
              >
                {SUIT_SYMBOL[suit]}
              </span>
              <div className="grid flex-1 gap-1" style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }}>
                {RANKS_DESC.map((rank) => {
                  const label = `${rank}${suit}`;
                  const isDead = dead.has(label);
                  const isEnabled = !isDead && (enabled === null || enabled.has(label));
                  const isChosen = chosen.has(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      disabled={!isEnabled}
                      onClick={() => onPick(label)}
                      aria-pressed={isChosen}
                      aria-label={`Card ${label}${isDead ? ' (already known)' : ''}${!isDead && !isEnabled ? ' (not available here)' : ''}`}
                      className={`flex h-9 flex-col items-center justify-center rounded-md border text-xs font-semibold leading-none transition-transform ${
                        isChosen
                          ? 'border-accent bg-navy-800 ring-2 ring-accent'
                          : isEnabled
                            ? 'border-navy-700 bg-navy-850 hover:scale-105 hover:border-table'
                            : 'border-navy-800 bg-navy-900 opacity-35'
                      }`}
                      style={{ color: SUIT_COLOR[suit] }}
                    >
                      <span>{rank}</span>
                      <span className="text-[10px]">{SUIT_SYMBOL[suit]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {caption ? <p className="mt-3 text-xs text-ink-faint">{caption}</p> : null}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-navy-700 pt-3">
          {onClear ? (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md bg-navy-800 px-3 py-1.5 text-xs font-semibold text-ink-dim hover:text-ink"
            >
              Clear
            </button>
          ) : null}
          {onRandom ? (
            <button
              type="button"
              onClick={onRandom}
              className="rounded-md bg-navy-800 px-3 py-1.5 text-xs font-semibold text-ink-dim hover:text-ink"
            >
              Randomize
            </button>
          ) : null}
          {applyLabel && onApply ? (
            <button
              type="button"
              onClick={onApply}
              disabled={applyDisabled}
              className="ml-auto rounded-md bg-table px-3 py-1.5 text-xs font-semibold text-white hover:bg-table-dark disabled:opacity-50"
            >
              {applyLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
