#!/usr/bin/env bash
# Consistent encrypted database snapshot plus its recovery key; root-only, seven-day retention.
set -euo pipefail
umask 077
python3 - <<'PY'
import datetime, pathlib, shutil, sqlite3, tempfile
root = pathlib.Path('/var/backups/buncargo-connect')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
root.chmod(0o700)
now = datetime.datetime.now(datetime.timezone.utc)
name = now.strftime('%Y%m%dT%H%M%S%fZ')
with tempfile.TemporaryDirectory(prefix='.pending-', dir=root) as temporary:
    path = pathlib.Path(temporary)
    with sqlite3.connect('file:/var/lib/buncargo-connect/directory.sqlite?mode=ro', uri=True) as source:
        with sqlite3.connect(path / 'directory.sqlite') as destination:
            source.backup(destination)
            if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup integrity check failed')
    shutil.copy2('/etc/buncargo-connect/server.env', path / 'server.env')
    for item in path.iterdir():
        item.chmod(0o600)
    path.rename(root / name)
cutoff = now.timestamp() - 7 * 86400
for old in root.iterdir():
    if old.is_dir() and not old.is_symlink() and old.name.endswith('Z') and old.stat().st_mtime < cutoff:
        shutil.rmtree(old)
print('Connection database backup verified')
PY
