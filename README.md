# Gesture Looper (phase 3: audio core + layers + sessions)

A browser looper you control with your hands. Hold a gesture, and it records your
voice into a loop that stays exactly on the beat. Use headphones: the microphone is
recorded raw, so speakers would feed back.

## Run it

```
npm install     (first time only)
npm run dev
```

Open the printed address (normally http://localhost:5173), click
"Start camera and microphone", and allow both permissions.
If you add files while `npm run dev` is running, stop it (Ctrl+C) and start it again once.

## How recording works

1. Hold **Victory**. You hear a one-bar count-in (4 clicks, the first one higher).
2. Recording starts exactly on the bar line and runs for the loop length (default 2 bars).
3. The loop then plays back, perfectly in time with the click grid.
4. Hold **Victory** again to add another layer: it starts recording at the next loop start.
   Pressing Victory during a recording ends it at the next bar line (the rest of that layer stays silent).
5. With loop length **Auto**, the first Victory starts, the second closes the loop at the end of the bar.

## Gestures (left hand, edit in `src/config.ts`)

| Gesture | Command | Hold |
| --- | --- | --- |
| Victory | Record / close loop | 0.3 s |
| Fist | Stop / resume (also discards a take in progress) | 0.5 s |
| Thumbs down | Undo last layer (or discard a take in progress) | 0.5 s |
| I-love-you sign | Clear all | 1.2 s |

Keyboard backup for testing sound without the camera: **R** record, **S** stop/resume, **U** undo, **C** clear, **M** metronome on/off, **1-9** mute layers, **Shift+1-9** solo.

## Layers

Every recording is its own layer, listed in the Layers panel with its waveform and a moving playhead.

- **M** button or key **1** to **9**: mute that layer (number = its position in the list).
- **S** button or **Shift + 1** to **9**: solo it (hear only that layer). A new recording clears any solo.
- **Slider**: volume, from silent up to 1.5x (boosts quiet takes).
- **x** button: delete that layer (the others keep playing; deleting the last one resets the loop).

## Saving and loading

- **Save session** downloads a zip: `session.json`, one lossless WAV per layer (`layer-1.wav`...),
  `mixdown.wav` (everything you hear, muted layers left out) and a short README. Open the WAVs in Audacity or any DAW.
  Tempo, loop length, layer names, volumes and mutes are saved. Solo, click and latency trim are not.
- **Load session** reads such a zip. If you already have layers, you must click the button twice (the second click replaces them).
  If the zip was saved at a different audio sample rate, it is converted automatically.
- **Autosave** keeps your latest session inside the browser (IndexedDB) about 1.5 seconds after every change.
  After a refresh or crash, press **Restore autosave**. It never saves an empty session, so even an accidental
  "Clear all" can be undone with Restore. **Delete autosave** wipes it. It lives only in this browser on this computer.

## Settings (on the page)

- **Tempo**: type a BPM or tap the Tap button. Locked while a loop exists.
- **Loop length**: 1, 2, 4 or 8 bars, or Auto. Locked while a loop exists.
- **Metronome**: master on/off switch (also key **M**). Off means no click at all, including the count-in, which then shows on screen only. The loop timing stays exactly the same. Remembered between visits.
- **Click during playback**: keep the metronome going after recording (needs the Metronome switch on).
- **Latency trim**: if your singing lands early or late against the click, nudge this. It is remembered.

## Known limits

- Bluetooth headphones add a lot of delay. Use the latency trim, or a wired headset.
- Keep the tab visible while looping; browsers slow background tabs, which can make clicks late.

## Project layout

```
index.html                    the page
public/recorder-worklet.js    records exact sample ranges on the audio thread
src/config.ts                 MAPPING: gestures -> commands, and timings (edit this one)
src/gestureEngine.ts          safety logic: smoothing, hold, release, cooldown
src/handTracker.ts            RECOGNITION: wraps MediaPipe
src/audio/grid.ts             beat/bar/loop maths in whole audio frames
src/audio/audioEngine.ts      microphone, recorder, metronome click
src/audio/looper.ts           the looper: count-in, layers (mute/solo/volume), stop/resume, undo, clear, save/load state
src/audio/mix.ts              shared loudness rules (volume curve, mute/solo, waveform outline)
src/session/session.ts        session <-> zip (session.json + WAV files + mixdown)
src/session/zip.ts            tiny zip writer/reader (no libraries)
src/session/wav.ts            WAV writer/reader
src/session/autosave.ts       latest session kept in the browser (IndexedDB)
src/main.ts                   camera, drawing, controls, and the live display
src/style.css                 the look
```
