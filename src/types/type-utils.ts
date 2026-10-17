/**
 * Object keys that are not a wide `string` index (`Record<string, …>`).
 * Used so empty-app configs and open records do not unlock every `*_URL`.
 */
export type ConcreteStringKeys<T> = string extends keyof T
	? never
	: Extract<keyof T, string>;
