import { readFile } from "node:fs/promises";
import { withFileLock } from "../file-lock";
import { writeJsonDocument } from "../registry-file";
import { connectionDirectory } from "../runtime-flags";
import { stateFilePath } from "../state-paths";
import { DirectoryClient } from "./client";
import {
	directoryOrigin,
	identifier,
	makeSecret,
	object,
	SECRET,
} from "./protocol";
export interface Device {
	version: 1;
	recipientId: string;
	owner: string;
	token: string;
	directory: string;
	cli: { program: string; script: string };
	pendingToken?: string;
	pendingRevokeAll?: boolean;
}
export const devicePath = () => stateFilePath("connect-device.json");
export async function readDevice(): Promise<Device | undefined> {
	let input: string;
	try {
		input = await readFile(devicePath(), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	const v = object(JSON.parse(input));
	const cli = object(v.cli);
	if (
		v.version !== 1 ||
		!identifier(v.recipientId) ||
		!SECRET.test(String(v.owner)) ||
		!SECRET.test(String(v.token)) ||
		typeof v.directory !== "string" ||
		typeof cli.program !== "string" ||
		typeof cli.script !== "string" ||
		(v.pendingToken !== undefined && !SECRET.test(String(v.pendingToken)))
	)
		throw new Error("Invalid local connection identity");
	directoryOrigin(v.directory);
	return v as unknown as Device;
}
export function deviceClient(device: Device): DirectoryClient {
	return new DirectoryClient(device.directory);
}
export async function setupDevice(): Promise<Device> {
	return withFileLock(devicePath(), async () => {
		let device = await readDevice();
		if (!device) {
			const origin = connectionDirectory();
			if (!origin)
				throw new Error(
					"Set BUNCARGO_CONNECT_DIRECTORY to the deployed directory HTTPS origin before creating a connection token",
				);
			device = {
				version: 1,
				recipientId: crypto.randomUUID(),
				owner: makeSecret(),
				token: makeSecret(),
				directory: directoryOrigin(origin),
				cli: { program: process.execPath, script: process.argv[1] },
			};
			// Persist before registration: retries use the same identity after interruption.
			await writeJsonDocument(devicePath(), device);
		}
		await deviceClient(device).create(
			device.recipientId,
			device.owner,
			device.token,
		);
		if (device.pendingToken)
			await finishRotation(device, device.pendingRevokeAll === true);
		device.cli = { program: process.execPath, script: process.argv[1] };
		await writeJsonDocument(devicePath(), device);
		return device;
	});
}
export function copiedToken(device: Device): string {
	return `bc1.${device.recipientId}.${device.token}`;
}
async function finishRotation(device: Device, revokeAll: boolean) {
	const token = device.pendingToken as string;
	await deviceClient(device).call(
		`/v1/devices/${device.recipientId}/rotate`,
		device.owner,
		"POST",
		{ token, revokeAll },
	);
	device.token = token;
	delete device.pendingToken;
	delete device.pendingRevokeAll;
	await writeJsonDocument(devicePath(), device);
}
export async function rotateDevice(revokeAll = false): Promise<Device> {
	return withFileLock(devicePath(), async () => {
		const device = await readDevice();
		if (!device) throw new Error("Create a connection token first");
		device.pendingToken ??= makeSecret();
		device.pendingRevokeAll = device.pendingRevokeAll || revokeAll;
		await writeJsonDocument(devicePath(), device);
		await finishRotation(device, device.pendingRevokeAll === true);
		return device;
	});
}
