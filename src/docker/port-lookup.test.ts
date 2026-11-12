import { describe, expect, it } from "bun:test";
import { parseDockerPublishedPort } from "./port-lookup";

describe("parseDockerPublishedPort", () => {
	it("matches published TCP ports from docker ps", () => {
		expect(parseDockerPublishedPort("0.0.0.0:5532->5432/tcp", 5532)).toBe(true);
		expect(parseDockerPublishedPort("0.0.0.0:5532->5432/tcp", 5432)).toBe(
			false,
		);
	});
});
