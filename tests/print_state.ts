/**
 * Test bridge for tests/test_state_agreement.py: prints a JSON object mapping
 * each cwd argument to the state directory the extension's lookup selects
 * (or null), so the Python and TypeScript implementations can be compared.
 */

import { stateDirectory } from "../extensions/vibe-wise.ts";

const results: Record<string, string | null> = {};
for (const cwd of Deno.args) {
	results[cwd] = stateDirectory(cwd);
}
console.log(JSON.stringify(results));
