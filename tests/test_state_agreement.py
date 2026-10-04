"""reset.py and the extension must agree on which state belongs to a project.

The state-lookup algorithm exists twice (skills/reset/reset.py in Python,
extensions/vibe-wise.ts in TypeScript). This test runs both against the same
fixture trees and asserts they select the same state directory — including
the cases where both must refuse (no state, worktree boundary, symlinks).

Skipped when `deno` is unavailable.
"""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/reset/reset.py"
BRIDGE = ROOT / "tests/print_state.ts"
sys.dont_write_bytecode = True  # keep __pycache__ out of the package clone
spec = importlib.util.spec_from_file_location("vibe_wise_reset", SCRIPT)
reset_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset_module)

DENO = shutil.which("deno")


def make_case(root):
    """Build fixture layouts; returns {name: (cwd, expected_state_or_None)}."""
    cases = {}

    # Active .vibe-wise at project root
    active = root / "active"; (active / ".git").mkdir(parents=True)
    state = active / ".vibe-wise"; state.mkdir()
    (state / "profile.md").write_text("Learning mode: active\n")
    cases["active"] = (active, state)

    # Active legacy .sensible-vibes
    legacy = root / "legacy"; (legacy / ".git").mkdir(parents=True)
    lstate = legacy / ".sensible-vibes"; lstate.mkdir()
    (lstate / "profile.md").write_text("Learning mode: active\n")
    cases["legacy"] = (legacy, lstate)

    # Both at the same level: new name must win
    both = root / "both"; (both / ".git").mkdir(parents=True)
    bnew = both / ".vibe-wise"; bnew.mkdir()
    (bnew / "profile.md").write_text("Learning mode: paused\n")
    bold = both / ".sensible-vibes"; bold.mkdir()
    (bold / "profile.md").write_text("Learning mode: active\n")
    cases["new-beats-legacy"] = (both, bnew)

    # Nested cwd finds the root state
    cases["nested-cwd"] = (active / "src" / "deep", state)
    (active / "src" / "deep").mkdir(parents=True)

    # Worktree .git FILE boundary hides the parent state
    worktree = root / "worktree-child"
    worktree.mkdir()
    (worktree / ".git").write_text("gitdir: /elsewhere/.git/worktrees/x")
    (worktree / ".vibe-wise").mkdir()  # own (empty) state: boundary still selects it
    cases["worktree-file"] = (worktree, worktree / ".vibe-wise")

    # No state anywhere
    bare = root / "bare"; (bare / ".git").mkdir(parents=True)
    cases["no-state"] = (bare, None)

    # Symlinked state: invalid candidate stops the search (no legacy fallback)
    linky = root / "linky"; (linky / ".git").mkdir(parents=True)
    outside = root / "outside-state"; outside.mkdir()
    (outside / "profile.md").write_text("Learning mode: active\n")
    (linky / ".vibe-wise").symlink_to(outside, target_is_directory=True)
    llegacy = linky / ".sensible-vibes"; llegacy.mkdir()
    (llegacy / "profile.md").write_text("Learning mode: active\n")
    cases["symlink-no-fallback"] = (linky, None)

    return cases


@unittest.skipUnless(DENO, "deno is required to run the TypeScript side")
class StateAgreementTests(unittest.TestCase):
    def test_python_and_typescript_select_the_same_state(self):
        with tempfile.TemporaryDirectory(prefix="vibe-wise-agreement-") as temp:
            root = Path(temp).resolve()
            cases = make_case(root)
            cwds = [str(cwd.resolve()) for cwd, _ in cases.values()]
            result = subprocess.run(
                [DENO, "run", "--allow-read", "--no-lock", str(BRIDGE), *cwds],
                capture_output=True, text=True, check=True, cwd=str(ROOT),
            )
            ts_results = json.loads(result.stdout)
            for name, (cwd, expected) in cases.items():
                resolved = str(cwd.resolve())
                # Compare as strings: the Python side returns Path objects.
                py = reset_module.state_directory(cwd)
                py = str(py) if py is not None else None
                ts = ts_results[resolved]
                self.assertEqual(
                    py, ts, f"{name}: python={py} typescript={ts}"
                )
                self.assertEqual(
                    py, str(expected) if expected else None,
                    f"{name}: both implementations picked {py}, expected {expected}",
                )


if __name__ == "__main__":
    unittest.main()
