/** TablePlus connection URL. Do not set `schema` with `name` — that pair is the table-filter deeplink. */
export function tablePlusUrl(input: {
	user: string;
	password: string;
	port: number;
	database: string;
	name: string;
}): string {
	const url = new URL("postgresql://127.0.0.1");
	url.port = String(input.port);
	url.username = input.user;
	url.password = input.password;
	url.pathname = `/${encodeURIComponent(input.database)}`;
	url.search = [
		["env", "development"],
		["name", input.name],
		["tLSMode", "0"],
	]
		.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
		.join("&");
	return url.toString();
}
