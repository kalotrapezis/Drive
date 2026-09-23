"""Put back the faces the wiped phone dragged out of their named people.

Yesterday's phone backup says which face belonged to which named person. A face that
crossed to this computer kept its embedding byte for byte, so the embedding is the key
that ties the two together — the backup predates UUIDs, so there is no id to match on.
"""
import sqlite3, hashlib, sys, time, os

live = os.path.expanduser('~/.local/share/local-drive-desktop/library.db')
target = sys.argv[1] if len(sys.argv) > 1 else live
backup = '/home/teo/Έγγραφα/Claude/Coding/Drive-Android-backups/2026-09-22/photo_metadata.db'
apply = '--apply' in sys.argv

d = sqlite3.connect(target)
b = sqlite3.connect(backup)
h = lambda x: hashlib.sha1(bytes(x)).hexdigest()
generated = lambda n: n.startswith('Person ')

was = {}  # embedding -> the name it had yesterday
for emb, name in b.execute('SELECT s.embedding, g.name FROM face_samples s JOIN face_groups g ON g.id = s.group_id'):
    if not generated(name):
        was[h(emb)] = name

people = {r[1]: r[0] for r in d.execute('SELECT id, name FROM people WHERE deleted = 0')}
names = {r[0]: r[1] for r in d.execute('SELECT id, name FROM people')}
now = int(time.time() * 1000)

moves, missing = [], set()
for fid, emb, person in d.execute('SELECT id, embedding, person_id FROM faces WHERE deleted = 0'):
    name = was.get(h(emb))
    if not name:
        continue
    home = people.get(name)
    if home is None:
        missing.add(name)
        continue
    if person != home:
        moves.append((fid, home, name, names.get(person, '?')))

print(f'faces to put back: {len(moves)}')
for name in sorted(missing):
    print(f'  ! no person called {name!r} on this computer any more')
by_name = {}
for _, _, name, _ in moves:
    by_name[name] = by_name.get(name, 0) + 1
for name, n in sorted(by_name.items(), key=lambda x: -x[1]):
    print(f'  {name}: {n}')

if not apply:
    print('\n(dry run — pass --apply to write)')
    raise SystemExit

with d:
    d.executemany('UPDATE faces SET person_id = ?, updated_at = ? WHERE id = ?',
                  [(home, now, fid) for fid, home, _, _ in moves])
    # People the wipe invented and nobody is in any more.
    empty = d.execute("""DELETE FROM people WHERE deleted = 0 AND name LIKE 'Person %'
        AND id NOT IN (SELECT person_id FROM faces WHERE person_id IS NOT NULL AND deleted = 0)""").rowcount
print(f'moved {len(moves)} faces back, removed {empty} empty auto-made people')
