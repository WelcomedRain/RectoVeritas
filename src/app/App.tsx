import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from './store';
import { PageView } from './PageView';
import { CodeView } from './CodeView';
import { WordsPanel, PicturesPanel, SelectionPanel } from './Panels';
import { StylePanel, ThemePanel } from './StylePanel';
import { SourceDialog, ConnectDialog, PublishDialog, SyncDialog, HistoryDialog, DriftDialog } from './Dialogs';
import { publish, type Step, type PublishResult } from '../core/publish';
import { verifyDeployment } from '../core/deploy';
import { useRegisterSW } from 'virtual:pwa-register/react';
import * as db from '../core/db';
import { outerRange, type StringEntry } from '../core/htmlIndex';
import type { LiveEdit } from './preview';
import { noteFor, summarise, type PreviewAck } from './previewable';
import { statusLine, siteState, SITE_WORD } from './status';
import { destinationsFor, type DestinationId } from '../core/destination';
import { ancestryOf, enclosingBlock } from '../core/ancestry';
import type { Version, SetAside } from '../core/history';
import { readTrace, type TracePayload, type TraceResult } from './trace';
import type { Comparison } from '../core/compare';
import { reportFit, makeItCover, makeItFitByHeight, type FitMeasurement, type SweepPoint } from '../core/fit';

type Mode = 'page' | 'split' | 'code';
type Tab = 'words' | 'style' | 'theme' | 'pictures' | 'selection';

export function App() {
  const ed = useEditor();
  const { state, online } = ed;

  const [mode, setMode] = useState<Mode>('page');
  const [tab, setTab] = useState<Tab>('words');
  const [showSource, setShowSource] = useState(false);
  const [hist, setHist] = useState<{
    open: boolean; loading: boolean; error: string | null;
    versions: Version[]; setAside: SetAside[]; busySha: string | null;
  }>({ open: false, loading: false, error: null, versions: [], setAside: [], busySha: null });

  const openHistory = async () => {
    setHist({ open: true, loading: true, error: null, versions: [], setAside: [], busySha: null });
    try {
      // The set-aside copies are local, so they are worth showing even if the
      // GitHub half of the list fails.
      const setAside = await ed.loadSetAside();
      setHist((h) => ({ ...h, setAside }));
      const versions = await ed.loadHistory();
      setHist((h) => ({ ...h, loading: false, versions }));
    } catch (e) {
      setHist((h) => ({ ...h, loading: false, error: (e as Error).message }));
    }
  };

  const doRestore = async (v: Version) => {
    setHist((h) => ({ ...h, busySha: v.sha, error: null }));
    try {
      await ed.restoreVersion(v);
      setHist((h) => ({ ...h, open: false, busySha: null }));
    } catch (e) {
      setHist((h) => ({ ...h, busySha: null, error: (e as Error).message }));
    }
  };
  const doRestoreSetAside = async (v: SetAside) => {
    setHist((h) => ({ ...h, busySha: v.key, error: null }));
    try {
      await ed.restoreSetAside(v.key);
      setHist((h) => ({ ...h, open: false, busySha: null }));
    } catch (e) {
      setHist((h) => ({ ...h, busySha: null, error: (e as Error).message }));
    }
  };

  const [busy, setBusy] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [hoverHeld, setHoverHeld] = useState(false);

  /**
   * Whether the installed window handed us its title bar.
   *
   * Also settable by hand for testing: an installed window is the one thing
   * that cannot be reproduced in a browser tab, so the layout would otherwise
   * ship unverified.
   */
  const [wco, setWco] = useState(false);
  useEffect(() => {
    const wcoApi = (navigator as Navigator & {
      windowControlsOverlay?: { visible: boolean; addEventListener: (t: string, f: () => void) => void };
    }).windowControlsOverlay;
    (window as Window & { __rectoForceWco?: (v: boolean) => void }).__rectoForceWco = setWco;
    if (!wcoApi) return;
    const sync = () => setWco(wcoApi.visible);
    sync();
    wcoApi.addEventListener('geometrychange', sync);
  }, []);

  // A new build is fetched in the background but never applied underneath an
  // edit in progress. Say it is ready; let the reload happen on request.
  const { needRefresh: [updateReady], updateServiceWorker } = useRegisterSW();

  const [pub, setPub] = useState<{
    open: boolean; phase: 'review' | 'running' | 'done';
    steps: Step[]; outcome: PublishResult['outcome'] | null; error: string | null;
    /** Which destination this publish is aimed at. Chosen before it runs. */
    dest: DestinationId;
  }>({ open: false, phase: 'review', steps: [], outcome: null, error: null, dest: 'preview' });

  const [fileText, setFileText] = useState('');
  useEffect(() => {
    if (!state.activeFile) return setFileText('');
    void db.getFile(state.activeFile).then((f) => setFileText(f?.text ?? ''));
  }, [state.activeFile, state.bundle]);

  /**
   * Whether the page could actually point at the current selection.
   *
   * A Share / SEO value has no box on the page, so nothing lights up. That
   * silence used to be the whole answer, and it is the reason a meta
   * description got edited in mistake for the heading it happened to quote
   * word for word. The page now says which it is, and the panel repeats it.
   */
  const [selShown, setSelShown] = useState<{ shown: boolean; detail: string }>(
    { shown: true, detail: '' },
  );
  /**
   * Style Trace: the panel asks where a value comes from, the page answers.
   *
   * Keyed by element and property, and cleared when the selection moves, so an
   * answer about one element can never be read as an answer about another.
   */
  const [traceReq, setTraceReq] = useState<{ elementId: string; prop: string; nonce: number } | null>(null);
  const [traces, setTraces] = useState<Record<string, TraceResult>>({});
  const traceKey = (elementId: string, prop: string) => `${elementId}|${prop}`;

  const onTraced = useCallback((p: TracePayload) => {
    setTraces((t) => ({ ...t, [`${p.elementId}|${p.prop}`]: readTrace(p) }));
  }, []);

  const onSelectionShown = useCallback(
    (shown: boolean, detail: string) => setSelShown({ shown, detail }), [],
  );

  useEffect(() => { setTraces({}); setTraceReq(null); }, [state.selection.elementId]);

  /**
   * Ask GitHub, once, on open. Observation only — see `observeRemote`.
   *
   * Guarded by a ref rather than by the dependency list: `online` and the
   * token both settle after the first render, and without the guard this
   * fires again every time one of them does.
   */
  const [drift, setDrift] = useState<{
    open: boolean; comparison: Comparison | null; loading: boolean; error: string | null; busy: boolean;
  }>({ open: false, comparison: null, loading: false, error: null, busy: false });

  /**
   * Raise the warning when the on-open look found the site had moved, and only
   * then go and read the whole file to say what differs. The cheap check
   * decides whether the expensive one is worth doing.
   */
  /**
   * One observation, one warning.
   *
   * `handledAt` records the `checkedAt` this has already reacted to, and does
   * both jobs at once: it stops the effect re-entering on every render, and it
   * is what makes the dialog dismissable. A plain `drift.open` guard cannot do
   * either — it is itself state, so closing the dialog re-runs the effect and
   * reopens it, re-reading 2 MB each time.
   *
   * `ed` is deliberately not a dependency. `useEditor` returns a fresh object
   * every render, so depending on it runs this on every render — which is
   * exactly the loop `handledAt` now also prevents.
   */
  const handledAt = useRef<number | null>(null);
  useEffect(() => {
    if (!state.remote || state.remote.inSync) return;
    if (handledAt.current === state.remote.checkedAt) return;
    handledAt.current = state.remote.checkedAt;
    setDrift({ open: true, comparison: null, loading: true, error: null, busy: false });
    void ed.describeDrift()
      .then((comparison) => setDrift((d) => ({ ...d, comparison, loading: false })))
      .catch((e: Error) => setDrift((d) => ({ ...d, loading: false, error: e.message })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.remote]);

  const dismissDrift = () => setDrift((d) => ({ ...d, open: false }));

  const looked = useRef(false);
  useEffect(() => {
    if (looked.current || !state.ready || !state.source || !state.token || !online) return;
    looked.current = true;
    void ed.observeRemote();
  }, [state.ready, state.source, state.token, online, ed]);


  const selectedEntry = state.selection.targetId
    ? state.index?.stringsById.get(state.selection.targetId) ?? null
    : null;
  const selectedElement = state.selection.elementId
    ? state.index?.byId.get(state.selection.elementId) ?? null
    : null;
  const selectedDecls = state.selection.elementId
    ? state.targets?.declsByElement.get(state.selection.elementId) ?? []
    : [];
  const selectedHover = state.selection.elementId
    ? state.targets?.hoverByElement.get(state.selection.elementId) ?? []
    : [];

  // Releasing on selection change stops a held hover following you to the next
  // element, where it would be showing something that is not true of it.
  useEffect(() => { setHoverHeld(false); }, [state.selection.elementId]);

  const elementSource = useMemo(() => {
    if (!selectedElement || !state.bundle) return null;
    const { start, end } = outerRange(selectedElement);
    return state.bundle.template.slice(start, end);
  }, [selectedElement, state.bundle]);

  const elementPending = selectedElement
    ? state.changes.get(`html:${selectedElement.id}`)?.nextValue ?? null
    : null;

  /**
   * Which element in the page shows a given asset.
   *
   * The template references assets by bare UUID in `src`, so this is a direct
   * lookup rather than a guess.
   */
  const imageElementFor = useCallback((uuid: string): string | null => {
    const els = state.index?.elements ?? [];
    for (const el of els) {
      if (el.attrs.some((a) => (a.name === 'src' || a.name === 'href') && a.value === uuid)) {
        return el.id;
      }
    }
    return null;
  }, [state.index]);

  /** And the reverse: the asset an element shows, so clicking it opens Images. */
  const assetForElement = useCallback((elementId: string): string | null => {
    const el = state.index?.byId.get(elementId);
    const src = el?.attrs.find((a) => a.name === 'src')?.value;
    return src && state.bundle?.manifest[src] ? src : null;
  }, [state.index, state.bundle]);

  /**
   * Which stylesheet rules govern the selected element, answered by the page.
   *
   * Matching is asked of the real DOM rather than computed here: the editor
   * knows the markup, but only the browser knows what the cascade resolved to.
   * Pseudo-class rules are matched on their bare selector, since `.btn:hover`
   * matches nothing while the pointer is over the panel — and those are exactly
   * the rules you cannot otherwise reach.
   */
  const [ruleMatches, setRuleMatches] = useState<{ index: number; count: number }[]>([]);
  const [matchedFor, setMatchedFor] = useState<string | null>(null);

  const matchSelectors = useMemo(
    () => (state.targets?.rules ?? []).map((r) => r.matchSelector),
    [state.targets],
  );

  const onRulesMatched = useCallback((elementId: string, matches: { index: number; count: number }[]) => {
    setMatchedFor(elementId);
    setRuleMatches(matches);
  }, []);

  // Drop stale answers the moment the selection moves, or the panel would show
  // the previous element's rules as if they were this one's.
  useEffect(() => {
    setRuleMatches([]);
    setMatchedFor(null);
  }, [state.selection.elementId]);

  const matchingRules = useMemo(() => {
    if (matchedFor !== state.selection.elementId) return [];
    const rules = state.targets?.rules ?? [];
    return ruleMatches
      .map((m) => ({ rule: rules[m.index], count: m.count }))
      .filter((x) => x.rule)
      // Most specific first. A universal reset legitimately matches, but
      // `*, *::before, *::after` at 305 elements is not what anyone opened this
      // panel to change, and leaving it on top buries the rule that is.
      .sort((a, b) => a.count - b.count);
  }, [ruleMatches, matchedFor, state.selection.elementId, state.targets]);

  /**
   * How the selected image sits in its frame.
   *
   * Measured rather than computed: the frame is laid out by the cascade and is
   * fluid here, so the editor cannot know its size without asking the page.
   */
  const [fit, setFit] = useState<FitMeasurement | null>(null);
  const [sweep, setSweep] = useState<SweepPoint[]>([]);
  const [sweepFor, setSweepFor] = useState<string | null>(null);
  const selectedImageElement = selectedAsset ? imageElementFor(selectedAsset) : null;

  useEffect(() => { setFit(null); setSweep([]); setSweepFor(null); }, [selectedImageElement]);

  const onSwept = useCallback((points: SweepPoint[]) => {
    setSweep(points);
    setSweepFor(null);
  }, []);

  const fitReport = useMemo(
    () => (fit && fit.elementId === selectedImageElement ? reportFit(fit, sweep) : null),
    [fit, sweep, selectedImageElement],
  );

  /** Rewrite the selected image's tag with one of the two fitting rules. */
  const setImageFit = useCallback((how: 'cover' | 'height') => {
    if (!selectedImageElement || !state.index || !state.bundle) return;
    const el = state.index.byId.get(selectedImageElement);
    if (!el) return;
    const { start, end } = outerRange(el);
    // Transform what is currently queued, not the original. Otherwise
    // switching back to the original fitting is a no-op: the rewrite compares
    // against source that already has it, decides nothing would change, and
    // silently does nothing.
    const pending = state.changes.get(`html:${selectedImageElement}`)?.nextValue;
    const src = pending ?? state.bundle.template.slice(start, end);
    const next = how === 'cover' ? makeItCover(src) : makeItFitByHeight(src);
    if (next) ed.editElementHtml(selectedImageElement, next);
  }, [selectedImageElement, state.index, state.bundle, state.changes, ed]);

  /**
   * Which asset each element references in the source.
   *
   * The preview needs this to put an image back after its markup is replaced:
   * the runtime resolves asset ids to blob URLs as it renders, and does so in
   * any attribute, so the id survives nowhere in the DOM.
   */
  const assetRefs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const el of state.index?.elements ?? []) {
      const src = el.attrs.find((a) => a.name === 'src')?.value;
      if (src && state.bundle?.manifest[src]) out[el.id] = src;
    }
    return out;
  }, [state.index, state.bundle]);

  /**
   * The background of the box an image sits in.
   *
   * It is what shows when an image is narrower than its frame, so anyone
   * deliberately supplying a narrower image needs to set it to blend. It
   * belongs to the parent element, which is awkward to select by clicking —
   * the image is on top of it — so it is surfaced beside the image instead.
   */
  const frameBackgroundTarget = useMemo(() => {
    if (!selectedImageElement || !state.index || !state.targets) return null;
    const img = state.index.byId.get(selectedImageElement);
    const parent = img?.parentId ? state.index.byId.get(img.parentId) : null;
    if (!parent) return null;
    const decls = state.targets.declsByElement.get(parent.id) ?? [];
    const bg = decls.find((d) => d.prop === 'background' || d.prop === 'background-color');
    return bg ? state.targets.byId.get(bg.id) ?? null : null;
  }, [selectedImageElement, state.index, state.targets]);

  const originalStyleFor = useCallback((elementId: string): string => {
    const el = state.index?.byId.get(elementId);
    return el?.attrs.find((a) => a.name === 'style')?.value ?? '';
  }, [state.index]);

  const originalHtmlFor = useCallback((elementId: string): string | null => {
    const el = state.index?.byId.get(elementId);
    if (!el || !state.bundle) return null;
    const { start, end } = outerRange(el);
    return state.bundle.template.slice(start, end);
  }, [state.index, state.bundle]);

  const forceHover = useMemo(
    () => (hoverHeld && state.selection.elementId
      ? {
          elementId: state.selection.elementId,
          decls: selectedHover.map((d) => ({
            prop: d.prop,
            value: state.changes.get(d.id)?.nextValue ?? d.value,
          })),
        }
      : null),
    [hoverHeld, state.selection.elementId, selectedHover, state.changes],
  );

  /** A click in the page maps to the first indexed string of that element. */
  const onSelectElement = useCallback((elementId: string, runOrdinal: number) => {
    const idx = ed.state.index;
    if (!idx) return;
    const candidates = idx.strings.filter((s) => s.elementId === elementId && s.kind === 'text');
    const hit = candidates.find((s) => s.runOrdinal === runOrdinal) ?? candidates[0];
    const asset = assetForElement(elementId);
    if (asset) {
      setSelectedAsset(asset);
      ed.select(null, elementId);
      setTab((t) => (t === 'style' || t === 'theme' ? t : 'pictures'));
      return;
    }
    if (hit) {
      ed.select(hit.id, elementId);
      // Keep the styling tabs put when the user is working on styling; jumping
      // them back to Selection on every click makes styling unusable.
      setTab((t) => (t === 'style' || t === 'theme' ? t : 'selection'));
    } else {
      // The element has no editable words of its own — say so rather than
      // silently doing nothing, which was the prototype's central complaint.
      ed.select(null, elementId);
      setTab((t) => (t === 'style' || t === 'theme' ? t : 'selection'));
    }
  }, [ed, assetForElement]);

  const liveEdits = useMemo(
    () => ed.changeList.flatMap((c): LiveEdit[] => {
      // A code edit has no entry in the target map by design; it carries its
      // own identity in the change.
      if (c.kind === 'style-attr') {
        return [{
          id: c.targetId,
          kind: 'style-attr',
          elementId: c.targetId.slice('override:'.length),
          runOrdinal: 0,
          value: c.nextValue,
        }];
      }
      if (c.kind === 'html') {
        return [{
          id: c.targetId,
          kind: 'html',
          elementId: c.targetId.slice('html:'.length),
          runOrdinal: 0,
          value: c.nextValue,
        }];
      }
      const t = state.targets?.byId.get(c.targetId);
      if (!t) return [];
      // A stylesheet rule is previewed by re-declaring it, so the bridge needs
      // the selector and any enclosing conditions, not just the value.
      const rule = t.kind === 'css-rule'
        ? state.targets?.rules.find((r) => c.targetId.startsWith(`${r.id}:`))
        : undefined;
      return [{
        id: c.targetId,
        kind: t.kind,
        elementId: t.elementId ?? '',
        runOrdinal: t.runOrdinal ?? 0,
        attrName: t.attrName,
        prop: t.prop,
        value: c.nextValue,
        selector: rule?.selector,
        matchSelector: rule?.matchSelector,
        conditions: rule?.conditions,
        ruleState: rule?.state ?? null,
      }];
    }),
    [ed.changeList, state.targets],
  );

  /**
   * What the page said about each change it was asked to apply.
   *
   * Held here rather than in the store because it describes the preview, not
   * the working copy: it is true of this window at this width, and says nothing
   * about whether the change will publish.
   */
  const [acks, setAcks] = useState<Map<string, PreviewAck>>(new Map());
  const onApplied = useCallback((id: string, ack: PreviewAck) => {
    setAcks((prev) => {
      const was = prev.get(id);
      if (was && was.result === ack.result && was.why === ack.why) return prev;
      const next = new Map(prev);
      next.set(id, ack);
      return next;
    });
  }, []);

  const preview = useMemo(
    () => summarise(ed.changeList.map((c) => noteFor(c, acks.get(c.targetId)))),
    [ed.changeList, acks],
  );

  /**
   * Editing a hover value holds the element in its hover state.
   *
   * Without this you would be typing a colour with no way to see it: the
   * pointer is over the panel, and the page's own hover still shows the value
   * the runtime captured when it rendered.
   */
  const editWithHover = useCallback((id: string, v: string) => {
    if (state.targets?.byId.get(id)?.kind === 'css-hover') setHoverHeld(true);
    ed.edit(id, v);
  }, [ed, state.targets]);

  /**
   * Guards against a second publish starting while the first is in flight.
   *
   * A ref, not rendered state: `phase: 'running'` only takes effect after a
   * re-render, so a second click landing in that window used to start a second
   * run. Both then read the same branch head, the first moved the branch, and
   * the second was refused with "Update is not a fast forward" — after the
   * change had already gone live. The user saw a failure for a publish that
   * had succeeded.
   */
  const publishing = useRef(false);

  const doPublish = async () => {
    if (publishing.current) return;
    if (!state.source || !state.targets || !fileText || !destinations) return;
    publishing.current = true;
    const destination = destinations[pub.dest];
    setPub((p) => ({ ...p, phase: 'running', steps: [], outcome: null, error: null }));
    const n = ed.changeList.length;
    const result = await publish(
      {
        ref: state.source,
        token: state.token ?? '',
        originalFile: fileText,
        destination,
        changes: ed.changeList,
        targets: state.targets!.byId,
        message: n === 0 && state.restored
          ? `Go back to version ${state.restored.short}`
          : destination.isLive
            ? `Update site copy (${n} change${n === 1 ? '' : 's'})`
            : `Stage ${n} change${n === 1 ? '' : 's'} for review`,
        online,
      },
      (steps) => setPub((p) => ({ ...p, steps })),
    );
    publishing.current = false;
    setPub((p) => ({ ...p, phase: 'done', outcome: result.outcome, error: result.error ?? null, steps: result.steps }));

    // A failure while sending leaves the app's picture of the site unreliable:
    // the commit may have landed and the queue still looks unpublished. Go and
    // look rather than leave the header asserting the last thing it knew.
    if (result.outcome === 'failed' && result.steps.some((s) => s.state === 'failed' && s.id === 'pushed')) {
      void ed.observeRemote();
    }

    if (result.outcome === 'pushed' && result.fileText) {
      // THE RULE. A preview publish does not touch the live page, so the edits
      // are still outstanding and the queue must survive untouched. Clearing it
      // here would report the work as shipped while the site was unchanged —
      // read the destination, never the outcome.
      if (result.destination.isLive) {
        await ed.commitPublished(result.commitSha ?? null, result.fileText);
      }
      // Observe the deployment rather than assume it. GitHub Pages builds
      // asynchronously and can fail after a good push.
      void verifyDeployment({
        liveUrl: result.destination.url,
        expected: result.fileText,
        subject: result.destination.isLive ? 'the live site' : 'the preview',
        onProgress: ed.setDeploy,
      }).then(ed.setDeploy);
    }
  };

  if (!state.ready) {
    return <div style={{ padding: 24 }} className="label">Opening your working copy…</div>;
  }

  if (!state.source || !state.token) {
    return (
      <ConnectDialog
        error={state.error}
        busy={busy}
        onConnect={async (v) => { setBusy(true); await ed.connect(v); setBusy(false); }}
      />
    );
  }

  const dirty = ed.changeList.length;

  /**
   * The notices, and nothing else.
   *
   * The left column used to carry a file list, two counts and a green tick.
   * The list was the repository tree, not the working copy, and only one of
   * its rows named a file the app had. The counts restated what the Words and
   * Pictures tabs already say, and could not move in response to an edit —
   * changing a word replaces a string's value, replacing an image swaps the
   * bytes under the same manifest entry, so both totals stay put. The tick
   * mirrored a gate `publish()` enforces anyway.
   *
   * What survives is the two things that are about this session and are
   * recorded nowhere else, plus the head check in the only state worth hearing
   * about: the one that will stop a publish.
   */
  const headBad = !!state.health && !state.health.headTagsInHead;
  const orphans = state.health?.orphanedChanges ?? 0;
  const applied = state.health?.appliedChanges ?? 0;
  const publishable = dirty + state.replacedImages.length;
  const previewNote = mode !== 'code' && !!preview.headline;
  const hasNotices = headBad || previewNote || orphans > 0 || applied > 0;

  const destinations = state.source
    ? destinationsFor(state.source.path, state.source.liveUrl)
    : null;

  /**
   * Preview until the real thing has worked once.
   *
   * `lastPush` is only written when a publish reaches the live page, so its
   * absence means no publish has ever succeeded against this site. The first
   * one should not be aimed at the homepage: if anything in the pipeline is
   * wrong, the staged copy is where you want to find out.
   */
  const defaultDest: DestinationId = state.lastPush ? 'live' : 'preview';

  const site = siteState({
    dirty, remote: state.remote, restored: state.restored,
    localModified: state.localModified,
  });

  const status = statusLine({
    dirty,
    remote: state.remote,
    localModified: state.localModified,
    networkUp: state.online,
    manualOffline: ed.manualOffline,
    // While the dialog is open it is the authority on where this publish is
    // going; the footer must not sit underneath it saying something else.
    publishTo: destinations?.[pub.open ? pub.dest : defaultDest].url,
    deploy: state.deploy,
    lastPush: state.lastPush,
    restored: state.restored,
  });
  const idx = state.index;

  return (
    <div className={`shell ${wco ? 'wco' : ''}`}>
      {/* The title bar we draw ourselves when the window gives us one. */}
      <div className="titlebar">
        {/* The overlay replaces the window's own caption, icon included, so the
            icon has to be drawn here or it simply disappears. */}
        <img className="tile" src="/icon-192.png" alt="" width={20} height={20} />
        <span className="mark">
          RECTO<span className="brand-dot">&bull;</span>VERITAS
        </span>
      </div>

      {/* ---------------- header ---------------- */}
      <header className="header">
        <div className="brand">
          {/* Monogram then full name. This does not repeat the accent the way a
              plain red square did — the tile is the same mark in miniature, so
              it anchors the wordmark instead of competing with it. */}
          <img className="brand-tile" src="/icon-192.png" alt="" width={26} height={26} />
          <span className="brand-name">
            RECTO<span className="brand-dot">&bull;</span>VERITAS
          </span>
        </div>
        <span className="rule-v" />
        <button className={`source-btn site-${site}`} onClick={() => setShowSource(true)}>
          <div className="site-line">
            <span className="site">{state.source.siteName}</span>
            <span className="site-state">{SITE_WORD[site]}</span>
          </div>
          <div className="where">local copy · {state.source.owner}/{state.source.repo}</div>
        </button>

        <div style={{ flex: 1 }} />

        <button
          className="btn btn-ghost"
          onClick={() => ed.setManualOffline((v) => !v)}
          title="Switch between online and offline for testing"
        >
          <span className={`status-square ${online ? '' : 'off'}`} />
          {online ? 'Online' : 'Offline'}
        </button>

        {/* The app knew where the page was served from the moment it read the
            repository's CNAME, and used it only to fetch-and-compare after a
            push. There was no way to simply go and look at it. */}
        <button
          className="btn btn-ghost"
          disabled={!destinations}
          onClick={() => window.open(destinations!.live.url, '_blank', 'noopener')}
          title={destinations ? `Open ${destinations.live.url}` : ''}
        >
          Open live
        </button>

        <button
          className="btn btn-ghost"
          disabled={!destinations}
          onClick={() => window.open(destinations!.preview.url, '_blank', 'noopener')}
          title={destinations ? `Open ${destinations.preview.url}` : ''}
        >
          Open preview
        </button>

        <button
          className="btn btn-ghost"
          onClick={() => void openHistory()}
          title="Every version you have published, and the way back to one"
        >
          History
        </button>

        {/* A replaced image queues no patch — the bytes go straight into the
            working copy — so gating on the patch count alone left that change
            unpublishable unless some text happened to be edited too. */}
        <button
          className="btn btn-primary"
          disabled={dirty === 0 && !state.restored && !state.localModified}
          onClick={() => setPub({
            open: true, phase: 'review', steps: [], outcome: null, error: null,
            dest: defaultDest,
          })}
        >
          Publish changes
          {/* Replaced images are counted here with the queued edits: they are
              changes like any other to whoever made them, and the app knows how
              many. The mark is only for the case it genuinely cannot count —
              a page file replaced wholesale by a restore. */}
          {publishable > 0 && <span className="badge">{publishable}</span>}
          {publishable === 0 && state.localModified && <span className="badge">&bull;</span>}
        </button>
      </header>

      {/* ---------------- middle ---------------- */}
      <div className="middle">
        {/* centre */}
        <main className="centre">
          <div className="toolbar">
            <span className="path">{state.activeFile}</span>
            <span className="note">
              compiled · {Math.round((fileText.length || 0) / 1024)} KB
            </span>
            <span className="spacer" />
            <div className="seg">
              <button className={mode === 'page' ? 'on' : ''} onClick={() => setMode('page')}>Page</button>
              <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>Page + code</button>
              <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>Code</button>
            </div>
          </div>

          {hasNotices && (
            <div className="notices">
              {headBad && state.health && (
                <div className="card">
                  <div className="card-title">Share tags</div>
                  <div className="card-body">
                    {state.health.headDetail}{' '}
                    Publishing refuses the page until this is fixed.
                  </div>
                </div>
              )}

              {previewNote && (
                <div className="card warn">
                  <div className="card-title">Not showing in the page</div>
                  <div className="card-body">
                    <b>{preview.headline}</b>
                    <div style={{ marginTop: 4 }}>
                      {preview.unseen > 0
                        ? 'They are queued and will publish exactly as written. The preview '
                          + 'just cannot show them here.'
                        : 'They are queued and will publish exactly as written.'}
                    </div>
                    <ul className="unseen">
                      {preview.notes.map((n) => (
                        <li key={n.id}>
                          <b>{n.label}</b>
                          <div>{n.why}</div>
                          {n.howToSee && <div className="how">{n.howToSee}</div>}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {applied > 0 && state.health && (
                <div className="card">
                  <div className="card-title">Already on the page</div>
                  <div className="card-body">
                    {applied} queued edit{applied === 1 ? '' : 's'}
                    {applied === 1 ? ' is' : ' are'} already in this copy of the page — the
                    change {applied === 1 ? 'it makes has' : 'they make have'} been made.
                    This is what a publish that reached GitHub but was reported as failed
                    leaves behind. Publishing {applied === 1 ? 'it' : 'them'} would change
                    nothing.
                  </div>
                  <button className="btn btn-primary" onClick={ed.dropApplied}>
                    Forget them
                  </button>
                </div>
              )}

              {orphans > 0 && state.health && (
                <div className="card">
                  <div className="card-title">Edits with nowhere to go</div>
                  <div className="card-body">
                    {orphans} queued change{orphans === 1 ? '' : 's'} no longer
                    {orphans === 1 ? ' matches' : ' match'} anything on this page
                    {state.health.exportDetected
                      ? ' — the page was replaced by a new export since you made them.'
                      : '.'}{' '}
                    They cannot be published.
                  </div>
                  <button className="btn btn-primary" onClick={ed.dropOrphans}>
                    Forget them
                  </button>
                </div>
              )}
            </div>
          )}

          <div className={`panes ${mode === 'split' ? 'split' : ''}`}>
            {mode !== 'code' && idx && (
              <PageView
                file={state.activeFile ?? ''}
                fileText={fileText}
                index={idx}
                onSelectElement={onSelectElement}
                selectedElementId={state.selection.elementId}
                liveEdits={liveEdits}
                onApplied={onApplied}
                forceHover={forceHover}
                matchSelectors={matchSelectors}
                onRulesMatched={onRulesMatched}
                measureFitFor={selectedImageElement}
                onFitMeasured={setFit}
                assetRefs={assetRefs}
                sweepFor={sweepFor}
                onSwept={onSwept}
                originalHtmlFor={originalHtmlFor}
                originalStyleFor={originalStyleFor}
          onSelectionShown={onSelectionShown}
          traceRequest={traceReq}
          onTraced={onTraced}
          selectedLabel={selectedEntry?.label ?? selectedElement?.tag ?? ''}
              />
            )}
            {mode !== 'page' && state.bundle && (
              <CodeView
                text={state.bundle.template}
                revealAt={selectedEntry?.start ?? null}
                compiled
              />
            )}
          </div>
        </main>

        {/* right */}
        <aside className="right">
          <div className="tabs">
            <button className={tab === 'words' ? 'on' : ''} onClick={() => setTab('words')}>Words</button>
            <button className={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>Style</button>
            <button className={tab === 'theme' ? 'on' : ''} onClick={() => setTab('theme')}>Theme</button>
            <button className={tab === 'pictures' ? 'on' : ''} onClick={() => setTab('pictures')}>Images</button>
            <button className={tab === 'selection' ? 'on' : ''} onClick={() => setTab('selection')}>Select</button>
          </div>

          {/* The page could not point at what is selected. Said here, beside
              the box being typed into, because that is where the belief about
              what is being edited actually lives. */}
          {!selShown.shown && selShown.detail && state.selection.targetId && (
            <div className="not-drawn">
              <b>Not on the page</b>
              <span>{selShown.detail}</span>
            </div>
          )}

          {tab === 'words' && idx && (
            <WordsPanel
              index={idx}
              valueOf={ed.valueOf}
              onEdit={ed.edit}
              onFocus={(s: StringEntry) => ed.select(s.id, s.elementId)}
              onSelectElement={(id) => ed.select(null, id)}
              changes={state.changes}
              selectedId={state.selection.targetId}
            />
          )}

          {tab === 'style' && state.targets && (
            <StylePanel
              element={selectedElement}
              decls={selectedDecls}
              hoverDecls={selectedHover}
              rules={matchingRules}
              hoverHeld={hoverHeld}
              onHoldHover={setHoverHeld}
              onTrace={(prop) => {
                const id = selectedElement?.id;
                if (!id) return;
                setTraces((t) => ({
                  ...t,
                  [traceKey(id, prop)]: { pending: true, computed: '', winner: null, overridden: [], agrees: 'not-comparable', unreadable: 0 },
                }));
                setTraceReq({ elementId: id, prop, nonce: Date.now() });
              }}
              traceFor={(prop) => (selectedElement ? traces[traceKey(selectedElement.id, prop)] ?? null : null)}
              valueOf={ed.valueOf}
              onEdit={editWithHover}
              onScopeToElement={ed.applyOverride}
              changes={state.changes}
              targetsById={state.targets.byId}
              tokens={state.targets.tokens}
            />
          )}

          {tab === 'theme' && state.targets && (
            <ThemePanel
              valueOf={ed.valueOf}
              onEdit={ed.edit}
              onScopeToElement={ed.applyOverride}
              selectedElementId={state.selection.elementId}
              changes={state.changes}
              targetsById={state.targets.byId}
              tokens={state.targets.tokens}
            />
          )}

          {tab === 'pictures' && state.bundle && (
            <PicturesPanel
              assets={state.assets}
              bundle={state.bundle}
              selectedUuid={selectedAsset}
              onSelect={(uuid) => {
                setSelectedAsset(uuid);
                // Selecting an image should show you where it is, not just
                // that it exists.
                const elId = imageElementFor(uuid);
                if (elId) ed.select(null, elId);
              }}
              onReplace={async (uuid, file) => {
                const buf = new Uint8Array(await file.arrayBuffer());
                return ed.replaceImage(uuid, buf, file.type || 'image/png');
              }}
              usedByElement={imageElementFor}
              fit={fitReport}
              sweeping={sweepFor !== null}
              onCheckWidths={() => selectedImageElement && setSweepFor(selectedImageElement)}
              onSetFit={setImageFit}
              backgroundTarget={frameBackgroundTarget}
              backgroundValue={frameBackgroundTarget ? ed.valueOf(frameBackgroundTarget) : ''}
              backgroundEdited={!!frameBackgroundTarget && state.changes.has(frameBackgroundTarget.id)}
              tokens={state.targets?.tokens ?? []}
              onEditBackground={(v) => frameBackgroundTarget && ed.edit(frameBackgroundTarget.id, v)}
              onShowCode={() => {
                if (selectedImageElement) ed.select(null, selectedImageElement);
                setMode('split');
                setTab('selection');
              }}
            />
          )}

          {tab === 'selection' && idx && (
            <SelectionPanel
              entry={selectedEntry}
              change={selectedEntry ? state.changes.get(selectedEntry.id) : undefined}
              valueOf={ed.valueOf}
              onEdit={editWithHover}
              onScopeToElement={ed.applyOverride}
              onUndo={ed.undo}
              onShowCode={() => setMode('split')}
              element={selectedElement}
              decls={selectedDecls}
              hoverDecls={selectedHover}
              rules={matchingRules}
              targetsById={state.targets?.byId ?? new Map()}
              tokens={state.targets?.tokens ?? []}
              changes={state.changes}
              hoverHeld={hoverHeld}
              onHoldHover={setHoverHeld}
              ancestry={idx ? ancestryOf(idx, selectedElement?.id ?? null) : []}
              block={idx ? enclosingBlock(idx, selectedElement?.id ?? null) : null}
              onSelectElement={(id) => ed.select(null, id)}
              elementSource={elementSource}
              elementPending={elementPending}
              onEditHtml={(html) => selectedElement && ed.editElementHtml(selectedElement.id, html)}
              onRevertHtml={() => selectedElement && ed.undo(`html:${selectedElement.id}`)}
            />
          )}
        </aside>
      </div>

      {/* ---------------- footer ---------------- */}
      {/* Two questions, two slots. See status.ts. */}
      <footer className="footer">
        {/* The reassurance that used to occupy its own permanent slot survives
            here, where it is available on hover without spending a slot on a
            fact that never changes. */}
        <span
          className={`chip status-${status.pending.tone}`}
          title="You are editing a copy on this computer. Nothing reaches the live site until you publish."
        >
          {status.pending.text}
        </span>
        {status.connection && (
          <span className={`chip ${status.connection.tone === 'switched' ? 'switched' : 'dirty'}`}>
            {status.connection.text}
          </span>
        )}
        {updateReady && (
          <button
            className="chip dirty"
            style={{ marginLeft: 'auto', cursor: 'pointer' }}
            onClick={() => updateServiceWorker(true)}
            title="A newer version of RectoVeritas has been downloaded"
          >
            Update ready · reload
          </button>
        )}
      </footer>

      {/* ---------------- dialogs ---------------- */}
      {drift.open && (
        <DriftDialog
          dirty={dirty}
          comparison={drift.comparison}
          loading={drift.loading}
          error={drift.error}
          busy={drift.busy}
          onKeepMine={dismissDrift}
          onClose={dismissDrift}
          onTakeTheirs={async () => {
            setDrift((d) => ({ ...d, busy: true }));
            try {
              await ed.applyRemote();
              setDrift({ open: false, comparison: null, loading: false, error: null, busy: false });
            } catch (e) {
              setDrift((d) => ({ ...d, busy: false, error: (e as Error).message }));
            }
          }}
        />
      )}

      {showSource && (
        <SourceDialog
          dirty={dirty}
          site={site}
          onRefetch={() => { setShowSource(false); void ed.checkRemote(); }}
          onDisconnect={() => { setShowSource(false); void ed.disconnect(); }}
          onClose={() => setShowSource(false)}
        />
      )}

      <SyncDialog sync={state.sync} onClose={ed.dismissSync} />

      {hist.open && (
        <HistoryDialog
          versions={hist.versions}
          setAside={hist.setAside}
          loading={hist.loading}
          error={hist.error}
          queued={dirty}
          busySha={hist.busySha}
          onRestore={(v) => void doRestore(v)}
          onRestoreSetAside={(v) => void doRestoreSetAside(v)}
          onClose={() => setHist((h) => ({ ...h, open: false }))}
        />
      )}

      {pub.open && (
        <PublishDialog
          phase={pub.phase}
          changes={ed.changeList}
          steps={pub.steps}
          outcome={pub.outcome}
          error={pub.error}
          online={online}
          deploy={state.deploy}
          destinations={destinations}
          dest={pub.dest}
          onDest={(d) => setPub((p) => ({ ...p, dest: d }))}
          everPublishedLive={state.lastPush !== null}
          unlisted={state.localModified}
          images={state.replacedImages.length}
          restored={state.restored !== null}
          onPublish={doPublish}
          onClose={() => setPub({
            open: false, phase: 'review', steps: [], outcome: null, error: null,
            dest: defaultDest,
          })}
        />
      )}

      {state.error && (
        <div style={{ position: 'fixed', bottom: 46, left: 14, right: 14, zIndex: 30 }}>
          <div className="banner-err">{state.error}</div>
        </div>
      )}
    </div>
  );
}
