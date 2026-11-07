# PLO GTO Study — local solve runner

This folder is a self-contained solver that runs on **your own computer**.
You pick poker spots from a built-in catalog of 300, your computer solves
them one after another (or a few at a time), and every finished solve is
added to your library — locally, and also to your central library on the
web if you connect one.

Nothing is installed and nothing needs administrator rights. Everything
the runner needs (including its own copy of Node.js) lives inside this
folder, so it works from any location — a path with spaces in it is fine.

## One-time setup

1. Unzip the package anywhere you like.
2. Double-click **setup.bat**.
   - **Step 1:** choose an admin password for this computer's runner and
     type it twice (the typing is hidden). Only a scrambled "hash" of the
     password is stored — never the password itself. Avoid the characters
     `%` and `"` in the password; the setup script cannot carry those two
     safely. Forgot it later? Just run setup.bat again and pick a new one.
   - **Step 2 (optional):** if your library also lives on a server, enter
     its address (URL) and then that server's admin password. From then
     on, every finished solve uploads there automatically. Press Enter to
     skip: solves then stay in the local library until you connect, which
     you can do at any time (see "Connecting later" below).

## Solving

1. Double-click **start.bat**. A console window opens and stays open —
   that window *is* the server. Keep it open while you solve; closing it
   (or pressing Ctrl+C) stops the runner.
2. Your browser opens the runner page at
   **http://localhost:8787/admin/runner** (if it doesn't, type that
   address yourself). Log in with the password from setup.
3. Tick the spots you want (filters at the top narrow the list by group,
   table size, street, or status), then **Add selected to queue**.
4. The queue panel at the top shows the work in order. A solving spot
   shows how long it has been running — real solves take minutes to
   hours, and the page deliberately shows elapsed time rather than a
   made-up percentage. When a spot finishes, the page shows its measured
   accuracy (Nash %) and iteration count, and whether it uploaded.

### How many solves at once?

The **At once** stepper in the queue panel sets how many spots solve in
parallel (1–8). Each running solve uses roughly one CPU core and up to a
couple of GB of memory. If you are using the computer for other things,
leave it at 1–2; if the machine is otherwise idle, 3–4 is a good fit for
most desktops. You can change it at any time — it takes effect on the
next spots that start.

### If the computer stops or freezes

Nothing finished is ever lost:

- Each spot is marked done **only after** its result is fully written to
  the local library (in `local-data\library`), and uploads are retried
  automatically until the central library confirms them.
- If the computer freezes, loses power, or the window is closed, just
  run **start.bat** again. The queue is saved on disk
  (`local-data\queue.json`): finished spots stay finished, and the one
  spot that was in the middle of solving goes back to "queued" and
  starts over. One honest caveat: a half-finished solve restarts from
  the beginning — the solver does not checkpoint mid-solve.

## Where results go

- **Local library:** `local-data\library` inside this folder. The runner
  page and the study app on this computer read from it.
- **Central library:** if you connected one in setup, each finished
  solve is pushed there (you will see "Uploaded" next to the spot). The
  push is safe to repeat — the central library recognises duplicates.

## Connecting later / re-connecting

Uploads use a login that lasts about **30 days**. When it expires,
finished spots will start showing "Upload failed … session rejected"
while still solving and saving locally just fine. To reconnect, open a
Command Prompt in this folder and run:

```
node-win\node.exe api\runner-login.mjs
```

It asks for the central address and password and stores a fresh login.
(Or simply run **setup.bat** again — step 2 does the same thing.)

The stored login lives in `local-data\runner-config.json`. Treat that
file like a password: don't share it.

## Range trimming: runner-settings.txt

Catalog ranges are wider than a home solve can hold exactly, so each
spot's ranges are trimmed to a per-side cap before solving (the catalog
shows the coverage percentage for every spot). `runner-settings.txt`
chooses how, via `QUEUE_RANGE_MODE`:

- `top` (default) — keep the highest-weight combos: a deterministic,
  premium-heavy slice of the range.
- `sample` — draw combos in proportion to their range weight, so the
  trimmed range sketches the whole range; the draw is seeded per spot,
  so every run and every machine gets the same sample.

Edit the value, save the file, and restart the runner to apply it.

## What's in the folder

| Path | What it is |
| --- | --- |
| `start.bat` / `setup.bat` | The two double-click scripts described above |
| `start.sh` | The Linux twin of start.bat (for testing the package on Linux) |
| `api\` | The job service that queues and runs solves and serves the app |
| `ui\dist\` | The web app itself (study screens + this runner page) |
| `engine-win\` | The Windows solver engine |
| `node-win\` | A portable Node.js runtime, used only inside this folder |
| `data\` | The preflop range sets and the 300-spot catalog |
| `local-data\` | Your queue, your finished solves, and the upload login — created as you go |
| `local-env.txt` | The admin password *hash* written by setup.bat |

## Troubleshooting

- **"Port 8787 is already in use"** — the runner is probably already
  running in another window. Use that one, or close it first.
- **The browser didn't open** — browse to
  http://localhost:8787/admin/runner manually; the runner works the
  same.
- **"Engine binary not found"** — the package was assembled without the
  Windows engine. Re-download the complete package.
- **An upload keeps failing with a network error** — the central server
  is unreachable from this computer (off, or the address changed). The
  solves are safe locally and the upload retries on its own every
  15 minutes and at every start.
