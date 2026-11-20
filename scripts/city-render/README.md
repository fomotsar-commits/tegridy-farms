# The city's render

`/city` shows the island as one night picture made in Blender, with the live parts (people
walking a wallet's staking pay, plaques, the picked plot) drawn over it by the page. Tapping a
building opens its close-up. This folder makes those pictures.

## What is here

- `plan.json`: the island's layout, written from the site's own plan (`frontend/src/lib/city/plan.ts`)
  by `frontend/src/lib/city/renderPlan.test.ts`. That test fails if this file and the plan disagree,
  so a render can never stand its buildings somewhere the page's plaques and presses are not.
- `kit.py`: materials and parts (each room's picture as a lit print, thatch, tin, bamboo, palms,
  lamps, the art wrap). Everything takes the site's coordinates; Blender's world is the site's with
  y turned over, because the site's axonometric is a mirror of a real camera's view.
- `buildings.py`: the twenty buildings, one idea each, every room's wrapped in its own picture.
- `island.py`: builds the island from `plan.json` and renders it at night, with the drawing set's
  cream line on the architecture.
- `maquette.py`: a building's close-up, as an architect's model. It builds the plot with the
  island's own builders, then swaps every material for a model maker's (basswood, white card, cork,
  walnut, brass, gloss resin pools in each community's colour), lays the room's art as glazed tile
  (each tile takes the picture's colour under its centre), sets the plot on a cut block and a black
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
The island takes a few minutes; each close-up one to two minutes (Cycles, on the CPU of an 18-thread
PC). Write test frames to an absolute path: Blender reads a relative one from its own working folder.

One close-up again: `python render_all.py <plotId>`. A quick look at one (a third of the size, few
samples): `blender -b --factory-startup --python maquette.py -- <plotId> <absolute out.png> 0.35 24`.
One plot alone on the island, to work on a building: `blender -b --factory-startup --python island.py -- plate:<plotId> out/plate.png 0.6 16`.

If a building's height changes, change its number in `PIECE_TOP` (`frontend/src/lib/city/render.ts`):
its plaque hangs there, and a press reaches up to it.
