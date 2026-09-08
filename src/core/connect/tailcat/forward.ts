import { connectorEndpoint, validPort } from "../protocol";
import { startTailcat } from "./process";
/** Fresh client keys avoid DERP identity collisions between simultaneous forwards. */
export async function tailcatForward(endpoint: string, port: number) {
	connectorEndpoint(endpoint);
	if (!validPort(port)) throw new Error("Invalid Tailcat target port");
	const child = await startTailcat(
		["--key=new", "forward", endpoint, `0:${port}`],
		(line) => {
			const match = line.match(/forwarding 127\.0\.0\.1:(\d+) -> remote /);
			return match ? Number(match[1]) : undefined;
		},
	);
	return { port: child.value, exited: child.exited, close: child.close };
}
