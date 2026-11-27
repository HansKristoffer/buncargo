/**
 * Quote one shell word, leaving words that need none as they are. A leaf, so
 * the menu bar installer and integrations can take it without the utils graph.
 */
export function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Split a command line into words the way a shell would.
 *
 * Honors single/double quotes and backslash escapes so commands like
 * `sh -c "echo hi"` or `PAGER="less -R +G"` preserve grouped arguments.
 */
export function splitCommandLine(value: string): string[] {
	const words: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;

	for (let i = 0; i < value.length; i++) {
		const char = value[i] as string;

		if (quote === "'") {
			// Single quotes are literal: even a backslash carries no meaning.
			if (char === "'") {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "\\") {
			const next = value[i + 1];
			// A trailing backslash has nothing to escape, so it stays literal.
			if (next === undefined) {
				current += char;
				continue;
			}
			// Inside double quotes a backslash only escapes these four.
			if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) {
				current += char;
				continue;
			}
			current += next;
			started = true;
			i++;
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			// An empty "" is still a word, so remember we opened one.
			started = true;
			continue;
		}

		if (/\s/.test(char)) {
			if (started || current) {
				words.push(current);
				current = "";
				started = false;
			}
			continue;
		}

		current += char;
		started = true;
	}

	if (started || current) words.push(current);

	return words;
}
