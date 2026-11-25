# Renders what /city shows and writes it where the site serves it (frontend/public/city/).
#   python render_all.py [island] [close] [plotId ...] [fingerprints]
# With no argument: the island, then every plot's close-up. Set BLENDER to Blender's exe if it is
# not at the default Windows path. Each frame is built from plan.json; see README.md. Every run
# ends by writing the pictures' fingerprints for the page's links; `fingerprints` alone writes
# only those.
import hashlib, os, subprocess, sys, json, time
from PIL import Image
from grade import grade, save, sharpen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
PUB = os.path.join(ROOT, 'frontend', 'public', 'city')
PRINTS = os.path.join(ROOT, 'frontend', 'src', 'lib', 'city', 'renderFingerprints.json')
OUT = os.path.join(HERE, 'out')
BLENDER = os.environ.get('BLENDER', r'C:\Program Files\Blender Foundation\Blender 5.0\blender.exe')
os.makedirs(os.path.join(PUB, 'close'), exist_ok=True)
os.makedirs(OUT, exist_ok=True)
plan = json.load(open(os.path.join(HERE, 'plan.json'), encoding='utf-8'))
# The owner's own models as handed over (owner, 2026-11-23: "Yes, use originals"): CITY_ORIGINALS is
# the folder holding them by the city's names, full/ as handed over and island/ lighter copies of the
# heaviest for the island picture only (README.md). Too large for the repo, so without it the
# pictures are made from props/, slimmed, which cracks a close-up's building.
ORIGINALS = os.environ.get('CITY_ORIGINALS')
print('models:', ORIGINALS or "props/ (slimmed: set CITY_ORIGINALS for the owner's originals)", flush=True)


def blender(script, mode, raw, scale, samples):
    t = time.time()
    env = dict(os.environ)
    if ORIGINALS:
        folders = (['island'] if script == 'island.py' else []) + ['full']
        env['CITY_PROPS_FROM'] = ';'.join(os.path.join(ORIGINALS, f) for f in folders)
    log = subprocess.run([BLENDER, '-b', '--factory-startup', '--python', os.path.join(HERE, script), '--', mode, raw, str(scale), str(samples)],
                         capture_output=True, text=True, env=env)
    if 'WROTE' not in log.stdout:
        sys.stderr.write(log.stdout[-3000:] + log.stderr[-3000:])
        raise SystemExit(f'{mode}: no render')
    print(f'{mode} rendered in {time.time() - t:.0f}s', flush=True)


def fingerprints():
    """
    Each picture's contents fingerprint, which the page puts on its link (lib/city/render.ts): the
    pictures keep their names, and a browser keeps each for a week, so a new picture needs a new link.
    """
    files = ['island.webp', 'island-half.webp'] + [f'close/{f}' for f in os.listdir(os.path.join(PUB, 'close')) if f.endswith('.webp')]
    prints = {f: hashlib.sha256(open(os.path.join(PUB, f), 'rb').read()).hexdigest()[:10] for f in sorted(files)}
    with open(PRINTS, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(prints, fh, indent=2)
        fh.write('\n')
    print('fingerprints written', len(prints), flush=True)


args = [a for a in sys.argv[1:] if a != 'fingerprints']
only_prints = not args and len(sys.argv) > 1
do_island = not only_prints and (not args or 'island' in args)
ids = [a for a in args if a not in ('island', 'close')]
if not only_prints and (not args or 'close' in args):
    ids = ids or [p['id'] for p in plan['plots']]

if do_island:
    raw = os.path.join(OUT, 'island-raw.png')
    blender('island.py', 'island', raw, 1.0, 128)
    img = grade(raw)
    want = (plan['render']['width'], plan['render']['height'])
    assert img.size == want, (img.size, want)
    # sharper, and kept finer: the full island is only fetched once a visitor zooms in on it
    save(sharpen(img), os.path.join(PUB, 'island.webp'), 90)
    save(sharpen(img.resize((want[0] // 2, want[1] // 2), Image.LANCZOS), 35), os.path.join(PUB, 'island-half.webp'), 82)
    print('island written', flush=True)

for pid in ids:
    raw = os.path.join(OUT, f'close-{pid}-raw.png')
    blender('maquette.py', pid, raw, 1.0, 200)
    save(grade(raw, vignette=0.3), os.path.join(PUB, 'close', f'{pid}.webp'), 86)
    print('close-up written', pid, flush=True)
fingerprints()
print('ALL DONE', flush=True)
