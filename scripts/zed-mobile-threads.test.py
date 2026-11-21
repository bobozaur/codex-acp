import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from uuid import UUID, uuid4


SCRIPT = Path(__file__).with_name("zed-mobile-threads.py")
ANDROID = "codex_chatgpt_android_remote"
FOLDER = "/workspace/sample project"
OTHER_FOLDER = "/workspace/another project"
REFERENCE = "c14d37f3-1381-45bf-8167-75ac1b636360"
CANDIDATE = "b19e7e15-a879-420f-9d5f-476da9879870"
EXISTING = "f6e358fd-f186-4a9d-a6e4-07ae162cc941"
AGENT = "Configured Codex"

NATIVE_SCHEMA = """
CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, source TEXT NOT NULL, originator TEXT,
    thread_source TEXT, creator_user_id TEXT, creator_account_id TEXT, archived INTEGER NOT NULL,
    has_user_event INTEGER NOT NULL, first_user_message TEXT NOT NULL,
    title TEXT NOT NULL, name TEXT, preview TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, created_at_ms INTEGER, updated_at_ms INTEGER
);
"""
ZED_SCHEMA = """
CREATE TABLE sidebar_threads (
    thread_id BLOB PRIMARY KEY, session_id TEXT, agent_id TEXT, title TEXT NOT NULL,
    updated_at TEXT NOT NULL, created_at TEXT, folder_paths TEXT, folder_paths_order TEXT,
    archived INTEGER DEFAULT 0, main_worktree_paths TEXT, main_worktree_paths_order TEXT,
    remote_connection TEXT, interacted_at TEXT, title_override TEXT
) STRICT;
"""


class MobileThreadsTest(unittest.TestCase):
    def setUp(self):
        scratch = TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.native = self.root / "state_10.sqlite"
        self.zed = self.root / "zed.sqlite"
        self.execute(self.native, NATIVE_SCHEMA)
        self.execute(self.zed, ZED_SCHEMA)

    def execute(self, db_path, sql, args=()):
        db = sqlite3.connect(db_path)
        try:
            db.row_factory = sqlite3.Row
            with db:
                return [dict(row) for row in db.execute(sql, args)]
        finally:
            db.close()

    def run_tool(self, *args, data=None, env=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args], input=data, env=env,
                              capture_output=True, timeout=10)

    def add_native(self, **overrides):
        values = dict(id=str(uuid4()), cwd=FOLDER, source="vscode", originator=ANDROID,
                      thread_source="user", creator_user_id="member-a", creator_account_id="team-a", archived=0,
                      has_user_event=0, first_user_message="Private transcript content", name="Saved heading",
                      title="List heading", preview="Preview only", created_at=1700000000, updated_at=1700000020,
                      created_at_ms=None, updated_at_ms=1700000020123)
        values.update(overrides)
        columns = ",".join(values)
        placeholders = ",".join("?" for _ in values)
        self.execute(self.native, f"INSERT INTO threads ({columns}) VALUES ({placeholders})", tuple(values.values()))

    def add_sidebar(self, session_id=REFERENCE, *, agent=AGENT, archived=0, folder=FOLDER, remote=None):
        self.execute(self.zed, """
            INSERT INTO sidebar_threads (thread_id, session_id, agent_id, title, updated_at, created_at,
                folder_paths, folder_paths_order, archived, main_worktree_paths, main_worktree_paths_order,
                remote_connection, interacted_at, title_override)
            VALUES (?, ?, ?, 'Original Zed title', '2025-01-01T00:00:00+00:00', NULL, ?, '0', ?, ?, '0', ?, NULL, 'Zed override')
        """, (uuid4().bytes, session_id, agent, folder, archived, folder, remote))

    def saved_rows(self):
        return self.execute(self.zed, "SELECT * FROM sidebar_threads ORDER BY thread_id")

    def snapshot(self, entries=(CANDIDATE,)):
        return json.dumps({
            "version": 1, "anchor": {"session_id": REFERENCE, "cwd": FOLDER},
            "threads": [{"session_id": session_id, "cwd": FOLDER if session_id == REFERENCE else OTHER_FOLDER,
                         "title": "New display title", "created_at_ms": 1700000000123,
                         "updated_at_ms": 1700000020000} for session_id in entries],
        }).encode()

    def test_exports_only_eligible_android_threads_owned_by_the_native_reference(self):
        self.add_native(id=REFERENCE, originator="codex", archived=1)
        self.add_native(id=CANDIDATE, cwd=OTHER_FOLDER, name="  Mobile 🧑‍💻\nthread  ", thread_source=None)
        self.add_native(id=EXISTING, name=None)
        for rejected in [dict(archived=1), dict(first_user_message=""), dict(originator="unknown"),
                         dict(source='{"subagent":"thread_spawn"}'), dict(thread_source="subagent"),
                         dict(creator_user_id="member-b"), dict(creator_account_id="team-b"),
                         dict(creator_user_id=None), dict(creator_account_id=None)]:
            self.add_native(**rejected)
        self.execute(self.root / "state_9.sqlite", NATIVE_SCHEMA)
        original = self.native.read_bytes()
        result = self.run_tool("export", REFERENCE, env={**os.environ, "CODEX_HOME": str(self.root)})
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["anchor"], {"session_id": REFERENCE, "cwd": FOLDER})
        self.assertEqual(data["threads"], [
            {"session_id": CANDIDATE, "cwd": OTHER_FOLDER, "title": "Mobile 🧑‍💻 thread",
             "created_at_ms": 1700000000000, "updated_at_ms": 1700000020123},
            {"session_id": EXISTING, "cwd": FOLDER, "title": "List heading",
             "created_at_ms": 1700000000000, "updated_at_ms": 1700000020123},
        ])
        self.assertNotIn(b"Private transcript content", result.stdout)
        self.assertNotIn(b"team-a", result.stdout)
        self.assertEqual(self.native.read_bytes(), original)

    def test_fails_export_without_both_owner_ids(self):
        self.add_native(id=REFERENCE, creator_account_id=None)
        result = self.run_tool("export", REFERENCE, "--db", str(self.native))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertIn(b"recorded account and user IDs", result.stderr)

    def test_imports_with_local_or_trusted_ssh_route_and_leaves_all_existing_rows_intact(self):
        ssh = json.dumps({"Ssh": {"host": {"Hostname": "example.test"}, "port": 22,
                                  "password": "fixture-only", "upload_binary_over_ssh": False}})
        self.execute(self.zed, "ALTER TABLE sidebar_threads ADD COLUMN extra TEXT")
        for route in [None, ssh]:
            with self.subTest(route=route is not None):
                self.execute(self.zed, "DELETE FROM sidebar_threads")
                self.add_sidebar(archived=1, remote=route)
                self.add_sidebar(EXISTING, archived=1, agent="Other agent")
                before = self.saved_rows()
                payload = self.snapshot((REFERENCE, EXISTING, CANDIDATE))
                dry_run = self.run_tool("import", "--db", str(self.zed), "--dry-run", data=payload)
                self.assertEqual(dry_run.returncode, 0, dry_run.stderr)
                self.assertIn(b"Would add 1", dry_run.stdout)
                self.assertEqual(self.saved_rows(), before)

                imported = self.run_tool("import", "--db", str(self.zed), data=payload)
                self.assertEqual(imported.returncode, 0, imported.stderr)
                self.assertIn(b"Added 1", imported.stdout)
                self.assertNotIn(b"fixture-only", imported.stdout + imported.stderr)
                rows = self.saved_rows()
                self.assertEqual([row for row in rows if row["session_id"] != CANDIDATE], before)
                added = next(row for row in rows if row["session_id"] == CANDIDATE)
                self.assertEqual(UUID(bytes=added["thread_id"]).version, 4)
                self.assertEqual({key: value for key, value in added.items() if key != "thread_id"},
                                 dict(session_id=CANDIDATE, agent_id=AGENT, title="New display title",
                                             created_at="2023-11-14T22:13:20.123+00:00", updated_at="2023-11-14T22:13:40.000+00:00",
                                             archived=0, title_override=None, interacted_at=None, extra=None,
                                             folder_paths=OTHER_FOLDER, main_worktree_paths=OTHER_FOLDER,
                                             folder_paths_order="0", main_worktree_paths_order="0", remote_connection=route))
                rerun = self.run_tool("import", "--db", str(self.zed), data=payload)
                self.assertEqual(rerun.returncode, 0, rerun.stderr)
                self.assertIn(b"Added 0", rerun.stdout)
                self.assertEqual(self.saved_rows(), rows)

    def test_rejects_ambiguous_route_unless_the_configured_agent_identifies_one_row(self):
        self.add_sidebar()
        self.add_sidebar(agent="Other agent", remote='{"Ssh":{"host":{"Hostname":"example.test"}}}')
        before = self.saved_rows()
        for args in [[], ["--agent-id", "Missing agent"]]:
            failed = self.run_tool("import", "--db", str(self.zed), *args, data=self.snapshot())
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(self.saved_rows(), before)
        selected = self.run_tool("import", "--db", str(self.zed), "--agent-id", AGENT, data=self.snapshot())
        self.assertEqual(selected.returncode, 0, selected.stderr)
        added = next(row for row in self.saved_rows() if row["session_id"] == CANDIDATE)
        self.assertEqual((added["agent_id"], added["remote_connection"]), (AGENT, None))

    def test_rejects_bad_snapshot_and_other_workspaces_without_changes(self):
        self.add_sidebar(remote='{"Wsl":{}}')
        before = self.saved_rows()
        broken_path = self.snapshot().replace(OTHER_FOLDER.encode(), b"relative")
        for payload in [self.snapshot(), self.snapshot((CANDIDATE, CANDIDATE)), broken_path, b"{}"]:
            failed = self.run_tool("import", "--db", str(self.zed), data=payload)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(self.saved_rows(), before)
        self.execute(self.zed, "UPDATE sidebar_threads SET remote_connection = NULL, folder_paths = ?, main_worktree_paths = ?",
                     (OTHER_FOLDER, OTHER_FOLDER))
        before = self.saved_rows()
        failed = self.run_tool("import", "--db", str(self.zed), data=self.snapshot())
        self.assertIn(b"different workspace", failed.stderr)
        self.assertEqual(self.saved_rows(), before)

    def test_serializes_concurrent_imports(self):
        self.add_sidebar()
        args = [sys.executable, str(SCRIPT), "import", "--db", str(self.zed)]
        with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as left:
            with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as right:
                payload = self.snapshot()
                left.stdin.write(payload)
                right.stdin.write(payload)
                left.stdin.close()
                right.stdin.close()
                left.stdin = right.stdin = None
                results = [left.communicate(timeout=10), right.communicate(timeout=10)]
                self.assertEqual((left.returncode, right.returncode), (0, 0), results)
        self.assertEqual([row["session_id"] for row in self.saved_rows()].count(CANDIDATE), 1)


if __name__ == "__main__":
    unittest.main()
