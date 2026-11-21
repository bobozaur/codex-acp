# Add Codex Android conversations to the stock Zed sidebar

Zed's thread archive has an **Import Threads** action for the Codex agent. Imported conversations start in the archive. Opening one restores it to the project sidebar. [Zed's ACP import](https://github.com/zed-industries/zed/blob/d01b134cddf5e4f71964deb2d6f81cdb38fcf1e7/crates/agent_ui/src/thread_import.rs#L794-L889)

`scripts/zed-mobile-threads.py` can add missing Android conversations directly to the project sidebar at startup. It uses the original Codex session IDs, so opening an entry resumes the existing conversation through the configured agent. The tool requires Python 3 with its standard `sqlite3` module and targets the sidebar schema used by Zed 1.29.3 stable.

Choose one native Codex session ID that is already present in the desktop's Zed sidebar and opens through the intended Codex ACP agent. The reference must have a recorded user message and native creator account and user IDs. The reference can be archived. If it has more than one Zed entry, use `import --agent-id` with the configured agent's exact ID to select a unique entry. Its native working directory must match one of that entry's Zed workspace paths.

## Run before opening Zed

Zed reads the persisted sidebar into memory at startup. Run the importer before starting Zed to see the entries at that launch. Each new entry gets its own Zed ID and project path with the same local or SSH connection as the reference. Existing entries keep their titles, archive flags, and routing.

On a host that runs both Codex and Zed, replace the example UUID with your reference ID. Use `--dry-run` on the import first to see the count. Remove `--dry-run` to add the entries.

```bash
set -o pipefail
python3 scripts/zed-mobile-threads.py export f83538cf-01e3-4c75-8c56-41e233222b55 \
  | python3 scripts/zed-mobile-threads.py import --dry-run
```

For a remote Codex workspace, make the script available on the Codex host and the Zed desktop. For example, copy it to `~/bin/zed-mobile-threads.py` on each host. Run the following from the Zed desktop, substituting your SSH host and reference UUID.

```bash
set -o pipefail
ssh -o BatchMode=yes -o ConnectTimeout=5 codex-host \
  'python3 "$HOME/bin/zed-mobile-threads.py" export f83538cf-01e3-4c75-8c56-41e233222b55' \
  | python3 "$HOME/bin/zed-mobile-threads.py" import
```

For automatic imports, save the following as a separate executable named `zed-with-mobile-threads`. Point your desktop launcher's command at it and keep the original Zed arguments. The wrapper starts Zed even when SSH or the import fails.

```bash
#!/usr/bin/env bash
set -o pipefail
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 codex-host \
  'python3 "$HOME/bin/zed-mobile-threads.py" export f83538cf-01e3-4c75-8c56-41e233222b55' \
  | python3 "$HOME/bin/zed-mobile-threads.py" import; then
  printf '%s\n' 'Could not refresh Codex Android threads. Starting Zed.' >&2
fi
exec zed "$@"
```

## Database and snapshot scope

`export` opens the latest numbered `state_*.sqlite` in `CODEX_HOME` or `~/.codex` in read-only mode. It selects active Android-origin conversations with recorded user messages whose native creator account and user IDs both match the reference. The snapshot contains session IDs, workspace paths, timestamps, and display titles of up to 512 characters. Treat it as private list metadata and pipe it only from the trusted exporter. It carries no owner IDs, conversation transcript, or Zed connection fields.

`import` defaults to the desktop's stable Zed database. For Linux that is `$XDG_DATA_HOME/zed/db/0-stable/db.sqlite`, with `~/.local/share` as the usual data directory. Pass `--db PATH` on either command to select a different database or a disposable copy for validation. `import --dry-run` opens the database read-only. Import runs in one transaction and refuses ambiguous references and incompatible schemas. It derives the agent and connection from the local Zed reference entry.

Validation uses disposable databases. [Zed sidebar storage and routing](https://github.com/zed-industries/zed/blob/d01b134cddf5e4f71964deb2d6f81cdb38fcf1e7/crates/agent_ui/src/thread_metadata_store.rs), [Zed path-list serialization](https://github.com/zed-industries/zed/blob/d01b134cddf5e4f71964deb2d6f81cdb38fcf1e7/crates/util/src/path_list.rs)

```bash
python3 -B scripts/zed-mobile-threads.test.py
```
