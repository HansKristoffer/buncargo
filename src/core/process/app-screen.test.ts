import { describe, expect, it } from "bun:test";
import { AppScreen } from "./app-screen";

async function feed(screen: AppScreen, ...chunks: string[]): Promise<void> {
	for (const chunk of chunks) {
		await new Promise<void>((resolve) => screen.term.write(chunk, resolve));
		screen.write("");
	}
	await new Promise<void>((resolve) => screen.term.write("", resolve));
}

describe("AppScreen", () => {
	it("emits ordinary lines as soon as the cursor leaves them", async () => {
		const lines: string[] = [];
		const screen = new AppScreen(40, 5, (line) => lines.push(line));
		await feed(screen, "one\r\ntwo\r\n");
		expect(lines).toEqual(["one", "two"]);
		screen.dispose();
	});

	it("holds a redrawing footer back and feeds the log lines printed above it", async () => {
		const lines: string[] = [];
		const screen = new AppScreen(40, 10, (line) => lines.push(line));
		// Ink-style: a footer drawn, then erased (cursor up) and redrawn under a new log line.
		const footer = (n: number) => `status ${n}\r\nkeys: p q`;
		const erase = "\u001b[2K\u001b[1A\u001b[2K\u001b[G";
		await feed(screen, footer(1));
		await feed(screen, erase, "log line A\r\n", footer(2));
		await feed(screen, erase, "log line B\r\n", footer(3));
		await feed(screen, erase, footer(4));
		await feed(screen, erase, footer(5));
		// The first frame cannot be told from plain lines yet (the documented ceiling).
		expect(lines).toEqual(["status 1", "log line A", "log line B"]);
		screen.flush();
		await feed(screen);
		expect(lines).toEqual([
			"status 1",
			"log line A",
			"log line B",
			"status 5",
			"keys: p q",
		]);
		screen.dispose();
	});

	it("keeps the alternate screen out of the feed until the app exits in it", async () => {
		const lines: string[] = [];
		const screen = new AppScreen(40, 5, (line) => lines.push(line));
		await feed(
			screen,
			"before\r\n",
			"\u001b[?1049h\u001b[Hfull screen\r\nmore",
		);
		expect(lines).toEqual(["before"]);
		screen.flush();
		await feed(screen);
		expect(lines).toEqual(["before", "full screen", "more"]);
		screen.dispose();
	});

	it("feeds every line of an app that scrolls, and recovers after a clear screen", async () => {
		const lines: string[] = [];
		const screen = new AppScreen(40, 5, (line) => lines.push(line));
		const many = Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`);
		await feed(screen, ...many);
		expect(lines).toEqual(many.map((line) => line.trim()));
		await feed(
			screen,
			"\u001b[2J\u001b[H",
			"ready\r\n",
			"a\r\n",
			"b\r\n",
			"c\r\n",
		);
		expect(lines.slice(30)).toEqual(["ready", "a", "b", "c"]);
		screen.dispose();
	});

	it("joins a wrapped line back into one", async () => {
		const lines: string[] = [];
		const screen = new AppScreen(10, 5, (line) => lines.push(line));
		await feed(screen, "0123456789abcdef\r\n");
		expect(lines).toEqual(["0123456789abcdef"]);
		screen.dispose();
	});
});
