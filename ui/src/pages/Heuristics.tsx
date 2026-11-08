import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  createHeuristic,
  deleteHeuristic,
  fetchHeuristics,
  fetchLibrary,
  fetchLibrarySolve,
  updateHeuristic,
} from '../lib/api';
import {
  HEURISTIC_SOURCE_LABEL,
  type Heuristic,
  type HeuristicInput,
  type HeuristicSource,
} from '../lib/study';
import { FAMILY_LABEL, type TextureFamily } from '../lib/texture';
import type { LibraryItem } from '../lib/types';
import { useStore } from '../store/useStore';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; heuristics: Heuristic[] }
  | { kind: 'needs-login' }
  | { kind: 'offline' };

const SPOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STREETS = ['flop', 'turn', 'river'] as const;

interface FormState {
  text: string;
  source: HeuristicSource;
  texture: string;
  street: string;
  spotType: string;
  linkedIdsText: string;
}

const EMPTY_FORM: FormState = {
  text: '',
  source: 'manual',
  texture: '',
  street: '',
  spotType: '',
  linkedIdsText: '',
};

function formFromHeuristic(h: Heuristic): FormState {
  return {
    text: h.text,
    source: h.source,
    texture: h.tags.texture ?? '',
    street: h.tags.street ?? '',
    spotType: h.tags.spot_type ?? '',
    linkedIdsText: h.linked_spot_ids.join(', '),
  };
}

/** Parse the comma/space separated linked-ids field; null on a bad id. */
function parseLinkedIds(text: string): string[] | null {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: string[] = [];
  for (const p of parts) {
    if (!SPOT_ID_RE.test(p)) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function formToInput(form: FormState): { input: HeuristicInput } | { error: string } {
  const text = form.text.trim();
  if (text.length === 0) return { error: 'Write the heuristic first — the text is the rule.' };
  const linked = parseLinkedIds(form.linkedIdsText);
  if (linked === null) {
    return { error: 'Linked spot ids must be plain ids (letters, digits, - and _), separated by commas.' };
  }
  const tags: HeuristicInput['tags'] = {};
  if (form.texture) tags.texture = form.texture;
  if (form.street) tags.street = form.street;
  if (form.spotType.trim()) tags.spot_type = form.spotType.trim();
  return {
    input: { text, source: form.source, tags, linked_spot_ids: linked },
  };
}

function SourceBadge({ source }: { source: HeuristicSource }) {
  if (source === 'mined') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-table px-2 py-0.5 text-[11px] font-semibold text-white"
        title="Mined from your solved library by the pattern miner — carries measured support stats."
      >
        Mined from solves
      </span>
    );
  }
  if (source === 'ai-suggested') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-accent px-2 py-0.5 text-[11px] font-semibold text-accent"
        title="Proposed by the explain-why panel from solver node data; kept only because you saved it."
      >
        AI-suggested
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-navy-800 px-2 py-0.5 text-[11px] font-semibold text-ink-dim ring-1 ring-navy-600"
      title="Written by you, in your own words."
    >
      Hand-written
    </span>
  );
}

function SupportStats({ h }: { h: Heuristic }) {
  const parts: string[] = [];
  if (h.support_n !== undefined) parts.push(`backed by ${h.support_n} spot${h.support_n === 1 ? '' : 's'}`);
  if (h.mean_freq !== undefined) parts.push(`mean dominant-action frequency ${(h.mean_freq * 100).toFixed(0)}%`);
  if (h.spread !== undefined) parts.push(`spread ${h.spread.toFixed(2)}`);
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-table-light" title="Measured by the mining pipeline when this heuristic was extracted — shown verbatim from the record.">
      Support: {parts.join(' · ')}
    </p>
  );
}

export function HeuristicsPage() {
  const navigate = useNavigate();
  const loadRawSolve = useStore((s) => s.loadRawSolve);
  const isAdmin = useStore((s) => s.isAdmin);

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [libraryById, setLibraryById] = useState<Map<string, LibraryItem>>(new Map());
  const [textureFilter, setTextureFilter] = useState('');
  const [streetFilter, setStreetFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'active' | 'retired' | 'all'>('active');
  const [sourceFilter, setSourceFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const heuristics = await fetchHeuristics();
        if (cancelled) return;
        setState({ kind: 'ready', heuristics });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setState({ kind: 'needs-login' });
        else setState({ kind: 'offline' });
      }
      // Best-effort: which linked ids can actually be opened in the Explorer.
      try {
        const library = await fetchLibrary();
        if (!cancelled) setLibraryById(new Map(library.map((item) => [item.id, item])));
      } catch {
        // No library access — linked ids render as plain chips.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const replaceRecord = (updated: Heuristic) => {
    setState((s) =>
      s.kind === 'ready'
        ? { kind: 'ready', heuristics: s.heuristics.map((h) => (h.id === updated.id ? updated : h)) }
        : s,
    );
  };

  const mutate = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Your session expired — log in and try again.'
          : err instanceof ApiError
            ? err.message
            : 'The job service could not be reached.',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = () => {
    const built = formToInput(createForm);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    void mutate(async () => {
      const created = await createHeuristic(built.input);
      setState((s) =>
        s.kind === 'ready' ? { kind: 'ready', heuristics: [...s.heuristics, created] } : s,
      );
      setCreateForm(EMPTY_FORM);
      setShowCreate(false);
    });
  };

  const submitEdit = (h: Heuristic) => {
    const built = formToInput(editForm);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    void mutate(async () => {
      const updated = await updateHeuristic(h.id, built.input);
      replaceRecord(updated);
      setEditingId(null);
    });
  };

  const setStatus = (h: Heuristic, status: 'active' | 'retired') => {
    void mutate(async () => {
      replaceRecord(await updateHeuristic(h.id, { status }));
    });
  };

  const remove = (h: Heuristic) => {
    void mutate(async () => {
      await deleteHeuristic(h.id);
      setState((s) =>
        s.kind === 'ready'
          ? { kind: 'ready', heuristics: s.heuristics.filter((x) => x.id !== h.id) }
          : s,
      );
      setConfirmDeleteId(null);
    });
  };

  const openLinkedSpot = async (id: string) => {
    const item = libraryById.get(id);
    if (!item) return;
    setOpenError(null);
    try {
      const raw = await fetchLibrarySolve(id);
      if (loadRawSolve(raw, item.name, 'library', id)) navigate('/explorer');
      else setOpenError(`"${item.name}" could not be parsed by the UI.`);
    } catch {
      setOpenError('Could not fetch that solve from the job service.');
    }
  };

  const texturesInData = useMemo(() => {
    if (state.kind !== 'ready') return [] as string[];
    const set = new Set<string>();
    for (const h of state.heuristics) if (h.tags.texture) set.add(h.tags.texture);
    return [...set].sort();
  }, [state]);

  const visible = useMemo(() => {
    if (state.kind !== 'ready') return [] as Heuristic[];
    return state.heuristics.filter((h) => {
      if (statusFilter !== 'all' && h.status !== statusFilter) return false;
      if (textureFilter && h.tags.texture !== textureFilter) return false;
      if (streetFilter && h.tags.street !== streetFilter) return false;
      if (sourceFilter && h.source !== sourceFilter) return false;
      return true;
    });
  }, [state, statusFilter, textureFilter, streetFilter, sourceFilter]);

  const formFields = (
    form: FormState,
    setForm: (f: FormState) => void,
    idPrefix: string,
  ) => (
    <div className="flex flex-col gap-3">
      <div>
        <label htmlFor={`${idPrefix}-text`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Heuristic
        </label>
        <textarea
          id={`${idPrefix}-text`}
          value={form.text}
          onChange={(e) => setForm({ ...form, text: e.target.value })}
          rows={3}
          placeholder="e.g. On paired boards, check back more of the preflop raiser's range — the nut advantage shrinks."
          className="w-full rounded-md border border-navy-600 bg-navy-850 px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor={`${idPrefix}-source`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Source
          </label>
          <select
            id={`${idPrefix}-source`}
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value as HeuristicSource })}
            className="w-full rounded-md border border-navy-600 bg-navy-850 px-2 py-2 text-sm text-ink"
          >
            {(Object.keys(HEURISTIC_SOURCE_LABEL) as HeuristicSource[]).map((s) => (
              <option key={s} value={s}>
                {HEURISTIC_SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-texture`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Texture tag
          </label>
          <select
            id={`${idPrefix}-texture`}
            value={form.texture}
            onChange={(e) => setForm({ ...form, texture: e.target.value })}
            className="w-full rounded-md border border-navy-600 bg-navy-850 px-2 py-2 text-sm text-ink"
          >
            <option value="">No texture tag</option>
            {(Object.keys(FAMILY_LABEL) as TextureFamily[]).map((f) => (
              <option key={f} value={f}>
                {FAMILY_LABEL[f]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-street`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Street tag
          </label>
          <select
            id={`${idPrefix}-street`}
            value={form.street}
            onChange={(e) => setForm({ ...form, street: e.target.value })}
            className="w-full rounded-md border border-navy-600 bg-navy-850 px-2 py-2 text-sm text-ink"
          >
            <option value="">No street tag</option>
            {STREETS.map((s) => (
              <option key={s} value={s}>
                {s[0]?.toUpperCase()}
                {s.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-spot`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Spot type tag
          </label>
          <input
            id={`${idPrefix}-spot`}
            value={form.spotType}
            onChange={(e) => setForm({ ...form, spotType: e.target.value })}
            placeholder="e.g. SRP BTN vs BB"
            className="w-full rounded-md border border-navy-600 bg-navy-850 px-2 py-2 text-sm text-ink placeholder:text-ink-faint"
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-linked`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Linked spot ids (comma separated)
        </label>
        <input
          id={`${idPrefix}-linked`}
          value={form.linkedIdsText}
          onChange={(e) => setForm({ ...form, linkedIdsText: e.target.value })}
          placeholder="Library solve ids that support this rule — the Explorer can add these for you"
          className="w-full rounded-md border border-navy-600 bg-navy-850 px-2 py-2 font-mono text-sm text-ink placeholder:text-ink-faint"
        />
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">My Heuristics</h1>
          <p className="text-sm text-ink-dim">
            Your personal rules of thumb, tagged by texture, street and spot, each linked to the
            solver spots that support it. Nothing here is solver output — it's your own distilled
            playbook.
          </p>
        </div>
        {state.kind === 'ready' ? (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="ml-auto rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
          >
            {showCreate ? 'Close' : 'New heuristic'}
          </button>
        ) : null}
      </header>

      {error ? (
        <p className="rounded-lg border border-red-900 bg-navy-900 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      ) : null}
      {openError ? (
        <p className="rounded-lg border border-red-900 bg-navy-900 p-3 text-sm text-red-300" role="alert">
          {openError}
        </p>
      ) : null}

      {state.kind === 'loading' ? (
        <p className="text-sm text-ink-dim">Loading your heuristics…</p>
      ) : state.kind === 'needs-login' ? (
        <div className="rounded-lg border border-navy-700 bg-navy-900 p-4">
          <h2 className="text-sm font-semibold text-ink">Your heuristics are personal — log in to see them</h2>
          <p className="mt-1 text-sm text-ink-dim">
            The log lives behind your admin login so it stays yours across devices.
          </p>
          <Link
            to="/login"
            className="mt-3 inline-block rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
          >
            Log in
          </Link>
        </div>
      ) : state.kind === 'offline' ? (
        <div className="rounded-lg border border-accent/60 bg-navy-900 p-4" role="status">
          <span className="font-semibold text-ink">Engine offline.</span>{' '}
          <span className="text-sm text-ink-dim">
            The job service isn't reachable, so your heuristics log can't be loaded. It is stored
            by the service (DATA_DIR/heuristics.json) and will reappear when it is back.
          </span>
        </div>
      ) : (
        <>
          {showCreate ? (
            <section aria-label="New heuristic" className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
              <h2 className="mb-3 text-sm font-semibold text-ink">New heuristic</h2>
              {formFields(createForm, setCreateForm, 'create')}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={submitCreate}
                  className="rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark disabled:opacity-50"
                >
                  Save heuristic
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShowCreate(false)}
                  className="rounded-md px-3 py-2 text-sm text-ink-dim hover:bg-navy-800 hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </section>
          ) : null}

          <div className="flex flex-wrap gap-2" aria-label="Filters">
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="rounded-md border border-navy-600 bg-navy-850 px-2 py-1.5 text-xs text-ink"
            >
              <option value="active">Active</option>
              <option value="retired">Retired</option>
              <option value="all">All</option>
            </select>
            <select
              aria-label="Filter by texture"
              value={textureFilter}
              onChange={(e) => setTextureFilter(e.target.value)}
              className="rounded-md border border-navy-600 bg-navy-850 px-2 py-1.5 text-xs text-ink"
            >
              <option value="">Any texture</option>
              {[...new Set([...(Object.keys(FAMILY_LABEL) as string[]), ...texturesInData])].map((t) => (
                <option key={t} value={t}>
                  {(FAMILY_LABEL as Record<string, string>)[t] ?? t}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by street"
              value={streetFilter}
              onChange={(e) => setStreetFilter(e.target.value)}
              className="rounded-md border border-navy-600 bg-navy-850 px-2 py-1.5 text-xs text-ink"
            >
              <option value="">Any street</option>
              {STREETS.map((s) => (
                <option key={s} value={s}>
                  {s[0]?.toUpperCase()}
                  {s.slice(1)}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by source"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-md border border-navy-600 bg-navy-850 px-2 py-1.5 text-xs text-ink"
            >
              <option value="">Any source</option>
              {(Object.keys(HEURISTIC_SOURCE_LABEL) as HeuristicSource[]).map((s) => (
                <option key={s} value={s}>
                  {HEURISTIC_SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
            <span className="ml-auto self-center text-xs text-ink-faint">
              {visible.length} of {state.heuristics.length} shown
              {isAdmin === false ? ' · read-only until you log in' : ''}
            </span>
          </div>

          {state.heuristics.length === 0 ? (
            <div className="rounded-lg border border-dashed border-navy-600 bg-navy-900 p-4">
              <p className="text-sm text-ink">No heuristics yet.</p>
              <p className="mt-1 text-sm text-ink-dim">
                When a solver spot teaches you something, write the rule here and link the spot —
                or use “Link to heuristic” in the Explorer on any library solve.
              </p>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-sm text-ink-dim">No heuristics match those filters.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {visible.map((h) => (
                <li key={h.id} className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
                  {editingId === h.id ? (
                    <>
                      {formFields(editForm, setEditForm, `edit-${h.id}`)}
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => submitEdit(h)}
                          className="rounded-md bg-table px-3 py-1.5 text-sm font-semibold text-white hover:bg-table-dark disabled:opacity-50"
                        >
                          Save changes
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setEditingId(null)}
                          className="rounded-md px-3 py-1.5 text-sm text-ink-dim hover:bg-navy-800 hover:text-ink"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start gap-2">
                        <p className={`flex-1 text-sm leading-relaxed ${h.status === 'retired' ? 'text-ink-dim line-through' : 'text-ink'}`}>
                          {h.text}
                        </p>
                        <SourceBadge source={h.source} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {h.tags.texture ? (
                          <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[11px] text-ink-dim ring-1 ring-navy-600">
                            {(FAMILY_LABEL as Record<string, string>)[h.tags.texture] ?? h.tags.texture}
                          </span>
                        ) : null}
                        {h.tags.street ? (
                          <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[11px] capitalize text-ink-dim ring-1 ring-navy-600">
                            {h.tags.street}
                          </span>
                        ) : null}
                        {h.tags.spot_type ? (
                          <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[11px] text-ink-dim ring-1 ring-navy-600">
                            {h.tags.spot_type}
                          </span>
                        ) : null}
                        <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[11px] capitalize text-ink-faint ring-1 ring-navy-600">
                          {h.status}
                        </span>
                      </div>
                      <div className="mt-2">
                        <SupportStats h={h} />
                      </div>
                      {h.linked_spot_ids.length > 0 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-ink-faint">Supporting spots:</span>
                          {h.linked_spot_ids.map((id) => {
                            const item = libraryById.get(id);
                            return item ? (
                              <button
                                key={id}
                                type="button"
                                onClick={() => void openLinkedSpot(id)}
                                title={`${item.name} — open in the Explorer`}
                                className="rounded-full bg-navy-800 px-2 py-0.5 font-mono text-[11px] text-table-light ring-1 ring-table/50 hover:bg-navy-700"
                              >
                                {item.board} · {item.kind}
                              </button>
                            ) : (
                              <span
                                key={id}
                                title="Not in this service's library (a catalog spot id, or a solve from another library)"
                                className="rounded-full bg-navy-800 px-2 py-0.5 font-mono text-[11px] text-ink-faint ring-1 ring-navy-600"
                              >
                                {id}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-navy-700 pt-3">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditForm(formFromHeuristic(h));
                            setEditingId(h.id);
                            setError(null);
                          }}
                          className="rounded-md px-2.5 py-1 text-xs font-semibold text-ink-dim ring-1 ring-navy-600 hover:bg-navy-800 hover:text-ink disabled:opacity-50"
                        >
                          Edit
                        </button>
                        {h.status === 'active' ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setStatus(h, 'retired')}
                            className="rounded-md px-2.5 py-1 text-xs font-semibold text-ink-dim ring-1 ring-navy-600 hover:bg-navy-800 hover:text-ink disabled:opacity-50"
                          >
                            Retire
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setStatus(h, 'active')}
                            className="rounded-md px-2.5 py-1 text-xs font-semibold text-table-light ring-1 ring-table/50 hover:bg-navy-800 disabled:opacity-50"
                          >
                            Reactivate
                          </button>
                        )}
                        {confirmDeleteId === h.id ? (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => remove(h)}
                              className="rounded-md bg-red-900 px-2.5 py-1 text-xs font-semibold text-red-100 hover:bg-red-800 disabled:opacity-50"
                            >
                              Confirm delete
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-md px-2.5 py-1 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
                            >
                              Keep it
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(h.id)}
                            className="rounded-md px-2.5 py-1 text-xs font-semibold text-red-300 ring-1 ring-red-900 hover:bg-navy-800 disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                        <span className="ml-auto text-[11px] text-ink-faint">
                          Added {new Date(h.created_at).toLocaleDateString()}
                          {h.updated_at !== h.created_at
                            ? ` · edited ${new Date(h.updated_at).toLocaleDateString()}`
                            : ''}
                        </span>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
