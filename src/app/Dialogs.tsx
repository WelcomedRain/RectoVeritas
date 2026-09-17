import { useState } from 'react';
import type { PendingChange, Step } from '../core/publish';
import type { Destination, DestinationId } from '../core/destination';
import { canRestore, type Version, type SetAside } from '../core/history';
import type { SyncState } from './store';
import { syncMessage } from './status';
import type { Comparison } from '../core/compare';
import type { SiteState } from './status';

/** Mirrors the store's retention. Shown so the promise here is the real one. */
const SET_ASIDE_KEEP = 5;
import type { DeployObservation } from '../core/deploy';

function Backdrop({ children, onClose, width, tight }: {
  children: React.ReactNode; onClose: () => void; width: number; tight?: boolean;
}) {
  return (
    <div className="backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`dialog ${tight ? 'tight' : ''}`}
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}


/* ------------------------------ Source ------------------------------- */

export function SourceDialog({
  dirty, site, onRefetch, onDisconnect, onClose,
}: {
  /**
   * The same four states the header shows, not a bare in-sync boolean.
   *
   * Reading `inSync` alone made this box say "This copy matches the site"
   * while the header said "edits pending" two inches above it. Both were true
   * of different things — the baseline did match GitHub, and the edits were
   * unpublished — but a reader has no way to know the box is talking about the
   * version this copy came from rather than about what they are looking at.
   */
  site: SiteState;
  /** Queued edits. The only thing here that cannot be got back. */
  dirty: number;
  onRefetch: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  /**
   * "Change Site" is the intended act — swap which site this app is bound to,
   * and swap back later — but the mechanism is destructive: it clears the
   * patches, the files, the source and the token, with no way back. Everything
   * except the queued edits is recoverable from GitHub, which is exactly why
   * the queued edits are the number this step says out loud. They were never
   * committed, so no commit can return them.
   */
  const [confirming, setConfirming] = useState(false);

  return (
    <Backdrop onClose={onClose} width={430} tight>
      <div className="stack">
        {/* The heading, the paragraph explaining copy-to-GitHub-to-live, and the
            three-column Working copy / GitHub / Live site block all came out.
            They described a process rather than offering an action, and the one
            fact they carried that is worth having — whether this copy is still
            the site — is answered in the header and the footer, continuously,
            without opening anything. What is left is the two things this box
            can actually do. */}
        <div>
          <h2>Site Management</h2>
          <p style={{ marginTop: 6 }}>
            {site === 'match' && 'This copy matches the site.'}
            {site === 'pending' && (dirty > 0
              ? `This copy came from the current version on GitHub. ${dirty} `
                + `edit${dirty === 1 ? '' : 's'} ${dirty === 1 ? 'is' : 'are'} not published yet.`
              : 'This copy came from the current version on GitHub, and has unpublished changes.')}
            {site === 'behind' && 'The site has changed since this copy was opened.'}
            {site === 'unchecked' && 'This copy has not been checked against the site.'}
          </p>
        </div>

        {confirming ? (
          <>
            <div className="banner-err">
              <b>Disconnecting clears this site from this device.</b>
              <div style={{ marginTop: 6 }}>
                {dirty > 0
                  ? `${dirty} queued edit${dirty === 1 ? '' : 's'} `
                    + `${dirty === 1 ? 'has' : 'have'} never been published. `
                    + `${dirty === 1 ? 'It exists' : 'They exist'} only in this browser and `
                    + `cannot be recovered afterwards.`
                  : 'Nothing is queued, so no unpublished work is at risk.'}
              </div>
              <div style={{ marginTop: 6 }}>
                Your access token is cleared and you will need to paste it again. The working
                copy is fetched fresh from GitHub, and published versions stay in the
                repository either way.
              </div>
            </div>
            <div className="actions">
              <button className="btn btn-primary" onClick={onDisconnect}>
                {dirty > 0
                  ? `Discard ${dirty} edit${dirty === 1 ? '' : 's'} and disconnect`
                  : 'Disconnect this site'}
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <div className="actions">
            <button className="btn btn-primary" onClick={onRefetch}>Check Sync</button>
            <button className="btn" onClick={() => setConfirming(true)}>Change Site</button>
            <button className="btn btn-ghost" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </Backdrop>
  );
}

/* ------------------------------ Connect ------------------------------ */

export function ConnectDialog({
  onConnect, error, busy,
}: {
  onConnect: (v: { repo: string; branch: string; token: string }) => void;
  error: string | null;
  busy: boolean;
}) {
  // Empty, not prefilled. A default here is one person's repository shown to
  // everyone else as though it were theirs, and it is the first thing the app
  // ever says.
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');

  return (
    <div className="backdrop">
      <div className="dialog" style={{ maxWidth: 620 }}>
        <div className="stack">
          <div>
            <h2>Connect your site</h2>
            <p style={{ marginTop: 6 }}>
              RectoVeritas keeps a complete copy on this device so you can work with no connection,
              and publishes when you ask it to.
            </p>
          </div>

          {error && <div className="banner-err">{error}</div>}

          <div className="numbered">
            <span className="n">01</span>
            <div className="stack" style={{ gap: 7, flex: 1 }}>
              <div style={{ fontSize: 15, fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Which repository</div>
              <p style={{ fontSize: 13 }}>The GitHub repository that holds your site.</p>
              <input className="input mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
            </div>
          </div>

          <div className="numbered">
            <span className="n">02</span>
            <div className="stack" style={{ gap: 7, flex: 1 }}>
              <div style={{ fontSize: 15, fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Which branch</div>
              <p style={{ fontSize: 13 }}>The branch GitHub Pages builds from.</p>
              <input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </div>
          </div>

          <div className="numbered">
            <span className="n">03</span>
            <div className="stack" style={{ gap: 7, flex: 1 }}>
              <div style={{ fontSize: 15, fontFamily: 'var(--font-heading)', fontWeight: 800 }}>A GitHub token</div>
              <p style={{ fontSize: 13 }}>
                A fine-grained personal access token with <b>Contents: read and write</b> on this
                repository — nothing else. It is stored on this device only and sent to GitHub alone.
                Make one at github.com → Settings → Developer settings → Personal access tokens →
                Fine-grained tokens.
              </p>
              <input
                className="input mono"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_…"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="actions">
            <button
              className="btn btn-primary"
              disabled={busy || !repo.trim() || !token.trim()}
              onClick={() => onConnect({ repo, branch, token })}
            >
              {busy ? 'Fetching…' : 'Open my site'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Sync -------------------------------- */

/**
 * The outcome of a look at GitHub, when there is an outcome worth reporting.
 *
 * It used to own the disagreement case too — "GitHub has changed, and so have
 * you", offering two shas and a choice. That moved to `DriftDialog`, which
 * offers the same two choices and can also say what actually differs, and it
 * is now raised by the observation itself rather than by whoever happened to
 * press a button. There is deliberately still no "merge": the page is one
 * compiled file whose byte offsets shift wholesale on every export, so a
 * three-way merge would be guesswork dressed up as a feature.
 */
export function SyncDialog({
  sync, onClose,
}: {
  sync: SyncState;
  onClose: () => void;
}) {
  if (sync.kind === 'idle' || sync.kind === 'checking') return null;


  const body = syncMessage(sync);

  return (
    <Backdrop onClose={onClose} width={460}>
      <div className="stack">
        <h2>{sync.kind === 'error' ? 'Could not check GitHub' : 'Up to date'}</h2>
        {sync.kind === 'error' ? <div className="banner-err">{body}</div> : <p>{body}</p>}
        <div className="actions">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Backdrop>
  );
}

/* ------------------------------ Publish ------------------------------ */

export function PublishDialog({
  phase, changes, steps, outcome, error, online, deploy,
  destinations, dest, onDest, everPublishedLive, images, unlisted, onPublish, onClose,
}: {
  phase: 'review' | 'running' | 'done';
  changes: PendingChange[];
  steps: Step[];
  outcome: 'pushed' | 'queued' | 'failed' | null;
  error: string | null;
  online: boolean;
  deploy: DeployObservation | null;
  destinations: Record<DestinationId, Destination> | null;
  dest: DestinationId;
  onDest: (d: DestinationId) => void;
  everPublishedLive: boolean;
  /**
   * The working copy differs from its baseline in a way that has no entry in
   * `changes` — a replaced image writes straight into the file, and so does a
   * restored version. Publishing carries it either way, so a dialog that
   * counted only the listed changes would say "0 changes will go to…" and then
   * ship one.
   */
  unlisted: boolean;
  /** Images replaced since the last sync. Counted, because the app knows. */
  images: number;
  onPublish: () => void;
  onClose: () => void;
}) {
  const target = destinations?.[dest] ?? null;
  // Which step stopped decides what can honestly be said about the site.
  const failedAtPush = steps.some((s) => s.state === 'failed' && s.id === 'pushed');

  return (
    <Backdrop onClose={phase === 'running' ? () => {} : onClose} width={560}>
      {phase === 'review' && (
        <div className="stack">
          <div>
            <h2>Publish your changes</h2>
            {/* Each kind named and counted separately, rather than one total that
                would have to explain itself. An image replacement is a change
                like any other to the person who made it; it is only unusual in
                here, where it has no before-and-after to show. */}
            <p style={{ marginTop: 6 }}>
              {[
                changes.length > 0
                  ? `${changes.length} change${changes.length === 1 ? '' : 's'}`
                  : null,
                images > 0 ? `${images} replaced image${images === 1 ? '' : 's'}` : null,
                unlisted && images === 0 ? 'a version loaded back' : null,
              ].filter(Boolean).join(' and ') || 'Nothing'}
              {target ? <> will go to <b>{target.url}</b></> : ' will be published'}.
            </p>
          </div>

          {/* Chosen here, at the moment of publishing, because this is the only
              screen where the difference between the two has consequences. */}
          {destinations && (
            <div className="dest">
              {(['preview', 'live'] as DestinationId[]).map((id) => (
                <button
                  key={id}
                  className={`dest-opt ${dest === id ? 'on' : ''}`}
                  onClick={() => onDest(id)}
                >
                  <span className="dest-name">
                    {id === 'preview' ? 'Preview' : 'Publish live'}
                    {id === 'preview' && !everPublishedLive && <em> · suggested</em>}
                  </span>
                  <span className="dest-url">{destinations[id].url}</span>
                </button>
              ))}
            </div>
          )}

          {!everPublishedLive && dest === 'live' && (
            <div className="banner-err">
              Nothing has ever been published from this editor, so the publish path
              itself is untested. If something is wrong with it, the homepage is a
              costly place to find out. Preview first is the cheaper order.
            </div>
          )}

          {/* Said before the button is pressed, so it has to be the truth about
              what the button will do — this is where the expectation is set. */}
          {!online && (
            <div className="banner-err">
              You are offline, so nothing can be sent. RectoVeritas will still write and
              check the whole page, which tells you it would publish cleanly — then your
              changes stay here, waiting, until you publish again with a connection.
            </div>
          )}

          <div className="stack" style={{ gap: 10 }}>
            {changes.map((c) => (
              <div className="change" key={c.targetId}>
                <div className="head">
                  <span className="label">{c.label}</span>
                  <span className="mono" style={{ fontSize: 11, marginLeft: 'auto', color: 'var(--color-neutral-700)' }}>{c.file}</span>
                </div>
                {/* Labelled, like the out-of-sync rows. Two values with nothing
                    naming them left the reader to remember which edit this was. */}
                <div className="from"><span className="side">Now</span>{c.liveValue || '(empty)'}</div>
                <div className="to"><span className="side">Will be</span>{c.nextValue || '(empty)'}</div>
              </div>
            ))}
          </div>

          {unlisted && (
            <div className="change">
              <div className="head">
                <span className="label">
                  {images > 0
                    ? `${images} replaced image${images === 1 ? '' : 's'}`
                    : 'A version loaded back'}
                </span>
              </div>
              <div className="from" style={{ background: 'transparent', padding: '2px 0' }}>
                {images > 0
                  ? 'Written straight into the page file rather than queued as an edit, '
                    + 'so there is no before-and-after to show here. It publishes with the rest.'
                  : 'The page file was replaced wholesale, so there are no individual edits '
                    + 'to list. It publishes with the rest.'}
              </div>
            </div>
          )}

          <div className="actions">
            {/* The button names its target. The selector above it already did,
                but the destination resets to Preview every time this dialog
                opens — it stands down only after a live publish has succeeded,
                which cannot happen while it is being missed. A whole evening
                went to publishing at Preview while checking the live page, with
                nothing on the button that was pressed to say so. */}
            <button
              className="btn btn-primary"
              disabled={phase !== 'review'}
              onClick={onPublish}
            >
              {target ? `Publish to ${target.label}` : 'Publish'}
            </button>
            <button className="btn btn-ghost" onClick={onClose}>Not yet</button>
          </div>
        </div>
      )}

      {phase !== 'review' && (
        <div className="stack">
          <h2>
            {phase === 'running' ? 'Publishing'
              : outcome === 'failed' ? 'Nothing was published'
              : outcome === 'queued' ? 'Checked — not sent'
              : target && !target.isLive ? 'Published to the preview'
              : 'Published to the live site'}
          </h2>

          <div>
            {steps.map((s) => (
              <div className={`step ${s.state}`} key={s.id}>
                <span className="mark" />
                <span className="txt">{s.label}</span>
                <span className="note">{s.note}</span>
              </div>
            ))}
          </div>

          {phase === 'done' && outcome === 'failed' && (
            <div className="banner-err">
              {error}
              {/* "Nothing reached the live site" is only knowable when the run
                  stopped before anything was sent. Sending is four calls —
                  blob, tree, commit, then moving the branch — and an exception
                  does not say which of them happened. Claiming nothing shipped
                  from a local throw is the same class of lie as claiming a save
                  that never happened, and it is worse here because it leaves
                  the queue looking unpublished when the site may already have
                  the change. */}
              <div style={{ marginTop: 6 }}>
                {failedAtPush
                  ? 'Your edits are still queued. This failed while sending, so whether '
                    + 'anything reached GitHub is not known from here — press Check Sync '
                    + 'to find out before publishing again.'
                  : 'Your edits are safe and still queued. Nothing was sent, so the live '
                    + 'site is untouched.'}
              </div>
            </div>
          )}

          {phase === 'done' && outcome === 'pushed' && (
            <div className="stack" style={{ gap: 8 }}>
              {/* The push and the deployment are separate facts. Saying the site
                  is live before observing it is the same lie as claiming a save
                  that never happened. One line, from one source: `detail` knows
                  which page was checked, so nothing here needs to guess and
                  nothing restates it. */}
              <div className={`step ${deploy?.state === 'verified' ? 'done' : 'active'}`}>
                <span className="mark" />
                <span className="txt">
                  {deploy?.detail ?? 'The commit is on GitHub. Watching for the rebuild.'}
                </span>
              </div>

              {/* Answers the question the badge raises. It still reads 1 because
                  the edit really is still unpublished — the live page has not
                  changed — and that is the point of staging, not a stuck count. */}
              {target && !target.isLive && (
                <p style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                  Your live site has not changed, so your edits stay queued — the
                  count in the corner is still counting them. Publish again and
                  choose <b>Publish live</b> when you want them on the real site.
                </p>
              )}
            </div>
          )}
          {phase === 'done' && outcome === 'queued' && (
            <p>
              Everything is written and checked, so it would publish cleanly — but
              nothing has been sent, because there is no connection. Your changes are
              still waiting. Press Publish again once you are back online.
            </p>
          )}

          {phase === 'done' && (
            <div className="actions">
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          )}
        </div>
      )}
    </Backdrop>
  );
}

/**
 * Every published version, and the way back to one.
 *
 * The safety of a separate dev site was never really about a second site — it
 * was that GitHub keeps every version and makes it easy to revert. It does, and
 * this editor has never shown one of them, so that safety was only available to
 * someone willing to open a terminal.
 *
 * Going back is not a rewrite. It loads the old page as the working copy; you
 * look at it, and publishing moves the site forward to it as a new commit. The
 * record of what happened stays true, including the mistake.
 */
export function HistoryDialog({
  versions, setAside, loading, error, queued, busySha, onRestore, onRestoreSetAside, onClose,
}: {
  versions: Version[];
  /** Working copies set aside when GitHub's version was taken instead. */
  setAside: SetAside[];
  loading: boolean;
  error: string | null;
  queued: number;
  busySha: string | null;
  onRestore: (v: Version) => void;
  onRestoreSetAside: (s: SetAside) => void;
  onClose: () => void;
}) {
  return (
    <Backdrop onClose={onClose} width={600}>
      <div className="stack">
        <div>
          <h2>Everything you have published</h2>
          <p style={{ marginTop: 6 }}>
            Going back loads that version here so you can look at it. Nothing
            reaches the site until you publish, and publishing adds a new
            version rather than erasing this one.
          </p>
        </div>

        {loading && <div className="label">Reading the history…</div>}
        {error && <div className="banner-err">{error}</div>}

        {!loading && !error && versions.length === 0 && (
          <div className="empty">No published versions yet.</div>
        )}

        {versions.map((v) => {
          const allowed = canRestore(v, queued);
          return (
            <div className={`ver ${v.current ? 'on' : ''}`} key={v.sha}>
              <div className="ver-main">
                <div className="ver-msg">{v.message}</div>
                <div className="ver-meta">
                  <span>{v.ago}</span>
                  <span className="mono">{v.short}</span>
                  {v.current && <span className="ver-tag">serving now</span>}
                  {v.preview && <span className="ver-tag">preview only</span>}
                  {!v.fromEditor && <span className="ver-tag dim">not from this editor</span>}
                </div>
              </div>
              <button
                className="btn"
                disabled={!allowed.ok || busySha != null}
                title={allowed.ok ? undefined : allowed.why}
                onClick={() => onRestore(v)}
              >
                {busySha === v.sha ? 'Loading…' : 'Go back to this'}
              </button>
            </div>
          );
        })}

        {setAside.length > 0 && (
          <>
            <div style={{ marginTop: 4 }}>
              <h2 style={{ fontSize: 15 }}>Set aside on this computer</h2>
              <p style={{ marginTop: 4, fontSize: 13 }}>
                Each time you chose the site&rsquo;s version over your own, the copy you
                had was kept here rather than discarded. These were never published, so
                they exist only in this browser. The most recent {SET_ASIDE_KEEP} are kept.
              </p>
            </div>
            {setAside.map((v) => (
              <div className="ver" key={v.key}>
                <div className="ver-main">
                  <div className="ver-msg">Your copy before the overwrite</div>
                  <div className="ver-meta">
                    <span>{v.ago}</span>
                    <span className="ver-tag dim">on this computer only</span>
                  </div>
                </div>
                <button
                  className="btn"
                  disabled={queued > 0 || busySha != null}
                  title={queued > 0
                    ? 'Publish or undo the queued changes first — this would replace the page they are edits to.'
                    : undefined}
                  onClick={() => onRestoreSetAside(v)}
                >
                  {busySha === v.key ? 'Loading…' : 'Go back to this'}
                </button>
              </div>
            ))}
          </>
        )}

        {queued > 0 && (
          <div className="banner-err">
            You have {queued} change{queued === 1 ? '' : 's'} waiting. Publish or undo
            them first — going back would replace the page they are edits to.
          </div>
        )}

        <div className="actions">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Backdrop>
  );
}

/* ------------------------- Site has changed ------------------------- */

/**
 * Raised when GitHub and the working copy do not match.
 *
 * Says nothing about why. The app cannot tell an edit made elsewhere from a
 * half-landed push from a bad deploy, and naming a cause it has not
 * established would be a guess wearing the clothes of a diagnosis.
 *
 * Deliberately not a fetch-and-replace. A remote that has moved is not
 * automatically the better version: a bad deploy, a half-landed push, or an
 * edit made from somewhere else all look identical from here, and only the
 * person reading it knows which. So the two ways out are stated as equals and
 * neither happens on its own.
 */
export function DriftDialog({
  dirty, comparison, loading, error, busy, onTakeTheirs, onKeepMine, onClose,
}: {
  dirty: number;
  comparison: Comparison | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onTakeTheirs: () => void;
  onKeepMine: () => void;
  onClose: () => void;
}) {
  const diffs = comparison?.differences ?? [];
  const shown = diffs.slice(0, 12);
  const images = comparison
    ? comparison.imagesChanged + comparison.imagesOnlyMine + comparison.imagesOnlyTheirs
    : 0;

  return (
    <Backdrop onClose={onClose} width={640}>
      <div className="stack">
        <div>
          <h2>Out-of-sync warning</h2>
          <p style={{ marginTop: 6 }}>
            The GitHub site does not match the local IndexedDB site in RectoVeritas.
            No change has been made to the local file
            {dirty > 0
              ? ` and the ${dirty} unpublished edit${dirty === 1 ? '' : 's'} `
                + `${dirty === 1 ? 'is' : 'are'} still present.`
              : '.'}
          </p>
        </div>

        {loading && <p className="label">Reading the version on GitHub…</p>}
        {error && <div className="banner-err">{error}</div>}

        {comparison && (
          <div className="drift">
            {diffs.length === 0 && images === 0 && (
              <p className="empty">
                The two versions read the same to the editor, so the difference is
                somewhere it does not index — whitespace, ordering, or the build itself.
              </p>
            )}

            {shown.map((d, i) => (
              <div className="drift-row" key={`${d.tag}-${i}`}>
                <div className="drift-head">
                  <span className="drift-tag">{d.tag}</span>
                  <span className="drift-label">{d.label}</span>
                </div>
                {/* Every row says which side it is. Colour alone did not: it
                    encoded the answer without stating it, so the one question
                    the dialog exists to answer — which of these two am I
                    keeping — had to be inferred. The words match the buttons
                    below verbatim. */}
                {d.kind === 'changed' && (
                  <>
                    <div className="drift-mine">
                      <span className="drift-side">My copy</span>{d.mine}
                    </div>
                    <div className="drift-theirs">
                      <span className="drift-side">The site</span>{d.theirs}
                    </div>
                  </>
                )}
                {d.kind === 'only-mine' && (
                  <div className="drift-mine">
                    <span className="drift-side">My copy only</span>{d.mine}
                  </div>
                )}
                {d.kind === 'only-theirs' && (
                  <div className="drift-theirs">
                    <span className="drift-side">The site only</span>{d.theirs}
                  </div>
                )}
              </div>
            ))}

            {diffs.length > shown.length && (
              <p className="label">and {diffs.length - shown.length} more</p>
            )}
            {images > 0 && (
              <p className="label">
                {comparison.imagesChanged > 0 && `${comparison.imagesChanged} image(s) differ. `}
                {comparison.imagesOnlyMine > 0 && `${comparison.imagesOnlyMine} only in your copy. `}
                {comparison.imagesOnlyTheirs > 0 && `${comparison.imagesOnlyTheirs} only on the site.`}
              </p>
            )}
          </div>
        )}

        <div className="banner-err">
          <div>
            Using the site&rsquo;s version will overwrite RectoVeritas&rsquo; locally stored
            version. The copy being replaced is kept, and History can put it back.
          </div>
          {/* Written out whole rather than assembled from word-level ternaries.
              The first attempt produced "any that still point at something, they
              stay ready to publish", which is what stitching a sentence together
              from conditionals tends to produce. */}
          {dirty === 1 && (
            <div style={{ marginTop: 6 }}>
              Your unpublished edit is not discarded. It is re-checked against the incoming
              page: if it still points at something it stays ready to publish, and if it
              does not it is listed as having nowhere to go, for you to keep or forget.
            </div>
          )}
          {dirty > 1 && (
            <div style={{ marginTop: 6 }}>
              Your {dirty} unpublished edits are not discarded. They are re-checked against
              the incoming page: any that still point at something stay ready to publish,
              and any that do not are listed as having nowhere to go, for you to keep or
              forget.
            </div>
          )}
        </div>

        <div className="actions">
          <button className="btn btn-primary" onClick={onKeepMine} disabled={busy}>
            Keep my copy
          </button>
          <button className="btn" onClick={onTakeTheirs} disabled={busy}>
            {busy ? 'Replacing…' : 'Use the site’s version'}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
