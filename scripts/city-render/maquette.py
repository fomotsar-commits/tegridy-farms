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
from kit import V
import buildings
import stock

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


# every material the builders ask for, as a model maker's stock
stock.swap()


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
            kit.tube('lane rope', [(xa + 0.05, yy, ZP + 0.05), (xb - 0.05, yy, ZP + 0.05)], 0.02, stock.card())
    if pl['lilies']:
        for (dx, dy, r) in ((-0.3, -1.1, 0.26), (0.25, 0.4, 0.2), (-0.2, 1.2, 0.23), (0.35, -0.3, 0.16)):
            kit.cyl('lily', pl['cx'] + dx, pl['cy'] + dy, ZP + 0.06, r, 0.012, stock.basswood(), verts=20)
    kit.slab_from('water', pts, ZP - 0.02, ZP + 0.035, stock.resin(pl['water'], *POOL.get(PID, (0.15, 0.38))))
    kit.tube('coping', [(x, y, ZP + 0.06) for (x, y) in pts] + [pts[0] + (ZP + 0.06,)], 0.06, stock.card())
    if pl['jet']:
        # a model's fountain: a clear acrylic rod
        kit.cyl('jet', pl['cx'], pl['cy'], ZP + 0.03, 0.035, 0.7, stock.rod(), r2=0.012, verts=16)


x0, y0 = P['x0'], P['y0']
# the building's middle; Range's diving tower stands at the far side of its pool
FCX, FCY = (x0 + 5.4, y0 + 2.8) if P['piece'] == 'lifeguard' else (P['X'] + 1.6, P['Y'] + 1.4)


def front(x, y, margin=0.6):
    """A thing at site (x, y) stands between the camera and the building (site x + y grows toward the camera)."""
    return x + y > FCX + FCY + margin


kit.box('plot', x0, y0, 0.0, PW, PD, ZP, stock.card())
kit.box('plot inner', x0 + 0.3, y0 + 0.3, ZP, PW - 0.6, PD - 0.6, 0.004, stock.cork() if P['kind'] == 'room' else stock.scored())
if P['pool']:
    pool(P)
if P['garden']:
    kit.stones(P['garden'])
if P['kind'] == 'room' and not front(x0 + 2.5, y0 + 4.75):
    kit.patio(x0 + 2.5, y0 + 4.75, P['pool']['water'] if P['pool'] else P['acc'], P['id'])
A = None
if P['mural']:
    A = stock.mosaic(P['mural'], plan['art'][P['mural']], TILE.get(PID, 0))
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

# ---------- scale figures: a model maker's white people; colour only on what is money ----------
def figure(x, y, face, z=ZP, **kw):
    stock.figure(x, y, face, z, **kw)


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
    print('figures', stock.figures(scene, P, ZP, PW, PD, lambda ob: ob.name.startswith('plot inner')))


# ---------- the model's base and plinth ----------
MG = 0.55
bx0, by0, bw, bd = x0 - MG, y0 - MG, PW + 2 * MG, PD + 2 * MG
kit.box('street', bx0, by0, -0.06, bw, bd, 0.06, stock.grey())
# the street's painted line round the block, in the drawing set's cream
dash = kit.mat('m paint', (0.85, 0.8, 0.66), rough=0.6)
kit.rects('kerb line', [((bx0 + 0.12, by0 + 0.12), (bx0 + bw - 0.12, by0 + 0.16), 0.002), ((bx0 + 0.12, by0 + bd - 0.16), (bx0 + bw - 0.12, by0 + bd - 0.12), 0.002),
                        ((bx0 + 0.12, by0 + 0.12), (bx0 + 0.16, by0 + bd - 0.12), 0.002), ((bx0 + bw - 0.16, by0 + 0.12), (bx0 + bw - 0.12, by0 + bd - 0.12), 0.002)], dash)
# the cut block under it, strata showing on its sides: card, cork, basswood, card, walnut
z = -0.06
for th, mf in ((0.05, stock.card), (0.16, stock.cork), (0.42, stock.basswood), (0.04, stock.card), (0.38, stock.walnut)):
    kit.box('stratum', bx0, by0, z - th, bw, bd, th, mf())
    z -= th
BASE_Z = z
PM = 0.7
kit.box('plinth', bx0 - PM, by0 - PM, BASE_Z - 9.0, bw + 2 * PM, bd + 2 * PM, 9.0,
        kit.mat('m plinth', (0.012, 0.012, 0.014), rough=0.4, coat=0.15), bevel=0.02)

# palms, the lighthouse's brass, and every light the builders made, at a model's strength
stock.dress()

# ---------- render ----------
stock.cycles(scene, SAMPLES)
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
