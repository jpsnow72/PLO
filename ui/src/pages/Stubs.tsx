// Placeholder pages for screens designed in Stitch but scheduled for
// later tickets. They render the layout skeleton with an explicit
// "coming in a later ticket" note — no fake data presented as real.

function StubShell({
  title,
  blurb,
  bullets,
}: {
  title: string;
  blurb: string;
  bullets: string[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">{title}</h1>
        <p className="text-sm text-ink-dim">{blurb}</p>
      </header>
      <section className="rounded-lg border border-dashed border-navy-600 bg-navy-900 p-4">
        <p className="inline-flex items-center gap-2 rounded-full border border-accent px-2.5 py-1 text-xs font-semibold text-accent">
          COMING IN A LATER TICKET
        </p>
        <ul className="mt-3 list-inside list-disc flex flex-col gap-1 text-sm text-ink-dim">
          {bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <div aria-hidden="true" className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="h-20 rounded-md bg-navy-850" />
          <div className="h-20 rounded-md bg-navy-850" />
          <div className="h-20 rounded-md bg-navy-850" />
        </div>
      </section>
    </div>
  );
}

export function QuickReviewPage() {
  return (
    <StubShell
      title="Quick Review"
      blurb="Phone-first flash review: your saved spots, tap to reveal the solver answer and the one-line why. Built for two-minute sessions."
      bullets={[
        'Saved spots come from the Explorer (bookmark any node).',
        'Streak counter included when this lands (V2 list).',
        'Designed as a true 390px mobile layout, per the approved design.',
      ]}
    />
  );
}

export function QuizPage() {
  return (
    <StubShell
      title="Quiz"
      blurb="Self-testing graded by EV lost against the solver, plus quizzes built from your own heuristics log, with spaced repetition."
      bullets={[
        'Questions are generated from real solved spots in your library.',
        'Grading shows the EV cost of each answer, not just right/wrong.',
        'Per-topic accuracy feeds the leak-ranked dashboard (V2 list).',
      ]}
    />
  );
}

export function HeuristicsPage() {
  return (
    <StubShell
      title="My Heuristics"
      blurb="Your personal rules of thumb, tagged by texture, street and spot, each linked to the solver spots that support it."
      bullets={[
        'The Explorer’s explain-why panel will propose candidate heuristics from real node data.',
        'Heuristics sync across devices under your login.',
        'Nothing here is solver output — it is your own distilled playbook.',
      ]}
    />
  );
}

export function SettingsPage() {
  return (
    <StubShell
      title="Settings"
      blurb="Account, engine connection, and study preferences."
      bullets={[
        'Engine host configuration for the job service.',
        'Default accuracy tier and solve-size preferences.',
        'Real accounts and cross-device sync arrive with the login ticket.',
      ]}
    />
  );
}
