/** Numeric diagnostics only: never commands, environment values, or credentials. */
type Observer = (name: string, amount: number) => void;
const observers = new Set<Observer>();
export function recordStartupMetric(name: string, amount = 1): void {
	for (const observer of observers) observer(name, amount);
}
export function observeStartupMetrics(observer: Observer): () => void {
	observers.add(observer);
	return () => {
		observers.delete(observer);
	};
}
