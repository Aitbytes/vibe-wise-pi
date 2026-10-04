/**
 * Behavior tests for extensions/vibe-wise.ts
 * (run with: deno test --allow-read --allow-write --allow-env tests/)
 *
 * Ports the scenario matrix from upstream test_session_start.py against the
 * real extension module: active/paused/empty/invalid profiles, legacy state,
 * worktree boundaries (both .git dir and .git file), symlink handling,
 * nearest-state precedence, nested-cwd search, delivery modes, and dedupe.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vibeWise, { stateDirectory } from "../extensions/vibe-wise.ts";

type RestoreMessage = { customType: string; content: string; display: boolean };
type Delivery = "nextTurn" | "steer";

/** Mock ExtensionAPI capturing sendMessage calls; fire() invokes handlers with (event, ctx). */
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
		fire: (event: string, eventArg: unknown = {}) => handlers[event]?.(eventArg, ctx),
	};
}

const ACTIVE = "# Learner Profile\nLearning mode: active\nOnboarding: complete\n";
const PAUSED = "# Learner Profile\nLearning mode: paused\n";

interface Project {
	dir: string;
	state: string;
	/** chdir into the project, run assertions, always restore cwd and clean up. */
	run(fn: (harness: ReturnType<typeof makeHarness>) => void, harnessOpts?: { isIdle?: () => boolean }): void;
}

/** Create a temp project with a .vibe-wise (or legacy .sensible-vibes) state dir. */
function project(
	setup?: (dir: string, state: string) => void,
	opts: { legacy?: boolean; withState?: boolean } = {},
): Project {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibewise-pi-test-"));
	const state = path.join(dir, opts.legacy ? ".sensible-vibes" : ".vibe-wise");
	if (opts.withState !== false) fs.mkdirSync(state);
	setup?.(dir, state);
	return {
		dir,
		state,
		run(fn, harnessOpts) {
			const previous = process.cwd();
			process.chdir(dir);
			try {
				const harness = makeHarness(harnessOpts);
				vibeWise(harness.pi as never);
				fn(harness);
			} finally {
				process.chdir(previous);
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

function writeProfile(state: string, content: string | Uint8Array) {
	fs.writeFileSync(path.join(state, "profile.md"), content);
}

function assertSilence(harness: ReturnType<typeof makeHarness>, why: string) {
	if (harness.sent.length !== 0) throw new Error(`expected silence: ${why}`);
}

Deno.test("session_start queues an invisible restore for an active profile", () => {
	const p = project((_, state) => writeProfile(state, ACTIVE));
	p.run((h) => {
		h.fire("session_start");
		if (h.sent.length !== 1) throw new Error(`expected 1 message, got ${h.sent.length}`);
		const message = h.sent[0].message;
		if (h.sent[0].options.deliverAs !== "nextTurn") throw new Error("must queue as nextTurn");
		if (message.display !== false) throw new Error("restore must be invisible");
		if (!message.content.includes("State directory: " + p.state)) {
			throw new Error("message must point at the state directory");
		}
		if (!message.content.includes("skills/learn/SKILL.md")) {
			throw new Error("message must reference the bundled Learn guide");
		}
	});
});

Deno.test("paused profile produces no restore", () => {
	const p = project((_, state) => writeProfile(state, PAUSED));
	p.run((h) => {
		h.fire("session_start");
		assertSilence(h, "paused profile");
	});
});

Deno.test("empty profile produces no restore", () => {
	const p = project((_, state) => writeProfile(state, ""));
	p.run((h) => {
		h.fire("session_start");
		assertSilence(h, "empty profile");
	});
});

Deno.test("invalid UTF-8 profile produces no restore (#2)", () => {
	// Upstream test: b"\xff\xfe" must not activate learning. Node string
	// decoding would substitute U+FFFD and count as content.
	const p = project((_, state) => writeProfile(state, new Uint8Array([0xff, 0xfe])));
	p.run((h) => {
		h.fire("session_start");
		assertSilence(h, "invalid UTF-8 profile");
	});
});

Deno.test("CR-only line endings honor the paused marker (#2)", () => {
	const p = project((_, state) =>
		writeProfile(state, "# Learner Profile\rLearning mode: paused\rOnboarding: complete\r")
	);
	p.run((h) => {
		h.fire("session_start");
		assertSilence(h, "paused marker in CR-only file");
	});
});

Deno.test("paused marker deep in a long profile is still honored", () => {
	const p = project((_, state) =>
		writeProfile(state, "# Learner Profile\n" + "# notes\n".repeat(5000) + "Learning mode: paused\n")
	);
	p.run((h) => {
		h.fire("session_start");
		assertSilence(h, "deep paused marker");
	});
});

Deno.test("legacy profile without a mode line still restores", () => {
	// Older profiles may lack an explicit mode; upstream preserves restoration.
	const p = project((_, state) => writeProfile(state, "# Learner Profile\nAdvanced\n"), {
		legacy: true,
	});
	p.run((h) => {
		h.fire("session_start");
		if (h.sent.length !== 1 || !h.sent[0].message.content.includes(".sensible-vibes")) {
			throw new Error("legacy profile without mode line must restore in place");
		}
	});
});

Deno.test("missing state directory produces no restore", () => {
	const p = project(undefined, { withState: false });
	p.run((h) => {
		h.fire("session_start");
		assertSilence(h, "no state directory");
	});
});

Deno.test("legacy .sensible-vibes state is restored in place", () => {
	const p = project((_, state) => writeProfile(state, ACTIVE), { legacy: true });
	p.run((h) => {
		h.fire("session_start");
		if (h.sent.length !== 1 || !h.sent[0].message.content.includes(".sensible-vibes")) {
			throw new Error("legacy state must be used in place");
		}
	});
});

Deno.test("git directory boundary stops the upward search", () => {
	const parent = project((_, state) => writeProfile(state, ACTIVE));
	const child = path.join(parent.dir, "nested-repo");
	fs.mkdirSync(path.join(child, ".git"), { recursive: true });
	const previous = process.cwd();
	process.chdir(child);
	try {
		const harness = makeHarness();
		vibeWise(harness.pi as never);
		harness.fire("session_start");
		assertSilence(harness, "must not borrow the parent repo's state");
	} finally {
		process.chdir(previous);
		fs.rmSync(parent.dir, { recursive: true, force: true });
	}
});

Deno.test("worktree .git file boundary stops the upward search", () => {
	const parent = project((_, state) => writeProfile(state, ACTIVE));
	const child = path.join(parent.dir, "worktree");
	fs.mkdirSync(child, { recursive: true });
	fs.writeFileSync(path.join(child, ".git"), "gitdir: /another/repo/.git/worktrees/test");
	const previous = process.cwd();
	process.chdir(child);
	try {
		const harness = makeHarness();
		vibeWise(harness.pi as never);
		harness.fire("session_start");
		assertSilence(harness, "must not borrow the parent worktree's state");
	} finally {
		process.chdir(previous);
		fs.rmSync(parent.dir, { recursive: true, force: true });
	}
});

Deno.test("symlinked state directory is not followed and does not fall back to legacy", () => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vibewise-pi-target-"));
	const target = path.join(outside, "real-state");
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, "profile.md"), ACTIVE);
	const p = project((dir) => {
		fs.symlinkSync(target, path.join(dir, ".vibe-wise"), "dir");
		fs.mkdirSync(path.join(dir, ".sensible-vibes"));
		writeProfile(path.join(dir, ".sensible-vibes"), ACTIVE);
	}, { withState: false });
	p.run((h) => {
		h.fire("session_start");
		// The invalid (symlinked) candidate must stop the search entirely:
		// silently falling back to legacy could load a different project's notes.
		assertSilence(h, "symlinked state must not fall back to legacy");
		if (fs.readdirSync(target).sort().join() !== "profile.md") {
			throw new Error("restore must have no side effects on the symlink target");
		}
	});
	fs.rmSync(outside, { recursive: true, force: true });
});

Deno.test("symlinked profile.md is rejected", () => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vibewise-pi-target-"));
	const p = project((_, state) => {
		fs.writeFileSync(path.join(outside, "profile.md"), ACTIVE);
		fs.symlinkSync(path.join(outside, "profile.md"), path.join(state, "profile.md"));
	});
	p.run((h) => {
		h.fire("session_start");
		assertSilence(h, "symlinked profile must not activate learning");
	});
	fs.rmSync(outside, { recursive: true, force: true });
});

Deno.test("upward search finds project state from a nested cwd", () => {
	const p = project((_, state) => writeProfile(state, ACTIVE));
	fs.mkdirSync(path.join(p.dir, "src", "deep"), { recursive: true });
	const previous = process.cwd();
	process.chdir(path.join(p.dir, "src", "deep"));
	try {
		if (stateDirectory(process.cwd()) !== p.state) {
			throw new Error("nested cwd must find the project root's state");
		}
	} finally {
		process.chdir(previous);
		fs.rmSync(p.dir, { recursive: true, force: true });
	}
});

Deno.test("new name wins at the same level even when paused (no legacy fallback)", () => {
	const p = project((dir, state) => {
		writeProfile(state, PAUSED); // paused .vibe-wise
		fs.mkdirSync(path.join(dir, ".sensible-vibes"));
		writeProfile(path.join(dir, ".sensible-vibes"), ACTIVE); // active legacy
	});
	p.run((h) => {
		h.fire("session_start");
		assertSilence(h, "paused new-format state must win over active legacy");
	});
});

Deno.test("new name wins at the same level when both are active", () => {
	const p = project((dir, state) => {
		writeProfile(state, ACTIVE);
		fs.mkdirSync(path.join(dir, ".sensible-vibes"));
		writeProfile(path.join(dir, ".sensible-vibes"), ACTIVE);
	});
	p.run((h) => {
		h.fire("session_start");
		if (h.sent.length !== 1 || !h.sent[0].message.content.includes(".vibe-wise")) {
			throw new Error("expected .vibe-wise to be preferred over legacy");
		}
	});
});

Deno.test("restore has no side effects on the state directory", () => {
	const p = project((_, state) => {
		writeProfile(state, ACTIVE);
		fs.writeFileSync(path.join(state, "progress.md"), "# Learning Progress\n");
	});
	p.run((h) => {
		const before = fs.readdirSync(p.state).sort().join();
		h.fire("session_start");
		const after = fs.readdirSync(p.state).sort().join();
		if (before !== after) throw new Error("restore must not modify the state directory");
	});
});

Deno.test("idle manual compaction keeps nextTurn delivery (#1)", () => {
	const p = project((_, state) => writeProfile(state, ACTIVE));
	p.run((h) => {
		h.fire("session_compact", { reason: "manual", willRetry: false });
		if (h.sent.length !== 1 || h.sent[0].options.deliverAs !== "nextTurn") {
			throw new Error("idle manual compaction must use nextTurn");
		}
	});
});

Deno.test("mid-run compaction uses steer delivery (#1)", () => {
	for (const [event, isIdle] of [
		[{ reason: "threshold", willRetry: false }, false],
		[{ reason: "overflow", willRetry: true }, true],
	] as const) {
		const p = project((_, state) => writeProfile(state, ACTIVE));
		p.run((h) => {
			h.fire("session_compact", event);
			if (h.sent.length !== 1 || h.sent[0].options.deliverAs !== "steer") {
				throw new Error(`${event.reason} compaction must use steer delivery`);
			}
		}, { isIdle: () => isIdle });
	}
});

Deno.test("no duplicate restore on the compaction-at-first-prompt path (#1/S5)", () => {
	const p = project((_, state) => writeProfile(state, ACTIVE));
	p.run((h) => {
		h.fire("session_start"); // queues restore #1 (nextTurn)
		// prompt() checks compaction before draining pending messages and before
		// before_agent_start fires, so the pending flag must suppress a second queue.
		h.fire("session_compact", { reason: "threshold", willRetry: false });
		if (h.sent.length !== 1) throw new Error(`expected 1 queued restore, got ${h.sent.length}`);
	});
});

Deno.test("pending flag clears at before_agent_start so later compactions re-queue", () => {
	const p = project((_, state) => writeProfile(state, ACTIVE));
	p.run((h) => {
		h.fire("session_start");
		h.fire("before_agent_start"); // startup restore delivered with this prompt
		h.fire("session_compact", { reason: "manual", willRetry: false });
		if (h.sent.length !== 2) {
			throw new Error(`expected startup + post-delivery compaction restores, got ${h.sent.length}`);
		}
	});
});
