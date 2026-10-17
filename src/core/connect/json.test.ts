import { expect, test } from "bun:test";
import { readJSON } from "./json";

test("a refused request rejects with the server's error", async () => {
	const response = Response.json(
		{ error: "Publication quota reached" },
		{ status: 429 },
	);

	await expect(readJSON(response)).rejects.toThrow("Publication quota reached");
});

test("a refusal without an error field names the status", async () => {
	const response = new Response("<html>Bad gateway</html>", { status: 502 });

	await expect(readJSON(response)).rejects.toThrow(
		"Connection directory request failed (502)",
	);
});
