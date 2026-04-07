const root = document.querySelector("#app");
if (!root) {
	throw new Error("missing #app");
}

const apiBase = import.meta.env.VITE_API_URL;
root.textContent = "Loading…";

fetch(`${apiBase}/api/hello`)
	.then((r) => r.json())
	.then((data: unknown) => {
		root.textContent = JSON.stringify(data, null, 2);
	})
	.catch((err: unknown) => {
		root.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
	});
