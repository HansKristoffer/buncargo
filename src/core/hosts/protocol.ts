/**
 * What the CLI and the root daemon agree on.
 *
 * The daemon is one machine-wide process, and every project on the machine
 * talks to it from whatever buncargo version it pins. Comparing versions made
 * each of two projects on different releases see the other's install as stale:
 * every interactive run asked for a password, and accepting downgraded the
 * daemon under the other project, dropping every proxied websocket on the
 * machine. A protocol number moves only when the CLI starts to rely on
 * something an older daemon cannot do.
 */

/**
 * The protocol this source speaks: what the daemon built from it reports in
 * its health body, and what `hosts install` records in the manifest.
 *
 * 2: health carries `protocol` and answers `?refresh` after a reload.
 */
export const HOSTS_PROTOCOL = 2;

/**
 * The oldest daemon this CLI can work with. Below it the daemon is stale and
 * `buncargo hosts install` updates it; at or above it, newer included, it is
 * left alone.
 */
export const MIN_HOSTS_PROTOCOL = 2;

/** The daemon binds these and nothing else. */
export const HOSTS_HTTPS_PORT = 443;
export const HOSTS_HTTP_PORT = 80;
