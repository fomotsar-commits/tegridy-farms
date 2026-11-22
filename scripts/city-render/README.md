# The city's render

`/city` shows the island as one picture made in Blender, an architect's model at night in a
gallery, with the live parts (people
walking a wallet's staking pay, plaques, the picked plot) drawn over it by the page. Tapping a
building opens its close-up. This folder makes those pictures.

## What is here

- `plan.json`: the island's layout, written from the site's own plan (`frontend/src/lib/city/plan.ts`)
  by `frontend/src/lib/city/renderPlan.test.ts`. That test fails if this file and the plan disagree,
  so a render can never stand its buildings somewhere the page's plaques and presses are not.
  The town is not a grid: its streets are smooth curves (`roads`, closely set centre lines; a
  ring road round the island, a boulevard from the pier through the plaza, a short lane), and
  each plot stands on a street's far side, turned to face it. A plot has TWO places: its frame
  (`x0`, `y0`, its pool, garden, palms and lamps; the old grid slot, where `buildings.py` and
  `maquette.py` make it) and its `site` (the middle it is moved to and how far it is turned, in
  radians, the site's sense). `island.py` builds each plot in its frame, then moves the lot to its
  site; a close-up is shot in the frame, so moving a plot never changes its close-up.
- `kit.py`: materials and parts (each room's picture as a lit print, thatch, tin, bamboo, palms,
  lamps, the art wrap). Everything takes the site's coordinates; Blender's world is the site's with
  y turned over, because the site's axonometric is a mirror of a real camera's view.
- `buildings.py`: the twenty buildings, one idea each, every room's wrapped in its own picture.
- `stock.py`: the model maker's stock both pictures are made of, so the island and its close-ups
  are one model: basswood, white card, cork, walnut, brass, gloss resin pools in each community's
  colour, the art laid as glazed tile (each tile takes the picture's colour under its centre),
  white figures for scale, and the one Cycles setup. `swap()` hands the builders this stock in
  place of `kit.py`'s night materials, and the owner's palms, street lamps and garden corners in
  place of `kit.palm`, `kit.lamp` and `kit.patio`, so the island, every close-up and BNKR's roof
  share them.
- `props/`: the owner's own models (made with Meshy AI, 2026-11-21), slimmed for the city: a
  coconut palm, a streetlight, the harbour's kayak rack, dock cart, fishing gear, cleat, tender
  and buoys, and the garden corners' umbrella, loungers, pool lounge set, fire pit and hammock. `stock.prop()` reads each once, upright and centred, and carves it in
  basswood: its own picture's light and dark become the wood's, so detail stays and colour goes.
  `stock.place()` sets one down at its real size. The originals (millions of triangles each) are
  kept out of the repo; a prop here is 3,000 to 20,000 triangles with one small picture.
- `island.py`: builds the island from `plan.json` as one model at night in a gallery: cork land on
  a pale veneer beach, a sea of deep blue resin, grey card streets on card pavements, basswood palms
  and beads for trees, three white figures on every plot. The gallery is dark (a low warm spot on
  the middle of the town, a cool rim, a moon), so the model is lit by its own street lamps, windows
  and pools. Cycles, the site's own axonometric camera.
- `maquette.py`: a building's close-up, the same model seen up close. It builds the plot with the
  island's own builders in `stock.py`'s stock, sets the plot on a cut block and a black
  plinth with three white figures for scale, and shoots it in Cycles at eye level: a 50 mm lens
  framed to the building's own size, from the corner its art wraps round, under a warm gallery spot,
  a cool rim light, and a blue-hour wall behind. Whatever stands between the camera and the
  building (a palm, a lamp, its garden corner) is left out. Colour is kept for the art and the
  money; the rest is pale model stock.
- Each room's garden corner is one of four, by its id: a parasol over loungers, a fire pit with log
  stools, a daybed under a canopy in its pool's colour, or a hammock.
- `grade.py`: a soft glow round the brightest lights and a light vignette.
- `render_all.py`: renders the island and every close-up and writes them to `frontend/public/city/`.

## Render again

After a change to the plan (a room joins, a plot moves):

```
cd frontend
CITY_PLAN_WRITE=1 npx vitest run src/lib/city/renderPlan.test.ts
cd ../scripts/city-render
python render_all.py
```

Blender 5.0 runs headless (`-b`), so nothing needs to be open. Set `BLENDER` to its exe if it is not
at `C:\Program Files\Blender Foundation\Blender 5.0\blender.exe`. Python needs Pillow and NumPy.
The island takes about ten minutes; each close-up one to two minutes (Cycles, on the CPU of an
18-thread PC). Write test frames to an absolute path: Blender reads a relative one from its own working folder.

Every run of `render_all.py` ends by writing each picture's fingerprint to
`frontend/src/lib/city/renderFingerprints.json`, and the page puts it on the picture's link
(`?v=`). The pictures keep their names, and a browser keeps each for a week without asking, so
without a new link a returning visitor sees the old picture under the new plaques. Commit the
file with the pictures; `lib/city/renderFingerprints.test.ts` fails if they disagree. A picture
changed by hand: `python render_all.py fingerprints` writes only the fingerprints.

One close-up again: `python render_all.py <plotId>`. A quick look at one (a third of the size, few
samples): `blender -b --factory-startup --python maquette.py -- <plotId> <absolute out.png> 0.35 24`.
One plot alone on the island, to work on a building: `blender -b --factory-startup --python island.py -- plate:<plotId> out/plate.png 0.6 16`.

If a building's height changes, change its number in `PIECE_TOP` (`frontend/src/lib/city/render.ts`):
its plaque hangs there, and a press reaches up to it.
