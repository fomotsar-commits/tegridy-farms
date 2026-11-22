# The model maker's stock, shared by the island (island.py) and the close-ups (maquette.py), so the
# whole city is one architect's model: basswood, white card, cork, walnut, brass, gloss resin, the
# art laid as glazed tile, white figures for scale. Colour is kept for the art and the money. Its
# palms, street lamps and harbour things are the owner's own models (props/), carved in the same wood.
import bpy, bmesh, math, os
from mathutils import Matrix, Vector
import kit
from kit import lin, hexrgb


def basswood():
    return kit._ramp_mat('m basswood', 4.0, 3.0, (0.56, 0.42, 0.27), (0.70, 0.55, 0.37), 0.55, stretch=(40, 40, 1.5), bump=0.02)


def pale():
    """A paler, finer veneer: the island's beach, a layer of its own round the land."""
    return kit._ramp_mat('m pale', 6.0, 3.0, (0.66, 0.55, 0.40), (0.78, 0.68, 0.52), 0.6, stretch=(30, 30, 1.5), bump=0.02)


def jute():
    return kit._ramp_mat('m jute', 40.0, 3.0, (0.36, 0.26, 0.15), (0.52, 0.40, 0.25), 0.85, stretch=(0.3, 0.3, 6.0), bump=0.25)


def card():
    return kit.mat('m card', (0.6, 0.585, 0.555), rough=0.82)


def grey():
    return kit.mat('m grey card', (0.16, 0.16, 0.17), rough=0.8)


def walnut():
    return kit._ramp_mat('m walnut', 3.0, 5.0, (0.035, 0.02, 0.012), (0.085, 0.05, 0.03), 0.4, stretch=(40, 40, 1.5), coat=0.35)


def cork(scale=90.0):
    """Cork sheet; the island lays it at a third of the close-ups' grain, so it reads from above."""
    return kit._ramp_mat('m cork', scale, 8.0, (0.27, 0.19, 0.11), (0.44, 0.33, 0.21), 0.9, bump=0.35)


def brass():
    return kit.mat('m brass', (0.92, 0.70, 0.38), rough=0.24, metal=1.0)


def zinc():
    return kit.mat('m zinc', (0.62, 0.63, 0.64), rough=0.32, metal=0.9)


def smoked():
    return kit.mat('m smoked', (0.02, 0.024, 0.03), rough=0.05, coat=1.0)


def rod():
    """A model's fountain: a clear acrylic rod, lit from its foot."""
    return kit.mat('m rod', (0.6, 0.66, 0.7), rough=0.05, coat=1.0, emit=(1.0, 0.9, 0.7), strength=0.6)


def resin(colour, glow=0.15, base=0.38):
    """A pool in a model: poured gloss resin in its community's colour, lit from within."""
    name = f'm resin {colour}'
    if name in kit._mats:
        return kit._mats[name]
    c = lin(hexrgb(colour))
    m = kit.mat(name, tuple(v * base for v in c), rough=0.02, coat=1.0, emit=c, strength=glow)
    kit._set(next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), ('Coat Roughness',), 0.01)
    return m


def scored():
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


def swap(**over):
    """Every material the city's builders ask kit for, as model stock (`over` replaces a few)."""
    import buildings
    table = dict(wood=basswood, bamboo=basswood, thatch=jute, tin=zinc, stone=card, basalt=walnut, cream=card,
                 brass=brass, terrazzo=card, paving=card, lawn=cork, sand=cork, dark_glass=smoked,
                 shell=lambda acc: card(), painted=lambda acc, k=0.6: card(), palm=palm, lamp=lamp, patio=patio)
    table.update(over)
    for k, f in table.items():
        setattr(kit, k, f)
        if hasattr(buildings, k):
            setattr(buildings, k, f)


# ---------- the art as a glazed tile mosaic ----------
def mosaic(room_id, src, tile_px=0, tiles=128, glow=0.1):
    """
    Each tile takes the picture's colour under its centre (a voronoi cell's position, divided back
    into the picture's UV), so both wrap_drum's and wrap_art's UVs give square tiles. Joints are
    sunk grout, every tile a little lighter or darker and set at its own slight tilt. `tile_px` =
    pixels of the picture per tile; with none, `tiles` tiles down the picture's height.
    """
    img = bpy.data.images.load(os.path.join(kit.ROOT, 'frontend', 'public', src.lstrip('/').replace('/', os.sep)), check_existing=True)
    iw, ih = img.size
    tile_px = tile_px or ih / tiles
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
    b.inputs['Emission Strength'].default_value = glow
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


# ---------- scale figures: a model maker's white people; colour only on what is money ----------
def figure(x, y, face, z, basket=None, stride=0.06):
    """A 0.56-tall figure at site (x, y), facing the site angle `face`; `basket` = a colour carried on the head."""
    w = card()
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


def open_ground(scene, P, ZP, PW, PD, inner, steps=(26, 22), n=3):
    """
    Up to `n` spots on a plot's open ground (in its frame), the nearest the camera first, apart from
    each other and from the building: a spot is open where a ray from above lands on `inner` (the
    plot's own ground), with room round it.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    x0, y0 = P['x0'], P['y0']
    FCX, FCY = (x0 + 5.4, y0 + 2.8) if P['piece'] == 'lifeguard' else (P['X'] + 1.6, P['Y'] + 1.4)

    def ground(x, y):
        hit, loc, nrm, idx, ob, mw = scene.ray_cast(dg, kit.V(x, y, 30), Vector((0, 0, -1)))
        return hit and inner(ob)

    free = []
    for i in range(1, steps[0]):
        for j in range(1, steps[1]):
            x, y = x0 + 0.3 + i * (PW - 0.6) / steps[0], y0 + 0.3 + j * (PD - 0.6) / steps[1]
            if all(ground(x + dx, y + dy) for (dx, dy) in ((0, 0), (0.32, 0), (-0.32, 0), (0, 0.32), (0, -0.32), (0.25, 0.25), (-0.25, -0.25))):
                free.append((x, y))
    free.sort(key=lambda q: -(q[0] + q[1]))
    picked = []
    for q in free:
        if all(math.hypot(q[0] - r[0], q[1] - r[1]) > 1.3 for r in picked) and math.hypot(q[0] - FCX, q[1] - FCY) > 1.2:
            picked.append(q)
        if len(picked) == n:
            break
    return picked, (FCX, FCY)


def figures(scene, P, ZP, PW, PD, inner):
    """Three white figures on a plot's open ground, turned toward its building."""
    picked, (FCX, FCY) = open_ground(scene, P, ZP, PW, PD, inner)
    for k, (x, y) in enumerate(picked):
        figure(x, y, math.atan2(FCY - y, FCX - x) + (0.0, 0.5, -0.4)[k], ZP, stride=(0.0, 0.05, 0.0)[k])
    return picked


# ---------- the owner's props (props/*.glb: made with Meshy AI, slimmed), in the same wood ----------
PROPS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'props')
_props = {}


def _carved(m):
    """A prop's own picture read as basswood: its light and dark become the wood's, so detail stays and colour goes."""
    if not m or not m.use_nodes:
        return
    nt = m.node_tree
    b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if b is None:
        return
    tex = next((l.from_node for l in nt.links if l.to_node == b and l.to_socket.name == 'Base Color' and l.from_node.type == 'TEX_IMAGE'), None)
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (0.28, 0.19, 0.11, 1)
    ramp.color_ramp.elements[1].color = (0.8, 0.66, 0.47, 1)
    if tex:
        bw = nt.nodes.new('ShaderNodeRGBToBW')
        nt.links.new(tex.outputs['Color'], bw.inputs[0])
        nt.links.new(bw.outputs[0], ramp.inputs['Fac'])
    else:
        ramp.inputs['Fac'].default_value = 0.6
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Metallic'].default_value = 0.0
    b.inputs['Roughness'].default_value = 0.6


def prop(name):
    """
    One prop's mesh, read once per scene: every part joined, upright, its base at 0 and centred,
    carved in basswood. Returns (mesh, its width / depth / height, the middle of its top, e.g. a lamp's head).
    """
    if name in _props:
        return _props[name]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(PROPS, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    bm = bmesh.new()
    mats = []
    for o in new:
        if o.type != 'MESH':
            continue
        part = o.data.copy()
        part.transform(o.matrix_world)
        for p in part.polygons:
            p.material_index += len(mats)
        mats += list(o.data.materials)
        bm.from_mesh(part)
        bpy.data.meshes.remove(part)
    me = bpy.data.meshes.new(f'prop {name}')
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
        _carved(m)
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
    me.transform(Matrix.Translation(Vector((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -min(zs)))))
    dims = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    top = [v.co for v in me.vertices if v.co.z > dims[2] * 0.93]
    head = sum(top, Vector()) / len(top) if top else Vector((0, 0, dims[2]))
    me.use_fake_user = True                      # a scene's builder deletes every object first, never meshes
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    _props[name] = (me, dims, head)
    return _props[name]


def place(name, x, y, z, size, along='h', rot=0.0):
    """A prop at site (x, y, z), `size` its height ('h') or its longest side ('l'), turned `rot` (Blender's sense, about z)."""
    me, dims, _ = prop(name)
    k = size / (dims[2] if along == 'h' else max(dims[0], dims[1]))
    o = bpy.data.objects.new(name, me)
    kit.put(o)
    o.location = kit.V(x, y, z)
    o.scale = (k, k, k)
    o.rotation_euler = (0, 0, rot)
    return o, k


def palm(x, y, h, lean, ph, coll=None, z=0.06):
    """
    A palm `h` tall, the owner's coconut palm, turned by its phase `ph`: no two stand alike. Stands in
    for kit.palm everywhere (swap), so the island, every close-up and BNKR's roof get the same palms.
    Its lean is the model's own. (The owner's young palm is 180,000 triangles that will not slim: its
    leaves are loose pieces the decimator cannot merge.)
    """
    place('coconut-palm', x, y, z - 0.06, h * 1.05, 'h', rot=ph)


def lamp(x, y):
    """A street lamp: the streetlight model, its head lit by a warm glow and a point light, as kit.lamp's was."""
    rot = ((int(x * 3 + y * 5) % 8) / 8.0) * math.tau
    o, k = place('streetlight', x, y, 0.0, 1.6, 'h', rot=rot)
    hd = prop('streetlight')[2]
    off = Matrix.Rotation(rot, 3, 'Z') @ Vector((hd.x * k, hd.y * k, 0))
    hx, hy, hz = o.location.x + off.x, -(o.location.y + off.y), hd.z * k      # back to the site's y
    kit.sphere('lamp head', hx, hy, hz - 0.08, 0.07, kit.glow(kit.WARM, 18.0, 'lamp glow'), seg=12)
    kit.light('POINT', 'lamp', (hx, hy, hz - 0.12), 48, kit.WARM, shadow=False, soft=0.1)


def patio(x, y, colour, seed=''):
    """
    A room's own corner of its garden, one of four by the room as kit.patio chose it (UX review,
    2026-11-19: every plot had the same parasol), now the owner's own furniture (2026-11-22: "Yes, add
    them"): a sun umbrella over a pair of loungers; a fire pit ringed by its stools, burning; a pair of
    pool loungers by a floor lantern; a hammock. Each stands where kit.patio's did, at its size. Its
    colour is the model's wood: colour stays for the art and the money.
    """
    kind = sum(ord(c) for c in seed) % 4 if seed else 0
    if kind == 0:
        place('umbrella', x + 0.2, y - 0.05, 0.06, 1.1, 'h')
        place('lounger', x - 0.15, y - 0.45, 0.06, 1.2, 'l', rot=0.2)
    elif kind == 1:
        place('fire-pit', x, y, 0.06, 1.8, 'l')
        kit.cyl('embers', x, y, 0.08, 0.16, 0.02, kit.glow((1.0, 0.38, 0.08), 14.0, 'embers'), verts=20)
        kit.light('POINT', 'fire', (x, y, 0.55), 60, (1.0, 0.55, 0.22), shadow=True, soft=0.25)
    elif kind == 2:
        place('lounge-set', x, y, 0.06, 1.3, 'l')
        kit.sphere('lantern', x + 0.62, y + 0.42, 0.14, 0.06, kit.glow(kit.WARM, 16.0, 'lamp glow'), seg=10)
        kit.light('POINT', 'daybed lantern', (x + 0.62, y + 0.42, 0.3), 14, kit.WARM, shadow=False, soft=0.1)
    else:
        place('hammock', x, y, 0.06, 1.7, 'l')


# ---------- the lights the builders made, at a model's strength ----------
GLOW = {'lamp core': 4.0, 'roof cream': 0.0, 'beacon': 25.0, 'frosted': 0.35, 'embers': 4.0, 'flame': 6.0, 'lily leaf': 0.15}
LIGHTS = {'lantern': 0.25, 'waist': 0.4, 'fire': 0.25, 'tower wash': 0.5}


def dress(glow=None, lights=None):
    """
    The lighthouse's stair and gallery in brass; the island's sweeping beam taken out (only the
    LIGHT: the price keeper's beam is a mesh, and stays); every light and lit material the builders
    made turned to a model's strength (AgX burns a bright amber light to white).
    """
    glow = {**GLOW, **(glow or {})}
    lights = {**LIGHTS, **(lights or {})}
    for o in list(bpy.data.objects):
        n = o.name.split('.')[0]
        if n in ('stair rail', 'treads', 'gallery rail', 'gallery post', 'mast', 'lantern roof'):
            o.data.materials.clear(); o.data.materials.append(brass())
        elif o.type == 'LIGHT':
            if n == 'beam':
                bpy.data.objects.remove(o, do_unlink=True)
            elif n in lights:
                o.data.energy *= lights[n]
    for mname, s in glow.items():
        mm = bpy.data.materials.get(mname)
        if mm:
            bb = next(n for n in mm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
            bb.inputs['Emission Strength'].default_value = s
            if mname == 'frosted':
                # a lit lantern of ribbed glass: amber, its core showing through, not a white drum
                bb.inputs['Base Color'].default_value = (0.22, 0.15, 0.08, 1)
                bb.inputs['Roughness'].default_value = 0.12
                kit._set(bb, ('Transmission Weight', 'Transmission'), 0.9)


def cycles(scene, samples, threshold=0.015, bounces=(8, 3, 4, 8, 16)):
    """Cycles on the CPU, denoised, under AgX: the one renderer for the island and its close-ups."""
    scene.render.engine = 'CYCLES'
    cy_ = scene.cycles
    cy_.device = 'CPU'
    cy_.samples = samples
    cy_.use_adaptive_sampling = True
    cy_.adaptive_threshold = threshold
    cy_.use_denoising = True
    try:
        cy_.denoiser = 'OPENIMAGEDENOISE'
    except Exception as ex:
        print('denoiser', ex)
    mb, db, gb, tb, tpb = bounces
    for name, val in (('max_bounces', mb), ('diffuse_bounces', db), ('glossy_bounces', gb), ('transmission_bounces', tb), ('transparent_max_bounces', tpb),
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
    scene.render.film_transparent = False
