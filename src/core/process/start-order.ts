/** What ordering reads off an app: a resolved one or one as written. */
interface OrderedApp {
	needsPublicUrls?: boolean;
	startAfter?: readonly string[];
}

interface SpawnOrder<TApp extends OrderedApp> {
	/** Layers spawned, and health-checked, before public tunnels open. */
	beforeTunnels: Record<string, TApp>[];
	/** Layers spawned after tunnels have published their URLs. */
	afterTunnels: Record<string, TApp>[];
}

/**
 * The order apps are spawned in.
 *
 * Two phases around the tunnel barrier: with `defer`, apps with
 * `needsPublicUrls` wait for tunnels, and so does anything that starts after
 * one of them. Within a phase, `startAfter` splits the apps into layers; each
 * layer spawns only once every earlier layer is healthy. A dependency outside
 * the set (not selected, or reused from another run) is already satisfied.
 *
 * Without `startAfter` a phase is one layer.
 */
export function planSpawnOrder<TApp extends OrderedApp>(
	apps: Record<string, TApp>,
	defer: boolean,
): SpawnOrder<TApp> {
	const late = new Set<string>(
		defer
			? Object.entries(apps)
					.filter(([, app]) => app.needsPublicUrls)
					.map(([name]) => name)
			: [],
	);
	// Anything that starts after a late app is late too, transitively.
	for (let changed = late.size > 0; changed;) {
		changed = false;
		for (const [name, app] of Object.entries(apps)) {
			if (late.has(name)) continue;
			if (app.startAfter?.some((dependency) => late.has(dependency))) {
				late.add(name);
				changed = true;
			}
		}
	}

	const pick = (inLate: boolean): Record<string, TApp> =>
		Object.fromEntries(
			Object.entries(apps).filter(([name]) => late.has(name) === inLate),
		);
	return {
		beforeTunnels: layers(pick(false)),
		afterTunnels: layers(pick(true)),
	};
}

/** Kahn's algorithm over `startAfter`, restricted to the apps given. */
function layers<TApp extends OrderedApp>(
	apps: Record<string, TApp>,
): Record<string, TApp>[] {
	const remaining = new Map(Object.entries(apps));
	const result: Record<string, TApp>[] = [];

	while (remaining.size > 0) {
		const ready = [...remaining].filter(([, app]) =>
			(app.startAfter ?? []).every((dependency) => !remaining.has(dependency)),
		);
		if (ready.length === 0) {
			// Validation rejects cycles; reaching here means a caller skipped it.
			throw new Error(
				`Circular startAfter dependency among: ${[...remaining.keys()].join(", ")}`,
			);
		}
		for (const [name] of ready) remaining.delete(name);
		result.push(Object.fromEntries(ready));
	}
	return result;
}
