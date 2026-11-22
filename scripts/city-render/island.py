# The island as one architect's model at night in a gallery (owner, 2026-11-21: "ship it ... this is
# daytime we need nighttime"), built in Blender from the site's own plan (plan.json) and rendered.
# Its stock is the close-ups' (stock.py): cork land on a pale veneer beach, a sea of deep blue resin,
# grey card streets on card pavements, basswood palms and beads for trees, every room's art laid as
# glazed tile, three white figures on every plot. The gallery is dark, a low warm spot on the middle
# of the town and a cool moon over the whole model, so what lights it at night is its own: the street
# lamps, the windows, the pools poured in their communities' colours and lit from within.
#
#   blender -b --factory-startup --python island.py -- <mode> <out.png> [scale] [samples]
#
#   mode  island         the whole island from the site's axonometric, framed as plan.json says
#         plate:<plotId> a quick look at one plot alone (for working on a building)
#   scale  multiplies the island frame's pixel size (1 = plan.json's width x height)
#
# Then grade.py adds the glow and writes webp. A building's close-up is maquette.py's. See README.md.
import bpy, json, math, os, sys
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kit
from kit import V, box, cyl, sphere, tube, mesh, rects, slab_from, ring_between, patio, stones, put, inked
import buildings
import stock

kit.ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
# every material the builders ask for, as the close-ups' stock; the island's cork at a coarser grain,
# its beach a paler veneer, its streets grey card. The swap also hands kit the owner's palms and
# street lamps (stock.palm, stock.lamp), so they are called as kit.palm and kit.lamp below.
stock.swap(lawn=lambda: stock.cork(30.0), sand=stock.pale, asphalt=stock.grey)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
MODE = argv[0] if argv else 'island'
OUT = argv[1] if len(argv) > 1 else os.path.join(HERE, 'out', 'island.png')
SCALE = float(argv[2]) if len(argv) > 2 else 1.0
SAMPLES = int(argv[3]) if len(argv) > 3 else 64
ONLY = MODE.split(':', 1)[1] if MODE.startswith('plate:') else None

plan = json.load(open(os.path.join(HERE, 'plan.json'), encoding='utf-8'))
G = plan['grid']
ZP = G['ZP']
PW, PD = G['PW'], G['PD']
ROAD_HALF, PAVE_W, JR = G['ROAD_HALF'], G['PAVE_W'], G['JUNCTION_R']
ROADS = [{'id': r['id'], 'pts': [tuple(q) for q in r['pts']], 'dead': r['dead']} for r in plan['roads']]
JUNCTIONS = [tuple(j) for j in plan['junctions']]


# ---------- the town's ground: where each plot stands, where the streets run ----------
def site_xy(p, fx, fy):
    """A point of a plot's frame (where its builder makes it), where the plot stands on the island (lib/city/plan.ts onSite)."""
    s = p['site']
    dx, dy = fx - (p['x0'] + PW / 2), fy - (p['y0'] + PD / 2)
    c, sn = math.cos(s['rot']), math.sin(s['rot'])
    return (s['x'] + dx * c - dy * sn, s['y'] + dx * sn + dy * c)


def site_matrix(p):
    """Carries everything built in a plot's frame to its site. Blender's y is the site's turned over, so the site's turn goes the other way about z."""
    s = p['site']
    return Matrix.Translation(V(s['x'], s['y'], 0)) @ Matrix.Rotation(-s['rot'], 4, 'Z') @ Matrix.Translation(-V(p['x0'] + PW / 2, p['y0'] + PD / 2, 0))


def _seg_d(q, a, b):
    abx, aby = b[0] - a[0], b[1] - a[1]
    l2 = abx * abx + aby * aby
    u = 0.0 if l2 == 0 else max(0.0, min(1.0, ((q[0] - a[0]) * abx + (q[1] - a[1]) * aby) / l2))
    return math.hypot(q[0] - a[0] - abx * u, q[1] - a[1] - aby * u)


def road_d(q, roads=None):
    """How far a point is from the nearest centre line."""
    best = 1e9
    for r in (ROADS if roads is None else roads):
        pts = r['pts']
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            if min(abs(q[0] - a[0]), abs(q[0] - b[0])) > best + 1 or min(abs(q[1] - a[1]), abs(q[1] - b[1])) > best + 1:
                continue
            best = min(best, _seg_d(q, a, b))
    return best


def plot_ground(p, grow=0.0):
    return [site_xy(p, x, y) for (x, y) in ((p['x0'] - grow, p['y0'] - grow), (p['x0'] + PW + grow, p['y0'] - grow),
                                             (p['x0'] + PW + grow, p['y0'] + PD + grow), (p['x0'] - grow, p['y0'] + PD + grow))]
scene = bpy.context.scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
kit.INK = None                 # a model is a photograph: no drawn line

stock.cycles(scene, SAMPLES, threshold=0.02, bounces=(6, 2, 3, 6, 12))

# ---------- the sea, the reef, the beach, the land ----------
def sea():
    """The sea in a model: a sheet of deep blue resin, glossy, barely lit."""
    return kit.mat('m sea', (0.006, 0.014, 0.03), rough=0.03, coat=1.0, emit=(0.02, 0.06, 0.14), strength=0.04)

coast = {k: [tuple(p) for p in v] for k, v in plan['coast'].items()}
cx0, cy0 = G['ISLAND_CX'], G['ISLAND_CY']
rects('sea', [((cx0 - 160, cy0 - 160), (cx0 + 160, cy0 + 160), -0.32)], sea())


def shallows():
    """The lagoon: the same resin, tinted teal over the shallows and deepening to the sea's blue."""
    m = bpy.data.materials.new('m lagoon')
    nt, b = kit._bsdf(m)
    at = nt.nodes.new('ShaderNodeAttribute')
    at.attribute_name = 'shore'
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'EASE'
    ramp.color_ramp.elements[0].color = (0.006, 0.014, 0.03, 1)
    ramp.color_ramp.elements[1].color = (0.03, 0.13, 0.15, 1)
    nt.links.new(at.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    key = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
    nt.links.new(ramp.outputs['Color'], b.inputs[key])
    b.inputs['Emission Strength'].default_value = 0.14
    b.inputs['Roughness'].default_value = 0.03
    kit._set(b, ('Coat Weight', 'Clearcoat'), 1.0)
    kit._set(b, ('Coat Roughness',), 0.01)
    return m


# the lagoon runs right up to the sand (it stopped short, and the dark sea showed as a black band)
lagoon = ring_between('lagoon', coast['1.26'], coast['1'], -0.31, -0.31, shallows())
_shore = lagoon.data.attributes.new('shore', 'FLOAT', 'POINT')
for _i in range(len(lagoon.data.vertices)):
    _shore.data[_i].value = 0.0 if _i < len(coast['1.26']) else 1.0
ring_between('beach', coast['1'], coast['0.95'], -0.3, 0.0, kit.sand())
slab_from('land', coast['0.95'], -0.3, 0.0, kit.lawn())
# the island's own growth, as a model maker plants it: turned basswood beads everywhere the town is not
import random as _r
def _inside(poly, x, y):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c
_shrub_meshes = []
_tex = bpy.data.textures.new('shrub noise', 'CLOUDS')
_tex.noise_scale = 0.3
for k in range(4):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1.0)
    t = bpy.context.active_object
    dm = t.modifiers.new('d', 'DISPLACE')
    dm.texture = _tex
    dm.strength = 0.45
    t.location = (k * 7.0, 0, 0)
    bpy.ops.object.modifier_apply(modifier='d')
    for poly in t.data.polygons:
        poly.use_smooth = True
    t.data.materials.append(stock.basswood())
    _shrub_meshes.append(t.data)
    bpy.data.objects.remove(t, do_unlink=True)
_rnd = _r.Random(11)
_land = coast['0.95']
_plot_ground = [plot_ground(p, 0.6) for p in plan['plots']]
_shrubs = 0
for _ in range(2600):
    x = cx0 + _rnd.uniform(-36, 36)
    y = cy0 + _rnd.uniform(-30, 30)
    if not _inside(_land, x, y):
        continue
    if any(_inside(g, x, y) for g in _plot_ground):
        continue
    if abs(x - G['PIER_X']) < 2.6 and y > G['PIER_Y0'] - 6:
        continue
    if road_d((x, y)) < ROAD_HALF + PAVE_W + 0.5:
        continue
    o = bpy.data.objects.new('shrub', _shrub_meshes[_shrubs % 4])
    put(o)
    s = _rnd.uniform(0.28, 0.75)
    o.location = V(x, y, s * 0.3)
    o.scale = tuple(v * 0.85 for v in (s * _rnd.uniform(0.9, 1.4), s, s * _rnd.uniform(0.55, 0.85)))
    o.rotation_euler = (0, 0, _rnd.uniform(0, 6.3))
    _shrubs += 1
print('shrubs', _shrubs)

# ---------- streets ----------
def _frame(pts, i, loop):
    """A centre line's heading and its left at point i (the site's left: a quarter turn from the heading)."""
    n = len(pts)
    a = pts[i - 1] if i > 0 else (pts[n - 2] if loop else pts[i])
    b = pts[i + 1] if i < n - 1 else (pts[1] if loop else pts[i])
    tx, ty = b[0] - a[0], b[1] - a[1]
    l = math.hypot(tx, ty) or 1.0
    return (tx / l, ty / l), (-ty / l, tx / l)


def _faced_up(o):
    for f in o.data.polygons:
        if f.normal.z < 0:
            f.flip()
    o.data.update()
    return o


def strip(name, rows, material, z):
    """A band of quads through rows of (left, right) site points, faced up."""
    verts, faces = [], []
    for k, (l, r) in enumerate(rows):
        verts += [V(l[0], l[1], z), V(r[0], r[1], z)]
        if k:
            n = len(verts)
            faces.append((n - 4, n - 3, n - 1, n - 2))
    return _faced_up(kit.mesh(name, verts, faces, material))


def bars(name, items, material, z):
    """Flat bars: (middle, heading, length along it, width across it)."""
    verts, faces = [], []
    for (q, (tx, ty), ln, wd) in items:
        nx, ny = -ty, tx
        n = len(verts)
        for (a, b) in ((-ln / 2, -wd / 2), (ln / 2, -wd / 2), (ln / 2, wd / 2), (-ln / 2, wd / 2)):
            verts.append(V(q[0] + tx * a + nx * b, q[1] + ty * a + ny * b, z))
        faces.append((n, n + 1, n + 2, n + 3))
    return _faced_up(kit.mesh(name, verts, faces, material))


asphalt, kerb_stone = kit.asphalt(), kit.paving()
dash_q = []
for k, r in enumerate(ROADS):
    pts = r['pts']
    loop = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 1e-6
    frames = [_frame(pts, i, loop) for i in range(len(pts))]
    # the asphalt, each street a hair above the last where two meet
    strip(f'road {r["id"]}', [((p[0] + n[0] * ROAD_HALF, p[1] + n[1] * ROAD_HALF), (p[0] - n[0] * ROAD_HALF, p[1] - n[1] * ROAD_HALF))
                              for p, (t, n) in zip(pts, frames)], asphalt, 0.01 + 0.0015 * k)
    # its pavements, both sides, stopping short wherever another street's asphalt comes in
    others = [o for o in ROADS if o is not r]
    for side in (1, -1):
        run = []
        for p, (t, n) in zip(pts, frames):
            inner = (p[0] + n[0] * side * ROAD_HALF, p[1] + n[1] * side * ROAD_HALF)
            outer = (p[0] + n[0] * side * (ROAD_HALF + PAVE_W), p[1] + n[1] * side * (ROAD_HALF + PAVE_W))
            clear = all(road_d(q, others) > ROAD_HALF + 0.08 for q in (inner, outer)) and all(math.hypot(p[0] - j[0], p[1] - j[1]) > ROAD_HALF + 0.3 for j in JUNCTIONS)
            if clear:
                run.append((inner, outer))
                continue
            if len(run) > 1:
                strip('pavement', run, kerb_stone, 0.045)
            run = []
        if len(run) > 1:
            strip('pavement', run, kerb_stone, 0.045)
    # the dashed centre line, broken through every junction and short of every turning circle
    walked = 0.0
    nxt = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        while seg > 0 and nxt <= walked + seg:
            u = (nxt - walked) / seg
            q = (a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u)
            nxt += 1.1
            if any(math.hypot(q[0] - j[0], q[1] - j[1]) < JR for j in JUNCTIONS):
                continue
            if (r['dead'][0] and math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]) < 1.8) or (r['dead'][1] and math.hypot(q[0] - pts[-1][0], q[1] - pts[-1][1]) < 1.8):
                continue
            dash_q.append((q, ((b[0] - a[0]) / seg, (b[1] - a[1]) / seg), 0.55, 0.07))
        walked += seg
    for end, dead in zip((pts[0], pts[-1]), r['dead']):
        if dead:
            cyl('turning circle', end[0], end[1], -0.02, ROAD_HALF + 0.75, 0.035 + 0.0015 * k, asphalt, verts=48)
for j in JUNCTIONS:
    cyl('junction', j[0], j[1], -0.02, ROAD_HALF + 0.35, 0.045, asphalt, verts=48)
bars('road paint', dash_q, kit.mat('road paint', (0.6, 0.57, 0.5), rough=0.5, emit=kit.CREAM, strength=0.12), 0.03)
# a crossing wherever a walk goes over a street: five bars along the street, set across it
zq = []
for z in plan['zebras']:
    t = (math.cos(z['a']), math.sin(z['a']))
    n = (-t[1], t[0])
    for j in range(5):
        o = -ROAD_HALF + 0.2 + j * 0.44 + 0.11
        zq.append(((z['x'] + n[0] * o, z['y'] + n[1] * o), t, 0.6, 0.22))
bars('crossings', zq, kit.mat('crossing paint', (0.6, 0.57, 0.5), rough=0.5, emit=kit.CREAM, strength=0.12), 0.05)
# the pier, its posts in the sea
pv = G['PIER_X']
(box('pier', pv - 1.2, G['PIER_Y0'], -0.12, 2.4, G['PIER_Y1'] - G['PIER_Y0'], 0.14, kit.wood()))
for k in range(int((G['PIER_Y1'] - G['PIER_Y0']) / 1.5) + 1):
    for dx in (-1.1, 1.1):
        cyl('pier post', pv + dx, G['PIER_Y0'] + k * 1.5, -0.6, 0.06, 0.75, kit.wood(), verts=8)
# the harbour (owner, 2026-11-21: "Palms, lamps, harbour"): three lamps along the pier, so the night
# shows it; a kayak rack, a dock cart, fishing gear and cleats on the deck; a tender moored alongside,
# two buoys off the end. Only what a light falls on reads at night.
if ONLY is None:
    y0p, y1p, deck = G['PIER_Y0'], G['PIER_Y1'], 0.02
    for (lx, ly) in ((pv - 0.95, y0p + 1.2), (pv + 0.95, y0p + 5.2), (pv - 0.95, y1p - 0.4)):
        kit.lamp(lx, ly)
    stock.place('kayak-rack', pv - 0.55, y0p + 2.6, deck, 1.0, 'l', rot=math.pi / 2)
    stock.place('dock-cart', pv + 0.5, y0p + 4.8, deck, 0.6, 'l', rot=0.3)
    stock.place('fishing-gear', pv - 0.5, y1p - 1.3, deck, 0.62, 'l', rot=1.2)
    for yy in (y0p + 1.5, y0p + 4.0, y0p + 6.5, y1p - 0.6):
        for xx in (pv - 1.08, pv + 1.08):
            stock.place('cleat', xx, yy, deck, 0.16, 'l', rot=math.pi / 2)
    stock.place('tender', pv + 2.4, y0p + 5.5, -0.3, 1.5, 'l', rot=math.pi / 2)
    stock.place('buoys', pv - 2.2, y1p - 0.3, -0.31, 0.55, 'h')
    stock.place('buoys', pv + 2.6, y1p + 0.8, -0.31, 0.5, 'h', rot=1.0)

# ---------- plots, pools, gardens ----------
# each room's art laid as glazed tile, coarser than in its close-up so it reads from above, lit for the night
art = {rid: stock.mosaic(rid, src, tiles=64, glow=0.6) for rid, src in plan['art'].items()}
plots = [p for p in plan['plots'] if ONLY is None or p['id'] == ONLY]

def pool(p):
    pl = p['pool']
    pts = [tuple(q) for q in pl['pts']]
    col = pl['water']
    if p['civic'] == 'lot':
        # dry: the outline only, as the site draws it until a coin moves in
        tube('dry pool', [(x, y, ZP + 0.02) for (x, y) in pts] + [pts[0] + (ZP + 0.02,)], 0.02, kit.glow(kit.CREAM, 1.5, 'dry line'))
        return
    # poured resin in its community's colour, lit from within: the brightest thing on a plot at night
    slab_from('water', pts, ZP - 0.02, ZP + 0.035, stock.resin(col, glow=1.7))
    (tube('coping', [(x, y, ZP + 0.06) for (x, y) in pts] + [pts[0] + (ZP + 0.06,)], 0.07, kit.stone()))
    if pl['lanes']:
        x0, x1 = pl['cx'] - pl['rw'] / 2, pl['cx'] + pl['rw'] / 2
        y0 = pl['cy'] - pl['rd'] / 2
        for i in range(1, 6):
            yy = y0 + i * pl['rd'] / 6
            for j in range(int(pl['rw'] / 0.16)):
                xx = x0 + 0.08 + j * 0.16
                sphere('float', xx, yy, ZP + 0.07, 0.035, kit.mat('float red', (0.8, 0.12, 0.08), rough=0.4) if (j // 3) % 2 else kit.mat('float white', (0.9, 0.9, 0.88), rough=0.4), seg=6)
        sphere('buoy', x0 + pl['rw'] * 0.55, pl['cy'] + 0.5, ZP + 0.1, 0.12, kit.glow((1.0, 0.75, 0.2), 2.5, 'buoy'), seg=12)
    if pl['jet']:
        cyl('jet', pl['cx'], pl['cy'], ZP + 0.03, 0.035, 0.7, stock.rod(), r2=0.012, verts=16)
    if pl['lilies']:
        for (dx, dy, r) in ((-0.3, -1.1, 0.26), (0.25, 0.4, 0.2), (-0.2, 1.2, 0.23), (0.35, -0.3, 0.16)):
            cyl('lily', pl['cx'] + dx, pl['cy'] + dy, ZP + 0.06, r, 0.01, stock.basswood(), verts=20)

tops = {}
for p in plots:
    _before = set(bpy.data.objects)
    x0, y0 = p['x0'], p['y0']
    box('plot', x0, y0, 0.0, PW, PD, ZP, kit.terrazzo())
    inner = kit.lawn() if p['kind'] == 'room' else stock.scored()
    ground = box('plot inner', x0 + 0.3, y0 + 0.3, ZP, PW - 0.6, PD - 0.6, 0.004, inner)
    if p['pool']:
        pool(p)
    if p['garden']:
        stones(p['garden'])
    if p['kind'] == 'room':
        patio(x0 + 2.5, y0 + 4.75, p['pool']['water'] if p['pool'] else p['acc'], p['id'])
    A = art.get(p['mural']) if p['mural'] else None
    tops[p['id']] = buildings.BUILDERS[p['piece']](p, A)
    # its own palms and lamps stand in its frame too
    for t in plan['palms']:
        if t['plot'] == p['id']:
            kit.palm(t['x'], t['y'], t['h'] * 0.95, t['lean'], t['ph'])
    for (x, y) in plan['lamps']:
        if x0 <= x <= x0 + PW and y0 <= y <= y0 + PD:
            kit.lamp(x, y)
    # three white figures on its open ground, turned toward its building, as its close-up has
    bpy.context.view_layer.update()
    stock.figures(scene, p, ZP, PW, PD, lambda ob, n=ground.name: ob.name == n)
    # then the whole plot is turned and moved to where it stands on the island
    bpy.context.view_layer.update()
    M = site_matrix(p)
    for o in bpy.data.objects:
        if o not in _before and o.parent is None:
            o.matrix_world = M @ o.matrix_world
    print('built', p['id'], p['piece'])

if ONLY is None:
    # the streets' and the shore's palms, and the street lamps
    for t in plan['palms']:
        if t['plot'] is None:
            kit.palm(t['x'], t['y'], t['h'] * 0.95, t['lean'], t['ph'])
    for (x, y) in plan['streetLamps']:
        kit.lamp(x, y)

# palms, the lighthouse's brass, and every light the builders made, at a model's strength; the street
# lamps' heads a little softer than in a close-up, where one stands close, so the island's many read as dots
stock.dress(glow={'lamp glow': 12.0, 'buoy': 0.6, 'dry line': 0.4})

# ---------- camera ----------
cam = bpy.data.cameras.new('cam')
cam.type = 'ORTHO'
cam.clip_end = 600
co = bpy.data.objects.new('cam', cam)
put(co)
co.rotation_euler = (math.radians(54.7356), 0, math.radians(45))
forward_back = co.rotation_euler.to_matrix() @ Vector((0, 0, 1))
R = plan['render']
if MODE == 'island':
    cam.sensor_fit = 'HORIZONTAL'
    # the site draws x - y at cos 30 per unit; a true isometric camera at 1/sqrt 2: the frame's width in Blender units
    cam.ortho_scale = R['span'][0] / math.sqrt(1.5)
    look = V(*R['center'])
    scene.render.resolution_x = round(R['width'] * SCALE)
    scene.render.resolution_y = round(R['height'] * SCALE)
else:
    pid = MODE.split(':', 1)[1]
    p = next(q for q in plan['plots'] if q['id'] == pid)
    cam.sensor_fit = 'VERTICAL'
    cam.ortho_scale = 12.5
    look = V(p['site']['x'], p['site']['y'], 2.2)
    scene.render.resolution_x = round(900 * SCALE)
    scene.render.resolution_y = round(900 * SCALE)
co.location = look + forward_back * 200
scene.camera = co

# ---------- the gallery at night ----------
# The room is dark: a low warm spot on the middle of the town, a cool rim from the far side, a faint
# fill and a moon, none of them seen in the glossy resin sea; what lights the model is its own.
world = bpy.data.worlds.new('gallery')
scene.world = world
world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
bg.inputs['Color'].default_value = (0.0012, 0.0016, 0.003, 1)
bg.inputs['Strength'].default_value = 1.0
target = V(cx0, cy0 + 2, 0)
flat = Vector((forward_back.x, forward_back.y, 0)).normalized()     # the visitor's side, on the ground
side = Vector((-flat.y, flat.x, 0))
up = Vector((0, 0, 1))


def gallery(kind, name, at, energy, colour, **kw):
    l = bpy.data.lights.new(name, kind)
    l.energy = energy
    l.color = colour
    for k, v in kw.items():
        setattr(l, k, v)
    o = bpy.data.objects.new(name, l)
    put(o)
    o.location = at
    o.rotation_euler = (target - at).to_track_quat('-Z', 'Y').to_euler()
    o.visible_glossy = False
    o.visible_camera = False
    return o


D = 110
gallery('SPOT', 'gallery key', target + flat * D * 0.35 + side * D * 0.45 + up * D * 0.8, 1.2e4, (1.0, 0.9, 0.78),
        spot_size=math.radians(40), spot_blend=0.9, shadow_soft_size=1.5)
gallery('SPOT', 'gallery rim', target - flat * D * 0.6 - side * D * 0.3 + up * D * 0.6, 1.2e4, (0.6, 0.72, 1.0),
        spot_size=math.radians(60), spot_blend=0.8, shadow_soft_size=4.0)
gallery('AREA', 'gallery fill', target + flat * D * 0.7 - side * D * 0.6 + up * D * 0.4, 2e3, (0.85, 0.9, 1.0), size=40.0)
gallery('SUN', 'gallery moon', target, 0.12, (0.55, 0.66, 1.0), angle=math.radians(1.5)).rotation_euler = (math.radians(52), 0, math.radians(-25))

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print('WROTE', OUT)
