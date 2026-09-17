/**
 * All editor state, in one hook.
 *
 * Small enough not to need a state library, and keeping it in one place makes
 * the "publish clears the queue" invariants checkable by reading one file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseBundle, serializeBundle, listAssets, type Bundle, type AssetInfo } from '../core/bundle';
import { indexTemplate, type TemplateIndex, type StringEntry } from '../core/htmlIndex';
import { buildTargets, validate, type EditTarget, type TargetSet } from '../core/targets';
import { outerRange } from '../core/htmlIndex';
import { parseDeclarations } from '../core/css';
import { bytesToBase64, imageSizeFromBase64 } from '../core/imageMeta';
import { GitHub, parseRepoInput, type RepoRef } from '../core/github';
import {
  describeVersions, describeSetAside, setAsideKeyFor,
  type Version, type SetAside,
} from '../core/history';
import { verifyHeadTags, alreadyApplied, type PendingChange } from '../core/publish';
import { liveUrlFor, type DeployObservation } from '../core/deploy';
import * as db from '../core/db';
import { gitBlobSha } from '../core/blobSha';
import { compareBundles, type Comparison } from '../core/compare';

export type Mode = 'page' | 'split' | 'code';
export type Tab = 'words' | 'pictures' | 'selection';

export interface RepoFileEntry {
  path: string;
  size: number;
  sha: string;
}

export interface HealthState {
  headTagsInHead: boolean;
  headDetail: string;
  stringsIndexed: number;
  imagesFound: number;
  /**
   * Queued edits that no longer point at anything in the current page.
   *
   * This is what an export looks like from in here: a Claude Design re-export
   * replaces the whole bundle, so byte ranges authored against the old one stop
   * resolving. Rather than publish a guess or silently drop the work, we count
   * them and say so.
   */
  orphanedChanges: number;
  /**
   * Queued edits the page already satisfies — published, then re-fetched.
   *
   * Counted apart from orphans because the remedy is the same but the story
   * is the opposite: nothing was lost, the work is done.
   */
  appliedChanges: number;
  /** The bundle changed since the queued edits were authored. */
  exportDetected: boolean;
}

/**
 * What a refresh against GitHub found.
 *
 * `decision` is the important one: the working copy has unpublished edits AND
 * GitHub has moved. Replacing the file underneath those edits would strand
 * every one of them against byte offsets that no longer exist, so nothing is
 * applied until the user chooses.
 */
export type SyncState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'updated'; displaced: boolean }
  | { kind: 'error'; message: string };

/**
 * What the last look at GitHub found, without acting on it.
 *
 * Distinct from `sync`, which is a conversation in progress, and from
 * `deploy`, which is about a publish we made. This is the passive answer to
 * the only question the header asks: is the copy on screen still the site?
 *
 * `inSync: false` deliberately does NOT trigger a fetch. A remote that has
 * moved is not automatically the better version — a bad deploy, a half-landed
 * push or an edit made elsewhere all look identical from here — so this
 * records the disagreement and leaves the decision where it belongs.
 */
export interface RemoteCheck {
  checkedAt: number;
  inSync: boolean;
}

export interface EditorState {
  ready: boolean;
  error: string | null;
  source: db.StoredSource | null;
  token: string | null;
  files: RepoFileEntry[];
  activeFile: string | null;
  bundle: Bundle | null;
  index: TemplateIndex | null;
  targets: TargetSet | null;
  assets: AssetInfo[];
  health: HealthState | null;
  changes: Map<string, PendingChange>;
  selection: { targetId: string | null; elementId: string | null };
  online: boolean;
  lastPush: number | null;
  sync: SyncState;
  deploy: DeployObservation | null;
  /** Null until GitHub has actually been asked. Never assumed. */
  remote: RemoteCheck | null;
  /**
   * Assets replaced since the last sync, by uuid.
   *
   * Tracked rather than inferred. An image replacement writes into the page
   * file and queues no edit, so the only other way to report it is "something
   * changed" — which tells you less than the app knows. Persisted, because the
   * fact survives a reload and so must the ability to say it.
   */
  replacedImages: string[];
  /**
   * The working copy differs from the baseline in ways that are not queued
   * patches — a replaced image, or an older version loaded back.
   *
   * Derived, never flagged: it is `gitBlobSha(text) !== sha`, recomputed from
   * the bytes themselves. A stored boolean would be one more thing that can
   * disagree with reality, and this is the fact Publish is gated on.
   */
  localModified: boolean;
  /**
   * Set when the working copy is an older published version, loaded back.
   *
   * A restore produces no queued edits — it replaces the page wholesale — so
   * without this the app would count zero changes and report that the working
   * copy matches the live site, while holding something quite different. It
   * also has to enable Publish, which is otherwise gated on there being edits.
   */
  restored: { sha: string; short: string; when: number } | null;
}

const PAGE_FILE_RE = /\.html?$/i;

/** How many displaced working copies to keep. Each is a whole page. */
const SET_ASIDE_KEEP = 5;

export function useEditor() {
  const [state, setState] = useState<EditorState>({
    ready: false,
    error: null,
    source: null,
    remote: null,
    replacedImages: [],
    localModified: false,
    restored: null,
    token: null,
    files: [],
    activeFile: null,
    bundle: null,
    index: null,
    targets: null,
    assets: [],
    health: null,
    changes: new Map(),
    selection: { targetId: null, elementId: null },
    online: navigator.onLine,
    lastPush: null,
    sync: { kind: 'idle' },
    deploy: null,
  });

  const stateRef = useRef<EditorState>(null as unknown as EditorState);

  const patch = useCallback((p: Partial<EditorState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  stateRef.current = state;

  // Real connectivity, with a manual override kept for testing.
  const [manualOffline, setManualOffline] = useState(false);
  useEffect(() => {
    const on = () => patch({ online: true });
    const off = () => patch({ online: false });
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [patch]);
  const online = state.online && !manualOffline;

  /** Restore the working copy. The queue must survive a restart. */
  useEffect(() => {
    (async () => {
      try {
        const [token, source, files, patches, lastPush, replacedImages] = await Promise.all([
          db.getToken(),
          db.getMeta<db.StoredSource>('source'),
          db.getMeta<RepoFileEntry[]>('files'),
          db.allPatches(),
          db.getMeta<number>('lastPush'),
          db.getMeta<string[]>('replacedImages'),
        ]);

        // Drop records written by an older schema rather than letting an
        // unkeyed patch inflate the badge and never publish.
        // Backfill for workspaces saved before the live URL was recorded. The
        // github.io form redirects to any custom domain and fetch follows it,
        // so this is correct even for a site on its own domain.
        const fixedSource = source && !source.liveUrl
          ? { ...source, liveUrl: liveUrlFor(undefined, source.owner, source.repo, source.path) }
          : source;
        if (source && !source.liveUrl && fixedSource) await db.setMeta('source', fixedSource);

        // Only once there is something to protect: asking on a first run, with
        // an empty store and nothing connected, spends the one prompt Firefox
        // gives you on a database holding nothing.
        if (source) void db.requestPersistence();

        const changes = new Map<string, PendingChange>();
        for (const p of patches) {
          if (!p.targetId) { void db.delPatch((p as { id: string }).id); continue; }
          changes.set(p.targetId, p);
        }

        let bundle: Bundle | null = null;
        let index: TemplateIndex | null = null;
        let targets: TargetSet | null = null;
        let assets: AssetInfo[] = [];
        let health: HealthState | null = null;
        const activeFile = source?.path ?? null;

        let localModified = false;
        if (activeFile) {
          const stored = await db.getFile(activeFile);
          if (stored?.text) {
            // The baseline is the version GitHub gave us; the text may have
            // moved on without a patch to show for it.
            localModified = stored.sha ? (await gitBlobSha(stored.text)) !== stored.sha : false;
            ({ bundle, index, targets, assets, health } = openBundle(stored.text));
            if (health && targets && bundle) {
              health = reconcile(health, changes, targets, bundle.template);
            }
          }
        }

        setState((s) => ({
          ...s,
          ready: true,
          token: token ?? null,
          source: fixedSource ?? null,
          files: files ?? [],
          activeFile,
          bundle,
          index,
          targets,
          assets,
          health,
          changes,
          localModified,
          // A list that outlived the divergence it described would name images
          // that are already published.
          replacedImages: localModified ? (replacedImages ?? []) : [],
          lastPush: lastPush ?? null,
        }));
      } catch (e) {
        setState((s) => ({ ...s, ready: true, error: (e as Error).message }));
      }
    })();
  }, []);

  const connect = useCallback(
    async (input: { repo: string; branch: string; token: string }) => {
      patch({ error: null });
      const parsed = parseRepoInput(input.repo);
      if (!parsed) {
        patch({ error: 'That does not look like a GitHub repository. Try "owner/name".' });
        return;
      }
      const ref: RepoRef = { ...parsed, branch: input.branch || 'main' };
      try {
        const gh = new GitHub(input.token);
        // Fetching the branch head is the validity check. Calling /user first
        // would be a nicer greeting but reaches outside the token's repository
        // scope, so a correctly-minted single-repo token could fail here before
        // ever touching the site it is allowed to edit.
        const head = await gh.getBranchHead(ref);
        const tree = await gh.listTree(ref, head.treeSha);

        const files = tree
          .filter((t) => t.type === 'file')
          .map((t) => ({ path: t.path, size: t.size, sha: t.sha }));

        const page = files.find((f) => f.path === 'index.html')
          ?? files.find((f) => PAGE_FILE_RE.test(f.path));
        if (!page) {
          patch({ error: 'No HTML page found in that repository.' });
          return;
        }

        const text = await gh.getBlobText(ref, page.sha);
        const opened = openBundle(text);

        // A CNAME in the repository is how GitHub Pages learns the custom
        // domain, so it is also the most reliable statement of where the
        // published page will be served from.
        const cnameEntry = files.find((f) => f.path === 'CNAME');
        const cname = cnameEntry
          ? await gh.getBlobText(ref, cnameEntry.sha).catch(() => undefined)
          : undefined;

        await db.clearFiles();
        await db.putFile({ path: page.path, text, sha: page.sha });
        const source: db.StoredSource = {
          ...ref,
          path: page.path,
          lastFetched: Date.now(),
          siteName: parsed.repo,
          liveUrl: liveUrlFor(cname, ref.owner, ref.repo, page.path),
        };
        await db.setToken(input.token);
        await db.setMeta('source', source);
        void db.requestPersistence();
        await db.setMeta('files', files);

        setState((s) => ({
          ...s,
          error: null,
          token: input.token,
          source,
          files,
          localModified: false,
          replacedImages: [],
          activeFile: page.path,
          ...opened,
          selection: { targetId: null, elementId: null },
        }));
      } catch (e) {
        patch({ error: (e as Error).message });
      }
    },
    [patch],
  );

  /**
   * Check GitHub without touching the working copy.
   *
   * Deliberately split from applying the result. The previous implementation
   * fetched and overwrote in one step, which silently stranded pending edits
   * whenever the remote had moved — the exact "never overwrite a changed
   * working copy without an explicit reviewed choice" failure.
   */
  /**
   * Look, record, and do nothing else.
   *
   * Runs on open so the header can stop guessing. It never writes to the
   * working copy, never raises a dialog and never reports an error: a failed
   * look is simply not an observation, and leaving `remote` null says exactly
   * that. Everything it could tell you is available on demand from the source
   * box, which is where acting on it belongs.
   */
  const observeRemote = useCallback(async (): Promise<void> => {
    if (!state.source || !state.token || !online) return;
    try {
      const gh = new GitHub(state.token);
      const head = await gh.getBranchHead(state.source);
      const tree = await gh.listTree(state.source, head.treeSha);
      const page = tree.find((t) => t.path === state.source!.path);
      if (!page) return;
      const stored = await db.getFile(state.source.path);
      patch({ remote: { checkedAt: Date.now(), inSync: page.sha === (stored?.sha ?? '') } });
    } catch {
      // No observation is the correct outcome of a look that did not work.
    }
  }, [state.source, state.token, online, patch]);

  const checkRemote = useCallback(async (): Promise<void> => {
    if (!state.source || !state.token) return;
    if (!online) {
      patch({ sync: { kind: 'error', message: 'You are offline, so GitHub cannot be checked.' } });
      return;
    }
    patch({ sync: { kind: 'checking' }, error: null });
    try {
      const gh = new GitHub(state.token);
      const head = await gh.getBranchHead(state.source);
      const tree = await gh.listTree(state.source, head.treeSha);
      const page = tree.find((t) => t.path === state.source!.path);
      if (!page) throw new Error('The page file is gone from the repository.');

      const stored = await db.getFile(state.source.path);
      const localSha = stored?.sha ?? '';

      if (page.sha === localSha) {
        patch({ sync: { kind: 'up-to-date' }, remote: { checkedAt: Date.now(), inSync: true } });
        return;
      }
      // Observe and stop, exactly as the check on open does. Pressing the
      // button is a request to look, not a licence to overwrite: a remote that
      // has moved may be a bad deploy or a half-landed push, and nothing here
      // can tell those from a good edit made elsewhere. Recording the
      // disagreement raises the out-of-sync warning, where both ways out are
      // offered as equals.
      patch({ sync: { kind: 'idle' }, remote: { checkedAt: Date.now(), inSync: false } });
    } catch (e) {
      patch({ sync: { kind: 'error', message: (e as Error).message } });
    }
  }, [state.source, state.token, state.changes, online, patch]);

  /**
   * Fetch GitHub's version and say what differs, without touching anything.
   *
   * Deliberately separate from the cheap sha check that runs on open: this
   * pulls the whole file, so it only happens once the shas already disagree
   * and there is something to explain.
   */
  const describeDrift = useCallback(async (): Promise<Comparison | null> => {
    const s = stateRef.current;
    if (!s.source || !s.token) return null;
    const gh = new GitHub(s.source ? s.token : '');
    const head = await gh.getBranchHead(s.source);
    const tree = await gh.listTree(s.source, head.treeSha);
    const page = tree.find((t) => t.path === s.source!.path);
    if (!page) throw new Error('The page file is gone from the repository.');
    const theirs = await gh.getBlobText(s.source, page.sha);
    const mine = await db.getFile(s.source.path);
    if (!mine?.text) return null;
    return compareBundles(mine.text, theirs);
  }, []);

  /**
   * Replace the working copy with GitHub's version.
   *
   * The displaced text is preserved first — the working copy being thrown away
   * is the only copy of that work, and losing it silently is the thing this
   * whole path exists to prevent.
   */
  const applyRemote = useCallback(async (expectSha?: string) => {
    if (!state.source || !state.token) return;
    const gh = new GitHub(state.token);
    const head = await gh.getBranchHead(state.source);
    const tree = await gh.listTree(state.source, head.treeSha);
    const page = tree.find((t) => t.path === state.source!.path);
    if (!page) throw new Error('The page file is gone from the repository.');
    if (expectSha && page.sha !== expectSha) {
      throw new Error('GitHub moved again while you were deciding. Check once more.');
    }

    const previous = await db.getFile(state.source.path);
    let displaced = false;
    if (previous?.text) {
      await db.putFile({
        path: setAsideKeyFor(state.source.path, Date.now()),
        text: previous.text,
        sha: previous.sha,
      });
      displaced = true;
      // Each of these is a whole page — 2 MB on this site. Keeping every one
      // forever would grow without limit for a feature that is about the last
      // wrong move, not the whole year.
      const kept = describeSetAside(await db.allFilePaths());
      for (const old of kept.slice(SET_ASIDE_KEEP)) await db.delFile(old.key);
    }

    const text = await gh.getBlobText(state.source, page.sha);
    await db.putFile({ path: page.path, text, sha: page.sha });
    const source = { ...state.source, lastFetched: Date.now() };
    await db.setMeta('source', source);

    setState((s) => {
      const opened = openBundle(text);
      const health = opened.health && opened.targets
        ? reconcile(opened.health, s.changes, opened.targets, opened.bundle!.template)
        : opened.health;
      return {
        ...s, source, ...opened, health, localModified: false, replacedImages: [],
        // We have just written GitHub's exact blob as the working copy and
        // adopted its sha as the baseline, so this is in sync by construction.
        // Without it the header went on saying "site has changed" after the
        // user had already resolved it.
        remote: { checkedAt: Date.now(), inSync: true },
        sync: { kind: 'updated', displaced },
      };
    });
  }, [state.source, state.token]);

  /**
   * Put a set-aside copy back as the working copy.
   *
   * The baseline is deliberately left alone: this text is not a version GitHub
   * ever handed us, so restoring it puts the copy out of step again — which is
   * the truth, and what the header should say.
   */
  const restoreSetAside = useCallback(async (key: string) => {
    const s = stateRef.current;
    if (!s.source) return;
    const kept = await db.getFile(key);
    if (!kept?.text) throw new Error('That set-aside copy is no longer here.');
    const opened = openBundle(kept.text);
    if (!opened.bundle) throw new Error('That copy is not a page this editor can open.');
    const base = await db.getFile(s.source.path);
    const sha = base?.sha ?? '';
    await db.putFile({ path: s.source.path, text: kept.text, sha });
    // Derived, like everywhere else. A set-aside copy usually differs from the
    // baseline, but it does not have to — asserting that it does would be the
    // stored-flag mistake in a new place.
    const localModified = sha ? (await gitBlobSha(kept.text)) !== sha : false;
    setState((cur) => ({
      ...cur, ...opened, localModified, restored: null, replacedImages: [],
    }));
  }, []);

  const loadSetAside = useCallback(async (): Promise<SetAside[]> => {
    return describeSetAside(await db.allFilePaths());
  }, []);

  const dismissSync = useCallback(() => patch({ sync: { kind: 'idle' } }), [patch]);

  /** Record an edit. The pre-edit value is captured once and kept. */
  const edit = useCallback(
    (targetId: string, nextValue: string) => {
      setState((s) => {
        const target = s.targets?.byId.get(targetId);
        if (!target || !s.source) return s;

        const problem = validate(target.kind, nextValue);
        if (problem) return { ...s, error: problem };

        const changes = new Map(s.changes);
        const existing = changes.get(targetId);
        const liveValue = existing?.liveValue ?? target.current;

        if (nextValue === liveValue) {
          changes.delete(targetId);
          void db.delPatch(targetId);
        } else {
          const change: PendingChange = {
            targetId,
            file: s.source.path,
            label: target.label,
            tag: target.tag,
            kind: target.kind,
            liveValue,
            nextValue,
          };
          changes.set(targetId, change);
          void db.putPatch({
            ...change,
            id: targetId,
            createdAt: Date.now(),
            baseFingerprint: s.bundle ? db.fingerprint(s.bundle.template) : '',
          });
        }
        return { ...s, error: null, changes };
      });
    },
    [],
  );

  /**
   * Replace one element's entire markup.
   *
   * Not routed through `edit`, because this target does not exist until it is
   * created: element ranges are not in the target map, which holds values
   * rather than whole elements.
   *
   * The subtlety is overlap. Any queued edit inside this element addresses
   * bytes that the new markup replaces, so publishing both would either throw
   * on overlapping patches or apply them in a nonsensical order. Those edits
   * are therefore dropped — the markup the user just wrote is the more recent
   * and more specific statement of intent.
   */
  const editElementHtml = useCallback((elementId: string, nextHtml: string) => {
    setState((s) => {
      const el = s.index?.byId.get(elementId);
      if (!el || !s.source || !s.bundle) return s;

      const problem = validate('html', nextHtml);
      if (problem) return { ...s, error: problem };

      const { start, end } = outerRange(el);
      const original = s.bundle.template.slice(start, end);
      const id = `html:${elementId}`;
      const changes = new Map(s.changes);

      // Supersede anything queued inside the range being replaced.
      let superseded = 0;
      for (const [cid, c] of changes) {
        if (cid === id) continue;
        const t = s.targets?.byId.get(c.targetId);
        if (t && t.start >= start && t.end <= end) {
          changes.delete(cid);
          void db.delPatch(cid);
          superseded++;
        }
      }

      if (nextHtml === original) {
        changes.delete(id);
        void db.delPatch(id);
      } else {
        const change: PendingChange = {
          targetId: id,
          file: s.source.path,
          label: `${el.tag} · code`,
          tag: 'code',
          kind: 'html',
          liveValue: original,
          nextValue: nextHtml,
          start,
          end,
        };
        changes.set(id, change);
        void db.putPatch({
          ...change,
          id,
          createdAt: Date.now(),
          baseFingerprint: db.fingerprint(s.bundle.template),
        });
      }

      return {
        ...s,
        error: superseded
          ? `${superseded} earlier change${superseded === 1 ? '' : 's'} inside this element ` +
            'were replaced by the code you wrote.'
          : null,
        changes,
      };
    });
  }, []);

  /**
   * Swap the bytes of an embedded image.
   *
   * The exporter stores assets as base64 in a JSON manifest keyed by UUID, and
   * the page references them by that bare UUID. So a replacement is a manifest
   * write and nothing else: no markup changes, no reference rewriting, and no
   * change to the site's own source. The design brief claimed these were not
   * replaceable without a rebuild; they are.
   *
   * Kept out of the change queue deliberately. Every other edit is a byte range
   * in the template, and the queue's whole model is ranges; an asset is a value
   * in the other payload. It applies to the working copy immediately and the
   * publish pipeline serializes both payloads anyway.
   */
  const replaceImage = useCallback(async (
    uuid: string,
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ ok: boolean; message: string }> => {
    const s = stateRef.current;
    if (!s.bundle || !s.source) return { ok: false, message: 'No site is open.' };
    const entry = s.bundle.manifest[uuid];
    if (!entry) return { ok: false, message: 'That image is not in this page.' };

    const data = bytesToBase64(bytes);
    const before = imageSizeFromBase64(entry.data);
    const after = imageSizeFromBase64(data);
    if (!after) {
      return { ok: false, message: 'That file does not look like an image this page can use.' };
    }

    const manifest = { ...s.bundle.manifest, [uuid]: { ...entry, mime, data, compressed: false } };
    const nextFile = serializeBundle(s.bundle, { manifest });
    // Keep the baseline sha. This is our own unpublished work, not evidence
    // that GitHub moved — clearing it here is what made a replaced image read
    // as "the site has changed".
    const base = await db.getFile(s.source.path);
    await db.putFile({ path: s.source.path, text: nextFile, sha: base?.sha ?? '' });
    setState((cur) => {
      const replacedImages = cur.replacedImages.includes(uuid)
        ? cur.replacedImages
        : [...cur.replacedImages, uuid];
      void db.setMeta('replacedImages', replacedImages);
      return { ...cur, ...openBundle(nextFile), localModified: true, replacedImages };
    });

    const differs = before && (before.width !== after.width || before.height !== after.height);
    return {
      ok: true,
      message: differs
        ? `Replaced. The new image is ${after.width} × ${after.height}, where the old one was ` +
          `${before.width} × ${before.height} — the page may lay out differently.`
        : `Replaced with a ${after.width} × ${after.height} image.`,
    };
  }, []);

  /**
   * Set a property on one element only, leaving the shared value alone.
   *
   * This is the "just this one" half of a shared edit. It writes into the
   * element's own `style` attribute, which outranks both a stylesheet rule and
   * a theme token without touching either.
   *
   * All of an element's overrides live in a single change keyed to its style
   * attribute, because they all rewrite the same bytes — two changes over one
   * range is a collision, not two edits. Pending edits to declarations already
   * in that attribute are folded in and superseded for the same reason.
   */
  const applyOverride = useCallback((elementId: string, prop: string, value: string) => {
    setState((s) => {
      const el = s.index?.byId.get(elementId);
      if (!el || !s.source || !s.bundle) return s;

      const problem = validate('css-inline', value);
      if (problem) return { ...s, error: problem };

      const attr = el.attrs.find((a) => a.name === 'style');
      const id = `override:${elementId}`;
      const changes = new Map(s.changes);
      const existingChange = changes.get(id);

      // Start from what the attribute holds, with any queued per-declaration
      // edits already applied — otherwise adding an override would quietly
      // revert them.
      const startingList = existingChange
        ? parseDeclarations(existingChange.nextValue).map((d) => [d.prop, d.value] as const)
        : parseDeclarations(attr?.value ?? '').map((d) => {
            const declTarget = [...(s.targets?.byId.values() ?? [])].find(
              (t) => t.kind === 'css-inline' && t.elementId === elementId && t.prop === d.prop,
            );
            const pending = declTarget && changes.get(declTarget.id)?.nextValue;
            return [d.prop, pending ?? d.value] as const;
          });

      const merged = new Map(startingList);
      merged.set(prop, value);
      const nextStyle = [...merged].map(([k, v]) => `${k}:${v}`).join(';');

      // Those per-declaration edits now live inside this one.
      for (const [cid, c] of changes) {
        const t = s.targets?.byId.get(c.targetId);
        if (t?.kind === 'css-inline' && t.elementId === elementId) {
          changes.delete(cid);
          void db.delPatch(cid);
        }
      }

      const change: PendingChange = {
        targetId: id,
        file: s.source.path,
        label: `${el.tag} · ${prop} on this one only`,
        tag: prop,
        kind: 'style-attr',
        liveValue: attr?.value ?? '',
        nextValue: nextStyle,
        // No style attribute yet, so one is inserted rather than replaced.
        start: attr ? attr.valueStart : el.attrInsertAt,
        end: attr ? attr.valueEnd : el.attrInsertAt,
      };
      changes.set(id, change);
      void db.putPatch({
        ...change,
        id,
        createdAt: Date.now(),
        baseFingerprint: db.fingerprint(s.bundle.template),
      });

      return { ...s, error: null, changes };
    });
  }, []);

  const undo = useCallback((targetId: string) => {
    setState((s) => {
      const changes = new Map(s.changes);
      changes.delete(targetId);
      void db.delPatch(targetId);
      return { ...s, changes };
    });
  }, []);

  const select = useCallback((targetId: string | null, elementId: string | null) => {
    setState((s) => ({ ...s, selection: { targetId, elementId } }));
  }, []);

  /**
   * Every published version of the page, newest first.
   *
   * Read on demand rather than kept in state: it is only wanted when the
   * question is asked, and it is the one thing here that is always better
   * fetched than remembered.
   */
  const loadHistory = useCallback(async (): Promise<Version[]> => {
    const s = stateRef.current;
    if (!s.source || !s.token) return [];
    const api = new GitHub(s.token);
    const commits = await api.listCommits(s.source, s.source.path, 30);
    return describeVersions(commits, { currentSha: commits[0]?.sha ?? null });
  }, []);

  /**
   * Load an older published version back as the working copy.
   *
   * Deliberately not a publish, and deliberately not a rewrite of history: it
   * puts the old page in front of you, and publishing it afterwards moves the
   * site forward to it as a new commit. What happened stays in the record,
   * mistake included.
   */
  const restoreVersion = useCallback(async (version: Version) => {
    const s = stateRef.current;
    if (!s.source || !s.token) throw new Error('Not connected.');
    const api = new GitHub(s.token);
    const text = await api.fileAtCommit(s.source, version.sha, s.source.path);
    // Refuse to load something the editor cannot read, rather than replacing a
    // working page with one that opens to an error.
    const opened = openBundle(text);
    if (!opened.bundle) throw new Error('That version is not a page this editor can open.');
    // Baseline preserved: the site has not moved because you looked backwards.
    // `restored` does not survive a reload, so this is what keeps a restored
    // copy from reporting itself as matching the live site tomorrow.
    const base = await db.getFile(s.source.path);
    await db.putFile({ path: s.source.path, text, sha: base?.sha ?? '' });
    setState((cur) => ({
      ...cur,
      localModified: true,
      replacedImages: [],
      ...opened,
      changes: new Map(),
      selection: { targetId: null, elementId: null },
      deploy: null,
      restored: { sha: version.sha, short: version.short, when: version.when },
    }));
  }, []);

  /** Put the working copy back to what the site is serving. */
  const discardRestore = useCallback(async () => {
    const s = stateRef.current;
    if (!s.source || !s.token) return;
    const api = new GitHub(s.token);
    const head = await api.getBranchHead(s.source);
    const text = await api.fileAtCommit(s.source, head.commitSha, s.source.path);
    // Head's own bytes, so this genuinely is the baseline again.
    await db.putFile({ path: s.source.path, text, sha: await gitBlobSha(text) });
    setState((cur) => ({
      ...cur, ...openBundle(text), changes: new Map(), restored: null,
      localModified: false, replacedImages: [],
    }));
  }, []);

  /** After a successful publish the edited values become the new baseline. */
  const commitPublished = useCallback(async (_commitSha: string | null, fileText: string) => {
    await db.clearPatches();
    const now = Date.now();
    await db.setMeta('lastPush', now);
    // The blob sha, not the commit sha the push returned. The sync check
    // compares against the blob sha in GitHub's tree, so storing the commit
    // sha here made every later check report a site that had changed.
    const sha = await gitBlobSha(fileText);
    setState((s) => {
      if (s.source) void db.putFile({ path: s.source.path, text: fileText, sha });
      return {
        ...s, changes: new Map(), lastPush: now, deploy: null, restored: null,
        // We have just made the live page out of exactly these bytes, so this
        // is an observation, not an assumption.
        remote: { checkedAt: now, inSync: true },
        localModified: false,
        replacedImages: [],
        ...openBundle(fileText),
      };
    });
  }, []);

  /** Forget queued edits the page already satisfies. */
  const dropApplied = useCallback(() => {
    setState((s) => {
      if (!s.targets || !s.bundle) return s;
      const changes = new Map(s.changes);
      for (const [id, c] of changes) {
        if (alreadyApplied(c, s.targets.byId, s.bundle.template)) {
          changes.delete(id);
          void db.delPatch(id);
        }
      }
      const health = s.health ? { ...s.health, appliedChanges: 0 } : null;
      return { ...s, changes, health };
    });
  }, []);

  /** Forget queued edits that no longer point at anything in the page. */
  const dropOrphans = useCallback(() => {
    setState((s) => {
      if (!s.targets) return s;
      const changes = new Map(s.changes);
      for (const [id] of changes) {
        if (!s.targets.byId.has(id)) { changes.delete(id); void db.delPatch(id); }
      }
      const health = s.health ? { ...s.health, orphanedChanges: 0, appliedChanges: 0, exportDetected: false } : null;
      return { ...s, changes, health };
    });
  }, []);

  const setDeploy = useCallback((deploy: DeployObservation | null) => {
    setState((s) => ({ ...s, deploy }));
  }, []);

  const disconnect = useCallback(async () => {
    await db.clearPatches();
    await db.clearFiles();
    await db.delMeta('source');
    await db.clearToken();
    setState((s) => ({
      ...s,
      token: null, source: null, files: [], activeFile: null,
      bundle: null, index: null, targets: null, assets: [], health: null,
      sync: { kind: 'idle' }, deploy: null,
      changes: new Map(), selection: { targetId: null, elementId: null },
    }));
  }, []);

  /** The values shown in the editor: pending edit if any, else the live value. */
  const valueOf = useCallback(
    (s: StringEntry | EditTarget) =>
      state.changes.get(s.id)?.nextValue ?? ('value' in s ? s.value : s.current),
    [state.changes],
  );

  const changeList = useMemo(() => [...state.changes.values()], [state.changes]);

  return {
    state, online, manualOffline, setManualOffline,
    connect, checkRemote, observeRemote, applyRemote, describeDrift, dismissSync, editElementHtml, replaceImage, applyOverride,
    edit, undo, select, commitPublished, disconnect, dropOrphans, setDeploy,
    loadHistory, restoreVersion, discardRestore, dropApplied, loadSetAside, restoreSetAside,
    valueOf, changeList, patch,
  };
}

/**
 * Compare the queued edits against the page as it now stands.
 *
 * Called on open and after a fetch — the two moments when the bundle can have
 * been replaced underneath us.
 */
function reconcile(
  health: HealthState,
  changes: Map<string, PendingChange>,
  targets: TargetSet,
  template: string,
): HealthState {
  const fp = db.fingerprint(template);
  let orphaned = 0;
  let applied = 0;
  let stale = false;
  for (const c of changes.values()) {
    if (alreadyApplied(c, targets.byId, template)) { applied++; continue; }
    // Some changes carry their own range and are deliberately absent from the
    // target map — a code edit spans a whole element, a scoped override spans a
    // whole style attribute, and both would overlap every target inside them.
    // Their absence is not evidence of anything.
    const selfDescribing = c.kind === 'html' || c.kind === 'style-attr';
    if (!selfDescribing && !targets.byId.has(c.targetId)) orphaned++;
    const patch = c as Partial<db.StoredPatch>;
    if (patch.baseFingerprint && patch.baseFingerprint !== fp) stale = true;
  }
  return {
    ...health, orphanedChanges: orphaned, appliedChanges: applied,
    exportDetected: stale && orphaned > 0,
  };
}

function openBundle(
  text: string,
): Pick<EditorState, 'bundle' | 'index' | 'targets' | 'assets' | 'health'> {
  const bundle = parseBundle(text);
  const index = indexTemplate(bundle.template);
  const targets = buildTargets(bundle.template, index);
  const assets = listAssets(bundle);
  const head = verifyHeadTags(text);
  return {
    bundle,
    index,
    targets,
    assets,
    health: {
      headTagsInHead: head.ok,
      headDetail: head.detail,
      stringsIndexed: index.strings.length,
      imagesFound: assets.filter((a) => a.kind === 'image').length,
      orphanedChanges: 0,
      appliedChanges: 0,
      exportDetected: false,
    },
  };
}

/** Kept out of the hook so the preview can be rebuilt without re-rendering. */
export function useStableRef<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}
