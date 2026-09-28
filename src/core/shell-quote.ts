/**
 * Quote one shell word, leaving words that need none as they are. A leaf, so
 * the menu bar installer and integrations can take it without the utils graph.
 */
export function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, `'\\''`)}'`;
}
