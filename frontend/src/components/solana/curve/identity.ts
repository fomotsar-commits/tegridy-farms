import type { Read } from '../../../lib/launcher/solana/curve';
import type { MetadataApi, MetadataRead, TokenMetadata } from './ports';

// Pure checks on what a launch says about itself. Shared by the list rows and the
// launch page so the two can never disagree about a warning.
//
// Every string checked here was written by whoever made the launch, possibly on
// another site, possibly to pass for a coin people already know. The reserved-name
// and lookalike rules therefore run on READ, not only when this site uploads.

/** The warnings for a launch's on-chain metadata and its linked details file. */
export function identityWarnings(meta: MetadataApi, md: Read<TokenMetadata> | null, json: MetadataRead | null): string[] {
  const out: string[] = [];
  if (md?.kind === 'absent') out.push('No name or symbol on chain. It was made outside this site, or without details.');
  if (md?.kind === 'unreadable' || md?.kind === 'undecodable') out.push('Its name and symbol could not be read.');
  if (md?.kind === 'ok') {
    const copying = meta.impersonationWarning({ name: md.value.name, symbol: md.value.symbol });
    if (copying) out.push(copying);
    else {
      if (!meta.checkSymbol(md.value.symbol).ok) {
        out.push('The symbol uses characters or a length this site does not allow. It may be copying another token.');
      }
      if (!meta.checkName(md.value.name).ok) {
        out.push('The name has hidden or unusual characters. It may be copying another token.');
      }
    }
    if (md.value.isMutable) out.push('Details can change: its creator can still edit the name, symbol and picture.');
  }
  if (json?.kind === 'ok') {
    // A file that names ANOTHER token is the copy signal. A file that names no token
    // at all is what every pasted link looks like (the token's address does not exist
    // until the launch is prepared), so it gets a plain note, not the accusation.
    if (json.json.mint !== null && !json.mintMatches) {
      out.push('Copied details: the linked details file was made for a different token.');
    } else if (json.json.mint === null) {
      out.push('The linked details file does not say which token it belongs to.');
    }
    for (const issue of json.issues) out.push(issue);
  }
  if (json?.kind === 'invalid') out.push('The details link does not hold valid token details.');
  return out;
}

/** The picture, only from the two content-addressed hosts. Re-checked here even though the reader checks it. */
export function safeImageUrl(meta: MetadataApi, json: MetadataRead | null): string | null {
  if (json?.kind !== 'ok' || typeof json.json.image !== 'string') return null;
  const c = meta.checkContentUri(json.json.image);
  return c.ok ? c.value : null;
}
