#!/usr/bin/env python3
"""Add existing Android-origin Codex sessions to an offline Zed sidebar."""

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import sqlite3
import sys
import unicodedata
from uuid import UUID, uuid4


ANDROID_ORIGINATOR = "codex_chatgpt_android_remote"
MAX_THREADS = 10_000
MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
MAX_TITLE = 512
MAX_CWD = 4096
MAX_TIMESTAMP = 253402300799999
ZED_COLUMNS = {
    "thread_id": "BLOB", "session_id": "TEXT", "agent_id": "TEXT", "title": "TEXT",
    "updated_at": "TEXT", "created_at": "TEXT", "interacted_at": "TEXT", "archived": "INTEGER",
    "folder_paths": "TEXT", "folder_paths_order": "TEXT", "main_worktree_paths": "TEXT",
    "main_worktree_paths_order": "TEXT", "remote_connection": "TEXT", "title_override": "TEXT",
}


class CompanionError(ValueError):
    pass


def is_session_id(value):
    if not isinstance(value, str) or len(value) != 36:
        return False
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


def is_cwd(value):
    return (isinstance(value, str) and 1 <= len(value) <= MAX_CWD and is_display_text(value)
            and (PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute()))


def is_display_text(value):
    return all(unicodedata.category(char) not in {"Cc", "Cs", "Zl", "Zp"} for char in value)


def native_database():
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
    candidates = []
    for file in home.glob("state_*.sqlite"):
        match = re.fullmatch(r"state_(\d+)\.sqlite", file.name)
        if match and file.is_file():
            candidates.append((int(match[1]), file))
    if not candidates:
        raise CompanionError("No Codex state database found. Set CODEX_HOME or pass --db.")
    return max(candidates)[1]


def zed_database():
    if sys.platform == "darwin":
        data = Path.home() / "Library" / "Application Support" / "Zed"
    elif sys.platform == "win32":
        root = os.environ.get("LOCALAPPDATA")
        if not root:
            raise CompanionError("Pass --db for this Zed profile.")
        data = Path(root) / "Zed"
    else:
        root = os.environ.get("FLATPAK_XDG_DATA_HOME") or os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
        data = Path(root) / "zed"
    return data / "db" / "0-stable" / "db.sqlite"


def open_database(path, *, writable):
    mode = "rw" if writable else "ro"
    db = sqlite3.connect(f"{path.expanduser().resolve().as_uri()}?mode={mode}", uri=True, isolation_level=None)
    db.row_factory = sqlite3.Row
    return db


def export_snapshot(path, anchor_id):
    if not is_session_id(anchor_id):
        raise CompanionError("The reference must be a native Codex session UUID.")
    with closing(open_database(path, writable=False)) as db:
        db.execute("BEGIN")
        anchor = db.execute("""
            SELECT cwd, creator_user_id, creator_account_id
            FROM threads
            WHERE id = ? AND length(trim(first_user_message)) > 0
                AND (thread_source IS NULL OR thread_source = 'user')
        """, (anchor_id,)).fetchone()
        if anchor is None or not all(anchor[key] for key in ("creator_user_id", "creator_account_id")):
            raise CompanionError("The native reference must be a user session with recorded account and user IDs.")
        rows = db.execute("""
            SELECT id AS session_id, cwd,
                COALESCE(created_at_ms, created_at * 1000) AS created_at_ms,
                COALESCE(updated_at_ms, updated_at * 1000) AS updated_at_ms,
                substr(COALESCE(NULLIF(trim(name), ''), NULLIF(trim(title), ''),
                    NULLIF(trim(preview), ''), 'Codex conversation'), 1, ?) AS title
            FROM threads
            WHERE originator = ? AND source = 'vscode'
                AND creator_user_id = ? AND creator_account_id = ?
                AND archived = 0 AND length(trim(first_user_message)) > 0
                AND (thread_source IS NULL OR thread_source = 'user')
            ORDER BY updated_at_ms DESC, id
            LIMIT ?
        """, (MAX_TITLE, ANDROID_ORIGINATOR, anchor["creator_user_id"], anchor["creator_account_id"], MAX_THREADS + 1))
        threads = []
        for row in rows:
            entry = dict(row)
            printable = "".join(char if is_display_text(char) else " " for char in entry["title"])
            entry["title"] = " ".join(printable.split()) or "Codex conversation"
            threads.append(entry)
        snapshot = {"version": 1, "anchor": {"session_id": anchor_id, "cwd": anchor["cwd"]}, "threads": threads}
    validate_snapshot(snapshot)
    return snapshot


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise CompanionError("Duplicate JSON fields are not supported.")
    return result


def has_fields(value, fields):
    return isinstance(value, dict) and value.keys() == fields


def validate_snapshot(value):
    if (not has_fields(value, {"version", "anchor", "threads"})
            or type(value["version"]) is not int or value["version"] != 1):
        raise CompanionError("Unsupported snapshot format.")
    anchor = value["anchor"]
    if (not has_fields(anchor, {"session_id", "cwd"}) or not is_session_id(anchor["session_id"])
            or not is_cwd(anchor["cwd"])):
        raise CompanionError("Invalid snapshot reference.")
    threads = value["threads"]
    if not isinstance(threads, list) or len(threads) > MAX_THREADS:
        raise CompanionError("Invalid snapshot thread count.")
    seen = set()
    for thread in threads:
        if not has_fields(thread, {"session_id", "cwd", "title", "created_at_ms", "updated_at_ms"}):
            raise CompanionError("Invalid snapshot thread fields.")
        session_id = thread["session_id"]
        title = thread["title"]
        created, updated = thread["created_at_ms"], thread["updated_at_ms"]
        if (not is_session_id(session_id) or session_id in seen or not is_cwd(thread["cwd"])
                or not isinstance(title, str) or not 1 <= len(title) <= MAX_TITLE or not is_display_text(title)
                or any(type(stamp) is not int or not 0 <= stamp <= MAX_TIMESTAMP for stamp in (created, updated))
                or (session_id == anchor["session_id"] and thread["cwd"] != anchor["cwd"])):
            raise CompanionError("Invalid or duplicate snapshot thread.")
        seen.add(session_id)


def read_snapshot(stream):
    payload = stream.read(MAX_SNAPSHOT_BYTES + 1)
    if len(payload) > MAX_SNAPSHOT_BYTES:
        raise CompanionError("Snapshot exceeds the size limit.")
    try:
        value = json.loads(payload.decode("utf-8"), object_pairs_hook=unique_object)
    except (ValueError, RecursionError) as error:
        raise CompanionError("Invalid UTF-8 snapshot JSON.") from error
    validate_snapshot(value)
    return value


def anchor_route(db, anchor, expected_agent):
    rows = db.execute("""
        SELECT agent_id, folder_paths, main_worktree_paths, remote_connection
        FROM sidebar_threads WHERE session_id = ? AND (? IS NULL OR agent_id = ?) LIMIT 2
    """, (anchor["session_id"], expected_agent, expected_agent)).fetchall()
    if len(rows) != 1:
        raise CompanionError("Zed must have exactly one sidebar entry for the reference session and configured agent.")
    row = rows[0]
    if not row["agent_id"]:
        raise CompanionError("The reference must belong to a configured ACP agent.")
    projects = (row["folder_paths"] or "").split("\n") + (row["main_worktree_paths"] or "").split("\n")
    if anchor["cwd"] not in projects:
        raise CompanionError("The reference has a different workspace in Zed and Codex.")
    remote = row["remote_connection"]
    if remote is not None:
        validate_ssh_route(remote)
    return row["agent_id"], remote


def validate_ssh_route(value):
    try:
        route = json.loads(value, object_pairs_hook=unique_object)
    except (ValueError, RecursionError) as error:
        raise CompanionError("Invalid Zed connection metadata.") from error
    if (not has_fields(route, {"Ssh"}) or not isinstance(route["Ssh"], dict)
            or not route["Ssh"].get("host")):
        raise CompanionError("The reference must use a local or SSH Zed workspace.")


def timestamp(milliseconds):
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (epoch + timedelta(milliseconds=milliseconds)).isoformat(timespec="milliseconds")


def import_snapshot(path, snapshot, *, dry_run=False, expected_agent=None):
    with closing(open_database(path, writable=not dry_run)) as db:
        db.execute("BEGIN" if dry_run else "BEGIN IMMEDIATE")
        columns = {row["name"]: row for row in db.execute("PRAGMA table_info(sidebar_threads)")}
        if (any(name not in columns or columns[name]["type"] != kind for name, kind in ZED_COLUMNS.items())
                or columns["thread_id"]["pk"] != 1):
            raise CompanionError("Unsupported Zed sidebar database schema. Use a Zed 1.29.3 profile.")
        agent, remote = anchor_route(db, snapshot["anchor"], expected_agent)
        existing = {row[0] for row in db.execute("SELECT session_id FROM sidebar_threads WHERE session_id IS NOT NULL")}
        pending = []
        for thread in snapshot["threads"]:
            session_id = thread["session_id"]
            if session_id in existing:
                continue
            cwd = thread["cwd"]
            pending.append((uuid4().bytes, session_id, agent, thread["title"], timestamp(thread["updated_at_ms"]),
                            timestamp(thread["created_at_ms"]), cwd, cwd, remote))
        if not dry_run:
            db.executemany("""
                INSERT INTO sidebar_threads (thread_id, session_id, agent_id, title, updated_at, created_at,
                    interacted_at, folder_paths, folder_paths_order, archived, main_worktree_paths,
                    main_worktree_paths_order, remote_connection, title_override)
                VALUES (?, ?, ?, ?, ?, ?, NULL, ?, '0', 0, ?, '0', ?, NULL)
            """, pending)
        db.execute("COMMIT")
    return len(pending), len(snapshot["threads"]) - len(pending)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="read native Codex metadata as JSON")
    export.add_argument("reference_session_id")
    export.add_argument("--db", type=Path)
    receive = commands.add_parser("import", help="add missing sessions to an offline Zed sidebar")
    receive.add_argument("--db", type=Path)
    receive.add_argument("--dry-run", action="store_true")
    receive.add_argument("--agent-id", help="pick the configured Codex agent if the reference has more than one entry")
    args = parser.parse_args()
    try:
        if args.command == "export":
            snapshot = export_snapshot(args.db or native_database(), args.reference_session_id)
            payload = json.dumps(snapshot, separators=(",", ":"))
            if len(payload) + 1 > MAX_SNAPSHOT_BYTES:
                raise CompanionError("Snapshot exceeds the size limit.")
            print(payload)
        else:
            snapshot = read_snapshot(sys.stdin.buffer)
            added, existing = import_snapshot(args.db or zed_database(), snapshot,
                                              dry_run=args.dry_run, expected_agent=args.agent_id)
            print(f"{'Would add' if args.dry_run else 'Added'} {added} Android threads. {existing} already present.")
    except (CompanionError, OSError, sqlite3.Error) as error:
        print(f"zed-mobile-threads: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
