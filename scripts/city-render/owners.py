# The owner's own buildings (made with Meshy AI, 2026-11-22: "replace the models we have with the
# appropriate one, use all of them"), carved in the model's basswood like the props (stock.prop).
# Five civic plots stand one in place of their designed piece (the rooms keep theirs: each is wrapped
# in its own art); the lighthouse lights the pier's head, and three more buildings and two small
# islands stand on open ground and out at sea, on the island only. Site coordinates throughout.
import math
import kit
import stock

ZP, PW, PD = 0.06, 7, 6

# piece: (model, highest, longest side, turn in Blender's sense, kept clear at the front, at the +x side).
# Each is fitted inside its plot clear of its pool, its garden corner and its palms (plan.ts PALM_SPOTS).
PIECES = {
    'bank': ('bank', 3.4, 4.6, 0.0, 0.6, 0.0),
    'poolclub': ('pool-complex', 1.3, 5.8, math.pi / 2, 1.1, 0.0),
    'pavilion': ('pool-pavilion', 3.0, 5.0, 0.0, 0.0, 1.4),
    'market': ('market', 2.6, 5.6, 0.0, 1.1, 1.2),
    'marina': ('marina-office', 3.4, 4.6, 0.0, 1.0, 2.7),
}
# a piece whose model brings its own pools: the plot's resin pool is not poured under it
OWN_POOLS = {'poolclub'}


def _box(p, front, side):
    x0, y0 = p['x0'], p['y0']
    xa, xb, ya, yb = x0 + 0.4, x0 + PW - 0.4, y0 + 0.4, y0 + PD - 0.4
    pl = p['pool']
    if pl and p['piece'] not in OWN_POOLS:
        xb = min(xb, pl['cx'] - pl['rw'] / 2 - 0.35)
    if p['kind'] == 'room':
        yb = min(yb, y0 + 4.75 - 0.75)              # its garden corner
    return xa, xb - side, ya, yb - front


def fit(p):
    """Where a plot's model stands and how large: (middle x, y, scale, width, depth, height) in site units."""
    name, hmax, lmax, rot, front, side = PIECES[p['piece']]
    water = (_rgb(p['pool']['water']), 1.7) if p['piece'] in OWN_POOLS and p['pool'] else None
    _, (w, d, h), _ = stock.prop(name, water=water)
    if abs(math.sin(rot)) > 0.7:
        w, d = d, w
    xa, xb, ya, yb = _box(p, front, side)
    k = min(hmax / h, lmax / max(w, d), (xb - xa) / w, (yb - ya) / d)
    return (xa + xb) / 2, (ya + yb) / 2, k, w * k, d * k, h * k


def centre(p):
    bx, by, *_ = fit(p)
    return bx, by


def _rgb(h):
    h = h.lstrip('#')
    return tuple((int(h[i:i + 2], 16) / 255.0) ** 2.2 for i in (0, 2, 4))


def _lit(x, y, w, d, h, fx=0.0, fy=1.0):
    """A low wash from the street and a warm lamp at the door: only what a light falls on reads at night."""
    rx, ry = fy, -fx
    wash = (x + fx * (d / 2 + 1.7) + rx * w * 0.45, y + fy * (d / 2 + 1.7) + ry * w * 0.45, ZP + 0.4)
    kit.light('SPOT', 'wash', wash, 420, (1.0, 0.86, 0.66), spot=75, blend=0.9, aim=(x, y, ZP + h * 0.45))
    door = (x + fx * (d / 2 + 0.35) + rx * w * 0.15, y + fy * (d / 2 + 0.35) + ry * w * 0.15, ZP + min(h * 0.35, 1.1))
    kit.light('POINT', 'door lamp', door, 30, kit.WARM, shadow=False, soft=0.15)


def build(p, A):
    """A plot's own building: the owner's model, lit, with what stands round it. Returns its top."""
    piece = p['piece']
    name, _, _, rot, _, _ = PIECES[piece]
    bx, by, k, w, d, h = fit(p)
    x0, y0 = p['x0'], p['y0']
    z = ZP
    stock.place(name, bx, by, z, h, 'h', rot=rot)
    _lit(bx, by, w, d, h)
    front_y = y0 + PD - 0.4 - 0.55                 # the strip kept clear at the front
    if piece in ('bank', 'pavilion'):
        kind, size = ('planter-palm', 1.15) if piece == 'bank' else ('hibiscus', 0.55)
        for sx in (-0.42, 0.42):
            stock.place(kind, bx + sx * w, by + d / 2 + 0.35, ZP, size, 'h', rot=0.3)
    elif piece == 'poolclub':
        stock.place('lifeguard-chair', x0 + 1.4, front_y, ZP, 1.0, 'h', rot=math.pi)
        stock.place('rescue-stand', x0 + 3.5, front_y, ZP, 0.62, 'h')
        stock.place('pool-shower', x0 + 5.6, front_y, ZP, 0.75, 'h')
    elif piece == 'market':
        stock.place('market-awning', x0 + 1.2, front_y, ZP, 0.9, 'h')
        stock.place('market-crates', x0 + 2.3, front_y, ZP, 0.42, 'h', rot=0.4)
        stock.place('scooter', x0 + 3.4, front_y, ZP, 0.58, 'l', rot=0.9)
        stock.place('food-cart', x0 + 4.6, front_y, ZP, 0.78, 'h', rot=-0.3)
        kit.light('POINT', 'stall light', (x0 + 1.6, front_y + 0.3, 0.8), 22, (1.0, 0.78, 0.5), shadow=False, soft=0.3)
    elif piece == 'marina':
        # along its side, between it and the plot's palms, clear of the view of its front
        for i, f in enumerate(('flag-jamaica', 'flag-india', 'flag-us')):
            stock.place(f, x0 + 4.45, y0 + 0.7 + i * 1.45, ZP, 2.4, 'h', rot=-0.6)
    return z + h + 0.2


# ---------- on open ground and at sea: the island only ----------
# (model, middle x, y, turn (Blender's sense: its front to its street), width, depth as fitted). Found
# clear of plots, pavements, junctions, lamps, the streets' palms and the shore, each front to its
# street and to the visitor; island.py checks the plan still leaves them clear.
GROUND = [
    ('hotel', 12.0, -4.0, 0.201, 4.2, 4.6),
    ('cafe', 28.0, 13.0, 0.326, 3.6, 2.6),
    ('house-veranda', -4.0, 30.0, 1.742, 3.2, 3.1),
]
ISLETS = [('island-terrain', 19.0, -31.0, 0.6, 11.0), ('island-ocean', 27.0, 63.0, -0.5, 11.0)]
LAGOON = (_rgb('#2bb6c4'), 0.5)


def footprints(grow=0.0):
    """Each building on open ground, as its corners on the site, grown by `grow`."""
    out = []
    for (_, x, y, rot, w, d) in GROUND:
        fx, fy = math.sin(rot), math.cos(rot)
        rx, ry = fy, -fx
        W, D = w / 2 + grow, d / 2 + grow
        out.append([(x + rx * sx * W + fx * sy * D, y + ry * sx * W + fy * sy * D) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    return out


def harbour_light(px, y1, deck):
    """The owner's lighthouse at the pier's head, on a round head of the deck's wood, its lamp lit."""
    kit.cyl('pier head', px, y1 - 0.3, -0.12, 1.7, 0.14, kit.wood(), verts=48)
    me, (w, d, h), head = stock.prop('lighthouse')
    k = 5.0 / h
    x, y = px, y1 - 0.3
    stock.place('lighthouse', x, y, deck, 5.0, 'h', rot=math.pi * 0.25)
    # its lamp: the model's top, turned with it
    c, s = math.cos(math.pi * 0.25), math.sin(math.pi * 0.25)
    hx, hy = head.x * k, head.y * k
    lx, ly, lz = x + hx * c - hy * s, y - (hx * s + hy * c), deck + 5.0 * 0.84
    kit.sphere('lighthouse lamp', lx, ly, lz, 0.2, kit.glow((1.0, 0.7, 0.3), 14.0, 'lighthouse lamp glow'), seg=16)
    kit.light('POINT', 'beacon light', (lx, ly, lz), 140, (1.0, 0.72, 0.35), shadow=False, soft=0.2)
    kit.light('SPOT', 'wash', (x + 2.6, y + 2.6, deck + 0.3), 380, (1.0, 0.86, 0.66), spot=60, blend=0.9, aim=(x, y, deck + 2.2))


def ground():
    """The hotel, the café and the veranda house on open ground; the two small islands at sea."""
    for (name, x, y, rot, w, d) in GROUND:
        _, (mw, md, mh), _ = stock.prop(name)
        k = min(w / mw, d / md)
        stock.place(name, x, y, ZP - 0.06, mh * k, 'h', rot=rot)
        fx, fy = math.sin(rot), math.cos(rot)
        _lit(x, y, mw * k, md * k, mh * k, fx, fy)
        rx, ry = fy, -fx
        kind, size = ('planter-palm', 1.1) if name == 'hotel' else ('hibiscus', 0.5)
        for sx in (-0.42, 0.42):
            stock.place(kind, x + fx * (md * k / 2 + 0.35) + rx * sx * mw * k, y + fy * (md * k / 2 + 0.35) + ry * sx * mw * k, 0.0, size, 'h', rot=rot)
    for (name, x, y, rot, size) in ISLETS:
        stock.prop(name, water=LAGOON)
        stock.place(name, x, y, -0.36, size, 'l', rot=rot)
        for l in (kit.light('POINT', 'islet glow', (x, y, 4.0), 500, (1.0, 0.85, 0.65), shadow=True, soft=1.5),
                  kit.light('POINT', 'islet rim', (x - 4.0, y - 4.0, 2.0), 200, (0.6, 0.72, 1.0), shadow=False, soft=2.0)):
            l.visible_glossy = False                  # not seen in the glossy resin sea, as the gallery's lights
            l.visible_camera = False


BUILDERS = {piece: build for piece in PIECES}
