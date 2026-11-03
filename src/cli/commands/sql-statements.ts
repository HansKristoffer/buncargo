/**
 * How `buncargo sql --json` decides whether a Postgres query can be wrapped in
 * `json_agg`. Only one row-returning statement can: an UPDATE or a second
 * statement inside the subquery is a syntax error that quotes the wrapper.
 * When the text cannot be read with certainty, it runs plain.
 */

interface ScannedStatement {
	text: string;
	/** Words outside strings, quoted identifiers and comments, lowercased. */
	words: string[];
}

interface ScannedSql {
	/** Statements with something besides whitespace and comments in them. */
	statements: ScannedStatement[];
	/** An unterminated string or comment, or a psql meta-command. */
	unsure: boolean;
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** The end of a quoted run starting at `start` (its opening quote), or -1. */
function quoteEnd(
	text: string,
	start: number,
	quote: "'" | '"',
	backslashEscapes: boolean,
): number {
	for (let i = start + 1; i < text.length; i++) {
		const char = text[i];
		if (backslashEscapes && char === "\\") {
			i++;
			continue;
		}
		if (char !== quote) continue;
		if (text[i + 1] !== quote) return i + 1;
		i++;
	}
	return -1;
}

/** The end of a nested block comment starting at `start`, or -1. */
function blockCommentEnd(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length - 1; i++) {
		const pair = text.slice(i, i + 2);
		if (pair === "/*") {
			depth++;
			i++;
		} else if (pair === "*/") {
			depth--;
			i++;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/** Split SQL into top-level statements, skipping strings and comments. */
export function scanSql(text: string): ScannedSql {
	const statements: ScannedStatement[] = [];
	let start = 0;
	let words: string[] = [];
	let significant = false;
	let unsure = false;

	const endStatement = (end: number) => {
		if (significant) statements.push({ text: text.slice(start, end), words });
		start = end + 1;
		words = [];
		significant = false;
	};

	let i = 0;
	while (i < text.length && !unsure) {
		const char = text[i] as string;
		const previous = i > 0 ? text[i - 1] : "";
		const afterIdentifier = previous !== "" && WORD_PART.test(previous);

		if (char === ";") {
			endStatement(i);
			i++;
			continue;
		}
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		if (text.startsWith("--", i)) {
			const newline = text.indexOf("\n", i);
			i = newline < 0 ? text.length : newline + 1;
			continue;
		}
		if (text.startsWith("/*", i)) {
			const end = blockCommentEnd(text, i);
			unsure = end < 0;
			i = end;
			continue;
		}

		significant = true;
		if (char === "\\") {
			unsure = true;
			continue;
		}
		if (char === "'" || char === '"') {
			// E'...' takes backslash escapes; the E is already a word, harmlessly.
			const escapes =
				char === "'" &&
				(previous === "E" || previous === "e") &&
				!(i > 1 && WORD_PART.test(text[i - 2] as string));
			const end = quoteEnd(text, i, char, escapes);
			unsure = end < 0;
			i = end;
			continue;
		}
		const tag =
			char === "$" && !afterIdentifier && DOLLAR_TAG.exec(text.slice(i));
		if (tag) {
			const close = text.indexOf(tag[0], i + tag[0].length);
			unsure = close < 0;
			i = close + tag[0].length;
			continue;
		}
		if (WORD_START.test(char) && !afterIdentifier) {
			let end = i + 1;
			while (end < text.length && WORD_PART.test(text[end] as string)) end++;
			words.push(text.slice(i, end).toLowerCase());
			i = end;
			continue;
		}
		i++;
	}
	if (!unsure) endStatement(text.length);
	return { statements, unsure };
}

/** Words that make a SELECT or WITH unfit for a subquery, or change data. */
const UNWRAPPABLE_WORDS = new Set([
	"insert",
	"update",
	"delete",
	"merge",
	"into",
	"copy",
]);

export type JsonQueryPlan =
	{ wrap: true; statement: string } | { wrap: false; reason: string };

/** The alias the rows are aggregated under; `alias.*` is always the whole row. */
const ROWS_ALIAS = "_buncargo_rows";

/**
 * Whether `--json` can wrap this query, and the wrapped statement if so.
 *
 * The user's text sits on lines of its own, so a trailing `-- comment` cannot
 * swallow the closing parenthesis and an error's `LINE n:` quotes the user's
 * own line ({@link unwrapJsonErrors} corrects the number).
 */
export function planJsonQuery(text: string): JsonQueryPlan {
	const scanned = scanSql(text);
	if (scanned.unsure)
		return {
			wrap: false,
			reason: "has a psql meta-command or an unclosed quote or comment",
		};
	const [statement, ...rest] = scanned.statements;
	if (!statement) return { wrap: false, reason: "has no statement" };
	if (rest.length > 0)
		return { wrap: false, reason: "has more than one statement" };

	const [first] = statement.words;
	const rowsOnly = !statement.words.some((word) => UNWRAPPABLE_WORDS.has(word));
	if ((first !== "select" && first !== "with") || !rowsOnly)
		return { wrap: false, reason: "is not a SELECT or WITH, or changes data" };

	const body = statement.text.trimEnd();
	return {
		wrap: true,
		statement: `select coalesce(json_agg(${ROWS_ALIAS}.*), '[]'::json) from (\n${body}\n) ${ROWS_ALIAS}`,
	};
}

/**
 * Whether the `LINE` at `index` belongs to a query a function ran: psql
 * prints that query as `QUERY:` in the same error, and its lines are its own.
 */
function quotesInnerQuery(lines: readonly string[], index: number): boolean {
	for (const line of lines.slice(index + 1)) {
		if (line.startsWith("ERROR:")) return false;
		if (line.startsWith("QUERY:")) return true;
	}
	return false;
}

/**
 * psql's error output for a wrapped query, numbered as the user wrote it.
 *
 * The wrapper's first line shifts every `LINE n:` by one; the caret line
 * below it is indented by that prefix, so it shrinks when the number does.
 */
export function unwrapJsonErrors(stderr: string): string {
	const lines = stderr.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const match = /^LINE (\d+):/.exec(lines[index] as string);
		if (!match || quotesInnerQuery(lines, index)) continue;
		const wrapped = Number(match[1]);
		const own = String(wrapped - 1);
		const shrink = String(wrapped).length - own.length;
		lines[index] =
			`LINE ${own}:${(lines[index] as string).slice(match[0].length)}`;
		const caret = lines[index + 1];
		if (shrink > 0 && caret?.startsWith(" ".repeat(shrink)))
			lines[index + 1] = caret.slice(shrink);
	}
	return lines.join("\n");
}
