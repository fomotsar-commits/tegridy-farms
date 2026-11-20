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
- `island.py`: builds the island from `plan.json` and renders one frame. A close-up is a portrait:
  a 35 mm camera at eye height, from the corner the building's art wraps round, with a warm key light
  on the art and a cool rim light behind. Whatever stands between that camera and the building (a
  neighbour, a palm, a lamp, its own garden corner) is left out of that frame; what stands behind it
  stays, softly out of focus. The drawing set's cream line is drawn on the island only.
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
The island takes a few minutes; each close-up one to three minutes. Write test frames to an absolute
path: Blender reads a relative one from its own working folder.

One plot alone, to work on a building: `blender -b --factory-startup --python island.py -- plate:<plotId> out/plate.png 0.6 16`.

If a building's height changes, change its number in `PIECE_TOP` (`frontend/src/lib/city/render.ts`):
its plaque hangs there, and a press reaches up to it.
