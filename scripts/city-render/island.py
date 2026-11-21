# The island at night, built in Blender from the site's own plan (plan.json), and rendered.
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
from kit import V, box, cyl, sphere, tube, mesh, rects, slab_from, ring_between, light, lamp, patio, stones, palm, put, inked
import buildings

kit.ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
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
kit.INK = kit.collection('ink')

# ---------- render settings ----------
engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in engines else 'BLENDER_EEVEE'
ee = scene.eevee
for name, val in (('taa_render_samples', SAMPLES), ('use_raytracing', True), ('use_shadows', True), ('use_fast_gi', True), ('fast_gi_distance', 4.0),
                  ('shadow_ray_count', 2), ('shadow_step_count', 8), ('volumetric_end', 200.0)):
    try:
        setattr(ee, name, val)
    except Exception as ex:
        print('skip', name, ex)
vs = scene.view_settings
vs.view_transform = 'AgX'
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_depth = '16'

# ---------- the sea, the reef, the beach, the land ----------
def sea():
    m = kit.bpy.data.materials.new('sea')
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (0.004, 0.012, 0.022, 1)
    b.inputs['Roughness'].default_value = 0.06
    nz = nt.nodes.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 0.9
    nz.inputs['Detail'].default_value = 6.0
    bp = nt.nodes.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.18
    nt.links.new(nz.outputs['Fac'], bp.inputs['Height'])
    nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
    return m

coast = {k: [tuple(p) for p in v] for k, v in plan['coast'].items()}
cx0, cy0 = G['ISLAND_CX'], G['ISLAND_CY']
rects('sea', [((cx0 - 160, cy0 - 160), (cx0 + 160, cy0 + 160), -0.32)], sea())


def shallows():
    """The lagoon: turquoise over the sand at the shore, deepening to night at the reef (it read as one flat teal band)."""
    m = bpy.data.materials.new('shallows')
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    at = nt.nodes.new('ShaderNodeAttribute')
    at.attribute_name = 'shore'
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'EASE'
    ramp.color_ramp.elements[0].color = (0.002, 0.012, 0.022, 1)
    ramp.color_ramp.elements[1].color = (0.02, 0.15, 0.16, 1)
    nt.links.new(at.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    key = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
    nt.links.new(ramp.outputs['Color'], b.inputs[key])
    b.inputs['Emission Strength'].default_value = 0.14
    b.inputs['Roughness'].default_value = 0.05
    nz = nt.nodes.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 1.3
    nz.inputs['Detail'].default_value = 6.0
    bp = nt.nodes.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.12
    nt.links.new(nz.outputs['Fac'], bp.inputs['Height'])
    nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
    return m


def broken(name, colour, strength, scale):
    """A line of light broken as surf is: lit where a noise rises over its middle, water between (they read as drawn lines)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nz = nt.nodes.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = scale
    nz.inputs['Detail'].default_value = 3.0
    nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeMapRange')
    ramp.inputs['From Min'].default_value = 0.36
    ramp.inputs['From Max'].default_value = 0.72
    nt.links.new(nz.outputs['Fac'], ramp.inputs['Value'])
    mul = nt.nodes.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = strength
    nt.links.new(ramp.outputs['Result'], mul.inputs[0])
    b.inputs['Base Color'].default_value = (0.01, 0.05, 0.06, 1)
    key = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
    b.inputs[key].default_value = (*colour, 1)
    nt.links.new(mul.outputs['Value'], b.inputs['Emission Strength'])
    b.inputs['Roughness'].default_value = 0.3
    return m


# the lagoon runs right up to the sand (it stopped short, and the dark sea showed as a black band)
lagoon = ring_between('lagoon', coast['1.26'], coast['1'], -0.31, -0.31, shallows())
_shore = lagoon.data.attributes.new('shore', 'FLOAT', 'POINT')
for _i in range(len(lagoon.data.vertices)):
    _shore.data[_i].value = 0.0 if _i < len(coast['1.26']) else 1.0
# one soft line of surf off the beach, rising and falling along it; no reef line (both read as drawn contours)
tube('foam', [(x, y, -0.28) for (x, y) in coast['1.03']] + [coast['1.03'][0] + (-0.28,)], 0.06, broken('foam', (0.85, 0.93, 1.0), 1.0, 0.7))
ring_between('beach', coast['1'], coast['0.95'], -0.3, 0.0, kit.sand())
slab_from('land', coast['0.95'], -0.3, 0.0, kit.lawn())
# the island's own growth: shrubs everywhere the town is not, thicker toward the shore
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
    t.data.materials.append(kit.mat(f'shrub {k}', ((0.02, 0.09, 0.04), (0.03, 0.12, 0.05), (0.04, 0.1, 0.03), (0.025, 0.08, 0.05))[k], rough=0.6))
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
    o.scale = (s * _rnd.uniform(0.9, 1.4), s, s * _rnd.uniform(0.55, 0.85))
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
bars('road paint', dash_q, kit.mat('road paint', kit.CREAM, rough=0.5, emit=kit.CREAM, strength=0.35), 0.03)
# a crossing wherever a walk goes over a street: five bars along the street, set across it
zq = []
for z in plan['zebras']:
    t = (math.cos(z['a']), math.sin(z['a']))
    n = (-t[1], t[0])
    for j in range(5):
        o = -ROAD_HALF + 0.2 + j * 0.44 + 0.11
        zq.append(((z['x'] + n[0] * o, z['y'] + n[1] * o), t, 0.6, 0.22))
bars('crossings', zq, kit.mat('crossing paint', (0.75, 0.72, 0.62), rough=0.5, emit=kit.CREAM, strength=0.2), 0.05)
# the pier, its posts in the sea
pv = G['PIER_X']
(box('pier', pv - 1.2, G['PIER_Y0'], -0.12, 2.4, G['PIER_Y1'] - G['PIER_Y0'], 0.14, kit.wood()))
for k in range(int((G['PIER_Y1'] - G['PIER_Y0']) / 1.5) + 1):
    for dx in (-1.1, 1.1):
        cyl('pier post', pv + dx, G['PIER_Y0'] + k * 1.5, -0.6, 0.06, 0.75, kit.wood(), verts=8)

# ---------- plots, pools, gardens ----------
art = {rid: kit.art(rid, src) for rid, src in plan['art'].items()}
plots = [p for p in plan['plots'] if ONLY is None or p['id'] == ONLY]

def pool(p):
    pl = p['pool']
    pts = [tuple(q) for q in pl['pts']]
    col = pl['water']
    if p['civic'] == 'lot':
        # dry: the outline only, as the site draws it until a coin moves in
        tube('dry pool', [(x, y, ZP + 0.02) for (x, y) in pts] + [pts[0] + (ZP + 0.02,)], 0.02, kit.glow(kit.CREAM, 1.5, 'dry line'))
        return
    slab_from('water', pts, ZP - 0.02, ZP + 0.035, kit.water(col))
    (tube('coping', [(x, y, ZP + 0.06) for (x, y) in pts] + [pts[0] + (ZP + 0.06,)], 0.07, kit.stone()))
    # the pool's own light spills its colour over the coping and the lawn round it, as a lit pool does at night
    # set just under the surface, so the water never mirrors it as a white spot
    light('POINT', 'pool glow', (pl['cx'], pl['cy'], ZP - 0.05), 18 + 6 * pl['rw'] * pl['rd'], kit.lin(kit.hexrgb(col)), shadow=False, soft=0.6)
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
        tube('jet', [(pl['cx'], pl['cy'], ZP + 0.05), (pl['cx'], pl['cy'], ZP + 1.3)], 0.04, kit.glow((1.0, 0.85, 0.5), 8.0, 'jet'))
        for i in range(10):
            a = 2 * math.pi * i / 10
            for t in (0.3, 0.6, 0.85):
                sphere('drop', pl['cx'] + math.cos(a) * 0.55 * t, pl['cy'] + math.sin(a) * 0.55 * t, ZP + 1.3 - 1.2 * t * t, 0.02, kit.glow((1.0, 0.9, 0.7), 10.0, 'drop'), seg=6)
    if pl['lilies']:
        for (dx, dy, r) in ((-0.3, -1.1, 0.26), (0.25, 0.4, 0.2), (-0.2, 1.2, 0.23), (0.35, -0.3, 0.16)):
            cyl('lily', pl['cx'] + dx, pl['cy'] + dy, ZP + 0.06, r, 0.01, kit.mat('lily small', (0.1, 0.35, 0.15), rough=0.4), verts=20)

tops = {}
for p in plots:
    _before = set(bpy.data.objects)
    x0, y0 = p['x0'], p['y0']
    box('plot', x0, y0, 0.0, PW, PD, ZP, kit.terrazzo())
    inner = kit.lawn() if p['kind'] == 'room' else kit.paving()
    box('plot inner', x0 + 0.3, y0 + 0.3, ZP, PW - 0.6, PD - 0.6, 0.004, inner)
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
            palm(t['x'], t['y'], t['h'] * 0.95, t['lean'], t['ph'])
    for (x, y) in plan['lamps']:
        if x0 <= x <= x0 + PW and y0 <= y <= y0 + PD:
            lamp(x, y)
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
            palm(t['x'], t['y'], t['h'] * 0.95, t['lean'], t['ph'])
    for (x, y) in plan['streetLamps']:
        lamp(x, y)

# ---------- night ----------
light('SUN', 'moon', (0, 0, 40), 2.2, (0.55, 0.66, 1.0)).rotation_euler = (math.radians(52), 0, math.radians(-25))
bpy.data.lights['moon'].angle = math.radians(1.5)
c = V(cx0, cy0, 0)
fill = light('AREA', 'sky fill', (cx0 + 60, cy0 + 60, 70), 14000, (0.45, 0.58, 1.0), size=120, shadow=False)
fill.rotation_euler = (c - fill.location).to_track_quat('-Z', 'Y').to_euler()
world = bpy.data.worlds.new('night')
scene.world = world
world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
bg.inputs['Strength'].default_value = 1.0
# the night: the sheet's own dark overhead, a little lighter and bluer at the horizon
_wt = world.node_tree
_tc = _wt.nodes.new('ShaderNodeTexCoord')
_sep = _wt.nodes.new('ShaderNodeSeparateXYZ')
_wt.links.new(_tc.outputs['Generated'], _sep.inputs['Vector'])
_sky = _wt.nodes.new('ShaderNodeValToRGB')
_sky.color_ramp.interpolation = 'EASE'
_sky.color_ramp.elements[0].position = 0.0
_sky.color_ramp.elements[0].color = (0.018, 0.034, 0.06, 1)
_sky.color_ramp.elements[1].position = 0.35
_sky.color_ramp.elements[1].color = (*kit.lin(kit.BG), 1)
_wt.links.new(_sep.outputs['Z'], _sky.inputs['Fac'])
_wt.links.new(_sky.outputs['Color'], bg.inputs['Color'])

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

# ---------- the drawing set's cream line, on the architecture only ----------
try:
    scene.render.use_freestyle = True
    scene.render.line_thickness_mode = 'ABSOLUTE'
    scene.render.line_thickness = 1.25 * max(1.0, SCALE)
    ls = scene.view_layers[0].freestyle_settings.linesets[0]
    ls.select_by_visibility = True
    ls.select_by_collection = True
    ls.collection = kit.INK
    ls.select_by_edge_types = True
    ls.select_silhouette = True
    ls.select_border = True
    ls.select_crease = True
    ls.linestyle.color = kit.CREAM
    ls.linestyle.alpha = 0.38
except Exception as ex:
    print('freestyle skip', ex)

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print('WROTE', OUT)
