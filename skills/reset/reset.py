"""Preview by default; reset only a confirmed snapshot of local learning notes."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def state_directory(cwd):
    """Find the nearest notes directory without crossing a Git project boundary.

    Mirrors the lookup in extensions/vibe-wise.ts so the reset helper and the
    session restore extension always agree on which state belongs to a project.
    """
    # Starting in a source subdirectory should still find the project's notes.
    for directory in (cwd, *cwd.parents):
        # Prefer the new name at the nearest location; keep legacy notes in place.
        for name in (".vibe-wise", ".sensible-vibes"):
            state = directory / name
            if state.exists() or state.is_symlink():
                # Stop even if this candidate is invalid. Falling back to a parent
                # could silently load a different project's learner profile.
                return state if state.is_dir() and not state.is_symlink() else None
        # A .git file is a worktree boundary too. Never borrow another repo's state.
        if (directory / ".git").exists():
            break
    return None


FRESH = {
    "profile.md": (
        "# Learner Profile\n\nLearning mode: active\nOnboarding: incomplete\n"
        "Onboarding reset: pending\n\n"
        "Remaining onboarding: Project situation, experience, stack familiarity, "
        "goals, and preferences.\n"
    ),
    "progress.md": "# Learning Progress\n\nNo learning events recorded yet.\n",
    "project-map.md": "# Project Map\n\nNot mapped yet. Inspect the current project.\n",
}


def snapshot(cwd):
    state = state_directory(cwd)
    if state is None:
        return None, {}, None
    notes = {}
    for name in FRESH:
        path = state / name
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(mode):
            raise ValueError("Refusing to reset non-regular note: " + str(path))
        notes[name] = path.read_bytes()
    # Include identity, missing files, and content so confirmation cannot drift
    # to another project or silently discard notes updated by another session.
    digest = hashlib.sha256(str(state).encode())
    for name in FRESH:
        data = notes.get(name)
        digest.update(json.dumps([name, None if data is None else data.hex()]).encode())
    return state, notes, digest.hexdigest()


def reset(cwd, confirmation=None):
    cwd = Path(cwd)
    if not cwd.is_absolute() or not cwd.is_dir():
        raise ValueError("Use an existing absolute project working directory.")
    cwd = cwd.resolve()
    state, notes, fingerprint = snapshot(cwd)
    if confirmation is not None and (not notes or confirmation != fingerprint):
        raise ValueError("Target or notes changed. Preview and confirm again; nothing reset.")
    if not notes:
        return {"status": "no_notes", "cwd": str(cwd)}
    result = {
        "status": "preview", "project": str(state.parent), "state": str(state),
        "files": list(notes), "backup_parent": str(state / "backups"),
        "confirmation": fingerprint,
    }
    if confirmation is None:
        return result

    backup_parent = state / "backups"
    if backup_parent.is_symlink() or (backup_parent.exists() and not backup_parent.is_dir()):
        raise ValueError("Backup path must be a real directory; nothing reset.")
    backup_parent.mkdir(mode=0o700, exist_ok=True)
    prefix = datetime.now(timezone.utc).strftime("reset-%Y%m%dT%H%M%SZ-")
    backup = Path(tempfile.mkdtemp(prefix=prefix, dir=backup_parent))
    try:
        # Finish all backups and prepare replacements before touching active notes.
        for name, data in notes.items():
            (backup / name).write_bytes(data)
        for name, text in FRESH.items():
            (backup / (".new-" + name)).write_text(text, encoding="utf-8")
        if snapshot(cwd)[2] != fingerprint:
            raise ValueError("Notes changed during backup; active notes were not reset.")
        for name in FRESH:
            os.replace(backup / (".new-" + name), state / name)
    except (OSError, ValueError) as error:
        raise ValueError(
            "Reset did not complete. Backup location: {}. "
            "Check active notes before continuing. {}".format(backup, error)
        ) from error
    return {"status": "reset", "project": str(state.parent),
            "state": str(state), "backup": str(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--confirm", help="Snapshot token from a preview; only after user confirmation")
    args = parser.parse_args()
    try:
        result = reset(args.cwd, args.confirm)
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "error", "message": str(error)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
