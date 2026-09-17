# The art runbook

How a folder of pictures becomes the art on a bungalow's door.

Five steps. Step 1 is the island's. Steps 2 and 3 are one command each. Step 4 is
done by eye in a browser, and step 5 is sending one file back.

Everything below was checked against the repo on 2026-09-16, not written from
memory. Where the words and the code disagree, the code is quoted.

---

## Step 1. Drop the art in a folder, one folder per bungalow

At the top of the repo, make a folder for the bungalow and put the pictures in
it. **This folder's name is for people, not for the tooling.** Nothing reads the
top of the repo; the name that has to be exact is the one in step 2. Naming it
after the bungalow is simply the way to know which pile is which, and the QR pile
arrived as `qrbungalow/` without any harm done:

```
bayla/   pepe/   mfer/   bnkr/   drb/   jbm/   bobo/   soy/   brainlet/   rizz/
```

Filenames do not matter. Camera roll names are fine, and the ones already here
are iPhone UUIDs. Formats that count: `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`.

The ids are the ones in `frontend/src/lib/bungalows.ts`. There are thirteen:

```
bayla  bnkr  bobo  brainlet  drb  jbm  mfer  nb1  pepe  qr  rizz  soy  toweli
```

Two notes on that list, both true today:

* **`qr` shows how little the drop folder's name matters.** QR's pile sits at
  the top of the repo as `qrbungalow/`, and its ten pictures are placed at
  `frontend/public/art/qr/` under the id. Same ten filenames, both places.
* **`nb1` has neither, and that is correct.** It is the quiet slot, and it is
  marked `live: false` in the registry.

These folders are a drop zone. They are not read by the site, they are not
committed, and no script opens them. Step 2 is what puts art where the site can
find it.

## Step 2. Move the folder into the frontend

The site only reads one place:

```
frontend/public/art/<id>/
```

So copy the pictures there, into a folder with the same id name. If the folder
already exists, add to it.

**The folder name must be an id from the registry.** A folder with any other
name is ignored in silence, and there is a live example of that in the repo
right now: `frontend/public/art/towelie/` holds three pictures that render
nowhere, because the registry id is `toweli` and `towelie` is only the alias
that opens the same room. Three other folders are ignored the same way on
purpose, because they are staging, not bungalows: `drop/`, `iphone/`, `new/`.

## Step 3. Run the generator

From the `frontend` folder:

```bash
node scripts/gen-bungalow-art.mjs
```

It scans `public/art/<id>/` for every id in the registry and writes
`frontend/src/lib/bungalowArtPools.ts`. It prints what it found, one line per
bungalow plus a total.

That file is generated. Do not hand edit it. If a picture is not listed there
after a run, the site cannot show it.

**The piece id is the filename with the extension removed. It is never the
position in the folder.** This is the one rule in the whole runbook worth
knowing by heart, and the code says why at `bungalows.ts`:

> an index-derived id would silently repoint every saved placement the moment a
> folder gains a file

Placements from step 4 are stored against those ids. Keep a filename and its
placement survives; rename a file and that one placement goes back to the
automatic rotation, which is a picture in the wrong place, not a crash.

## Step 4. Place the art by eye, in the studio

Open the bungalow's own studio. It is not linked from anywhere, so type the URL:

```
https://memetics.finance/bungalow-studio/<id>
```

Pick the surface, pick the piece, nudge the framing. The studio is the same tool
in both places, and only the button at the end differs:

* On the live site there is **no save path at all**. The button reads **Export
  placements** and downloads a file called `bungalowArtOverrides.ts`.
* Running locally (`npm run dev` in `frontend`), the button reads **Save to
  disk** and writes `frontend/src/lib/bungalowArtOverrides.ts` directly. That
  write only exists in the dev server.

Each placement is stored as `<bungalowId>|<pageId>:<index>` pointing at a piece
id, so two skins never overwrite each other's choices, and a bungalow may borrow
a classic piece by naming it.

## Step 5. Send the exported file back

DM the downloaded `bungalowArtOverrides.ts`. It replaces
`frontend/src/lib/bungalowArtOverrides.ts` in the repo, and the placements are
live on the next deploy.

If a placement ever names a picture that is no longer there, that surface falls
back to the automatic rotation. Nothing breaks, and nothing goes blank.

---

## The four files, in order

| What | Where | Written by |
| --- | --- | --- |
| The pictures | `frontend/public/art/<id>/` | step 2, by hand |
| The list of pictures | `frontend/src/lib/bungalowArtPools.ts` | step 3, generated |
| The registry (ids, names, doors) | `frontend/src/lib/bungalows.ts` | by hand, rarely |
| The placements | `frontend/src/lib/bungalowArtOverrides.ts` | step 4, by the studio |

## If something does not show up

1. Is the folder under `frontend/public/art/` named exactly a registry id?
   `towelie` is not one. `toweli` is. (The drop folder at the top of the repo can
   be called anything; it is only step 2's name that decides.)
2. Did step 3 run, and did it print that bungalow with the count you expect?
3. Is the file extension one of `.jpg .jpeg .png .webp .avif`?
4. Is it a placement problem rather than a missing picture? An unknown piece id
   in the overrides file falls back to the rotation, so the door still paints.
