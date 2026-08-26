/**
 * Primitive `process.argv` helpers shared by every buncargo command.
 */

export function splitCliArgs(args: string[]): {
	flags: string[];
	passthrough: string[];
} {
	const separator = args.indexOf("--");
	if (separator === -1) {
		return { flags: args, passthrough: [] };
	}
	return {
		flags: args.slice(0, separator),
		passthrough: args.slice(separator + 1),
	};
}

export function hasFlag(args: string[], flag: string): boolean {
	return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function getFlagValue(args: string[], flag: string): string | undefined {
	const prefixed = args.find((arg) => arg.startsWith(`${flag}=`));
	if (prefixed) {
		return prefixed.split("=")[1];
	}

	const index = args.indexOf(flag);
	if (index !== -1 && index + 1 < args.length) {
		const nextArg = args[index + 1];
		if (nextArg !== undefined && !nextArg.startsWith("-")) {
			return nextArg;
		}
	}

	return undefined;
}
