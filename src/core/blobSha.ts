/**
 * Git's own name for a file's contents.
 *
 * The working copy records the sha GitHub gave it, and the sync check compares
 * that against the sha in the tree. Those are both *blob* shas on the fetch
 * path — but a publish only learns the *commit* sha, and storing that made the
 * two permanently unequal. The result was an app that, from its first publish
 * onward, would have reported the site as changed every time it looked.
 *
 * Computing it here rather than asking GitHub keeps the check offline and free,
 * and removes the asymmetry between fetching and publishing at the source.
 *
 * The formula is git's: sha1 of the bytes `blob <byte length>\0<contents>`.
 * Byte length, not character count — a multi-byte character would otherwise
 * produce a plausible, wrong answer.
 */
export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header, 0);
  bytes.set(body, header.length);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
