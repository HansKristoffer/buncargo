import { describe, expect, it } from "bun:test";
import { DotenvMergeError, mergeDotenv } from "./dotenv-merge";

const base = `# Database
DATABASE_URL=postgres://base
API_KEY=base-key
# Removed on one side
OLD=1
`;

describe("mergeDotenv", () => {
	it("takes each side's own changes and keeps the checkout's layout", () => {
		const checkout = `# Database
DATABASE_URL=postgres://mine
API_KEY=base-key
OLD=1
LOCAL_ONLY=yes # mine
`;
		const store = `# Database
DATABASE_URL=postgres://base
API_KEY=new-key
# Stripe
STRIPE_KEY="sk_test"
`;

		expect(mergeDotenv(base, checkout, store)).toEqual({
			conflicts: [],
			text: `# Database
DATABASE_URL=postgres://mine
API_KEY=new-key
# Stripe
STRIPE_KEY="sk_test"
LOCAL_ONLY=yes # mine
`,
		});
	});

	it("reports keys changed on both sides by name, and resolves them per key", () => {
		const checkout = "A=mine\nB=mine\nC=same\n";
		const store = "A=theirs\nB=theirs\nC=same\n";
		const result = mergeDotenv("A=1\nB=1\nC=1\n", checkout, store);
		expect(result).toEqual({ conflicts: ["A", "B"] });
		expect(JSON.stringify(result)).not.toContain("mine");

		expect(
			mergeDotenv(
				"A=1\nB=1\nC=1\n",
				checkout,
				store,
				new Map([
					["A", "store"],
					["B", "checkout"],
				]),
			).text,
		).toBe("A=theirs\nB=mine\nC=same\n");
	});

	it("without a base, adds what is missing on either side and conflicts on the rest", () => {
		const result = mergeDotenv("", "A=1\nB=mine\n", "B=theirs\nC=3");
		expect(result).toEqual({ conflicts: ["B"] });
		expect(
			mergeDotenv(
				"",
				"A=1\nB=mine\n",
				"B=theirs\nC=3",
				new Map([["B", "checkout"]]),
			).text,
		).toBe("A=1\nB=mine\nC=3");
	});

	it("carries multiline and quoted values whole", () => {
		const key = 'KEY="-----BEGIN\nline\n-----END"\n';
		const result = mergeDotenv(
			"A=1\nKEY=old\n",
			"A=2\nKEY=old\n",
			`A=1\n${key}`,
		);
		expect(result.text).toBe(`A=2\n${key}`);
	});

	it("deletes a key the store removed and keeps one the checkout removed", () => {
		expect(mergeDotenv("A=1\nB=2\n", "A=1\nB=2\n", "B=2\n").text).toBe("B=2\n");
		expect(mergeDotenv("A=1\nB=2\n", "B=2\n", "A=1\nB=2\n").text).toBe("B=2\n");
	});

	it("refuses files that are not dotenv, without quoting them", () => {
		expect(() => mergeDotenv("", '{"token": "hunter2"}\n', "A=1\n")).toThrow(
			DotenvMergeError,
		);
		try {
			mergeDotenv("", '{"token": "hunter2"}\n', "A=1\n");
		} catch (error) {
			expect(String(error)).not.toContain("hunter2");
		}
		expect(() => mergeDotenv("", "A=1\nA=2\n", "A=1\n")).toThrow(
			"sets A more than once",
		);
	});
});
