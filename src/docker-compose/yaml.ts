import { isRecord } from "hanzio";
import type { DockerComposeNode } from "../types";
import type { ComposeDocument } from "./model";

function formatScalar(value: string | number | boolean | null): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	return String(value);
}

function formatKey(key: string): string {
	return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

function sortNode(node: DockerComposeNode): DockerComposeNode {
	if (Array.isArray(node)) {
		return node.map(sortNode);
	}
	if (isRecord(node)) {
		const sorted: Record<string, DockerComposeNode | undefined> = {};
		for (const key of Object.keys(node).sort()) {
			const value = node[key];
			if (value !== undefined) {
				sorted[key] = sortNode(value);
			}
		}
		return sorted;
	}
	return node;
}

function stringifyNode(node: DockerComposeNode, indent = 0): string {
	const prefix = " ".repeat(indent);

	if (
		typeof node === "string" ||
		typeof node === "number" ||
		typeof node === "boolean" ||
		node === null
	) {
		return `${prefix}${formatScalar(node)}`;
	}

	if (Array.isArray(node)) {
		if (node.length === 0) return `${prefix}[]`;
		return node
			.map((item) => {
				const isNested = typeof item === "object" && item !== null;
				if (!isNested) {
					return `${prefix}- ${formatScalar(
						item as string | number | boolean | null,
					)}`;
				}
				return `${prefix}-\n${stringifyNode(item, indent + 2)}`;
			})
			.join("\n");
	}

	const entries = Object.entries(node).filter(
		([, value]) => value !== undefined,
	) as Array<[string, DockerComposeNode]>;
	if (entries.length === 0) return `${prefix}{}`;

	return entries
		.map(([key, value]) => {
			const formattedKey = formatKey(key);
			const isNested = typeof value === "object" && value !== null;
			if (!isNested) {
				return `${prefix}${formattedKey}: ${formatScalar(
					value as string | number | boolean | null,
				)}`;
			}
			return `${prefix}${formattedKey}:\n${stringifyNode(value, indent + 2)}`;
		})
		.join("\n");
}

export function composeToYaml(document: ComposeDocument): string {
	const sorted = sortNode(document as DockerComposeNode);
	return `${stringifyNode(sorted)}\n`;
}
