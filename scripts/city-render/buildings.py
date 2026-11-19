# The twenty buildings, in 3D, each one idea in an island's materials, every room's wrapped in its
# own picture. They follow the approved plates (frontend/src/lib/city/pieces.ts), taller so the art
# reads. Site coordinates throughout (kit.V turns them for Blender). A builder gets its plot (from
# plan.json) and, for a room, its picture (material, image).
import math, random
import bpy, bmesh
from mathutils import Vector
from kit import (V, box, cyl, sphere, tube, mesh, bilinear, rects, slab_from, wrap_art, wrap_drum, walls_art, light, ladder, put, inked,
                 mat, glow, glass, dark_glass, cream, brass, basalt, stone, thatch, tin, wood, bamboo, shell, painted, terrazzo, paving,
                 hexrgb, lin, WARM, CREAM)

ZP = 0.06


def _art_block(name, x, y, z, w, d, h, A, top=None, rot=0.0):
    """A block in the room's picture: walls take the picture, the top another material."""
    o = inked(box(name, x, y, z, w, d, h, A[0], rot=rot))
    walls_art(o, A[0], top or wood())
    return o


def _door(x, y, z, w, h, lit=False, face='L'):
    """A door on a wall's face: 'L' faces the sheet's lower left (site +y), 'R' the lower right (site +x)."""
    m = glow(WARM, 6.0, 'door glow') if lit else mat('door', (0.03, 0.03, 0.035), rough=0.4)
    if face == 'L':
        box('door', x, y - 0.02, z, w, 0.05, h, m)
    else:
        box('door', x - 0.02, y, z, 0.05, w, h, m)


def _window(x, y, z, w, h, face='L', lit=True):
    m = glow(WARM, 5.0, 'window glow') if lit else dark_glass()
    if face == 'L':
        box('window', x, y - 0.015, z, w, 0.04, h, m)
    else:
        box('window', x - 0.015, y, z, 0.04, w, h, m)


def _hip(name, x, y, w, d, e, rise, over, material):
    a = (x + w / 2, y + d / 2, e + rise)
    c = [(x - over, y - over, e), (x + w + over, y - over, e), (x + w + over, y + d + over, e), (x - over, y + d + over, e)]
    verts = [V(*a)] + [V(*p) for p in c]
    faces = [(0, 2, 1), (0, 3, 2), (0, 4, 3), (0, 1, 4)]
    o = mesh(name, verts, faces, material)
    s = o.modifiers.new('solid', 'SOLIDIFY')
    s.thickness = 0.05
    return inked(o)


def _butterfly(name, x, y, w, d, e, rise, over, material, lit=True):
    xm = x + w / 2
    zv, zt = e + 0.06, e + rise
    for (xa, xb) in ((x - over, xm), (xm, x + w + over)):
        za, zb = (zt, zv) if xa < xm else (zv, zt)
        o = mesh(name, [V(xa, y - over, za), V(xb, y - over, zb), V(xb, y + d + over, zb), V(xa, y + d + over, za)], [(0, 3, 2, 1)], material)
        o.modifiers.new('solid', 'SOLIDIFY').thickness = 0.05
        inked(o)
    if lit:
        # the V of glass under the wings, lamplit
        g = glow(WARM, 3.0, 'clerestory')
        mesh('clerestory', [V(x, y + d, e), V(x + w, y + d, e), V(x + w, y + d, zt - 0.02), V(xm, y + d, zv), V(x, y + d, zt - 0.02)], [(0, 1, 2, 3, 4)], g)


def _cone(name, x, y, z, r, h, material, verts=32, tip=None):
    bm = bmesh.new()
    base = [bm.verts.new(V(x + r * math.cos(2 * math.pi * i / verts), y + r * math.sin(2 * math.pi * i / verts), z)) for i in range(verts)]
    apex = bm.verts.new(V(*(tip or (x, y, z + h))))
    for i in range(verts):
        bm.faces.new((base[i], base[(i + 1) % verts], apex))
    bm.faces.new(list(reversed(base)))
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    put(o)
    o.data.materials.append(material)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def _helix(name, cx, cy, r_at, z0, z1, turns, a0, rad, material, n=360):
    pts = []
    for i in range(n + 1):
        t = i / n
        a = a0 + t * turns * 2 * math.pi
        z = z0 + t * (z1 - z0)
        r = r_at(z)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a), z))
    return tube(name, pts, rad, material)


def _treads(name, cx, cy, r_at, z0, z1, turns, a0, count, material):
    verts, faces = [], []
    for i in range(count):
        t = i / (count - 1)
        a = a0 + t * turns * 2 * math.pi
        z = z0 + t * (z1 - z0)
        r = r_at(z)
        c = (cx + r * math.cos(a), cy + r * math.sin(a))
        dirx, diry = math.cos(a), math.sin(a)
        tx, ty = -diry, dirx
        n = len(verts)
        for (o, s) in ((-0.17, -0.07), (0.17, -0.07), (0.17, 0.07), (-0.17, 0.07)):
            verts.append(V(c[0] + dirx * o + tx * s, c[1] + diry * o + ty * s, z))
        for (o, s) in ((-0.17, -0.07), (0.17, -0.07), (0.17, 0.07), (-0.17, 0.07)):
            verts.append(V(c[0] + dirx * o + tx * s, c[1] + diry * o + ty * s, z + 0.025))
        faces += [(n, n + 1, n + 2, n + 3), (n + 4, n + 7, n + 6, n + 5), (n, n + 4, n + 5, n + 1), (n + 1, n + 5, n + 6, n + 2), (n + 2, n + 6, n + 7, n + 3), (n + 3, n + 7, n + 4, n)]
    o = mesh(name, verts, faces, material)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    return o


def _van(x, y):
    white = mat('van white', (0.85, 0.87, 0.88), rough=0.3, coat=0.6)
    box('van body', x - 0.65, y - 0.3, 0.12, 1.3, 0.6, 0.62, white, bevel=0.06)
    box('van glass', x + 0.38, y - 0.31, 0.42, 0.24, 0.62, 0.26, dark_glass())
    box('van stripe', x - 0.6, y + 0.295, 0.3, 0.9, 0.02, 0.07, glow(lin(hexrgb('#5ad1e6')), 3.0, 'keeper stripe'))
    for dx in (-0.4, 0.4):
        for dy in (-0.3, 0.3):
            cyl('wheel', x + dx, y + dy, 0.06, 0.11, 0.08, mat('tyre', (0.01, 0.01, 0.01), rough=0.7), verts=16)


# ---------- the twenty ----------
def wing(p, A):
    """TOWELI. The Saddle: one thatched roof, twisted, two corners high on masts, two at shoulder height."""
    X, Y = p['X'], p['Y']
    hut = _art_block('hut', X + 0.3, Y + 0.4, ZP, 2.6, 2.0, 1.55, A, top=wood())
    wrap_art([hut], A[1], ZP, ZP + 1.55)
    _door(X + 1.3, Y + 2.4, ZP, 0.46, 1.0, lit=True)
    _window(X + 2.9, Y + 0.9, ZP + 0.7, 0.6, 0.5, face='R')
    ladder(X + 0.45, Y + 2.4, 1.45)
    C = [(X - 0.45, Y - 0.25, ZP + 1.85), (X + 3.65, Y - 0.25, ZP + 3.9), (X + 3.65, Y + 3.25, ZP + 2.1), (X - 0.45, Y + 3.25, ZP + 3.8)]
    inked(bilinear('saddle', C, 18, thatch(), thick=0.07))
    for (cx, cy, cz) in (C[1], C[3]):
        cyl('mast', cx, cy, ZP, 0.07, cz - ZP, wood(), verts=10)
    for (cx, cy, cz), (gx, gy) in ((C[1], (C[1][0] + 0.6, C[1][1] - 0.6)), (C[3], (C[3][0] - 0.6, C[3][1] + 0.6)), (C[0], (C[0][0] - 0.3, C[0][1] - 0.3)), (C[2], (C[2][0] + 0.35, C[2][1] + 0.4))):
        tube('guy', [(cx, cy, cz), (gx, gy, ZP)], 0.012, cream())
    light('POINT', 'under the saddle', (X + 1.6, Y + 1.4, ZP + 2.2), 45, WARM, shadow=False)
    return ZP + 4.0


def pads(p, A):
    """PEPE. The Lily Pads: giant leaves on stems, each with its one slit, over a mural screen wall."""
    X, Y = p['X'], p['Y']
    wall = _art_block('screen wall', X - 0.1, Y + 2.25, ZP, 3.0, 0.4, 1.9, A, top=stone())
    wrap_art([wall], A[1], ZP, ZP + 1.9)
    _door(X + 1.15, Y + 2.65, ZP, 0.5, 1.15)
    ladder(X + 0.05, Y + 2.65, 1.7)
    leaf = mat('lily leaf', lin(hexrgb('#7fd18f')), rough=0.35, coat=0.5, emit=lin(hexrgb('#5f9e6e')), strength=0.25)
    vein = glow(lin(hexrgb('#a6e83a')), 6.0, 'lily rim')
    stem = mat('stem', (0.1, 0.32, 0.14), rough=0.5)
    for (dx, dy, r, z, rot) in ((0.85, 0.6, 0.95, 2.75, 0.9), (1.45, 1.55, 0.8, 2.05, 4.0), (2.35, 0.95, 1.25, 3.6, 2.4), (2.95, 1.95, 0.62, 1.55, 5.2)):
        cx, cy = X + dx, Y + dy
        cyl('stem', cx, cy, ZP, 0.08, z - ZP, stem, r2=0.05, verts=12)
        n = 40
        verts = [V(cx, cy, z + 0.05)]
        for i in range(n + 1):
            a = rot + 0.18 + (2 * math.pi - 0.36) * i / n
            verts.append(V(cx + r * math.cos(a), cy + r * math.sin(a), z + 0.02 * math.sin(i)))
        faces = [(0, i + 2, i + 1) for i in range(n)]
        pad = mesh('lily pad', verts, faces, leaf, smooth=True)
        pad.modifiers.new('solid', 'SOLIDIFY').thickness = 0.05
        inked(pad)
        tube('pad rim', [(cx + r * math.cos(rot + 0.18 + (2 * math.pi - 0.36) * i / n), cy + r * math.sin(rot + 0.18 + (2 * math.pi - 0.36) * i / n), z + 0.04) for i in range(n + 1)], 0.018, vein)
        light('POINT', 'pad glow', (cx, cy, z - 0.35), 30, lin(hexrgb('#a6e83a')), shadow=False)
    return ZP + 3.8


def blade(p, A):
    """NFT loans. The Blade: the gallery wall from the loans sheet, under one roof drawn out to a point and tied back to a mast."""
    X, Y = p['X'], p['Y']
    wall = inked(box('gallery wall', X - 0.1, Y + 2.35, ZP, 3.6, 0.32, 2.1, mat('gallery white', (0.62, 0.6, 0.56), rough=0.6)))
    for i, col in enumerate(('#f5e4b8', '#5b7fe0', '#b49cff')):
        fx = X + 0.1 + i * 1.15
        box('frame', fx, Y + 2.67, ZP + 0.55, 0.95, 0.05, 1.15, mat('frame', (0.02, 0.02, 0.025), rough=0.3))
        box('picture', fx + 0.08, Y + 2.71, ZP + 0.63, 0.79, 0.03, 0.99, glow(lin(hexrgb(col)), 2.2, f'loan art {col}'))
        box('loan line', fx + 0.08, Y + 2.735, ZP + 0.85 + i * 0.22, 0.79, 0.015, 0.03, glow((1.0, 0.95, 0.8), 12.0, 'loan line'))
        box('plaque', fx + 0.3, Y + 2.7, ZP + 0.3, 0.35, 0.03, 0.12, cream())
    for (bx, tx) in ((0.5, 0.95), (2.9, 2.4)):
        tube('strut', [(X + bx, Y + 1.0, ZP), (X + tx, Y + 2.2, ZP + 2.6)], 0.035, stone())
    C = [(X - 0.7, Y + 1.35, ZP + 2.4), (X + 3.3, Y + 0.9, ZP + 2.7), (X + 5.7, Y + 3.35, ZP + 3.8), (X - 0.7, Y + 3.35, ZP + 2.2)]
    inked(bilinear('blade roof', C, 10, tin(), thick=0.05))
    mx, my = X + 4.2, Y + 0.7
    cyl('mast', mx, my, ZP, 0.05, 5.0, stone(), verts=10)
    for c in (C[1], C[2]):
        tube('tie', [(mx, my, ZP + 5.0), c], 0.012, cream())
    light('SPOT', 'gallery wash', (X + 1.7, Y + 4.2, ZP + 0.2), 260, (1.0, 0.92, 0.8), spot=70, blend=0.9, aim=(X + 1.7, Y + 2.6, ZP + 1.3))
    return ZP + 3.4


def balance(p, A):
    """The price keeper. The Balance: a lit beam across a stone wedge, a pan of water for our price and a pan of brass for the price outside."""
    X, Y = p['X'], p['Y']
    xa, xb, ya, yb = X - 0.55, X + 3.75, Y + 0.95, Y + 1.55
    ym = (ya + yb) / 2
    zc = ZP + 2.7
    wedge = mesh('wedge', [V(X + 0.9, yb + 0.35, ZP), V(X + 2.3, yb + 0.35, ZP), V(X + 2.3, ya - 0.35, ZP), V(X + 0.9, ya - 0.35, ZP), V(X + 1.6, ym, zc)],
                 [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (3, 2, 1, 0)], stone())
    inked(wedge)
    beam = inked(box('beam', xa, ya, zc, xb - xa, yb - ya, 0.34, mat('beam', (0.22, 0.22, 0.24), rough=0.3, coat=0.5)))
    box('beam light', xa + 0.1, yb - 0.01, zc + 0.09, xb - xa - 0.2, 0.03, 0.16, glow(WARM, 10.0, 'beam light'))
    for (px, fill, col) in ((xa + 0.3, glow(lin(hexrgb('#5ad1e6')), 4.0, 'pan water'), lin(hexrgb('#5ad1e6'))), (xb - 0.3, brass(), (1.0, 0.75, 0.35))):
        cyl('pan', px, ym, zc - 1.55, 0.62, 0.1, stone(), verts=40)
        cyl('pan fill', px, ym, zc - 1.46, 0.55, 0.02, fill, verts=40)
        for (dx, dy) in ((-0.52, 0), (0.52, 0), (0, 0.52)):
            tube('chain', [(px, ym, zc), (px + dx, ym + dy, zc - 1.46)], 0.01, cream())
        light('POINT', 'pan glow', (px, ym, zc - 1.2), 40, col, shadow=False)
    _van(X + 1.6, Y + 3.0)
    return zc + 0.6


def ghost(p, A):
    """An open lot. The Ghost: survey pegs and string, and the next building in glowing line, because nobody has drawn it yet."""
    x0, y0, X, Y = p['x0'], p['y0'], p['X'], p['Y']
    line = glow(CREAM, 1.1, 'ghost line')
    pegs = [(x0 + 0.5, y0 + 0.5), (x0 + 6.5, y0 + 0.5), (x0 + 6.5, y0 + 5.5), (x0 + 0.5, y0 + 5.5)]
    for (px, py) in pegs:
        cyl('peg', px, py, ZP, 0.04, 0.45, cream(), verts=8)
    tube('string', [(px, py, ZP + 0.35) for (px, py) in pegs + pegs[:1]], 0.008, line)
    x1, x2, y1, y2, h = X + 0.5, X + 2.8, Y + 0.5, Y + 2.4, ZP + 1.5
    for e in ([(x1, y2, ZP), (x2, y2, ZP), (x2, y1, ZP)], [(x1, y2, h), (x2, y2, h), (x2, y1, h), (x1, y1, h), (x1, y2, h)], [(x1, y2, ZP), (x1, y2, h)], [(x2, y2, ZP), (x2, y2, h)], [(x2, y1, ZP), (x2, y1, h)]):
        tube('ghost edge', e, 0.014, line)
    C = [(x1 - 0.35, y1 - 0.35, h + 1.6), (x2 + 0.35, y1 - 0.35, h + 0.25), (x2 + 0.35, y2 + 0.35, h + 1.4), (x1 - 0.35, y2 + 0.35, h + 0.25)]
    for i in range(5):
        t = i / 4
        lerp = lambda a, b, s: tuple(a[k] + (b[k] - a[k]) * s for k in range(3))
        tube('ghost roof', [lerp(lerp(C[0], C[1], t), lerp(C[3], C[2], t), s / 6) for s in range(7)], 0.01, line)
        tube('ghost roof', [lerp(lerp(C[0], C[3], t), lerp(C[1], C[2], t), s / 6) for s in range(7)], 0.01, line)
    cyl('sign post', x0 + 1.3, y0 + 4.5, ZP, 0.035, 0.75, wood(), verts=8)
    cyl('sign post', x0 + 3.0, y0 + 4.5, ZP, 0.035, 0.75, wood(), verts=8)
    box('sign', x0 + 1.05, y0 + 4.46, ZP + 0.75, 2.2, 0.08, 0.8, mat('sign board', (0.12, 0.12, 0.13), rough=0.6))
    box('sign line', x0 + 1.3, y0 + 4.55, ZP + 1.25, 1.7, 0.01, 0.06, cream())
    return ZP + 3.2


def slouch(p, A):
    """MFER. The Slouch: three slabs, each slid and turned further than the one below, the last hanging in the air on one prop."""
    X, Y = p['X'], p['Y']
    def blk(name, cx, cy, w, d, ang, z, h):
        return _art_block(name, cx - w / 2, cy - d / 2, z, w, d, h, A, top=terrazzo(), rot=ang)
    s1 = blk('slab 1', X + 1.3, Y + 1.5, 2.3, 1.9, 0.0, ZP, 1.35)
    s2 = blk('slab 2', X + 1.65, Y + 1.4, 2.7, 1.5, -0.24, ZP + 1.35, 1.0)
    s3 = blk('slab 3', X + 1.95, Y + 1.3, 3.1, 1.15, -0.52, ZP + 2.35, 0.85)
    wrap_art([s1, s2, s3], A[1], ZP, ZP + 3.2)
    _door(X + 1.05, Y + 2.45, ZP, 0.42, 0.95, lit=True)
    ladder(X + 0.3, Y + 2.45, 1.25)
    tube('prop', [(X + 3.55, Y + 2.6, ZP), (X + 3.05, Y + 1.95, ZP + 2.35)], 0.05, stone())
    tube('aerial', [(X + 2.2, Y + 1.1, ZP + 3.2), (X + 2.2, Y + 1.1, ZP + 4.2)], 0.012, cream())
    light('SPOT', 'slab wash', (X + 2.4, Y + 4.4, ZP + 0.1), 220, WARM, spot=60, blend=0.9, aim=(X + 1.8, Y + 1.6, ZP + 1.9))
    return ZP + 3.4


def monolith(p, A):
    """BNKR. The Monolith: a block held over an open lobby on needles, split by a seam of light, a palm on its roof."""
    X, Y = p['X'], p['Y']
    z1 = ZP + 1.5
    ndl = stone()
    for (dx, dy) in ((0.5, 0.45), (2.7, 0.45), (0.5, 2.45), (2.7, 2.45)):
        cyl('needle', X + dx, Y + dy, ZP, 0.045, z1 - ZP, ndl, verts=10)
    core = box('lobby', X + 1.25, Y + 1.1, ZP, 0.7, 0.7, z1 - ZP, glow(WARM, 4.0, 'lobby'))
    light('POINT', 'lobby light', (X + 1.6, Y + 1.45, ZP + 0.7), 60, WARM, shadow=False)
    lo = _art_block('lower', X + 0.3, Y + 0.25, z1, 2.6, 2.4, 1.15, A, top=basalt())
    box('seam', X + 0.4, Y + 0.35, z1 + 1.15, 2.4, 2.2, 0.08, glow(WARM, 14.0, 'seam'))
    up = _art_block('upper', X + 0.3, Y + 0.25, z1 + 1.23, 2.6, 2.4, 1.15, A, top=basalt())
    wrap_art([lo, up], A[1], z1, z1 + 2.38)
    ladder(X + 0.4, Y + 2.7, 1.35)
    from kit import palm
    palm(X + 1.3, Y + 1.2, 1.6, 0.3, 1.3, z=z1 + 2.38)
    return z1 + 2.5


def gridshell(p, A):
    """DRB. The Gridshell: a bamboo dome you see through, and inside it a round room wrapped in DRB's picture, a fire on its roof."""
    X, Y, cx, cy = p['X'], p['Y'], p['cx'], p['cy']
    cyl('ring', cx, cy, ZP, 1.8, 0.15, stone(), verts=72)
    floor = ZP + 0.15
    room = cyl('round room', cx, cy, floor, 1.15, 1.05, A[0], verts=96, cap=True)
    walls_art(room, A[0], basalt())
    wrap_drum(room, A[1], cx, cy, floor, floor + 1.05, 1.15)
    inked(room)
    _cone('fire', cx, cy, floor + 1.05, 0.22, 0.45, glow((1.0, 0.55, 0.15), 18.0, 'fire'))
    light('POINT', 'fire light', (cx, cy, floor + 1.4), 120, (1.0, 0.6, 0.25), shadow=False)
    R, s = 1.72, 1.0
    bam = bamboo()
    for turn in (1, -1):
        for j in range(16):
            pts = []
            for i in range(14):
                ph = i / 13 * (math.pi / 2) * 0.92
                th = j / 16 * 2 * math.pi + turn * ph * 1.25
                pts.append((cx + R * math.cos(ph) * math.cos(th), cy + R * math.cos(ph) * math.sin(th), floor + R * s * math.sin(ph)))
            tube('bamboo', pts, 0.022, bam)
    tube('base ring', [(cx + R * math.cos(2 * math.pi * i / 64), cy + R * math.sin(2 * math.pi * i / 64), floor) for i in range(65)], 0.035, bam)
    rt = R * math.cos(math.pi / 2 * 0.92)
    tube('oculus', [(cx + rt * math.cos(2 * math.pi * i / 32), cy + rt * math.sin(2 * math.pi * i / 32), floor + R * s * math.sin(math.pi / 2 * 0.92)) for i in range(33)], 0.03, bam)
    gate = _art_block('gate', X - 0.4, Y + 2.65, ZP, 1.7, 0.26, 1.35, A, top=stone())
    wrap_art([gate], A[1], ZP, ZP + 1.35)
    _door(X + 0.25, Y + 2.91, ZP, 0.45, 0.95)
    ladder(X - 0.3, Y + 2.91, 1.2)
    return floor + R + 0.2


def wave(p, A):
    """JBM. The Surf: one golden roof coming in like a set of waves, each taller than the last."""
    X, Y = p['X'], p['Y']
    e = 1.35
    hut = _art_block('hall', X, Y + 0.45, ZP, 3.2, 2.1, e, A, top=wood())
    wrap_art([hut], A[1], ZP, ZP + e)
    _door(X + 1.4, Y + 2.55, ZP, 0.45, 1.0, lit=True)
    ladder(X + 0.12, Y + 2.55, 1.25)
    xa, xb = X - 0.3, X + 3.5
    def zat(x):
        t = max(0.0, min(1.0, (x - xa) / (xb - xa)))
        return ZP + e + 0.12 + (0.32 + 0.95 * t) * (0.5 - 0.5 * math.cos(t * 2 * math.pi * 2.5))
    n = 60
    xs = [xa + (xb - xa) * i / n for i in range(n + 1)]
    verts, faces = [], []
    for x in xs:
        verts += [V(x, Y + 0.2, zat(x)), V(x, Y + 2.85, zat(x))]
    for i in range(n):
        a = 2 * i
        faces.append((a, a + 2, a + 3, a + 1))
    roof = mesh('surf roof', verts, faces, shell(p['acc']), smooth=True)
    roof.modifiers.new('solid', 'SOLIDIFY').thickness = 0.06
    inked(roof)
    yf = Y + 2.55
    gv, gf = [], []
    xs2 = [X + 3.2 * i / 30 for i in range(31)]
    for x in xs2:
        gv += [V(x, yf, ZP + e), V(x, yf, zat(x) - 0.02)]
    for i in range(30):
        a = 2 * i
        gf.append((a, a + 1, a + 3, a + 2))
    mesh('surf glass', gv, gf, glow(WARM, 3.5, 'surf glass'))
    for i in range(1, 12):
        x = X + 3.2 * i / 12
        box('mullion', x - 0.015, yf - 0.03, ZP + e, 0.03, 0.04, zat(x) - ZP - e, cream())
    return ZP + e + 1.4


def lighthouse(p, A):
    """BAYLA. The Lighthouse: the tower wrapped in BAYLA's picture, the lock ladder wound round it as a stair, a frosted lantern."""
    X, Y, cx, cy = p['X'], p['Y'], p['cx'], p['cy']
    cyl('step', cx, cy, ZP, 1.55, 0.14, basalt(), verts=72)
    cyl('step', cx, cy, ZP + 0.14, 1.3, 0.14, basalt(), verts=72)
    g = glow(WARM, 20.0, 'groove')
    for (r, z) in ((1.54, ZP + 0.13), (1.29, ZP + 0.27)):
        tube('groove', [(cx + r * math.cos(2 * math.pi * i / 72), cy + r * math.sin(2 * math.pi * i / 72), z) for i in range(73)], 0.012, g)
    z0 = ZP + 0.28
    H = 5.6
    R0, R1 = 0.98, 0.8
    shaft = cyl('tower', cx, cy, z0, R0, H, A[0], r2=R1, verts=128, cap=False)
    wrap_drum(shaft, A[1], cx, cy, z0, z0 + H, (R0 + R1) / 2)
    inked(shaft)
    r_at = lambda z: R0 + (R1 - R0) * (z - z0) / H + 0.2
    c = cream()
    _helix('stair rail', cx, cy, lambda z: r_at(z) + 0.1, z0 + 0.15, z0 + H, 2.25, 0.4, 0.014, c)
    _helix('stair rail', cx, cy, lambda z: r_at(z) + 0.1, z0 + 0.45, z0 + H + 0.3, 2.25, 0.4, 0.014, c)
    _treads('treads', cx, cy, r_at, z0 + 0.15, z0 + H, 2.25, 0.4, 110, c)
    zt = z0 + H
    inked(cyl('gallery', cx, cy, zt, R1 + 0.38, 0.08, basalt(), verts=64))
    tube('gallery rail', [(cx + (R1 + 0.34) * math.cos(2 * math.pi * i / 64), cy + (R1 + 0.34) * math.sin(2 * math.pi * i / 64), zt + 0.45) for i in range(65)], 0.012, c)
    for i in range(36):
        a = 2 * math.pi * i / 36
        tube('gallery post', [(cx + (R1 + 0.34) * math.cos(a), cy + (R1 + 0.34) * math.sin(a), zt + 0.08), (cx + (R1 + 0.34) * math.cos(a), cy + (R1 + 0.34) * math.sin(a), zt + 0.45)], 0.008, c)
    cyl('lamp core', cx, cy, zt + 0.15, 0.28, 0.65, glow((1.0, 0.86, 0.6), 50.0, 'lamp core'), verts=32)
    inked(cyl('lantern', cx, cy, zt + 0.08, 0.6, 0.9, glass(), verts=48))
    inked(cyl('lantern roof', cx, cy, zt + 1.15, R1 + 0.25, 0.06, mat('roof cream', CREAM, rough=0.4, emit=WARM, strength=0.3), r2=R1 + 0.05))
    tube('mast', [(cx, cy, zt + 1.21), (cx, cy, zt + 2.0)], 0.02, c)
    sphere('beacon', cx, cy, zt + 2.05, 0.06, glow((1.0, 0.12, 0.06), 40.0, 'beacon'), seg=12)
    light('POINT', 'lantern', (cx, cy, zt + 0.5), 500, (1.0, 0.82, 0.55), soft=0.3)
    light('SPOT', 'beam', (cx, cy, zt + 0.5), 30000, (1.0, 0.86, 0.6), spot=8, blend=0.7, aim=(cx - 14, cy - 4, zt - 3))
    for i, ang in enumerate((-0.2, -0.95, -1.7)):
        a = ang - math.pi / 4
        fx, fy = cx + 1.35 * math.cos(a), cy - 1.35 * math.sin(a)
        light('SPOT', 'tower wash', (fx, fy, ZP + 0.35), 160, WARM, spot=28, blend=0.9, aim=(cx + (fx - cx) * 0.25, cy + (fy - cy) * 0.25, z0 + 4.2), soft=0.1)
    cot = _art_block('cottage', X - 0.25, Y + 2.0, ZP, 1.45, 0.9, 0.85, A, top=wood())
    wrap_art([cot], A[1], ZP, ZP + 0.85)
    _door(X + 0.95, Y + 2.15, ZP, 0.42, 0.65, lit=True, face='R')
    _butterfly('cottage roof', X - 0.25, Y + 2.0, 1.45, 0.9, ZP + 0.85, 0.36, 0.12, tin())
    return zt + 2.1


def canopy(p, A):
    """Central Station. The Umbrellas: three thin shells on single columns over the stand every swap sets off from."""
    X, Y = p['X'], p['Y']
    hall = inked(box('hall', X - 0.45, Y + 0.05, ZP, 4.8, 0.85, 1.3, dark_glass()))
    for i in range(12):
        box('pane', X - 0.35 + i * 0.39, Y + 0.89, ZP + 0.12, 0.3, 0.03, 1.0, glow(WARM, 2.6 if i % 3 else 1.2, 'hall pane'))
    nx, ny = X + 4.5, Y + 0.25
    inked(box('clock needle', nx, ny, ZP, 0.45, 0.45, 4.6, stone()))
    _hip('needle top', nx, ny, 0.45, 0.45, ZP + 4.6, 1.1, 0.0, stone())
    box('clock face', nx + 0.1, ny + 0.44, ZP + 4.0, 0.25, 0.03, 0.25, glow((1.0, 0.95, 0.85), 8.0, 'clock'))
    sh = shell(p['acc'])
    for i in range(3):
        ux, uy = X + 0.3 + i * 1.62, Y + 2.0
        lift = 0.45 if i == 1 else 0.0
        zc, zt, half = ZP + 1.7 + lift, ZP + 2.95 + lift, 0.85
        for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            inked(bilinear('umbrella', [(ux, uy, zc), (ux + sx * half, uy, zt), (ux + sx * half, uy + sy * half, zt), (ux, uy + sy * half, zt)], 6, sh, thick=0.04))
        cyl('column', ux, uy, ZP, 0.08, zc - ZP, stone(), r2=0.05, verts=16)
        light('POINT', 'under umbrella', (ux, uy, zc - 0.35), 70, WARM, shadow=False)
    return ZP + 3.6


def hourglass(p, A):
    """The Treasury. The Hourglass: a brass lattice over a stone strongroom, every member straight; 48 marks ring its foot for the 48-hour wait."""
    X, Y = p['X'], p['Y']
    cx, cy = X + 1.6, Y + 1.3
    z0, z1, R, tw = ZP + 0.16, ZP + 4.9, 1.38, 2.2
    inked(cyl('base', cx, cy, ZP, 1.75, 0.16, stone(), verts=72))
    for i in range(48):
        a = 2 * math.pi * i / 48
        box('mark', cx + 1.58 * math.cos(a) - 0.03, cy + 1.58 * math.sin(a) - 0.03, z0, 0.06, 0.06, 0.02, brass())
    inked(cyl('strongroom', cx, cy, z0, 0.68, 1.05, stone(), verts=48))
    box('vault door', cx - 0.25, cy + 0.6, z0, 0.5, 0.12, 0.85, brass())
    b = brass()
    for turn in (1, -1):
        for i in range(24):
            a0 = 2 * math.pi * i / 24
            a1 = a0 + turn * tw
            tube('lattice', [(cx + R * math.cos(a0), cy + R * math.sin(a0), z0), (cx + R * math.cos(a1), cy + R * math.sin(a1), z1)], 0.018, b)
    for (z, r) in ((z0, R), (z1, R), ((z0 + z1) / 2, R * math.cos(tw / 2))):
        tube('lattice ring', [(cx + r * math.cos(2 * math.pi * i / 64), cy + r * math.sin(2 * math.pi * i / 64), z) for i in range(65)], 0.025, b)
    light('POINT', 'waist', (cx, cy, (z0 + z1) / 2), 160, (1.0, 0.75, 0.35), shadow=False)
    light('SPOT', 'brass wash', (cx + 2.4, cy + 2.4, ZP + 0.2), 400, (1.0, 0.85, 0.6), spot=50, blend=0.9, aim=(cx, cy, ZP + 2.5))
    return z1 + 0.2


def lifeguard(p, A):
    """Range pools. The Diving Tower: one thin wall, three boards out over the lanes."""
    x, y = p['x0'] + 6.45, p['y0'] + 2.3
    inked(box('tower wall', x, y, ZP, 0.2, 0.8, 3.4, stone()))
    for (z, ln) in ((1.05, 1.0), (1.95, 1.45), (2.85, 0.9)):
        inked(box('board', x - ln, y + 0.12, ZP + z, ln + 0.2, 0.56, 0.07, mat('board', (0.8, 0.78, 0.72), rough=0.5)))
    for i in range(1, 14):
        box('rung', x + 0.2, y + 0.3, ZP + i * 0.24, 0.03, 0.2, 0.025, cream())
    tube('flag pole', [(x + 0.1, y + 0.4, ZP + 3.4), (x + 0.1, y + 0.4, ZP + 4.2)], 0.012, cream())
    mesh('flag', [V(x + 0.1, y + 0.4, ZP + 4.2), V(x + 0.6, y + 0.28, ZP + 4.05), V(x + 0.1, y + 0.4, ZP + 3.9)], [(0, 1, 2)], mat('flag', (0.85, 0.2, 0.12), rough=0.6))
    return ZP + 4.2


def lift(p, A):
    """BOBO. The Raising: four bamboo masts, the thatched roof part-way up them on its ropes, not yet set down."""
    X, Y = p['X'], p['Y']
    hut = _art_block('hut', X + 0.45, Y + 0.45, ZP, 2.3, 1.9, 1.3, A, top=glow(WARM, 3.0, 'open top'))
    wrap_art([hut], A[1], ZP, ZP + 1.3)
    _door(X + 1.35, Y + 2.35, ZP, 0.42, 0.95, lit=True)
    _window(X + 2.75, Y + 0.9, ZP + 0.55, 0.6, 0.45, face='R')
    ladder(X + 0.56, Y + 2.35, 1.2)
    light('POINT', 'inside', (X + 1.6, Y + 1.4, ZP + 1.1), 60, WARM, shadow=False)
    mh = ZP + 4.9
    feet = [(X - 0.15, Y - 0.15), (X + 3.35, Y - 0.15), (X + 3.35, Y + 2.95), (X - 0.15, Y + 2.95)]
    heads = [(X + 0.45, Y + 0.45), (X + 2.75, Y + 0.45), (X + 2.75, Y + 2.35), (X + 0.45, Y + 2.35)]
    bam = bamboo()
    for f, h in zip(feet, heads):
        tube('mast', [(f[0], f[1], ZP), (h[0], h[1], mh)], 0.045, bam)
    for i in range(4):
        a, b = heads[i], heads[(i + 1) % 4]
        tube('tie', [(a[0], a[1], mh - 0.25), (b[0], b[1], mh - 0.25)], 0.035, bam)
    e = ZP + 2.15
    _hip('raised roof', X + 0.45, Y + 0.45, 2.3, 1.9, e, 1.6, 0.4, thatch())
    eaves = [(X + 0.1, Y + 0.1), (X + 3.1, Y + 0.1), (X + 3.1, Y + 2.7), (X + 0.1, Y + 2.7)]
    for h, ev in zip(heads, eaves):
        tube('rope', [(h[0], h[1], mh - 0.25), (ev[0], ev[1], e)], 0.008, cream())
    return mh + 0.1


def halo(p, A):
    """SOY. The Halo: a lit dance floor on a mural-walled roof, a ring of neon over it on three raking masts."""
    X, Y = p['X'], p['Y']
    club = _art_block('club', X + 0.1, Y + 0.25, ZP, 2.9, 2.4, 1.4, A, top=basalt())
    wrap_art([club], A[1], ZP, ZP + 1.4)
    z1 = ZP + 1.4
    rnd = random.Random(4)
    cols = ['#ff4fc8', '#5ad1e6', '#b5c95f', '#ffd078', '#b49cff', '#ff6fa3']
    tw, td = 2.5 / 4, 2.0 / 4
    for i in range(4):
        for j in range(4):
            c = cols[rnd.randrange(len(cols))]
            box('floor tile', X + 0.3 + i * tw + 0.02, Y + 0.45 + j * td + 0.02, z1, tw - 0.04, td - 0.04, 0.02, glow(lin(hexrgb(c)), 1.6, f'tile {c}'))
    box('door', X + 1.3, Y + 2.62, ZP, 0.45, 0.05, 0.8, glow(lin(hexrgb('#ff6fa3')), 4.0, 'club door'))
    ladder(X + 0.22, Y + 2.65, 1.3)
    cx, cy, R = X + 1.55, Y + 1.45, 2.0
    def ring(t):
        return (cx + R * math.cos(t), cy + R * math.sin(t), z1 + 2.0 + 0.55 * math.cos(t - 0.7))
    neon = glow(lin(hexrgb('#ff2f86')), 5.0, 'neon')
    tube('halo', [ring(2 * math.pi * i / 96) for i in range(97)], 0.045, neon)
    for (gx, gy, t) in ((X - 0.45, Y - 0.2, 3.9), (X + 3.6, Y + 0.2, 5.6), (X + 1.0, Y + 3.25, 1.75)):
        tube('halo mast', [(gx, gy, ZP), ring(t)], 0.035, stone())
    for i in range(4):
        q = ring(2 * math.pi * i / 4)
        light('POINT', 'neon glow', q, 35, lin(hexrgb('#ff6fa3')), shadow=False)
    for (tx, ty) in ((X - 0.25, Y + 3.0), (X + 3.3, Y + 3.0)):
        cyl('torch', tx, ty, ZP, 0.03, 1.0, wood(), verts=8)
        _cone('flame', tx, ty, ZP + 1.0, 0.07, 0.2, glow((1.0, 0.55, 0.15), 20.0, 'flame'))
        light('POINT', 'torch', (tx, ty, ZP + 1.15), 20, (1.0, 0.6, 0.25), shadow=False)
    return z1 + 2.7


def stack(p, A):
    """BRAINLET. The Wrong Way Up: the smallest block at the bottom, the biggest on top, each turned, a thatched hat worn askew."""
    X, Y = p['X'], p['Y']
    cx, cy = X + 1.6, Y + 1.5
    def blk(name, bx, by, w, d, ang, z, h):
        return _art_block(name, bx - w / 2, by - d / 2, z, w, d, h, A, top=wood(), rot=ang)
    s1 = blk('small', cx - 0.05, cy + 0.15, 1.15, 1.05, 0.12, ZP, 1.15)
    s2 = blk('middle', cx + 0.1, cy + 0.02, 1.75, 1.5, -0.2, ZP + 1.15, 1.05)
    s3 = blk('big', cx - 0.05, cy - 0.05, 2.5, 2.2, 0.15, ZP + 2.2, 1.4)
    wrap_art([s1, s2, s3], A[1], ZP, ZP + 3.6)
    ladder(cx - 0.55, cy + 0.72, 1.05)
    for (gx, gy, tx, ty) in ((X - 0.15, Y + 2.85, X + 0.7, Y + 2.25), (X + 3.3, Y + 2.35, X + 2.6, Y + 1.95)):
        tube('prop', [(gx, gy, ZP), (tx, ty, ZP + 2.2)], 0.04, stone())
    zt = ZP + 3.6
    _cone('hat', cx - 0.45, cy - 0.2, zt, 0.85, 1.2, thatch(), verts=40, tip=(cx - 0.1, cy - 0.6, zt + 1.25))
    tube('telescope', [(cx + 0.45, cy + 0.35, zt + 0.35), (cx + 1.3, cy - 0.5, zt + 1.05)], 0.07, cream())
    tube('telescope stand', [(cx + 0.45, cy + 0.35, zt), (cx + 0.45, cy + 0.35, zt + 0.35)], 0.02, cream())
    light('SPOT', 'stack wash', (cx + 1.9, cy + 2.6, ZP + 0.1), 200, WARM, spot=60, blend=0.9, aim=(cx, cy, ZP + 2.2))
    return zt + 1.3


def villa(p, A):
    """Your wallet. The Villa: a house on stilts under a thatched butterfly roof; everything you earn comes in by the front door."""
    X, Y = p['X'], p['Y']
    zf = ZP + 0.55
    post = wood()
    for i in range(4):
        for j in range(3):
            cyl('stilt', X + 0.18 + i * 0.95, Y + 0.28 + j * 1.25, ZP, 0.05, zf - ZP, post, verts=8)
    inked(box('deck', X, Y + 0.1, zf - 0.1, 3.2, 2.85, 0.1, wood()))
    house = inked(box('house', X + 0.2, Y + 0.25, zf, 2.8, 1.8, 1.15, painted(p['acc'], 0.45)))
    box('front door', X + 1.2, Y + 2.03, zf, 0.75, 0.05, 1.0, glow((1.0, 0.92, 0.75), 6.0, 'villa door'))
    light('POINT', 'door light', (X + 1.6, Y + 2.5, zf + 0.8), 70, WARM, shadow=False)
    for wx in (X + 0.4, X + 2.3):
        _window(wx, Y + 2.05, zf + 0.35, 0.45, 0.55)
    _window(X + 3.0, Y + 0.6, zf + 0.35, 0.9, 0.55, face='R')
    _butterfly('villa roof', X + 0.2, Y + 0.25, 2.8, 1.8, zf + 1.15, 0.8, 0.32, thatch())
    c = cream()
    for (a, b) in (((X, Y + 2.95), (X + 1.1, Y + 2.95)), ((X + 2.1, Y + 2.95), (X + 3.2, Y + 2.95)), ((X + 3.2, Y + 2.95), (X + 3.2, Y + 0.1))):
        tube('rail', [(a[0], a[1], zf + 0.32), (b[0], b[1], zf + 0.32)], 0.012, c)
    for i in range(3):
        box('step', X + 1.15, Y + 2.95 + i * 0.17, ZP, 0.9, 0.17, (zf - ZP) * (1 - (i + 1) / 4), post)
    for lx in (X + 1.1, X + 2.1):
        tube('door lamp post', [(lx, Y + 2.95, zf), (lx, Y + 2.95, zf + 0.62)], 0.01, c)
        sphere('door lamp', lx, Y + 2.95, zf + 0.68, 0.05, glow(WARM, 20.0, 'lamp glow'), seg=10)
    return zf + 2.0


def bloom(p, A):
    """RIZZ. The Bloom: seven petals opening from a mural-walled roof round a lamp."""
    X, Y = p['X'], p['Y']
    base = _art_block('base', X + 0.2, Y + 0.15, ZP, 2.8, 2.5, 1.25, A, top=wood())
    wrap_art([base], A[1], ZP, ZP + 1.25)
    _door(X + 1.35, Y + 2.65, ZP, 0.45, 0.85, lit=True)
    ladder(X + 0.32, Y + 2.65, 1.15)
    z1 = ZP + 1.25
    rose = mat('rose', (0.7, 0.04, 0.05), rough=0.5)
    for i in range(9):
        sphere('rose', X + 0.35 + i * 0.32, Y + 2.58, z1 + 0.05, 0.06, rose, seg=10)
    cx, cy = X + 1.6, Y + 1.4
    sphere('lamp', cx, cy, z1 + 0.45, 0.28, glow((1.0, 0.75, 0.6), 30.0, 'bloom lamp'), seg=20)
    light('POINT', 'bloom light', (cx, cy, z1 + 0.6), 220, (1.0, 0.55, 0.5), shadow=False)
    petal_m = mat('petal', lin(hexrgb('#ff5a5a')), rough=0.35, emit=lin(hexrgb('#ff5a5a')), strength=0.6, coat=0.4)
    for k in range(7):
        an = 2 * math.pi * k / 7 + 0.35
        verts, faces = [], []
        N, M = 12, 6
        for i in range(N + 1):
            t = i / N
            r = 0.45 + 1.35 * t
            z = z1 + 2.3 * (t ** 0.85)
            wd = 0.42 * math.sin(math.pi * (0.08 + 0.92 * t)) ** 0.8
            for j in range(M + 1):
                s = j / M - 0.5
                a = an + s * wd * 1.6 / max(r, 0.5)
                cup = 0.18 * (1 - (2 * s) ** 2) * math.sin(math.pi * t)
                rr = r - cup
                verts.append(V(cx + rr * math.cos(a), cy + rr * math.sin(a), z + cup * 0.5))
        for i in range(N):
            for j in range(M):
                a = i * (M + 1) + j
                faces.append((a, a + 1, a + M + 2, a + M + 1))
        pet = mesh('petal', verts, faces, petal_m, smooth=True)
        pet.modifiers.new('solid', 'SOLIDIFY').thickness = 0.03
        inked(pet)
    return z1 + 2.5


def slip(p, A):
    """The launch slip. The Slip: a hull in frame, its ribs showing, the stern under a tarp, a timber arch over the bow."""
    X, Y = p['X'], p['Y']
    cx, ya, yb = X + 1.45, Y + 0.45, Y + 4.05
    w = wood()
    rects('slipway', [((X + 0.5, Y + 0.1), (X + 2.4, Y + 4.9), ZP + 0.005)], mat('slipway', (0.08, 0.08, 0.085), rough=0.6))
    for i in range(10):
        yy = Y + 0.4 + i * 0.47
        box('sleeper', X + 0.7, yy, ZP, 1.5, 0.12, 0.06, w)
    half = lambda t: 0.8 * math.sin(math.pi * (0.13 + t * 0.87)) ** 0.75
    sheer = lambda t: ZP + 1.35 + 0.55 * abs(t - 0.42) ** 2.2 / 0.58 ** 2.2
    keel = lambda t: ZP + 0.45 + (((t - 0.78) / 0.22) ** 1.6 * 1.2 if t > 0.78 else 0)
    yy = lambda t: ya + (yb - ya) * t
    tube('keel', [(cx, yy(i / 30), keel(i / 30)) for i in range(31)] + [(cx, yb, sheer(1) + 0.15)], 0.045, w)
    for i in range(15):
        t = i / 15
        pts = []
        for j in range(13):
            s = j / 12
            ang = math.pi * s
            pts.append((cx - half(t) * math.cos(ang), yy(t), keel(t) + (sheer(t) - keel(t)) * (1 - math.sin(ang)) ** 0.6))
        tube('rib', pts, 0.025, w)
    for sgn in (-1, 1):
        tube('sheer', [(cx + sgn * half(i / 30), yy(i / 30), sheer(i / 30)) for i in range(31)] + [(cx, yb, sheer(1) + 0.15)], 0.022, cream())
    tarp = mat('tarp', (0.35, 0.22, 0.1), rough=0.8)
    ts = [0, 0.07, 0.14, 0.21, 0.28]
    verts = [V(cx - half(t), yy(t), sheer(t) + 0.08) for t in ts] + [V(cx + half(t), yy(t), sheer(t) + 0.08) for t in ts]
    faces = [(i, i + 1, 6 + i, 5 + i) for i in range(4)]
    mesh('tarp top', verts, faces, tarp)
    for sgn in (-1, 1):
        sv = [V(cx + sgn * half(t), yy(t), sheer(t) + 0.08) for t in ts] + [V(cx + sgn * (half(t) - 0.05), yy(t), sheer(t) - 0.45) for t in ts]
        mesh('tarp side', sv, [(i, i + 1, 6 + i, 5 + i) for i in range(4)], tarp)
    for ay in (Y + 3.2, Y + 3.6):
        tube('arch', [(X - 0.35 + 3.6 * (i / 28), ay, ZP + 3.9 * 4 * (i / 28) * (1 - i / 28)) for i in range(29)], 0.05, w)
    tube('tackle', [(cx, Y + 3.4, ZP + 3.9), (cx, yb, sheer(1) + 0.2)], 0.008, cream())
    cyl('lamp post', X + 2.85, Y + 4.4, ZP, 0.03, 0.95, basalt(), verts=8)
    sphere('lamp off', X + 2.85, Y + 4.4, ZP + 1.0, 0.07, mat('amber off', (0.35, 0.22, 0.05), rough=0.3), seg=10)
    return ZP + 3.0


BUILDERS = {
    'wing': wing, 'pads': pads, 'blade': blade, 'balance': balance, 'ghost': ghost, 'slouch': slouch, 'monolith': monolith,
    'gridshell': gridshell, 'wave': wave, 'lighthouse': lighthouse, 'canopy': canopy, 'hourglass': hourglass, 'lifeguard': lifeguard,
    'lift': lift, 'halo': halo, 'stack': stack, 'villa': villa, 'bloom': bloom, 'slip': slip,
}
