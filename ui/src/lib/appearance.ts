import { useCallback, useState } from 'react';

/**
 * Appearance preferences (rebrand slice 13, issue #25): the deck
 * colour scheme, the card-back style, and the table felt colour.
 *
 * Mechanics: every affected colour was already a CSS token
 * (--suit-*, --cardback-*, --felt-* in index.css), so a preference
 * is nothing but a data attribute on <html> — the [data-deck] /
 * [data-cardback] / [data-felt] blocks in index.css hold the
 * variant token values, and CardChip / CardBack / TableView remain
 * the only renderers. No theme engine, no forked components.
 *
 * Persistence: localStorage only ('plo-appearance'), applied at
 * startup by main.tsx before the first render. Deliberately NOT
 * synced to the account or the API — the captured reference stores
 * these locally too, and this app has no cross-device preference
 * store to put them in.
 */

export type DeckScheme = 'four-colour' | 'classic';
export type CardBackStyle = 'navy-lattice' | 'green-lattice' | 'amber-lattice';
export type FeltColour = 'green' | 'navy' | 'charcoal';

export interface Appearance {
  deck: DeckScheme;
  cardBack: CardBackStyle;
  felt: FeltColour;
}

/** The shipped look — also what renders when no preference is saved. */
export const DEFAULT_APPEARANCE: Appearance = {
  deck: 'four-colour',
  cardBack: 'navy-lattice',
  felt: 'green',
};

export const DECK_OPTIONS: { value: DeckScheme; label: string; blurb: string }[] = [
  {
    value: 'four-colour',
    label: 'Four-colour deck',
    blurb: 'Spades grey, hearts red, diamonds blue, clubs green — the default.',
  },
  {
    value: 'classic',
    label: 'Classic two-colour',
    blurb: 'Hearts and diamonds red; spades and clubs near-black with light print.',
  },
];

export const CARD_BACK_OPTIONS: { value: CardBackStyle; label: string; blurb: string }[] = [
  {
    value: 'navy-lattice',
    label: 'Navy lattice',
    blurb: 'Deep navy back, green lattice — the default.',
  },
  {
    value: 'green-lattice',
    label: 'Green lattice',
    blurb: 'Table green back, navy lattice.',
  },
  {
    value: 'amber-lattice',
    label: 'Amber lattice',
    blurb: 'Deep amber-brown back, amber lattice.',
  },
];

/** hi/lo mirror the --felt-* values in index.css; used for the Settings swatches. */
export const FELT_OPTIONS: { value: FeltColour; label: string; hi: string; lo: string }[] = [
  { value: 'green', label: 'Table green', hi: '#2e9e6b', lo: '#248457' },
  { value: 'navy', label: 'Deep navy', hi: '#24405f', lo: '#12233c' },
  { value: 'charcoal', label: 'Charcoal', hi: '#4b5563', lo: '#292f38' },
];

const STORAGE_KEY = 'plo-appearance';

function isDeck(v: unknown): v is DeckScheme {
  return v === 'four-colour' || v === 'classic';
}
function isCardBack(v: unknown): v is CardBackStyle {
  return v === 'navy-lattice' || v === 'green-lattice' || v === 'amber-lattice';
}
function isFelt(v: unknown): v is FeltColour {
  return v === 'green' || v === 'navy' || v === 'charcoal';
}

/** Saved preference, each field validated on its own; anything unreadable falls back to the defaults. */
export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<Record<keyof Appearance, unknown>>;
    return {
      deck: isDeck(parsed.deck) ? parsed.deck : DEFAULT_APPEARANCE.deck,
      cardBack: isCardBack(parsed.cardBack) ? parsed.cardBack : DEFAULT_APPEARANCE.cardBack,
      felt: isFelt(parsed.felt) ? parsed.felt : DEFAULT_APPEARANCE.felt,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/**
 * Apply a preference by switching the <html> data attributes the
 * index.css variant blocks key on. A default-valued field REMOVES
 * its attribute, so the :root tokens stay the single source of the
 * shipped look.
 */
export function applyAppearance(a: Appearance): void {
  const el = document.documentElement;
  if (a.deck === DEFAULT_APPEARANCE.deck) delete el.dataset.deck;
  else el.dataset.deck = a.deck;
  if (a.cardBack === DEFAULT_APPEARANCE.cardBack) delete el.dataset.cardback;
  else el.dataset.cardback = a.cardBack;
  if (a.felt === DEFAULT_APPEARANCE.felt) delete el.dataset.felt;
  else el.dataset.felt = a.felt;
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch {
    // Storage unavailable (private mode): the choice still applies
    // for this session via applyAppearance below.
  }
  applyAppearance(a);
}

/** Startup hook (main.tsx): apply the saved preference before first render. */
export function initAppearance(): void {
  applyAppearance(loadAppearance());
}

/** Settings-page state: current preference + a patch updater that saves and applies immediately. */
export function useAppearance(): [Appearance, (patch: Partial<Appearance>) => void] {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const update = useCallback((patch: Partial<Appearance>) => {
    setAppearance((prev) => {
      const next = { ...prev, ...patch };
      saveAppearance(next);
      return next;
    });
  }, []);
  return [appearance, update];
}
