/** What ordering reads off an app: a resolved one or one as written. */
interface OrderedApp {
	needsPublicUrls?: boolean;
	startAfter?: readonly string[];
}

interface SpawnOrder<TApp extends OrderedApp> {
	/** Layers that must be ready before the `barrierApps` task runs (e.g. `seed.afterApps`). */
	beforeBarrier: Record<string, TApp>[];
	/** Layers spawned, and health-checked, before public tunnels open. */
	beforeTunnels: Record<string, TApp>[];
	/** Layers spawned after tunnels have published their URLs. */
	afterTunnels: Record<string, TApp>[];
}

/**
 * The order apps are spawned in.
 *
 * When `barrierApps` is given (e.g. `seed.afterApps` with `beforeApps !== false`),
 * those apps and their transitive `startAfter` prerequisites form `beforeBarrier`
 * so the caller can run the barrier task before remaining apps start.
 *
 * Two phases around the tunnel barrier: with `defer`, apps with
 * `needsPublicUrls` wait for tunnels, and so does anything that starts after
 * one of them. Within each phase, `startAfter` splits the apps into layers;
 * each layer spawns only once every earlier layer is healthy. A dependency
 * outside the set (not selected, or reused from another run) is already
 * satisfied.
 *
 * Without `startAfter` or `barrierApps`, a phase is one layer.
 */
export function planSpawnOrder<TApp extends OrderedApp>(
	apps: Record<string, TApp>,
	defer: boolean,
	barrierApps?: readonly string[],
): SpawnOrder<TApp> {
	const late = new Set<string>(
		defer
			? Object.entries(apps)
					.filter(([, app]) => app.needsPublicUrls)
					.map(([name]) => name)
			: [],
	);
	// Anything that starts after a late app is late too, transitively.
	let changed = late.size > 0;
	while (changed) {
		changed = false;
		for (const [name, app] of Object.entries(apps)) {
			if (late.has(name)) continue;
			if (app.startAfter?.some((dependency) => late.has(dependency))) {
				late.add(name);
				changed = true;
			}
		}
	}

	// Barrier prerequisites: every named barrier app in `apps` plus anything
	// they `startAfter` (transitively), so the barrier never waits on an app
	// sitting in a later phase.
	for (const name of barrierApps ?? []) {
		if (name in apps && late.has(name)) {
			// Validation rejects this; reaching here means a caller skipped it.
			throw new Error(
				`Barrier app "${name}" waits for public URLs (needsPublicUrls) and cannot run before wave 1`,
			);
		}
	}
	const preBarrier = new Set<string>(
		(barrierApps ?? []).filter((name) => name in apps),
	);
	let addedPrereq = preBarrier.size > 0;
	while (addedPrereq) {
		addedPrereq = false;
		for (const name of [...preBarrier]) {
			for (const dep of apps[name]?.startAfter ?? []) {
				if (dep in apps && !preBarrier.has(dep)) {
					if (late.has(dep)) {
						throw new Error(
							`Barrier app "${name}" starts after "${dep}", which waits for public URLs (needsPublicUrls)`,
						);
					}
					preBarrier.add(dep);
					addedPrereq = true;
				}
			}
		}
	}

	const pick = (predicate: (name: string) => boolean): Record<string, TApp> =>
		Object.fromEntries(
			Object.entries(apps).filter(([name]) => predicate(name)),
		);

	return {
		beforeBarrier: layers(pick((name) => preBarrier.has(name))),
		beforeTunnels: layers(
			pick((name) => !preBarrier.has(name) && !late.has(name)),
		),
		afterTunnels: layers(pick((name) => late.has(name))),
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
