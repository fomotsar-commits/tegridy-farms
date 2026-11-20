# The city's render kit: materials and parts for Blender, in the site's own units.
#
# COORDINATES. Everything here takes the SITE's world coordinates (lib/city/plan.ts): x runs
# down-right on the sheet, y down-left, z up, one unit per plan unit. The site's axonometric is a
# mirror of a real camera's view, so Blender's world is the site's with y turned over: a site
# point (x, y, z) stands at Blender (x, -y, z), and a camera at Blender (+x, -y, +z) looking back
# sees exactly what the site draws. V() does that turn; use it for every position.
import bpy, bmesh, math, random
from mathutils import Vector

ROOT = None          # the repo's root, set by island.py
CREAM = (0.96, 0.89, 0.72)
WARM = (1.0, 0.8, 0.55)
BG = (0.0196, 0.0314, 0.0588)   # the sheet's #05080f


def V(x, y, z=0.0):
    return Vector((x, -y, z))


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def lin(c):
    """sRGB to linear, for colours given as the site's hex."""
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


# ---------- materials ----------
_mats = {}


def _bsdf(m):
    m.use_nodes = True
    nt = m.node_tree
    return nt, next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')


def _set(b, keys, val):
    for k in keys:
        if k in b.inputs:
            b.inputs[k].default_value = val
            return k
    return None


def mat(name, base=(0.1, 0.1, 0.1), rough=0.5, metal=0.0, emit=None, strength=0.0, trans=0.0, ior=1.45, coat=0.0, alpha=1.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    nt, b = _bsdf(m)
    b.inputs['Base Color'].default_value = (*base, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    _set(b, ('Transmission Weight', 'Transmission'), trans)
    b.inputs['IOR'].default_value = ior
    _set(b, ('Coat Weight', 'Clearcoat'), coat)
    if emit is not None:
        _set(b, ('Emission Color', 'Emission'), (*emit, 1))
        b.inputs['Emission Strength'].default_value = strength
    if alpha < 1.0:
        b.inputs['Alpha'].default_value = alpha
    _mats[name] = m
    return m


def _ramp_mat(name, scale, detail, c0, c1, rough, coord=None, stretch=(1, 1, 1), bump=0.0, wave=None, coat=0.0):
    """A material whose colour runs between two tones by noise (or by bands), with an optional bump."""
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    nt, b = _bsdf(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = stretch
    nt.links.new(tc.outputs[coord or 'Object'], mp.inputs['Vector'])
    if wave:
        tx = nt.nodes.new('ShaderNodeTexWave')
        tx.wave_type = 'BANDS'
        tx.bands_direction = wave
        tx.inputs['Scale'].default_value = scale
        tx.inputs['Distortion'].default_value = detail
        out = tx.outputs['Fac']
    else:
        tx = nt.nodes.new('ShaderNodeTexNoise')
        tx.inputs['Scale'].default_value = scale
        tx.inputs['Detail'].default_value = detail
        out = tx.outputs['Fac']
    nt.links.new(mp.outputs['Vector'], tx.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*c0, 1)
    ramp.color_ramp.elements[1].color = (*c1, 1)
    nt.links.new(out, ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    _set(b, ('Coat Weight', 'Clearcoat'), coat)
    if bump:
        bp = nt.nodes.new('ShaderNodeBump')
        bp.inputs['Strength'].default_value = bump
        nt.links.new(out, bp.inputs['Height'])
        nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
    _mats[name] = m
    return m


def lawn():
    return _ramp_mat('lawn', 0.6, 8.0, (0.012, 0.035, 0.02), (0.035, 0.075, 0.04), 0.9)


def sand():
    return _ramp_mat('sand', 3.0, 6.0, (0.42, 0.33, 0.21), (0.6, 0.48, 0.32), 0.9, bump=0.15)


def asphalt():
    return _ramp_mat('asphalt', 40.0, 4.0, (0.018, 0.02, 0.026), (0.034, 0.036, 0.045), 0.5)


def terrazzo():
    return _ramp_mat('terrazzo', 90.0, 2.0, (0.075, 0.075, 0.082), (0.14, 0.14, 0.15), 0.22, coat=0.35)


def paving():
    return _ramp_mat('paving', 60.0, 2.0, (0.11, 0.105, 0.1), (0.17, 0.16, 0.15), 0.35, coat=0.2)


def basalt():
    return mat('basalt', (0.05, 0.052, 0.06), rough=0.16, coat=0.6)


def stone():
    return _ramp_mat('stone', 12.0, 4.0, (0.32, 0.3, 0.27), (0.45, 0.42, 0.38), 0.55, bump=0.08)


def thatch():
    return _ramp_mat('thatch', 30.0, 2.5, (0.36, 0.25, 0.11), (0.66, 0.5, 0.25), 0.8, stretch=(0.2, 0.2, 6.0), bump=0.35)


def tin():
    return _ramp_mat('tin', 18.0, 0.0, (0.35, 0.4, 0.44), (0.5, 0.55, 0.6), 0.35, wave='X', bump=0.25, coat=0.2)


def wood():
    return _ramp_mat('wood', 2.0, 6.0, (0.17, 0.1, 0.055), (0.32, 0.2, 0.11), 0.5, stretch=(1, 1, 18), bump=0.05, coat=0.25)


def bamboo():
    return mat('bamboo', (0.55, 0.52, 0.28), rough=0.4, coat=0.4)


def cream():
    return mat('cream', CREAM, rough=0.3, emit=CREAM, strength=0.12, coat=0.3)


def brass():
    return mat('brass', (0.95, 0.72, 0.32), rough=0.22, metal=1.0, emit=(1.0, 0.72, 0.3), strength=0.15)


def glow(colour=WARM, strength=20.0, name=None):
    return mat(name or f'glow {colour} {strength}', colour, emit=colour, strength=strength)


def glass():
    return mat('frosted', (1.0, 0.93, 0.8), rough=0.35, trans=0.6, emit=WARM, strength=4.0)


def dark_glass():
    return mat('night glass', (0.02, 0.035, 0.06), rough=0.06, coat=0.8)


def shell(acc):
    c = lin(hexrgb(acc))
    return mat(f'shell {acc}', tuple(0.25 + 0.55 * v for v in c), rough=0.45, coat=0.2)


def painted(acc, k=0.6):
    c = lin(hexrgb(acc))
    return mat(f'paint {acc} {k}', tuple(v * k for v in c), rough=0.45, coat=0.25)


def water_old(colour):
    name = f'water old {colour}'
    if name in _mats:
        return _mats[name]
    c = lin(hexrgb(colour))
    m = bpy.data.materials.new(name)
    nt, b = _bsdf(m)
    b.inputs['Base Color'].default_value = (*[v * 0.35 for v in c], 1)
    b.inputs['Roughness'].default_value = 0.03
    _set(b, ('Transmission Weight', 'Transmission'), 0.85)
    b.inputs['IOR'].default_value = 1.33
    nz = nt.nodes.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 3.0
    nz.inputs['Detail'].default_value = 4.0
    bp = nt.nodes.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.3
    nt.links.new(nz.outputs['Fac'], bp.inputs['Height'])
    nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
    _mats[name] = m
    return m


def water(colour, strength=2.2):
    """A pool lit from below: its own colour, light rippling across it as caustics do, under a clear gloss."""
    name = f'water {colour}'
    if name in _mats:
        return _mats[name]
    c = lin(hexrgb(colour))
    m = bpy.data.materials.new(name)
    nt, b = _bsdf(m)
    # a soft, wavering mesh of light, as sunlight makes on a pool floor: voronoi edges, bent by noise
    tc = nt.nodes.new('ShaderNodeTexCoord')
    bend = nt.nodes.new('ShaderNodeTexNoise')
    bend.inputs['Scale'].default_value = 1.6
    bend.inputs['Detail'].default_value = 2.0
    add = nt.nodes.new('ShaderNodeVectorMath')
    add.operation = 'ADD'
    nt.links.new(tc.outputs['Object'], add.inputs[0])
    nt.links.new(bend.outputs['Color'], add.inputs[1])
    vo = nt.nodes.new('ShaderNodeTexVoronoi')
    vo.feature = 'DISTANCE_TO_EDGE'
    vo.inputs['Scale'].default_value = 7.0
    nt.links.new(add.outputs['Vector'], vo.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'EASE'
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (*[0.12 + 0.95 * v for v in c], 1)
    ramp.color_ramp.elements[1].position = 0.05
    ramp.color_ramp.elements[1].color = (*[v * 0.62 for v in c], 1)
    nt.links.new(vo.outputs['Distance'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    key = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
    nt.links.new(ramp.outputs['Color'], b.inputs[key])
    b.inputs['Emission Strength'].default_value = strength
    b.inputs['Roughness'].default_value = 0.08
    _set(b, ('Coat Weight', 'Clearcoat'), 1.0)
    _set(b, ('Coat Roughness',), 0.02)
    nz = nt.nodes.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 4.0
    bp = nt.nodes.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.15
    nt.links.new(nz.outputs['Fac'], bp.inputs['Height'])
    key2 = 'Coat Normal' if 'Coat Normal' in b.inputs else 'Normal'
    nt.links.new(bp.outputs['Normal'], b.inputs[key2])
    _mats[name] = m
    return m


_art = {}


def art(room_id, src, glow_k=1.0):
    """The room's own picture, as a lit print under a clear coat."""
    if room_id in _art:
        return _art[room_id]
    import os
    m = bpy.data.materials.new(f'art {room_id}')
    nt, b = _bsdf(m)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(os.path.join(ROOT, 'frontend', 'public', src.lstrip('/').replace('/', os.sep)))
    tex.extension = 'MIRROR'
    tex.interpolation = 'Cubic'
    nt.links.new(tex.outputs['Color'], b.inputs['Base Color'])
    key = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
    nt.links.new(tex.outputs['Color'], b.inputs[key])
    b.inputs['Emission Strength'].default_value = glow_k
    b.inputs['Roughness'].default_value = 0.32
    _set(b, ('Coat Weight', 'Clearcoat'), 0.6)
    _set(b, ('Coat Roughness',), 0.05)
    _art[room_id] = (m, tex.image)
    return _art[room_id]


# ---------- collections ----------
def collection(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


INK = None   # set by island.py: the architecture that takes the drawing set's cream line


def put(o, coll=None):
    for c in list(o.users_collection):
        c.objects.unlink(o)
    (coll or bpy.context.scene.collection).objects.link(o)
    return o


def inked(o):
    if INK is not None:
        INK.objects.link(o)
    return o


# ---------- solids, in site coordinates ----------
def mesh(name, verts, faces, material=None, smooth=False, coll=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate()
    me.update()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    o = bpy.data.objects.new(name, me)
    put(o, coll)
    if material is not None:
        if isinstance(material, (list, tuple)):
            for m in material:
                o.data.materials.append(m)
        else:
            o.data.materials.append(material)
    return o


def box(name, x, y, z, w, d, h, material, bevel=0.0, rot=0.0, coll=None):
    """A block standing on (x, y) to (x + w, y + d) in site units, from z up h; `rot` turns it about its middle (site sense)."""
    cx, cy = x + w / 2, y + d / 2
    c, s = math.cos(rot), math.sin(rot)
    pts = []
    for (dx, dy) in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
        pts.append((cx + dx * c - dy * s, cy + dx * s + dy * c))
    verts = [V(px, py, z) for (px, py) in pts] + [V(px, py, z + h) for (px, py) in pts]
    # Blender's y is turned over, so wind the faces the other way round to keep them outward
    faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    o = mesh(name, verts, faces, material, coll=coll)
    _outward(o)
    if bevel > 0:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = 2
        b.limit_method = 'ANGLE'
    return o


def _outward(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def cyl(name, x, y, z, r, h, material, r2=None, verts=64, cap=True, smooth=True, coll=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r if r2 is None else r2, depth=h, location=tuple(V(x, y, z + h / 2)), end_fill_type='NGON' if cap else 'NOTHING')
    o = bpy.context.active_object
    o.name = name
    put(o, coll)
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = abs(p.normal.z) < 0.5
    o.data.materials.append(material)
    return o


def sphere(name, x, y, z, r, material, scale=(1, 1, 1), seg=24, coll=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=seg // 2, radius=r, location=tuple(V(x, y, z)))
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    put(o, coll)
    for p in o.data.polygons:
        p.use_smooth = True
    o.data.materials.append(material)
    return o


def tube(name, pts, radius, material, coll=None, res=3, closed=False):
    """A round rail through site points (x, y, z)."""
    cd = bpy.data.curves.new(name, 'CURVE')
    cd.dimensions = '3D'
    cd.bevel_depth = radius
    cd.bevel_resolution = res
    cd.use_fill_caps = True
    sp = cd.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        q = V(*p)
        sp.points[i].co = (q.x, q.y, q.z, 1)
    sp.use_cyclic_u = closed
    o = bpy.data.objects.new(name, cd)
    put(o, coll)
    o.data.materials.append(material)
    return o


def rects(name, quads, material, coll=None):
    """Many flat rectangles in one mesh: quads are ((x0, y0), (x1, y1), z) in site units."""
    verts, faces = [], []
    for (a, b, z) in quads:
        n = len(verts)
        verts += [V(a[0], a[1], z), V(b[0], a[1], z), V(b[0], b[1], z), V(a[0], b[1], z)]
        faces.append((n, n + 3, n + 2, n + 1))
    return mesh(name, verts, faces, material, coll=coll)


def slab_from(name, pts, z0, z1, material, coll=None):
    """A flat-topped prism over a site outline, from z0 up to z1."""
    n = len(pts)
    verts = [V(x, y, z0) for (x, y) in pts] + [V(x, y, z1) for (x, y) in pts]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    o = mesh(name, verts, faces, material, coll=coll)
    _outward(o)
    return o


def ring_between(name, outer, inner, z_out, z_in, material, coll=None):
    """A ring of faces from one closed outline to another of the same count."""
    n = len(outer)
    verts = [V(x, y, z_out) for (x, y) in outer] + [V(x, y, z_in) for (x, y) in inner]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    o = mesh(name, verts, faces, material, coll=coll)
    _outward(o)
    for p in o.data.polygons:
        if p.normal.z < 0:
            p.flip()
    return o


def bilinear(name, C, res, material, coll=None, thick=0.0):
    """A saddle shell between four corners in site points, straight lines all ways."""
    verts, faces = [], []
    for j in range(res + 1):
        for i in range(res + 1):
            u, v = i / res, j / res
            p = [C[0][k] * (1 - u) * (1 - v) + C[1][k] * u * (1 - v) + C[2][k] * u * v + C[3][k] * (1 - u) * v for k in range(3)]
            verts.append(V(*p))
    for j in range(res):
        for i in range(res):
            a = j * (res + 1) + i
            faces.append((a, a + res + 1, a + res + 2, a + 1))
    o = mesh(name, verts, faces, material, smooth=True, coll=coll)
    if thick:
        s = o.modifiers.new('solid', 'SOLIDIFY')
        s.thickness = thick
    return o


# ---------- the room's picture round its building ----------
def wrap_art(objs, picture, z0, z1):
    """
    One picture round a building: every wall shows the part of it in front of it. u runs along
    the near walls (Blender x + y: the distance round from the left-hand corner, true to the wall's
    length on both near faces) and v up the building, centred on the building, cropped like
    object-fit: cover and never squeezed. Pass every block of the building at once.
    """
    iw, ih = picture.size
    us = []
    for o in objs:
        mw = o.matrix_world
        for v in o.data.vertices:
            w = mw @ v.co
            us.append(w.x + w.y)
    u0, u1 = min(us), max(us)
    um = (u0 + u1) / 2
    h = z1 - z0
    k = min(iw / (u1 - u0), ih / h)
    oy = (ih - h * k) * 0.3
    for o in objs:
        me = o.data
        mw = o.matrix_world
        uv = me.uv_layers.active or me.uv_layers.new()
        for poly in me.polygons:
            for li in poly.loop_indices:
                w = mw @ me.vertices[me.loops[li].vertex_index].co
                px = iw / 2 + ((w.x + w.y) - um) * k
                py = oy + (z1 - w.z) * k
                uv.data[li].uv = (px / iw, 1 - py / ih)


def wrap_drum(o, picture, cx, cy, z0, z1, r):
    """The picture round a drum: the half that faces you shows its middle, left of the sheet on the left."""
    iw, ih = picture.size
    h = z1 - z0
    pic_w = h * iw / ih
    frac = math.pi * r / pic_w
    face_on = -math.pi / 4
    me = o.data
    mw = o.matrix_world
    uv = me.uv_layers.active or me.uv_layers.new()
    c = V(cx, cy)
    for poly in me.polygons:
        for li in poly.loop_indices:
            w = mw @ me.vertices[me.loops[li].vertex_index].co
            a = math.atan2(w.y - c.y, w.x - c.x)
            d = (a - face_on + math.pi) % (2 * math.pi) - math.pi
            uv.data[li].uv = (0.5 + (d / math.pi) * frac, (w.z - z0) / h)


def walls_art(o, art_mat, other_mat):
    """Give a block's walls the picture and its top (and bottom) another material."""
    if art_mat.name not in [m.name for m in o.data.materials]:
        o.data.materials.append(art_mat)
    if other_mat.name not in [m.name for m in o.data.materials]:
        o.data.materials.append(other_mat)
    ia = [m.name for m in o.data.materials].index(art_mat.name)
    io = [m.name for m in o.data.materials].index(other_mat.name)
    for p in o.data.polygons:
        p.material_index = ia if abs(p.normal.z) < 0.5 else io


# ---------- lights ----------
def light(kind, name, at, energy, colour, size=None, spot=None, blend=None, aim=None, shadow=True, soft=0.2):
    l = bpy.data.lights.new(name, kind)
    l.energy = energy
    l.color = colour
    if size is not None:
        l.size = size
    if spot is not None:
        l.spot_size = math.radians(spot)
    if blend is not None:
        l.spot_blend = blend
    if kind in ('POINT', 'SPOT'):
        l.shadow_soft_size = soft
    try:
        l.use_shadow = shadow
    except Exception:
        pass
    o = bpy.data.objects.new(name, l)
    put(o)
    o.location = V(*at)
    if aim is not None:
        o.rotation_euler = (V(*aim) - o.location).to_track_quat('-Z', 'Y').to_euler()
    return o


# ---------- island furniture ----------
def ladder(x, y, top, z0=0.06, along=1):
    """The lock ladder, leaning on a wall: the mark of a pool you can lock in."""
    out = top / 4
    m = cream()
    for s in (0.0, 0.3):
        tube('ladder rail', [(x + s * along, y + out, z0), (x + s * along, y + 0.03, z0 + top)], 0.025, m)
    for i in range(1, 7):
        t = i / 7
        o2 = out * (1 - t) + 0.03
        tube('ladder rung', [(x, y + o2, z0 + top * t), (x + 0.3 * along, y + o2, z0 + top * t)], 0.018, m)


def lamp(x, y):
    cyl('lamp post', x, y, 0.06, 0.04, 1.35, basalt(), verts=10)
    sphere('lamp head', x, y, 1.45, 0.09, glow(WARM, 18.0, 'lamp glow'), seg=12)
    light('POINT', 'lamp', (x, y, 1.4), 22, WARM, shadow=False, soft=0.1)


def patio(x, y, colour):
    cushion = painted(colour, 0.7)
    for dx in (-0.75, 0.55):
        box('lounger', x + dx, y - 0.45, 0.06, 0.34, 0.7, 0.12, cushion, bevel=0.03)
    cyl('parasol pole', x, y, 0.06, 0.03, 0.95, wood(), verts=8)
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.62, radius2=0.04, depth=0.32, location=tuple(V(x, y, 1.0)))
    o = bpy.context.active_object
    o.name = 'parasol'
    put(o)
    o.data.materials.append(thatch())


def stones(pts):
    """Stepping stones along a path of site points."""
    verts, faces = [], []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        n = max(1, round(math.hypot(b[0] - a[0], b[1] - a[1]) / 0.42))
        for j in range(0 if i == 0 else 1, n + 1):
            x = a[0] + (b[0] - a[0]) * j / n
            y = a[1] + (b[1] - a[1]) * j / n
            z = (a[2] if len(a) > 2 else 0.0) + 0.065
            base = len(verts)
            for k in range(8):
                ang = k / 8 * 2 * math.pi
                verts.append(V(x + 0.14 * math.cos(ang), y + 0.11 * math.sin(ang), z))
            faces.append(tuple(range(base + 7, base - 1, -1)))
    if verts:
        mesh('stepping stones', verts, faces, stone())


# ---------- palms ----------
_palm_variants = []


def _palm_variant(seed):
    rnd = random.Random(seed)
    trunk_pts = []
    lean = 0.45
    for i in range(13):
        t = i / 12
        trunk_pts.append((lean * t * t, 0.0, t))
    verts, faces = [], []
    top = Vector((lean, 0.0, 1.0))
    fronds = 15
    for f in range(fronds):
        yaw = f / fronds * 2 * math.pi + rnd.uniform(-0.18, 0.18)
        d = Vector((math.cos(yaw), math.sin(yaw), 0))
        side = Vector((-d.y, d.x, 0))
        L = rnd.uniform(0.42, 0.56)
        rise = rnd.uniform(0.05, 0.16)
        prev = None
        N = 14
        for s in range(N + 1):
            t = s / N
            c = top + d * (L * t) + Vector((0, 0, rise * t - (rise + 0.24) * t * t))
            if prev is not None and s >= 2:
                tangent = (c - prev).normalized()
                ll = 0.16 * math.sin(math.pi * t) ** 0.6 + 0.02
                for sgn in (-1, 1):
                    leaf = (side * sgn * 0.9 + tangent * 0.45 + Vector((0, 0, -0.6))).normalized()
                    w = 0.011
                    b0 = len(verts)
                    verts += [c - tangent * w, c + tangent * w, c + leaf * ll]
                    faces.append((b0, b0 + 1, b0 + 2))
            prev = c
    me = bpy.data.meshes.new(f'palm crown {seed}')
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    me.materials.append(mat('frond', (0.03, 0.15, 0.06), rough=0.42))
    cd = bpy.data.curves.new(f'palm trunk {seed}', 'CURVE')
    cd.dimensions = '3D'
    cd.bevel_depth = 0.028
    cd.bevel_resolution = 3
    sp = cd.splines.new('POLY')
    sp.points.add(len(trunk_pts) - 1)
    for i, p in enumerate(trunk_pts):
        sp.points[i].co = (*p, 1)
        sp.points[i].radius = 1.25 - 0.5 * (i / 12)
    cd.materials.append(mat('trunk', (0.3, 0.23, 0.17), rough=0.8))
    return me, cd


def palm(x, y, h, lean, ph, coll=None, z=0.06):
    """A palm h tall, its crown leaning `lean` across the sheet, turned by ph. Shares its meshes with every other palm."""
    global _palm_variants
    if not _palm_variants:
        _palm_variants = [_palm_variant(s) for s in range(5)]
    me, cd = _palm_variants[int(abs(ph) * 997) % len(_palm_variants)]
    for data, nm in ((me, 'palm crown'), (cd, 'palm trunk')):
        o = bpy.data.objects.new(nm, data)
        put(o, coll)
        o.location = V(x, y, z)
        o.scale = (h, h, h)
        o.rotation_euler = (0, 0, ph + (0 if lean >= 0 else math.pi))
    return o
