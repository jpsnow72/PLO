import type { ReactNode } from 'react';
import { CardBack, CardRow } from '../components/CardChip';
import {
  CARD_BACK_OPTIONS,
  DECK_OPTIONS,
  FELT_OPTIONS,
  useAppearance,
} from '../lib/appearance';
import { parseCard, type Card } from '../lib/cards';
import { EXPLORER_HOTKEYS } from '../lib/hotkeys';

/**
 * Settings (rebrand slice 13, issue #25): appearance choices + the
 * hotkey list. This replaces the placeholder stub that used to sit
 * here. The appearance options are token switches (see
 * lib/appearance): they save to this browser's localStorage and
 * apply immediately, app-wide, through the same CardChip / CardBack
 * / TableView components everything else renders with.
 */

const PREVIEW_CARDS: Card[] = ['As', 'Ah', 'Ad', 'Ac']
  .map((label) => parseCard(label))
  .filter((c): c is Card => c !== null);

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}

function OptionRow({
  selected,
  label,
  blurb,
  preview,
  onPick,
}: {
  selected: boolean;
  label: string;
  blurb: string;
  preview?: ReactNode;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-table bg-navy-800 ring-1 ring-table'
          : 'border-navy-700 bg-navy-900 hover:bg-navy-800'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="block text-xs text-ink-dim">{blurb}</span>
      </span>
      {preview}
      {selected ? (
        <span className="shrink-0 rounded-full bg-table px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          In use
        </span>
      ) : null}
    </button>
  );
}

export function SettingsPage() {
  const [appearance, update] = useAppearance();

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Settings</h1>
        <p className="text-sm text-ink-dim">
          Appearance and keyboard shortcuts. Appearance choices are saved in this browser
          (localStorage) and apply everywhere immediately — they are not synced to an account.
          Engine connection lives with the API status in the sidebar; account and admin tools
          are on the Login and Admin pages.
        </p>
      </header>

      <Section title="Cards — deck colours">
        <div className="flex flex-col gap-2">
          {DECK_OPTIONS.map((opt) => (
            <OptionRow
              key={opt.value}
              selected={appearance.deck === opt.value}
              label={opt.label}
              blurb={opt.blurb}
              onPick={() => update({ deck: opt.value })}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-navy-850 px-3 py-2.5">
          <span className="text-xs text-ink-faint">Preview — one ace per suit:</span>
          <CardRow cards={PREVIEW_CARDS} size="md" />
        </div>
      </Section>

      <Section title="Cards — card backs">
        <div className="flex flex-col gap-2">
          {CARD_BACK_OPTIONS.map((opt) => (
            <OptionRow
              key={opt.value}
              selected={appearance.cardBack === opt.value}
              label={opt.label}
              blurb={opt.blurb}
              preview={<CardBack size="sm" />}
              onPick={() => update({ cardBack: opt.value })}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          Every back above renders the current choice — the backs on the Explorer's table change
          with it.
        </p>
      </Section>

      <Section title="Table — felt colour">
        <div className="flex flex-col gap-2">
          {FELT_OPTIONS.map((opt) => (
            <OptionRow
              key={opt.value}
              selected={appearance.felt === opt.value}
              label={opt.label}
              blurb="Felt of the table in the Explorer's Table view."
              preview={
                <span
                  aria-hidden="true"
                  className="h-8 w-14 shrink-0 rounded-[50%] border-4 border-navy-800"
                  style={{
                    background: `radial-gradient(ellipse at center, ${opt.hi} 0%, ${opt.lo} 72%)`,
                  }}
                />
              }
              onPick={() => update({ felt: opt.value })}
            />
          ))}
        </div>
      </Section>

      <Section title="Keyboard shortcuts — Explorer">
        <ul className="flex flex-col gap-1.5">
          {EXPLORER_HOTKEYS.map((h) => (
            <li key={h.keys} className="flex items-baseline gap-3 text-sm">
              <kbd className="w-14 shrink-0 rounded bg-navy-800 px-1.5 py-0.5 text-center font-mono text-[11px] text-ink ring-1 ring-navy-600">
                {h.keys}
              </kbd>
              <span className="text-ink-dim">{h.action}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-faint">
          Shortcuts pause while you type in a field and while a card picker is open. Choosing a
          different action after stepping back clears the forward history, like a browser.
        </p>
      </Section>

      <p className="text-xs text-ink-faint">
        Appearance only changes how the same solver data is drawn — no number, range, or grade
        anywhere depends on it.
      </p>
    </div>
  );
}
