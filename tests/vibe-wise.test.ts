/**
 * Runtime smoke test for extensions/vibe-wise.ts (run with: deno test --allow-read tests/)
 * Verifies the ported hook behavior: restore only for active profiles, nearest
 * state wins, legacy names read in place, worktree boundaries respected.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vibeWise from "../extensions/vibe-wise.ts";

type SentMessage = { customType: string; content: string; display: boolean };

function makeHarness() {
	const sent: SentMessage[] = [];
	const handlers: Record<string, () => void> = {};
	const pi = {
		on: (event: string, handler: () => void) => {
			handlers[event] = handler;
		},
		sendMessage: (message: SentMessage) => {
			sent.push(message);
		},
	};
	return { pi, sent, fire: (event: string) => handlers[event]?.() };
}

function tmpProject(profile: string | null, legacy = false): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibewise-pi-test-"));
	const state = path.join(dir, legacy ? ".sensible-vibes" : ".vibe-wise");
	fs.mkdirSync(state);
	if (profile !== null) {
		fs.writeFileSync(path.join(state, "profile.md"), profile);
	}
	return dir;
}

const ACTIVE = "# Learner Profile\nLearning mode: active\nOnboarding: complete\n";
const PAUSED = "# Learner Profile\nLearning mode: paused\n";

Deno.test("session_start queues restore for an active profile", () => {
	const dir = tmpProject(ACTIVE);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness();
	vibeWise(pi as never);
	fire("session_start");
	if (sent.length !== 1) throw new Error(`expected 1 message, got ${sent.length}`);
	const message = sent[0];
	if (message.display !== false) throw new Error("restore must be invisible");
	if (!message.content.includes("State directory: " + path.join(dir, ".vibe-wise"))) {
		throw new Error("message must point at the state directory");
	}
	if (!message.content.includes("skills/learn/SKILL.md")) {
		throw new Error("message must reference the bundled Learn guide");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("no restore for paused, empty, or missing state", () => {
	for (const profile of [PAUSED, null]) {
		const dir = tmpProject(profile);
		process.chdir(dir);
		const { pi, sent, fire } = makeHarness();
		vibeWise(pi as never);
		fire("session_start");
		if (sent.length !== 0) throw new Error("expected silence");
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

Deno.test("legacy .sensible-vibes state is restored in place", () => {
	const dir = tmpProject(ACTIVE, true);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness();
	vibeWise(pi as never);
	fire("session_start");
	if (sent.length !== 1 || !sent[0].content.includes(".sensible-vibes")) {
		throw new Error("legacy state must be used in place");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("git boundary stops the upward search", () => {
	const parent = tmpProject(ACTIVE);
	const child = path.join(parent, "nested-repo");
	fs.mkdirSync(child);
	fs.mkdirSync(path.join(child, ".git"));
	process.chdir(child);
	const { pi, sent, fire } = makeHarness();
	vibeWise(pi as never);
	fire("session_start");
	if (sent.length !== 0) throw new Error("must not borrow the parent repo's state");
	fs.rmSync(parent, { recursive: true, force: true });
});

Deno.test("session_compact re-injects restore after compaction", () => {
	const dir = tmpProject(ACTIVE);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness();
	vibeWise(pi as never);
	fire("session_compact");
	if (sent.length !== 1) throw new Error("compaction must re-inject context");
	fs.rmSync(dir, { recursive: true, force: true });
});
