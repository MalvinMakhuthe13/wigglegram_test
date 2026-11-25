# Wigglegram Maker

Create fun 3D-style animated photos (wigglegrams) from two images.

A **wigglegram** rapidly alternates between two photos taken from slightly different angles. This creates a simple but surprisingly effective sense of depth and movement — no 3D glasses required.

## Features

- Upload left & right images (or drag & drop)
- Manual alignment controls (horizontal + vertical offset)
- Live preview with adjustable speed
- Download as animated GIF
- Works entirely in the browser — no uploads, no account needed
- Clean, modern dark UI

## How to use

1. Open `index.html` in your browser (or host it)
2. Upload a **Left** image and a **Right** image  
   (photos of the same subject taken a few centimeters apart)
3. Adjust the alignment so the main subject stays still while the background moves
4. Tweak the speed to your liking
5. Click **Download GIF**

### Tips for good wigglegrams

- Keep the camera at the same height
- Move only sideways between the two shots (not forward/backward)
- The closer the subject, the stronger the 3D effect
- Align on the main subject’s eyes or face for portraits

## Running locally

Just open `index.html` in any modern browser.  
No build step or server required.

If you want a local server (recommended for some browsers):

```bash
npx serve .
```

## Tech

- Pure HTML, CSS & JavaScript
- [gif.js](https://github.com/jnordberg/gif.js) for GIF export (loaded via CDN)

## License

MIT
