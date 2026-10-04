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
type Delivery = "nextTurn" | "steer";

type RestoreMessage = SentMessage & { details?: unknown };

function makeHarness(opts: { isIdle?: () => boolean } = {}) {
	const sent: Array<{ message: RestoreMessage; options: { deliverAs: Delivery } }> = [];
	const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
			handlers[event] = handler;
		},
		sendMessage: (message: RestoreMessage, options: { deliverAs: Delivery }) => {
			sent.push({ message, options });
		},
	};
	const ctx = { isIdle: opts.isIdle ?? (() => true) };
	return {
		pi,
		sent,
		// Events carry (event, ctx); pass a fresh event object each time.
		fire: (event: string, eventArg: unknown = {}) => handlers[event]?.(eventArg, ctx),
	};
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
	const message = sent[0].message;
	if (message.display !== false) throw new Error("restore must be invisible");
	if (!message.content.includes("State directory: " + path.join(dir, ".vibe-wise"))) {
		throw new Error("message must point at the state directory");
	}
	if (!message.content.includes("skills/learn/SKILL.md")) {
		throw new Error("message must reference the bundled Learn guide");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("paused profile produces no restore", () => {
	const dir = tmpProject(PAUSED);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness();
	vibeWise(pi as never);
	fire("session_start");
	if (sent.length !== 0) throw new Error("expected silence");
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("invalid UTF-8 profile produces no restore (#2)", () => {
	// Upstream test: b"\xff\xfe" must not activate learning. Node string
	// decoding would substitute U+FFFD and count as content.
	const dir = tmpProject(null);
	fs.writeFileSync(path.join(dir, ".vibe-wise", "profile.md"), new Uint8Array([0xff, 0xfe]));
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness();
	vibeWise(pi as never);
	fire("session_start");
	if (sent.length !== 0) throw new Error("invalid UTF-8 must not activate learning");
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("CR-only line endings honor the paused marker (#2)", () => {
	const dir = tmpProject(null);
	fs.writeFileSync(
		path.join(dir, ".vibe-wise", "profile.md"),
		"# Learner Profile\rLearning mode: paused\rOnboarding: complete\r",
	);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness();
	vibeWise(pi as never);
	fire("session_start");
	if (sent.length !== 0) throw new Error("paused marker in CR-only file must be found");
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("legacy .sensible-vibes state is restored in place", () => {
	const dir = tmpProject(ACTIVE, true);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness();
	vibeWise(pi as never);
	fire("session_start");
	if (sent.length !== 1 || !sent[0].message.content.includes(".sensible-vibes")) {
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
	fire("session_compact", { reason: "manual", willRetry: false });
	if (sent.length !== 1) throw new Error("compaction must re-inject context");
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("mid-run compaction uses steer delivery, not nextTurn (#1)", () => {
	const dir = tmpProject(ACTIVE);
	process.chdir(dir);
	for (const [event, isIdle] of [
		[{ reason: "threshold", willRetry: false }, false],
		[{ reason: "overflow", willRetry: true }, true],
	] as const) {
		const { pi, sent, fire } = makeHarness({ isIdle: () => isIdle });
		vibeWise(pi as never);
		fire("session_compact", event);
		if (sent.length !== 1) throw new Error(`expected steer delivery for ${event.reason}`);
		if (sent[0].options.deliverAs !== "steer") {
			throw new Error(`${event.reason} compaction must use steer delivery`);
		}
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("idle manual compaction keeps nextTurn delivery (#1)", () => {
	const dir = tmpProject(ACTIVE);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness({ isIdle: () => true });
	vibeWise(pi as never);
	fire("session_compact", { reason: "manual", willRetry: false });
	if (sent.length !== 1 || sent[0].options.deliverAs !== "nextTurn") {
		throw new Error("idle manual compaction must use nextTurn");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("no duplicate restore on the compaction-at-first-prompt path (#1/S5)", () => {
	const dir = tmpProject(ACTIVE);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness({ isIdle: () => true });
	vibeWise(pi as never);
	fire("session_start"); // queues restore #1 (nextTurn)
	// prompt() checks compaction before draining pending messages and before
	// before_agent_start fires, so the pending flag must suppress a second queue.
	fire("session_compact", { reason: "threshold", willRetry: false });
	if (sent.length !== 1) {
		throw new Error(`expected 1 queued restore, got ${sent.length}`);
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

Deno.test("pending flag clears at before_agent_start so later compactions re-queue", () => {
	const dir = tmpProject(ACTIVE);
	process.chdir(dir);
	const { pi, sent, fire } = makeHarness({ isIdle: () => true });
	vibeWise(pi as never);
	fire("session_start");
	fire("before_agent_start"); // startup restore delivered with this prompt
	fire("session_compact", { reason: "manual", willRetry: false });
	if (sent.length !== 2) {
		throw new Error(`expected startup + post-delivery compaction restores, got ${sent.length}`);
	}
	fs.rmSync(dir, { recursive: true, force: true });
});
