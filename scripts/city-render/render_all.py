# Renders what /city shows and writes it where the site serves it (frontend/public/city/).
#   python render_all.py [island] [close] [plotId ...]
# With no argument: the island, then every plot's close-up. Set BLENDER to Blender's exe if it is
# not at the default Windows path. Each frame is built from plan.json; see README.md.
import os, subprocess, sys, json, time
from PIL import Image
from grade import grade, save, sharpen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
PUB = os.path.join(ROOT, 'frontend', 'public', 'city')
OUT = os.path.join(HERE, 'out')
BLENDER = os.environ.get('BLENDER', r'C:\Program Files\Blender Foundation\Blender 5.0\blender.exe')
os.makedirs(os.path.join(PUB, 'close'), exist_ok=True)
os.makedirs(OUT, exist_ok=True)
plan = json.load(open(os.path.join(HERE, 'plan.json'), encoding='utf-8'))


def blender(script, mode, raw, scale, samples):
    t = time.time()
    log = subprocess.run([BLENDER, '-b', '--factory-startup', '--python', os.path.join(HERE, script), '--', mode, raw, str(scale), str(samples)],
                         capture_output=True, text=True)
    if 'WROTE' not in log.stdout:
        sys.stderr.write(log.stdout[-3000:] + log.stderr[-3000:])
        raise SystemExit(f'{mode}: no render')
    print(f'{mode} rendered in {time.time() - t:.0f}s', flush=True)


args = sys.argv[1:]
do_island = not args or 'island' in args
ids = [a for a in args if a not in ('island', 'close')]
if not args or 'close' in args:
    ids = ids or [p['id'] for p in plan['plots']]

if do_island:
    raw = os.path.join(OUT, 'island-raw.png')
    blender('island.py', 'island', raw, 1.0, 64)
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
print('ALL DONE', flush=True)
