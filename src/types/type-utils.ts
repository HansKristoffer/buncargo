export type ConcreteStringKeys<T> = string extends keyof T
	? never
	: Extract<keyof T, string>;
