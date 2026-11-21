# The model maker's stock, shared by the island (island.py) and the close-ups (maquette.py), so the
# whole city is one architect's model: basswood, white card, cork, walnut, brass, gloss resin, the
# art laid as glazed tile, white figures for scale. Colour is kept for the art and the money.
import bpy, math, os
from mathutils import Vector
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
                 shell=lambda acc: card(), painted=lambda acc, k=0.6: card())
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


# ---------- the lights the builders made, at a model's strength ----------
GLOW = {'lamp core': 4.0, 'roof cream': 0.0, 'beacon': 25.0, 'frosted': 0.35, 'embers': 4.0, 'flame': 6.0, 'lily leaf': 0.15}
LIGHTS = {'lantern': 0.25, 'waist': 0.4, 'fire': 0.25, 'tower wash': 0.5}


def dress(glow=None, lights=None):
    """
    Palms as laser-cut veneer fronds on walnut trunks; the lighthouse's stair and gallery in brass;
    the island's sweeping beam taken out (only the LIGHT: the price keeper's beam is a mesh, and
    stays); every light and lit material the builders made turned to a model's strength (AgX burns
    a bright amber light to white).
    """
    glow = {**GLOW, **(glow or {})}
    lights = {**LIGHTS, **(lights or {})}
    for o in list(bpy.data.objects):
        n = o.name.split('.')[0]
        if o.name.startswith('palm crown'):
            o.data.materials.clear(); o.data.materials.append(basswood())
        elif o.name.startswith('palm trunk'):
            o.data.materials.clear(); o.data.materials.append(walnut())
        elif n in ('stair rail', 'treads', 'gallery rail', 'gallery post', 'mast', 'lantern roof'):
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
