/**
 * CLI status output.
 *
 * One place for the prefixes and stream choice so command handlers stop
 * hand-writing emoji. The rich environment banner stays in
 * `src/environment/logging.ts`; this is only for CLI-level status and errors.
 */

/** Plain line, no prefix — used for report bodies and key/value listings. */
export function line(message = ""): void {
	console.log(message);
}

export function info(message: string): void {
	console.log(message);
}

export function success(message: string): void {
	console.log(`✅ ${message}`);
}

/** Completed step, one notch quieter than {@link success}. */
export function done(message: string): void {
	console.log(`✓ ${message}`);
}

export function warn(message: string): void {
	console.warn(`⚠ ${message}`);
}

export function error(message: string): void {
	console.error(`❌ ${message}`);
}

/** Indented continuation under an {@link error} or {@link warn}. */
export function hint(message: string): void {
	console.error(`   ${message}`);
}

/** Report a message and exit; nothing is torn down. */
export function fail(message: string, hints: string[] = []): never {
	error(message);
	for (const item of hints) {
		hint(item);
	}
	process.exit(1);
}
