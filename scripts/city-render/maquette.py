# A building's close-up, as an architect's model (owner, 2026-11-20: "Yes, all 20"): its plot cut
# from the island as a model block on a black plinth, every material swapped for a model maker's
# (basswood, white card, cork, walnut, brass, gloss resin), its art laid as glazed tile, white
# figures for scale, shot at eye level under gallery light against a blue-hour wall. The buildings
# are the island's own (buildings.py), so a close-up always shows the building the island shows.
#
#   blender -b --factory-startup --python maquette.py -- <plotId> <out.png> [scale] [samples]
#
#   scale  multiplies the frame's 1000 x 1250 pixels
# Then grade.py adds the glow and writes webp. See README.md.
import bpy, sys, os, math, json
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kit
kit.ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
kit.INK = None                 # a model is a photograph: no drawn line
from kit import V, lin, hexrgb

argv = sys.argv[sys.argv.index('--') + 1:]
PID = argv[0]
OUT = argv[1]
SCALE = float(argv[2]) if len(argv) > 2 else 1.0
SAMPLES = int(argv[3]) if len(argv) > 3 else 200

# Per plot: BAYLA's picture is a busy one, so its tiles are bigger (pixels of the picture per tile;
# the rest get 128 tiles down the picture's height). The treasury's gold pool, lit low and darker,
# so the hourglass over it reads.
TILE = {'bayla': 16}
POOL = {'treasury': (0.12, 0.3)}           # (glow, base): the default is (0.15, 0.38)

plan = json.load(open(os.path.join(HERE, 'plan.json'), encoding='utf-8'))
G = plan['grid']
ZP, PW, PD = G['ZP'], G['PW'], G['PD']
P = next(q for q in plan['plots'] if q['id'] == PID)
scene = bpy.context.scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)


# ---------- the model maker's materials ----------
def m_basswood():
    return kit._ramp_mat('m basswood', 4.0, 3.0, (0.56, 0.42, 0.27), (0.70, 0.55, 0.37), 0.55, stretch=(40, 40, 1.5), bump=0.02)


def m_jute():
    return kit._ramp_mat('m jute', 40.0, 3.0, (0.36, 0.26, 0.15), (0.52, 0.40, 0.25), 0.85, stretch=(0.3, 0.3, 6.0), bump=0.25)


def m_card():
    return kit.mat('m card', (0.6, 0.585, 0.555), rough=0.82)


def m_grey():
    return kit.mat('m grey card', (0.16, 0.16, 0.17), rough=0.8)


def m_walnut():
    return kit._ramp_mat('m walnut', 3.0, 5.0, (0.035, 0.02, 0.012), (0.085, 0.05, 0.03), 0.4, stretch=(40, 40, 1.5), coat=0.35)


def m_cork():
    return kit._ramp_mat('m cork', 90.0, 8.0, (0.27, 0.19, 0.11), (0.44, 0.33, 0.21), 0.9, bump=0.35)


def m_brass():
    return kit.mat('m brass', (0.92, 0.70, 0.38), rough=0.24, metal=1.0)


def m_zinc():
    return kit.mat('m zinc', (0.62, 0.63, 0.64), rough=0.32, metal=0.9)


def m_smoked():
    return kit.mat('m smoked', (0.02, 0.024, 0.03), rough=0.05, coat=1.0)


def m_resin(colour):
    """A pool in a model: poured gloss resin in its community's colour, lit from within."""
    name = f'm resin {colour}'
    if name in kit._mats:
        return kit._mats[name]
    c = lin(hexrgb(colour))
    strength, base = POOL.get(PID, (0.15, 0.38))
    m = kit.mat(name, tuple(v * base for v in c), rough=0.02, coat=1.0, emit=c, strength=strength)
    kit._set(next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), ('Coat Roughness',), 0.01)
    return m


SWAP = dict(wood=m_basswood, bamboo=m_basswood, thatch=m_jute, tin=m_zinc, stone=m_card, basalt=m_walnut, cream=m_card,
            brass=m_brass, terrazzo=m_card, paving=m_card, lawn=m_cork, sand=m_cork, dark_glass=m_smoked,
            shell=lambda acc: m_card(), painted=lambda acc, k=0.6: m_card())
import buildings
for k, f in SWAP.items():
    setattr(kit, k, f)
    if hasattr(buildings, k):
        setattr(buildings, k, f)


# ---------- the art as a glazed tile mosaic ----------
def mosaic(room_id, src, tile_px):
    """
    Each tile takes the picture's colour under its centre (a voronoi cell's position, divided back
    into the picture's UV), so both wrap_drum's and wrap_art's UVs give square tiles. Joints are
    sunk grout, every tile a little lighter or darker and set at its own slight tilt.
    """
    img = bpy.data.images.load(os.path.join(kit.ROOT, 'frontend', 'public', src.lstrip('/').replace('/', os.sep)), check_existing=True)
    iw, ih = img.size
    tile_px = tile_px or ih / 128
    m = bpy.data.materials.new(f'mosaic {room_id}')
    nt, b = kit._bsdf(m)
    L = nt.links.new
    tc = nt.nodes.new('ShaderNodeTexCoord')
    k = (iw / tile_px, ih / tile_px, 1.0)
    sc = nt.nodes.new('ShaderNodeVectorMath'); sc.operation = 'MULTIPLY'; sc.inputs[1].default_value = k
    L(tc.outputs['UV'], sc.inputs[0])
    vo = nt.nodes.new('ShaderNodeTexVoronoi'); vo.voronoi_dimensions = '2D'; vo.feature = 'F1'
    vo.inputs['Scale'].default_value = 1.0; vo.inputs['Randomness'].default_value = 0.7
    L(sc.outputs[0], vo.inputs['Vector'])
    ed = nt.nodes.new('ShaderNodeTexVoronoi'); ed.voronoi_dimensions = '2D'; ed.feature = 'DISTANCE_TO_EDGE'
    ed.inputs['Scale'].default_value = 1.0; ed.inputs['Randomness'].default_value = 0.7
    L(sc.outputs[0], ed.inputs['Vector'])
    back = nt.nodes.new('ShaderNodeVectorMath'); back.operation = 'DIVIDE'; back.inputs[1].default_value = k
    L(vo.outputs['Position'], back.inputs[0])
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img; tex.extension = 'MIRROR'; tex.interpolation = 'Linear'
    L(back.outputs[0], tex.inputs['Vector'])
    # grout: 0 in the joint, 1 on the tile
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = 0.025; mr.inputs['From Max'].default_value = 0.07
    L(ed.outputs['Distance'], mr.inputs['Value'])
    # each tile a little lighter or darker, as hand-glazed tile is
    bw = nt.nodes.new('ShaderNodeRGBToBW'); L(vo.outputs['Color'], bw.inputs[0])
    sh = nt.nodes.new('ShaderNodeMath'); sh.operation = 'MULTIPLY_ADD'; sh.inputs[1].default_value = 0.2; sh.inputs[2].default_value = 0.9
    L(bw.outputs[0], sh.inputs[0])
    tile = nt.nodes.new('ShaderNodeVectorMath'); tile.operation = 'SCALE'
    L(tex.outputs['Color'], tile.inputs[0]); L(sh.outputs[0], tile.inputs['Scale'])
    grout = (0.42, 0.40, 0.37)
    d = nt.nodes.new('ShaderNodeVectorMath'); d.operation = 'SUBTRACT'; d.inputs[1].default_value = grout
    L(tile.outputs[0], d.inputs[0])
    dm = nt.nodes.new('ShaderNodeVectorMath'); dm.operation = 'SCALE'
    L(d.outputs[0], dm.inputs[0]); L(mr.outputs['Result'], dm.inputs['Scale'])
    col = nt.nodes.new('ShaderNodeVectorMath'); col.operation = 'ADD'; col.inputs[1].default_value = grout
    L(dm.outputs[0], col.inputs[0])
    L(col.outputs[0], b.inputs['Base Color'])
    key = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
    L(col.outputs[0], b.inputs[key])
    b.inputs['Emission Strength'].default_value = 0.1
    rg = nt.nodes.new('ShaderNodeMath'); rg.operation = 'MULTIPLY_ADD'; rg.inputs[1].default_value = -0.7; rg.inputs[2].default_value = 0.85
    L(mr.outputs['Result'], rg.inputs[0]); L(rg.outputs[0], b.inputs['Roughness'])
    if 'Coat Weight' in b.inputs:
        L(mr.outputs['Result'], b.inputs['Coat Weight'])
        b.inputs['Coat Roughness'].default_value = 0.08
    # relief: joints sunk, every tile set at its own slight tilt
    loc = nt.nodes.new('ShaderNodeVectorMath'); loc.operation = 'SUBTRACT'
    L(sc.outputs[0], loc.inputs[0]); L(vo.outputs['Position'], loc.inputs[1])
    dr = nt.nodes.new('ShaderNodeVectorMath'); dr.operation = 'SUBTRACT'; dr.inputs[1].default_value = (0.5, 0.5, 0.5)
    L(vo.outputs['Color'], dr.inputs[0])
    dot = nt.nodes.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
    L(loc.outputs[0], dot.inputs[0]); L(dr.outputs[0], dot.inputs[1])
    h = nt.nodes.new('ShaderNodeMath'); h.operation = 'MULTIPLY_ADD'; h.inputs[1].default_value = 0.35
    L(dot.outputs['Value'], h.inputs[0])
    L(mr.outputs['Result'], h.inputs[2])
    bp = nt.nodes.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.6
    bp.inputs['Distance'].default_value = 0.002
    L(h.outputs[0], bp.inputs['Height'])
    L(bp.outputs['Normal'], b.inputs['Normal'])
    return m, img


# ---------- the plot, built by the city's own builders ----------
def pool(p):
    pl = p['pool']
    pts = [tuple(q) for q in pl['pts']]
    if p['civic'] == 'lot':
        # dry: the outline only, until a coin moves in
        kit.tube('dry pool', [(x, y, ZP + 0.02) for (x, y) in pts] + [pts[0] + (ZP + 0.02,)], 0.02, kit.glow(kit.CREAM, 1.2, 'dry line'))
        return
    if pl['lanes']:
        xa, xb = pl['cx'] - pl['rw'] / 2, pl['cx'] + pl['rw'] / 2
        ya = pl['cy'] - pl['rd'] / 2
        for i in range(1, 6):
            yy = ya + i * pl['rd'] / 6
            kit.tube('lane rope', [(xa + 0.05, yy, ZP + 0.05), (xb - 0.05, yy, ZP + 0.05)], 0.02, m_card())
    if pl['lilies']:
        for (dx, dy, r) in ((-0.3, -1.1, 0.26), (0.25, 0.4, 0.2), (-0.2, 1.2, 0.23), (0.35, -0.3, 0.16)):
            kit.cyl('lily', pl['cx'] + dx, pl['cy'] + dy, ZP + 0.06, r, 0.012, m_basswood(), verts=20)
    kit.slab_from('water', pts, ZP - 0.02, ZP + 0.035, m_resin(pl['water']))
    kit.tube('coping', [(x, y, ZP + 0.06) for (x, y) in pts] + [pts[0] + (ZP + 0.06,)], 0.06, m_card())
    if pl['jet']:
        # a model's fountain: a clear acrylic rod
        kit.cyl('jet', pl['cx'], pl['cy'], ZP + 0.03, 0.035, 0.7, kit.mat('m rod', (0.6, 0.66, 0.7), rough=0.05, coat=1.0, emit=(1.0, 0.9, 0.7), strength=0.6), r2=0.012, verts=16)


def m_scored():
    """A civic plaza in a model: basswood scored into staggered slabs."""
    if 'm scored' in kit._mats:
        return kit._mats['m scored']
    m = bpy.data.materials.new('m scored')
    nt, b = kit._bsdf(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    br = nt.nodes.new('ShaderNodeTexBrick')
    nt.links.new(tc.outputs['Object'], br.inputs['Vector'])
    br.inputs['Scale'].default_value = 1.1
    br.inputs['Mortar Size'].default_value = 0.012
    br.inputs['Color1'].default_value = (0.6, 0.47, 0.31, 1)
    br.inputs['Color2'].default_value = (0.68, 0.54, 0.37, 1)
    br.inputs['Mortar'].default_value = (0.3, 0.22, 0.14, 1)
    nt.links.new(br.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.6
    bp = nt.nodes.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.4
    nt.links.new(br.outputs['Fac'], bp.inputs['Height'])
    nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
    kit._mats['m scored'] = m
    return m


x0, y0 = P['x0'], P['y0']
# the building's middle; Range's diving tower stands at the far side of its pool
FCX, FCY = (x0 + 5.4, y0 + 2.8) if P['piece'] == 'lifeguard' else (P['X'] + 1.6, P['Y'] + 1.4)


def front(x, y, margin=0.6):
    """A thing at site (x, y) stands between the camera and the building (site x + y grows toward the camera)."""
    return x + y > FCX + FCY + margin


kit.box('plot', x0, y0, 0.0, PW, PD, ZP, m_card())
kit.box('plot inner', x0 + 0.3, y0 + 0.3, ZP, PW - 0.6, PD - 0.6, 0.004, m_cork() if P['kind'] == 'room' else m_scored())
if P['pool']:
    pool(P)
if P['garden']:
    kit.stones(P['garden'])
if P['kind'] == 'room' and not front(x0 + 2.5, y0 + 4.75):
    kit.patio(x0 + 2.5, y0 + 4.75, P['pool']['water'] if P['pool'] else P['acc'], P['id'])
A = None
if P['mural']:
    A = mosaic(P['mural'], plan['art'][P['mural']], TILE.get(PID, 0))
_before = set(bpy.data.objects)
top = buildings.BUILDERS[P['piece']](P, A)
bpy.context.view_layer.update()
# the building's own extent frames the shot; its top is its highest part (the station's clock
# needle stands over the top its builder returns)
BPTS = [o.matrix_world @ Vector(c) for o in bpy.data.objects if o not in _before and o.type in ('MESH', 'CURVE') for c in o.bound_box]
_tops = [max((o.matrix_world @ Vector(c)).z for c in o.bound_box) for o in bpy.data.objects if o.type in ('MESH', 'CURVE')]
top = max([top] + _tops)
for t in plan['palms']:
    if t['plot'] == PID and not front(t['x'], t['y'], -0.8):
        kit.palm(t['x'], t['y'], t['h'] * 0.95, t['lean'], t['ph'])
for (x, y) in plan['lamps']:
    if x0 - 0.4 <= x <= x0 + PW + 0.4 and y0 - 0.4 <= y <= y0 + PD + 0.4 and not front(x, y):
        kit.lamp(x, y)
# palms in a model: laser-cut veneer fronds on a walnut trunk
for o in bpy.data.objects:
    if o.name.startswith('palm crown'):
        o.data.materials.clear(); o.data.materials.append(m_basswood())
    if o.name.startswith('palm trunk'):
        o.data.materials.clear(); o.data.materials.append(m_walnut())
# the lighthouse's stair is brass; the island's sweeping beam is not part of a model (only the
# LIGHT: the price keeper's beam is a mesh, and stays)
for o in list(bpy.data.objects):
    n = o.name.split('.')[0]
    if n in ('stair rail', 'treads', 'gallery rail', 'gallery post', 'mast', 'lantern roof'):
        o.data.materials.clear(); o.data.materials.append(m_brass())
    if n == 'beam' and o.type == 'LIGHT':
        bpy.data.objects.remove(o, do_unlink=True)
    elif n == 'tower wash' and o.type == 'LIGHT':
        o.data.energy *= 0.5


# ---------- scale figures: a model maker's white people; colour only on what is money ----------
def figure(x, y, face, z=ZP, basket=None, stride=0.06):
    """A 0.56-tall figure at site (x, y), facing the site angle `face`; `basket` = a colour carried on the head."""
    w = m_card()
    fx, fy = math.cos(face), math.sin(face)
    sx, sy = -fy, fx
    P2 = lambda a, s, h: (x + fx * a + sx * s, y + fy * a + sy * s, z + h)
    for s, a in ((-0.03, stride), (0.03, -stride)):
        kit.tube('fig leg', [P2(0, s, 0.27), P2(a, s * 1.2, 0.012)], 0.021, w)
    kit.tube('fig body', [P2(0, 0, 0.27), P2(0, 0, 0.45)], 0.045, w)
    kit.sphere('fig head', *P2(0, 0, 0.52), 0.037, w, seg=16)
    if basket:
        for s in (-0.055, 0.055):
            kit.tube('fig arm', [P2(0, s, 0.44), P2(0, s * 1.1, 0.62)], 0.014, w)
        bm = kit.mat(f'basket {basket}', tuple(v * 0.8 for v in lin(hexrgb(basket))), rough=0.35, coat=0.6,
                     emit=lin(hexrgb(basket)), strength=0.6)
        kit.cyl('fig basket', *P2(0, 0, 0.56), 0.085, 0.08, bm, r2=0.105, verts=20)
    else:
        for s, a in ((-0.058, -stride * 0.8), (0.058, stride * 0.8)):
            kit.tube('fig arm', [P2(0, s, 0.44), P2(a, s * 1.15, 0.27)], 0.014, w)


if PID == 'bayla':
    cx, cy = P['cx'], P['cy']
    zt = ZP + 0.28 + 5.6
    figure(cx + 0.67, cy + 0.67, math.radians(45), z=zt + 0.08, stride=0.0)       # on the gallery, looking out to sea
    figure(5.5, 24.55, math.radians(0), basket=P['acc'])                            # staking pay, out in the open,
    figure(6.75, 24.75, math.radians(0), basket=P['acc'], stride=-0.06)             # walking off toward the wallet
    figure(8.95, 23.1, math.radians(180), stride=0.0)                               # at the pool's edge
elif PID == 'treasury':
    cx, cy = P['X'] + 1.6, P['Y'] + 1.3
    figure(cx + 1.15, cy + 1.95, math.radians(-120), stride=0.0)
    figure(cx + 1.5, cy + 1.75, math.radians(-140), stride=0.02)
    figure(cx - 1.5, cy + 2.2, math.radians(10))
    figure(25.6, 23.8, math.radians(150), stride=0.0)
else:
    # three figures on open ground, the nearest first, apart from each other and from the building
    dg = bpy.context.evaluated_depsgraph_get()

    def ground(x, y):
        hit, loc, nrm, idx, ob, mw = scene.ray_cast(dg, V(x, y, 30), Vector((0, 0, -1)))
        return hit and ob.name.startswith('plot inner')

    free = []
    for i in range(1, 26):
        for j in range(1, 22):
            x, y = x0 + 0.3 + i * (PW - 0.6) / 26, y0 + 0.3 + j * (PD - 0.6) / 22
            if all(ground(x + dx, y + dy) for (dx, dy) in ((0, 0), (0.32, 0), (-0.32, 0), (0, 0.32), (0, -0.32), (0.25, 0.25), (-0.25, -0.25))):
                free.append((x, y))
    free.sort(key=lambda q: -(q[0] + q[1]))
    picked = []
    for q in free:
        if all(math.hypot(q[0] - r[0], q[1] - r[1]) > 1.3 for r in picked) and math.hypot(q[0] - FCX, q[1] - FCY) > 1.2:
            picked.append(q)
        if len(picked) == 3:
            break
    for k, (x, y) in enumerate(picked):
        look = math.atan2(FCY - y, FCX - x)
        figure(x, y, look + (0.0, 0.5, -0.4)[k], stride=(0.0, 0.05, 0.0)[k])
    print('figures', picked)


# ---------- the model's base and plinth ----------
MG = 0.55
bx0, by0, bw, bd = x0 - MG, y0 - MG, PW + 2 * MG, PD + 2 * MG
kit.box('street', bx0, by0, -0.06, bw, bd, 0.06, m_grey())
# the street's painted line round the block, in the drawing set's cream
dash = kit.mat('m paint', (0.85, 0.8, 0.66), rough=0.6)
kit.rects('kerb line', [((bx0 + 0.12, by0 + 0.12), (bx0 + bw - 0.12, by0 + 0.16), 0.002), ((bx0 + 0.12, by0 + bd - 0.16), (bx0 + bw - 0.12, by0 + bd - 0.12), 0.002),
                        ((bx0 + 0.12, by0 + 0.12), (bx0 + 0.16, by0 + bd - 0.12), 0.002), ((bx0 + bw - 0.16, by0 + 0.12), (bx0 + bw - 0.12, by0 + bd - 0.12), 0.002)], dash)
# the cut block under it, strata showing on its sides: card, cork, basswood, card, walnut
z = -0.06
for th, mf in ((0.05, m_card), (0.16, m_cork), (0.42, m_basswood), (0.04, m_card), (0.38, m_walnut)):
    kit.box('stratum', bx0, by0, z - th, bw, bd, th, mf())
    z -= th
BASE_Z = z
PM = 0.7
kit.box('plinth', bx0 - PM, by0 - PM, BASE_Z - 9.0, bw + 2 * PM, bd + 2 * PM, 9.0,
        kit.mat('m plinth', (0.012, 0.012, 0.014), rough=0.4, coat=0.15), bevel=0.02)

# lights inside the model, at a model's strength (AgX burns a bright amber light to white)
for o in bpy.data.objects:
    n = o.name.split('.')[0]
    if o.type == 'LIGHT':
        if n == 'lantern':
            o.data.energy *= 0.25
        if n == 'waist':
            o.data.energy *= 0.4
        if n == 'fire':
            o.data.energy *= 0.25
for mname, s in (('lamp core', 4.0), ('roof cream', 0.0), ('beacon', 25.0), ('frosted', 0.35), ('embers', 4.0), ('flame', 6.0), ('lily leaf', 0.15)):
    mm = bpy.data.materials.get(mname)
    if mm:
        bb = next(n for n in mm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        bb.inputs['Emission Strength'].default_value = s
        if mname == 'frosted':
            # a lit lantern of ribbed glass: amber, its core showing through, not a white drum
            bb.inputs['Base Color'].default_value = (0.22, 0.15, 0.08, 1)
            bb.inputs['Roughness'].default_value = 0.12
            kit._set(bb, ('Transmission Weight', 'Transmission'), 0.9)

# ---------- render ----------
scene.render.engine = 'CYCLES'
cy_ = scene.cycles
cy_.device = 'CPU'
cy_.samples = SAMPLES
cy_.use_adaptive_sampling = True
cy_.adaptive_threshold = 0.015
cy_.use_denoising = True
try:
    cy_.denoiser = 'OPENIMAGEDENOISE'
except Exception as ex:
    print('denoiser', ex)
for name, val in (('max_bounces', 8), ('diffuse_bounces', 3), ('glossy_bounces', 4), ('transmission_bounces', 8), ('transparent_max_bounces', 16),
                  ('caustics_reflective', False), ('caustics_refractive', False), ('blur_glossy', 1.0), ('sample_clamp_indirect', 6.0)):
    try:
        setattr(cy_, name, val)
    except Exception as ex:
        print('skip', name, ex)
vs = scene.view_settings
vs.view_transform = 'AgX'
try:
    vs.look = 'AgX - Medium High Contrast'
except Exception as ex:
    print('look', ex)
vs.exposure = 0.0
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_depth = '16'
scene.render.resolution_x = round(1000 * SCALE)
scene.render.resolution_y = round(1250 * SCALE)
scene.render.film_transparent = False

# the gallery: near black to light the scene, a blue-hour glow on the wall behind for the camera
world = bpy.data.worlds.new('gallery')
scene.world = world
world.use_nodes = True
wt = world.node_tree
bg = next(n for n in wt.nodes if n.type == 'BACKGROUND')
tc = wt.nodes.new('ShaderNodeTexCoord')
sep = wt.nodes.new('ShaderNodeSeparateXYZ')
wt.links.new(tc.outputs['Window'], sep.inputs['Vector'])
ramp = wt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.interpolation = 'EASE'
e = ramp.color_ramp.elements
e[0].position = 0.0; e[0].color = (0.004, 0.008, 0.02, 1)
e[1].position = 1.0; e[1].color = (0.0015, 0.002, 0.004, 1)
mid = e.new(0.42); mid.color = (*[c * 0.7 for c in (0.03, 0.07, 0.16)], 1)
wt.links.new(sep.outputs['Y'], ramp.inputs['Fac'])
lp = wt.nodes.new('ShaderNodeLightPath')
mixc = wt.nodes.new('ShaderNodeMix'); mixc.data_type = 'RGBA'
wt.links.new(lp.outputs['Is Camera Ray'], mixc.inputs[0])
cols = [s for s in mixc.inputs if s.type == 'RGBA']
cols[0].default_value = (0.0012, 0.0016, 0.003, 1)
wt.links.new(ramp.outputs['Color'], cols[1])
wt.links.new(next(s for s in mixc.outputs if s.type == 'RGBA'), bg.inputs['Color'])
bg.inputs['Strength'].default_value = 1.0

# the camera: the building alone at eye level, from the corner its art wraps round, nearly filling
# the frame: its height in the frame's height, its width across the view in the frame's width
toward = Vector((1, -1, 0)).normalized()               # Blender: toward the site's +x +y
yaw = math.radians(-6.0)
toward = Vector((toward.x * math.cos(yaw) - toward.y * math.sin(yaw), toward.x * math.sin(yaw) + toward.y * math.cos(yaw), 0))
across = Vector((-toward.y, toward.x, 0))
_r = [q.dot(across) for q in BPTS]
_d = [q.dot(toward) for q in BPTS]
w_b, d_b = max(_r) - min(_r), max(_d) - min(_d)
lens = 50
hh, vh = math.atan(18 * 0.8 / lens), math.atan(18 / lens)
dist = max((w_b / 2) * 1.16 / math.tan(hh), (top / 2) * 1.14 / math.tan(vh), 6.0) + d_b / 2
tz = top * 0.5
_c = V(FCX, FCY, 0)
_c = _c + across * ((max(_r) + min(_r)) / 2 - _c.dot(across)) + toward * ((max(_d) + min(_d)) / 2 - _c.dot(toward))
target = V(_c.x, -_c.y, tz)
elev = math.radians(9)
camd = bpy.data.cameras.new('cam')
camd.lens = lens
camd.sensor_fit = 'AUTO'
camd.sensor_width = 36
camd.clip_end = 500
co = bpy.data.objects.new('cam', camd)
kit.put(co)
co.location = target + (toward * math.cos(elev) + Vector((0, 0, math.sin(elev)))) * dist
co.rotation_euler = (target - co.location).to_track_quat('-Z', 'Y').to_euler()
# shallow focus on the building's near face, so it reads as a miniature
camd.dof.use_dof = True
camd.dof.focus_distance = (target - co.location).length - d_b / 2
camd.dof.aperture_fstop = 0.6
print('frame', dict(top=round(top, 2), dist=round(dist, 2), tz=round(tz, 2)))
scene.camera = co

fwd = (target - co.location).normalized()
up = Vector((0, 0, 1))
right = fwd.cross(up).normalized()


def aimed(kind, name, at, energy, colour, **kw):
    l = bpy.data.lights.new(name, kind)
    l.energy = energy
    l.color = colour
    for k2, v2 in kw.items():
        setattr(l, k2, v2)
    o = bpy.data.objects.new(name, l)
    kit.put(o)
    o.location = at
    o.rotation_euler = (target - at).to_track_quat('-Z', 'Y').to_euler()
    return o


# gallery light: a warm spot from above beside the camera, a cool rim behind, a faint fill
aimed('SPOT', 'gallery key', target - fwd * 11 + right * 6.5 + up * 10, 9000, (1.0, 0.9, 0.78), spot_size=math.radians(34), spot_blend=0.55, shadow_soft_size=0.6)
aimed('SPOT', 'gallery rim', target + fwd * 9 - right * 6 + up * 9, 6000, (0.6, 0.72, 1.0), spot_size=math.radians(40), spot_blend=0.7, shadow_soft_size=0.8)
aimed('AREA', 'gallery fill', target - fwd * 10 - right * 9 + up * 3, 600, (0.85, 0.9, 1.0), size=6.0)

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print('WROTE', OUT, 'top', top)
