"""A resumed private worker must inherit the completed sound milestones and select streaming music."""
import json
import subprocess
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/mundo_ia"))
import areas
import journal


def git(*args):
    return subprocess.check_output(["git", *map(str, args)])


def check():
    with tempfile.TemporaryDirectory() as folder:
        state = Path(folder)
        repo = state / "engine.git"
        git("clone", "-q", "--bare", "--shared", ROOT, repo)
        git("-C", repo, "update-ref", "refs/heads/mundo-ia", "v0.56.0^{commit}")
        journal.init_db(state)
        old = state / "programa_mundo.json"
        receipts = state / "integrados.json"
        for path in (old, receipts):
            path.write_bytes(git("-C", ROOT, "show", f"v0.56.0:tools/mundo_ia/{path.name}"))
        with patch.object(areas, "DEFAULT_PLAN", old), patch.object(areas, "UPSTREAM_PLAN", receipts):
            areas.install(state)
        areas.set_budget(state, "navegacion", 48)
        with closing(journal._open(state)) as db, db:
            db.execute("UPDATE work_areas SET spent_ms=12000 WHERE key='navegacion'")
            ids = dict(db.execute("SELECT key,job_id FROM plan_items"))
        has_tag = subprocess.run(["git", "-C", str(repo), "show-ref", "--verify", "--quiet",
                                  "refs/tags/v0.57.0"]).returncode == 0
        release = "v0.57.0" if has_tag else "HEAD"
        git("-C", repo, "update-ref", "refs/heads/mundo-ia", f"{release}^{{commit}}")
        for path in (old, receipts):
            path.write_bytes(git("-C", ROOT, "show", f"{release}:tools/mundo_ia/{path.name}"))
        with patch.object(areas, "DEFAULT_PLAN", old), patch.object(areas, "UPSTREAM_PLAN", receipts):
            counts = areas.install(state)
        assert counts[0] == 14
        with closing(journal._open(state)) as db:
            new_ids = dict(db.execute("SELECT key,job_id FROM plan_items"))
            assert new_ids.items() >= ids.items()
            assert tuple(db.execute("SELECT shifts,spent_ms FROM work_areas WHERE key='navegacion'").fetchone()) == (48, 12000)
            for key in ("audio-01", "audio-02"):
                expected = json.loads(receipts.read_text())["tareas"][key]
                assert db.execute("SELECT revision FROM upstream_jobs WHERE job_id=?", (ids[key],)).fetchone()[0] == expected
            current = areas.next_task(db)
            assert current["id"] == new_ids["audio-03"]
        print("OK · identidades, horas, recibos y siguiente tarea de 0.57.0")


if __name__ == "__main__":
    check()
