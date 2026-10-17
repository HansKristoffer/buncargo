import { relative } from "node:path";
import { appendToGitignore, isGitIgnored } from "../core/gitignore";
import { lookupOnPath } from "../core/tool-binary";
import type { SetupCheck } from "../types";
import {
	firebaseVersion,
	isFirebaseInstalled,
	isTestedFirebaseVersion,
	resolveFirebaseBin,
} from "./cli";
import type { FirebaseEmulator } from "./emulators";
import type { FirebaseProject } from "./project";

/** The emulators `firebase-tools` runs on the JVM. */
const JAVA_EMULATORS: readonly FirebaseEmulator[] = [
	"firestore",
	"database",
	"storage",
];

export function firebaseChecks(state: {
	project: (root: string) => FirebaseProject;
	workdir: (root: string) => string;
	emulators: (root: string) => readonly FirebaseEmulator[];
	/** The data directory, relative to the root; undefined without persistence. */
	dataDir: (root: string) => string | undefined;
}): SetupCheck[] {
	return [
		{
			name: "Firebase CLI is installed",
			check: ({ root }) => isFirebaseInstalled(root, state.workdir(root)),
			fix: "bun add -d firebase-tools",
		},
		{
			name: "firebase.json exists",
			check: ({ root }) => {
				const project = state.project(root);
				if (project.error) {
					return {
						ok: false,
						detail: `${relative(root, project.path)}: ${project.error}`,
					};
				}
				if (!project.exists) {
					return {
						ok: false,
						detail: `No ${relative(root, project.path)}; run \`firebase init emulators\``,
					};
				}
				return (
					state.emulators(root).length > 0 || {
						ok: false,
						detail: `${relative(root, project.path)} configures no emulator; run \`firebase init emulators\``,
					}
				);
			},
		},
		{
			// The CLI checks the version itself, with a clear message; this only
			// catches the missing binary before anything starts.
			name: "Java is installed for the Firebase emulators",
			check: ({ root }) =>
				!state.emulators(root).some((name) => JAVA_EMULATORS.includes(name)) ||
				lookupOnPath("java") !== undefined || {
					ok: false,
					detail:
						"Firestore, Realtime Database and Storage emulators need a JDK 21 or newer on PATH",
				},
		},
		{
			name: "Firebase emulator data is gitignored",
			severity: "warning",
			fast: false,
			check: ({ root }) => {
				const dir = state.dataDir(root);
				if (!dir) return true;
				return (
					isGitIgnored(root, dir) || {
						ok: false,
						detail: `${dir} is not gitignored`,
					}
				);
			},
			fix: ({ root }) => {
				const dir = state.dataDir(root);
				if (dir) appendToGitignore(root, [`/${dir}`]);
			},
			fixDescription: "add it to .gitignore",
		},
		{
			name: "Firebase CLI version is tested",
			fast: false,
			severity: "warning",
			check: ({ root }) => {
				const version = firebaseVersion(
					resolveFirebaseBin(root, state.workdir(root)),
					root,
				);
				if (!version)
					return { ok: false, detail: "`firebase --version` failed" };
				return (
					isTestedFirebaseVersion(version) || {
						ok: false,
						detail: `Firebase CLI ${version} is outside the tested 13.x–15.x range`,
					}
				);
			},
		},
	];
}
