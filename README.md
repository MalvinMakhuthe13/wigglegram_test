# Wigglegram — depth moments for events

A phone camera app for events and clubs. Shoot a short sideways sweep, and it turns it into a looping 3D "wiggle" clip with your branding. Then take payment and send the clip to the guest on the spot.

Plain HTML, CSS and JavaScript. No build step, and no server is needed to run it. Install it to the home screen like an app; after the first visit it works offline.

## Why it has more depth than a 4-lens camera

A 4-lens camera has a fixed, short gap between lenses and exactly 4 views. Wigglegram:

- **Shoots a burst of 6–24 frames while you slide the phone** (about a hand-width), so the distance between the first and last view is many times wider than lens spacing. More distance means more parallax, which means more depth.
- **Measures how far the camera actually moved in each frame** and picks views evenly spaced by *distance*, not time. An uneven hand still gives a smooth turn. Where several frames are close to the right spot, it keeps the sharpest one.
- **Cancels hand wobble.** Five detail patches on the subject are tracked and a rotation + zoom + shift is fitted and refined twice, so a sweep that tilts a few degrees or drifts closer still gives a subject that holds within about half a pixel (tested: 2.5° tilt and 3% zoom drift → 0.4 px).
- **Evens out exposure** between frames, so the loop doesn't flicker.
- **Shoots from the sharpest stream the phone offers** (up to 4K, 60 fps where supported).
- **Lets you choose 2–10 views** and how much of the sweep to use (the *Depth* slider).
- **Locks the subject.** Tap a person and every view is aligned on them to sub-pixel accuracy, so they stay still while the world turns around them. It works whether you slide straight or orbit around the subject.
- **Crisp frames by default**, like a lens camera. *Smooth* adds blended in-between frames if you prefer a softer turn.
- **Film look** (optional): warm tone, moving grain and vignette.

## Three ways to shoot

| Mode | For | How |
|---|---|---|
| **Sweep** | People who can hold still for a second | Slide one phone sideways a hand-width. Most depth, best quality. |
| **Action** | Sport, dancing, anything moving | **Hold** the shutter while the play happens; the last 3 s are kept at 15 fps. Scrub to the exact frame, and the 3D is built from that single instant: on-device AI finds the players and the scene is given depth around them, so the action is frozen sharp. Offline it falls back to depth estimated from the scene. |
| **Multi-phone** | True 3D of moving action | 2–4 phones side by side all film the play (each one taps record in Multi-phone mode, or uses its own camera app). Import all the videos on one phone: they are lined up automatically **by sound** (crowd noise, whistles, kicks), you scrub to the moment, and the same instant is pulled from every phone. Each phone can be nudged by a frame if needed. Name the files left to right. |

## Event flow

1. **Capture**: frame the guest, tap the shutter, then slide the phone after the countdown. In dark clubs, use 💡 to turn on the light (Android).
2. **Edit**: tap the guest's face, then adjust depth, views, speed and the 4:5, 1:1 or 9:16 crop.
3. **Make clip**: renders an MP4 (iPhone and most Android phones) or a WebM, with your watermark and logo. You can also make a GIF.
4. **Deliver**: the price shows on screen. The guest pays by QR (your Yoco, PayFast, SnapScan or Zapper link), cash or card, and you tap *Paid*. That unlocks sending.
   - **Share…**: the phone's share sheet (WhatsApp, AirDrop, Instagram, email).
   - **WhatsApp**: opens a chat with the guest's number. South African 0-numbers become +27.
   - **Email**
   - **QR download**: the guest scans to download the clip themselves.
   - **Organiser pays** mode skips payment entirely, for when the venue books you.
5. **Event tab**: every clip, paid or owing, with revenue so far. Export a CSV of sales at the end of the night.

## Settings

Everything is on the ⚙️ tab and saved on the phone: event name, watermark, logo, price, payment link, which payment and delivery options to show, frames per sweep, sweep time, countdown, quality and clip length.

## Sending links instead of files (optional)

With an **Upload address** set, WhatsApp, Email and QR download send a link to the clip instead of the file. The app `POST`s `multipart/form-data` with the fields `file`, `id` and `event`, plus `Authorization: Bearer <Upload key>` if a key is set. The address must answer with JSON `{"url": "https://…"}` or with the link as plain text. A Supabase Storage edge function or any small server works.

## Multi-phone rigs and other cameras

**Import** takes 2 or more photos at once, from synced phones on a bar or a multi-lens camera's frames. They are sorted by file name, so name them left to right. The same alignment, crop, branding and selling flow applies. A rig captures everyone at the same instant, which is best for people who are moving.

## Run it

Host the folder on any HTTPS static host (GitHub Pages, Cloudflare Pages, Netlify). Camera access needs HTTPS. Locally:

```bash
npx serve .
```

## Files

- `core.js`: frame selection, alignment, crop and timing. Pure functions; they run in Node for tests.
- `app.js`: camera, capture, editor, export, payments, delivery and the event log (IndexedDB).
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline install.

MIT licence.
