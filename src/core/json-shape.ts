/**
 * Type guards for JSON state files, composed so a file's TypeScript type is
 * inferred from the one value that validates it (`Guarded<typeof isEntry>`).
 *
 * Hand-written guards next to hand-written interfaces drifted: `runs.json`'s
 * guard never checked fields BuncargoBar requires. A schema library would do,
 * but every config load and state read pays for its import, and these files
 * need only objects, arrays and a few refinements over hanzio's guards
 * (`isString`, `isBoolean`, `isOneOf`).
 *
 * Objects ignore keys they do not name, so a field a newer buncargo adds
 * costs an older reader nothing.
 */

import { isRecord } from "hanzio";

export type Guard<T> = (value: unknown) => value is T;
export type Guarded<G> = G extends Guard<infer T> ? T : never;

/** A property an object may leave out, from {@link optional}. */
interface OptionalGuard<T> {
	readonly optional: Guard<T>;
}

type PropertyGuard = Guard<unknown> | OptionalGuard<unknown>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type ShapeOf<P extends Record<string, PropertyGuard>> = Simplify<
	{
		[K in keyof P as P[K] extends Guard<unknown> ? K : never]: Guarded<P[K]>;
	} & {
		[
			K in keyof P as P[K] extends OptionalGuard<unknown> ? K : never
		]?: P[K] extends OptionalGuard<infer T> ? T : never;
	}
>;

/** A finite number. */
export const isFiniteNumber: Guard<number> = (value): value is number =>
	typeof value === "number" && Number.isFinite(value);

export const isPositiveInteger: Guard<number> = (value): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;

export const isPort: Guard<number> = (value): value is number =>
	isPositiveInteger(value) && value <= 65535;

export function optional<T>(guard: Guard<T>): OptionalGuard<T> {
	return { optional: guard };
}

export function nullable<T>(guard: Guard<T>): Guard<T | null> {
	return (value): value is T | null => value === null || guard(value);
}

export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
	return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

export function recordOf<T>(guard: Guard<T>): Guard<Record<string, T>> {
	return (value): value is Record<string, T> =>
		isRecord(value) && Object.values(value).every(guard);
}

export function oneOf<const G extends readonly Guard<unknown>[]>(
	...guards: G
): Guard<Guarded<G[number]>> {
	return (value): value is Guarded<G[number]> =>
		guards.some((guard) => guard(value));
}

/** `guard`, narrowed by a rule its shape cannot state. */
export function refine<T>(
	guard: Guard<T>,
	rule: (value: T) => boolean,
): Guard<T> {
	return (value): value is T => guard(value) && rule(value);
}

/**
 * An object with these properties. An optional property may be absent or
 * `undefined`; any other key is allowed and ignored.
 */
export function object<P extends Record<string, PropertyGuard>>(
	properties: P,
): Guard<ShapeOf<P>> {
	const entries = Object.entries(properties);
	return (value): value is ShapeOf<P> =>
		isRecord(value) &&
		entries.every(([key, property]) => {
			if (typeof property === "function") return property(value[key]);
			return value[key] === undefined || property.optional(value[key]);
		});
}
