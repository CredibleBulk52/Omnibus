#!/usr/bin/env python3
"""Set metadata.era in every series.json under one folder.

Run inside the container:
  docker cp scripts/archive/set_era.py omnibus:/tmp/set_era.py
  docker exec omnibus python3 /tmp/set_era.py                 # preview
  docker exec omnibus python3 /tmp/set_era.py --apply         # write

Defaults: folder "/comics/Marvel Comics/3. Marvel NOW! - ANAD", era "Marvel NOW! - ANAD".
Override: --folder "<path>" --era "<name>".
Keeps each file's formatting style (indented or compact), writes atomically, keeps a
series.json.bak copy, and marks the series for re-read on the next scan.
"""
import json, os, sqlite3, sys

def arg(k, d):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d

APPLY = '--apply' in sys.argv
FOLDER = arg('--folder', '/comics/Marvel Comics/3. Marvel NOW! - ANAD').rstrip('/')
ERA = arg('--era', 'Marvel NOW! - ANAD')
DB = os.environ.get('DB_PATH', '/appdata/omnibus.db')

changed, same, missing, bad = [], 0, [], []
for name in sorted(os.listdir(FOLDER)):
    d = os.path.join(FOLDER, name)
    if not os.path.isdir(d):
        continue
    p = os.path.join(d, 'series.json')
    if not os.path.isfile(p):
        missing.append(name); continue
    try:
        raw = open(p, encoding='utf-8').read()
        data = json.loads(raw)
    except Exception as e:
        bad.append(f'{name}: {e}'); continue
    meta = data.setdefault('metadata', {})
    old = meta.get('era')
    if old == ERA:
        same += 1; continue
    changed.append((name, old))
    if APPLY:
        meta['era'] = ERA
        indent = 2 if '\n' in raw.strip() else None
        out = json.dumps(data, ensure_ascii=False, indent=indent) + ('\n' if raw.endswith('\n') else '')
        with open(p + '.bak', 'w', encoding='utf-8') as f:
            f.write(raw)
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(out)
        os.replace(tmp, p)

if APPLY and changed:
    con = sqlite3.connect(DB, timeout=10)
    pre = FOLDER + '/'
    ids = [r[0] for r in con.execute('SELECT id FROM scanned_series WHERE substr(path,1,?) = ?', (len(pre), pre))]
    con.execute('UPDATE scanned_series SET dir_mtime = 0 WHERE substr(path,1,?) = ?', (len(pre), pre))
    con.executemany('DELETE FROM series_json_cache WHERE series_id = ?', [(i,) for i in ids])
    con.commit(); con.close()

print(('APPLIED' if APPLY else 'PREVIEW (add --apply to write)') + f'  era -> "{ERA}"  in {FOLDER}')
print(f'  to change: {len(changed)}   already set: {same}   no series.json: {len(missing)}   unreadable: {len(bad)}')
olds = {}
for _, o in changed:
    olds[o] = olds.get(o, 0) + 1
for o, n in sorted(olds.items(), key=lambda x: -x[1]):
    print(f'    from {o!r}: {n}')
for m in missing: print('  no series.json:', m)
for b in bad: print('  unreadable:', b)
if APPLY and changed:
    print('Done. Now scan the Marvel library so the app picks up the new era.')
