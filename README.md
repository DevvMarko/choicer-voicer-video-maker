# Choicer Voicer Video Maker

A small desktop app (Electron, Linux and Windows) that turns a **Choicer Voicer**
dub into **one MP4 video** with your voice on it.

When you dub a scene, the game saves:

- the scene's video, e.g. `dub_video.ogv` (with the original audio), and
- every recorded line as its own file:

```
_dubrecord_01_Hamshow_00-000.wav
_dubrecord_02_Hamshow_05-662.wav
_dubrecord_03_Hamshow_06-538.wav
...
```

The last part of each clip's name (`05-662`) is when the line starts in the
scene: **5.662 seconds**. Some scenes write the time right after the name
with a dot instead (`_dubrecord_02_Peter9.389.wav`,
`_dubrecord_08_Dennis Carradine37.596.wav`), and the app reads that too.

Some scenes save no time in the name (`_dubrecord_01_Lois.wav`,
`_dubrecord_001_CHARACTER.wav`). The time is then in the **scene pack**, the
folder with `_pack_info.ini` that the scene came in. For each line the pack
has a `.txt` file, and `01_Lois.txt` contains `dub_timestamps=[3.917]` for the
recording `_dubrecord_01_Lois.wav`. The app reads these times when you add
the scene folder. A time in the file name always wins over the pack.

The app:

1. **removes the original audio** from the video,
2. **mixes all voice clips into one track**, putting each clip at its own time
   (gaps stay silent, and clips that overlap are mixed together),
3. **combines that track with the video** and saves it as an MP4
   (H.264 video + AAC audio),
4. optionally **compresses it to a maximum size** (20 MB by default).

## Using it

1. Start the app.
2. **1 · Scene → Add scene folder…**: pick the scene pack (the folder with
   `_pack_info.ini` and `dub_video.ogv`). The app takes the video and the
   line times. It never takes the pack's own voice lines or backing track.
3. **2 · Voice clips → Add recordings folder…**: pick the folder with your
   `_dubrecord_*.wav` files. If that folder has `_dubrecord_` files, only
   those are added. If it also has the video, the video is used when none is
   set yet.

   You can do steps 2 and 3 in either order. Dragging a folder onto an area
   works like that area's button. Single files can be dropped too: videos go
   to the video slot and audio files go to the clip list.
4. Check the list. If you need to, you can change a clip's start time, or
   remove a clip with ✕.
5. Optional: tick **Compress to max 20 MB** (you can change the number).
6. Click **Make video…** (it's enabled once there's a video and at least one
   clip), choose where to save, and wait.

The output keeps the video's length. If a clip runs past the end of the video,
the app shows a warning, and the audio after the end is cut.

### Compress to max size

When this option is on, the video is encoded at good quality, with a bitrate
ceiling chosen so the file **can't be bigger than the limit**
(MB = 1,000,000 bytes, so it is also under the limit if a site counts
1 MB as 1,048,576 bytes).

- Simple scenes come out smaller than the limit. For example, the
  45-second 1080p60 test scene was 8.5 MB.
- For long videos, the app also lowers the resolution (720p / 540p / 480p / 360p)
  and the frame rate (to 30 fps), so the picture still looks reasonable.
- If the file somehow ends up too big, it's encoded again at a lower bitrate.

Without the option, the video keeps its full quality, resolution and frame rate
(x264 CRF 20).

## Running from source

Requirements: [Node.js](https://nodejs.org/) 20 or newer, with npm.

```bash
npm install
npm start
```

`npm install` downloads the ffmpeg binary for your system (package
`ffmpeg-static`). npm 11+ blocks install scripts by default, and
`package.json` already allows this one through `allowScripts`. If ffmpeg
still wasn't downloaded, run:

```bash
npm rebuild ffmpeg-static
```

When the app can't find the built-in ffmpeg, it uses `ffmpeg` from your
`PATH`. To force a specific binary, set the environment variable `CVVM_FFMPEG`:

```bash
CVVM_FFMPEG=/usr/bin/ffmpeg npm start
```

The first `npm start` also downloads the Electron runtime.

## Building the apps

The output goes to `dist/`.

### Linux

```bash
npm run dist:linux
```

This makes an `.AppImage` (portable: `chmod +x` it and run it).
To also build a `.deb`, add `"homepage"` and an author email to `package.json`,
then add `"deb"` to `build.linux.target`.

### Windows

The easiest way is to build **on Windows**:

```bat
npm install
npm run dist:win
```

This makes an installer (`Choicer Voicer Video Maker Setup 1.2.0.exe`) and a
portable `Choicer Voicer Video Maker 1.2.0.exe` that runs without installing.

**Building for Windows on Linux** also works. First download the Windows ffmpeg
binary next to the Linux one, then build (you may need Wine):

```bash
npm run ffmpeg:win   # downloads node_modules/ffmpeg-static/ffmpeg.exe
npm run dist:win
```

Each package only includes the ffmpeg binary for its own platform.

## How it works

Everything is done by ffmpeg, in two steps:

1. **Mix the voices**: each clip is delayed to its start time (`adelay`), then
   all clips are mixed at full volume (`amix`) into a temporary WAV.
2. **Make the video**: only the video stream of the `.ogv` is used
   (`-map 0:v:0`), so the original audio is dropped. The voice track is
   added (`-map 1:a:0`) and padded with silence to the video's length. Video is
   encoded with `libx264`, and audio with AAC.
   - With **Compress**, x264 still uses CRF quality, but `-maxrate`/`-bufsize`
     cap the bitrate at (size limit − audio) / length. That limits the file size
     without making easy scenes bigger.

The temporary files are deleted afterwards.

## Project structure

```
package.json            app + electron-builder config
src/main.js             Electron main process (window, dialogs, IPC)
src/preload.js          safe bridge between the UI and the main process
src/ffmpeg.js           reads files, parses start times, mixes voices, encodes, compresses
src/renderer/           UI (index.html, renderer.js, styles.css)
```

## Troubleshooting

- **"Could not start ffmpeg"**: the built-in binary is missing. Run
  `npm rebuild ffmpeg-static`, or set `CVVM_FFMPEG` to an ffmpeg you installed.
- **A clip shows as "unreadable"**: ffmpeg can't open it. Hover over the name
  to see why. That clip is skipped.
- **A clip is crossed out**: it starts after the end of the video, so it won't
  be heard.
- **"No start time"**: the file name doesn't end in a time like `_12-738`.
  Type the start time in the list, or the clip starts at 0 s.
- **"The video is too long to fit in … MB"**: raise the size limit or untick
  Compress.

## License

MIT. The bundled ffmpeg is licensed under GPL (see
`node_modules/ffmpeg-static/ffmpeg.LICENSE`).
