# The island at night, built in Blender from the site's own plan (plan.json), and rendered.
#
#   blender -b --factory-startup --python island.py -- <mode> <out.png> [scale] [samples]
#
#   mode  island         the whole island from the site's axonometric, framed as plan.json says
#         close:<plotId> that plot's building close up, its art at full size
#         plate:<plotId> a quick look at one plot alone (for working on a building)
#   scale  multiplies the island frame's pixel size (1 = plan.json's width x height)
#
# Then grade.py adds the glow and writes webp. See README.md.
import bpy, json, math, os, sys
from mathutils import Vector

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
SX, SY, RW, NC, NR, XMAX, YMAX = G['SX'], G['SY'], G['RW'], G['NC'], G['NR'], G['XMAX'], G['YMAX']
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
lagoon = kit.mat('lagoon', (0.008, 0.04, 0.05), rough=0.08, emit=(0.02, 0.16, 0.18), strength=0.07)
ring_between('lagoon', coast['1.26'], coast['1.03'], -0.31, -0.31, lagoon)
tube('reef', [(x, y, -0.3) for (x, y) in coast['1.12']] + [coast['1.12'][0] + (-0.3,)], 0.03, kit.mat('reef', (0.2, 0.5, 0.5), emit=(0.25, 0.75, 0.75), strength=0.8))
tube('foam', [(x, y, -0.27) for (x, y) in coast['1.03']] + [coast['1.03'][0] + (-0.27,)], 0.05, kit.mat('foam', (0.9, 0.95, 1.0), emit=(0.85, 0.92, 1.0), strength=1.2))
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
_shrubs = 0
for _ in range(2600):
    x = cx0 + _rnd.uniform(-36, 36)
    y = cy0 + _rnd.uniform(-30, 30)
    if not _inside(_land, x, y):
        continue
    if -2.2 < x < XMAX + 4.6 and -2.2 < y < YMAX + 4.6:
        continue
    if abs(x - (G['PIER_AVENUE'] * SX + RW / 2)) < 2.6 and y > YMAX:
        continue
    o = bpy.data.objects.new('shrub', _shrub_meshes[_shrubs % 4])
    put(o)
    s = _rnd.uniform(0.28, 0.75)
    o.location = V(x, y, s * 0.3)
    o.scale = (s * _rnd.uniform(0.9, 1.4), s, s * _rnd.uniform(0.55, 0.85))
    o.rotation_euler = (0, 0, _rnd.uniform(0, 6.3))
    _shrubs += 1
print('shrubs', _shrubs)

# ---------- roads ----------
Hr = lambda i: i * SY + RW / 2
Vr = lambda k: k * SX + RW / 2
road_q, dash_q = [], []
for i in range(NR + 1):
    road_q.append(((-0.8, i * SY), (XMAX + 2.0, i * SY + RW), 0.01))
    x = -0.8
    while x < XMAX + 2.0:
        dash_q.append(((x, Hr(i) - 0.035), (min(x + 0.55, XMAX + 2.0), Hr(i) + 0.035), 0.016))
        x += 1.1
for c in range(NC + 1):
    end = G['PIER_Y0'] if c == G['PIER_AVENUE'] else YMAX + 2.0
    road_q.append(((c * SX, -0.8), (c * SX + RW, end), 0.012))
    y = -0.8
    stop = G['PIER_Y1'] if c == G['PIER_AVENUE'] else YMAX + 2.0
    while y < stop:
        if not any(abs(y + 0.27 - Hr(i)) < RW / 2 for i in range(NR + 1)):
            dash_q.append(((Vr(c) - 0.035, y), (Vr(c) + 0.035, min(y + 0.55, stop)), 0.018))
        y += 1.1
rects('roads', road_q, kit.asphalt())
rects('road paint', dash_q, kit.mat('road paint', kit.CREAM, rough=0.5, emit=kit.CREAM, strength=0.35))
for i in range(NR + 1):
    cyl('turning circle', XMAX + 2.3, Hr(i), -0.02, 1.55, 0.03, kit.asphalt(), verts=48)
for c in range(NC + 1):
    if c != G['PIER_AVENUE']:
        cyl('turning circle', Vr(c), YMAX + 2.3, -0.02, 1.55, 0.03, kit.asphalt(), verts=48)
zq = []
for z in plan['zebras']:
    for j in range(5):
        o = 0.2 + j * 0.44
        if z['kind'] == 'v':
            zq.append(((z['i'] * SX + o, z['at'] - 0.3), (z['i'] * SX + o + 0.22, z['at'] + 0.3), 0.02))
        else:
            zq.append(((z['at'] - 0.3, z['i'] * SY + o), (z['at'] + 0.3, z['i'] * SY + o + 0.22), 0.02))
rects('crossings', zq, kit.mat('crossing paint', (0.75, 0.72, 0.62), rough=0.5, emit=kit.CREAM, strength=0.2))
# the pier, its posts in the sea
pv = Vr(G['PIER_AVENUE'])
(box('pier', pv - 1.2, G['PIER_Y0'], -0.12, 2.4, G['PIER_Y1'] - G['PIER_Y0'], 0.14, kit.wood()))
for k in range(int((G['PIER_Y1'] - G['PIER_Y0']) / 1.5) + 1):
    for dx in (-1.1, 1.1):
        cyl('pier post', pv + dx, G['PIER_Y0'] + k * 1.5, -0.6, 0.06, 0.75, kit.wood(), verts=8)

# ---------- plots, pools, gardens ----------
PW, PD = G['PW'], G['PD']
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
    if pl['lanes']:
        x0, x1 = pl['cx'] - pl['rw'] / 2, pl['cx'] + pl['rw'] / 2
        y0 = pl['cy'] - pl['rd'] / 2
        for i in range(1, 6):
            yy = y0 + i * pl['rd'] / 6
            for j in range(int(pl['rw'] / 0.16)):
                xx = x0 + 0.08 + j * 0.16
                sphere('float', xx, yy, ZP + 0.07, 0.035, kit.mat('float red', (0.8, 0.12, 0.08), rough=0.4) if (j // 3) % 2 else kit.mat('float white', (0.9, 0.9, 0.88), rough=0.4), seg=6)
        sphere('buoy', x0 + pl['rw'] * 0.55, pl['cy'] + 0.5, ZP + 0.1, 0.12, kit.glow((1.0, 0.75, 0.2), 6.0, 'buoy'), seg=12)
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
    x0, y0 = p['x0'], p['y0']
    box('plot', x0, y0, 0.0, PW, PD, ZP, kit.terrazzo())
    inner = kit.lawn() if p['kind'] == 'room' else kit.paving()
    box('plot inner', x0 + 0.3, y0 + 0.3, ZP, PW - 0.6, PD - 0.6, 0.004, inner)
    if p['pool']:
        pool(p)
    if p['garden']:
        stones(p['garden'])
    if p['kind'] == 'room':
        patio(x0 + 2.5, y0 + 4.75, p['pool']['water'] if p['pool'] else p['acc'])
    A = art.get(p['mural']) if p['mural'] else None
    tops[p['id']] = buildings.BUILDERS[p['piece']](p, A)
    print('built', p['id'], p['piece'])

for t in plan['palms']:
    if ONLY is None or t['plot'] == ONLY:
        palm(t['x'], t['y'], t['h'] * 0.95, t['lean'], t['ph'])
if ONLY is None:
    for (x, y) in plan['lamps']:
        lamp(x, y)
else:
    p0 = plots[0]
    for (x, y) in plan['lamps']:
        if p0['x0'] <= x <= p0['x0'] + PW and p0['y0'] <= y <= p0['y0'] + PD:
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
bg.inputs['Color'].default_value = (*kit.lin(kit.BG), 1)
bg.inputs['Strength'].default_value = 1.0

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
    top = tops.get(pid, 4.0)
    cam.sensor_fit = 'VERTICAL'
    if MODE.startswith('close:'):
        cam.ortho_scale = max(7.0, top * 1.05 + 4.2)
        look = V(p['X'] + 1.7, p['Y'] + 1.5, top * 0.48)
        scene.render.resolution_x = round(1000 * SCALE)
        scene.render.resolution_y = round(1250 * SCALE)
    else:
        cam.ortho_scale = 12.5
        look = V(p['x0'] + PW / 2, p['y0'] + PD / 2, 2.2)
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
