import { expect, it } from "bun:test";
import { preferredAppUrl } from "./app-url";

it("prefers a public URL, then the named host only while hosts are active", () => {
	const app = {
		url: "https://api.app.localhost",
		loopbackUrl: "http://localhost:3000",
	};
	expect(preferredAppUrl(app, true)).toBe("https://api.app.localhost");
	expect(preferredAppUrl(app, false)).toBe("http://localhost:3000");
	expect(
		preferredAppUrl({ ...app, publicUrl: "https://x.trycloudflare.com" }, true),
	).toBe("https://x.trycloudflare.com");
	expect(preferredAppUrl({}, true)).toBeUndefined();
});

it("opens an app at its entryPath, without touching its origin", () => {
	expect(
		preferredAppUrl(
			{ loopbackUrl: "http://localhost:3000", entryPath: "/app/" },
			false,
		),
	).toBe("http://localhost:3000/app/");
	expect(
		preferredAppUrl(
			{ url: "https://web.app.localhost/", entryPath: "/app/" },
			true,
		),
	).toBe("https://web.app.localhost/app/");
});
