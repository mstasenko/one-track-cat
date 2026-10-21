<h1 align="center">OneTrackCat</h1>

<p align="center">
  <img src="assets/icon.svg" alt="OneTrackCat icon: a black cat curled around a video play symbol." width="200">
</p>

<p align="center"><strong>OneTrackCat — the one trick you need to turn gameplay into highlights.</strong></p>

OneTrackCat is a local gameplay video editor for Linux. Remove quiet stretches, repeat the
best moment, slow down or zoom the action, add text and reaction media, and export a finished
video without an account or an upload.

## What you can do

- Cut out unwanted moments with a few marks.
- Replay a highlight, change its speed, zoom it, or freeze a frame.
  Replay repeats the footage at half speed and carries over face blur. Other effects aren't copied, but text and effects spanning the replay stay active.
- Add text, pictures, GIFs, reaction videos, sounds, and simple transitions.
- Make a regular landscape video or a 9:16 Short.
- For Shorts, use the arrows above the timeline to set the frame position at the playhead. The frame moves smoothly between these points; click a diamond to return to one.
- Blur, pixelate, or mask faces with the optional local face pack.
- Export an AI-enhanced 4K, 60 fps video with the optional AI pack.
- Undo and redo your editing.

## Requirements

- Ubuntu 26.04
- GNOME running on Wayland
- A 64-bit computer

OneTrackCat is currently developed and tested for this setup. Other Linux desktops, X11,
Windows, and macOS are not supported at this time.

### Hardware for optional AI features

| Feature | Graphics requirements | Recommended computer memory (RAM) |
| --- | --- | --- |
| Face blur (face pack) | Intel graphics recommended; also works on the CPU, more slowly. | 8 GB; 16 GB for 4K video. |
| 4K enhancement (AI pack) | Intel Arc graphics card with **at least 12 GB of graphics memory**. Tested with B580 (12 GB) and A770 (16 GB). Cannot run on the CPU. | 32 GB. |
| Smoother motion at 60 fps (AI pack) | Intel graphics recommended; also works on the CPU, more slowly. Fast processing at 4K can need about 10 GB of graphics memory. | 16 GB; 32 GB for 4K video. |

Graphics memory is separate from your computer's RAM on a dedicated graphics card.
Built-in Intel graphics shares RAM instead. AMD and NVIDIA graphics are not supported for
these AI features; face blur and smoother motion can use the CPU instead, but 4K enhancement cannot.
Ordinary editing does not require an AI-capable graphics card.

These memory figures are recommendations, not guaranteed minimums. Close other memory-heavy
programs before AI exports, and leave free disk space for temporary files. OneTrackCat checks
disk space before starting. The AI pack also downloads its models on first use.

## Install and open OneTrackCat

1. Download the OneTrackCat AppImage from [Releases](https://github.com/mstasenko/one-track-cat/releases).
2. In Files, right-click the AppImage and choose **Properties**.
3. Open **Permissions** and enable **Allow executing file as program**.
4. Close the Properties window and double-click the AppImage.

Run OneTrackCat as your normal user. You do not need `sudo` or an administrator account.

## Optional media packs

The media pack adds ready-to-use reaction images, clips, and sounds. The face pack adds the
**Blur faces** effect. The AI pack adds optional video enhancement. Download the packs you want
from Releases and extract them beside the AppImage.

```text
one-track-cat/
├── OneTrackCat-...AppImage
├── meme/
├── face-pack/
└── ai-pack/
```

You can use OneTrackCat without any packs and add your own media with **New**. The packs are
optional downloads; their included files and licenses are listed in their manifests.

## A simple editing workflow

1. Drop a gameplay video into OneTrackCat or choose **Open**.
2. Move the playhead and add marks around a moment.
3. Click inside a section, then choose **Remove Marked**, **Speed**, **Zoom**, **Freeze**, or **Replay**.
4. Add text, a picture, a reaction clip, or a sound from the side panel.
5. Choose **Export**, click **Start**, and select where to save the finished video.

In the video chooser, hover over a clip for a short, silent preview. **Browse…** opens
the usual file dialog. **Clear Marks** removes only the highlighted section's boundary
marks, without deleting any video.

Search **Images** for local pictures, blank templates from
[MemeFact on Hugging Face](https://huggingface.co/datasets/sergiogpinto/memefact-templates)
and [Imgflip](https://imgflip.com/api), and ready-made captioned memes from
[IMKG](https://memes.science/). You can search their captions, too. **Videos** searches local
clips and animated Imgflip memes. Online matches appear in the same list with a small
globe. Hover to preview, click the name to download and add it, or click the globe to visit
its source. Selected templates stay on your computer for later editing. If a service is
unavailable, choose **Retry online search**. Your videos and project are never uploaded.
Memes and templates have their own usage rights; check the source before publishing, especially for
commercial use. No account or paid API is needed.

Effects apply to the section containing the playhead when marks are present. With no marks,
they apply to the entire video.

Choose **Effects → Transition** to fade or blur a section. Pick an effect and **In** or **Out**;
the effect uses the selected section's full duration.
After inserting a video, the playhead moves to its end so you can insert the next clip there.
Inserted-video transitions overlap the two clips while both play, shortening the combined
video by the overlap duration. Long transitions automatically fit the clips.

### Face blur

Choose **Effects → Blur faces**, choose a style, and click **Apply face blur**. OneTrackCat renders
a preview of the selected section, or the whole video when there are no marks. The rendered
result appears in the main preview while the playhead is inside that range; move outside it to
see the original video again. OneTrackCat keeps the current position and stays paused after the
render finishes, so no separate preview window opens or starts playing by itself.
The latest rendered preview is restored when you reopen an unchanged project, as long as
its cached video is still available. If it is unavailable, use **Apply face blur** again.
To edit an existing face-blur range, click its **Face blur** band in the timeline; this selects
its settings without moving the playhead.
Face-blur ranges appear on the timeline. Export reuses the preview's face analysis when the
footage and detection settings have not changed during the same app session. Export still
needs to apply the effect and encode the finished video.

- **Sensitivity** balances missed faces against extra detections. The default 1% is strict;
  increase it if real faces are missed.
- **Small faces** looks for smaller faces and may take longer.
- **Hold missed faces** extends an existing mask through short detection gaps (0.3 seconds
  by default, up to 2 seconds). It cannot cover a face before its first detection or a longer gap.
- **Strength** and **Style** control how strongly the face is hidden.

Automatic detection can miss faces; check the preview before sharing.

If hardware processing is unavailable or a permission prompt is declined, OneTrackCat falls back
to CPU processing. Your project and media stay on your computer.

### AI-enhanced export

In **Export**, choose an AI enhancement mode before clicking **Start**. It is off by default
and requires the optional AI pack. Choose **Turbo** for faster processing or **Base** for
more detail. Enhancement applies to the finished video, including its text and effects.
4K enhancement supports landscape 3840×2160 videos and vertical 2160×3840 Shorts, and
requires a supported Intel discrete GPU. Extra frames can be added separately to reach 60 fps;
sources at 50 fps or below use AI frame interpolation. Sources above 50 fps use occasional
repeated frames instead, keeping conversion to 60 fps much faster.
A video already at 4K and 60 fps needs neither unless it has close-ups. For a 4K video
with **Zoom** effects, 4K enhancement processes only those close-ups, not the unchanged sections.
This also applies to Shorts made from 4K footage: only the visible Short area is processed,
and AI enhancement runs only during close-ups. Lower-resolution footage is enhanced throughout.
In **Zoom**, use **Transition (seconds)** to set how long zoom-in and zoom-out take;
short close-ups automatically use shorter transitions.

On first use, OneTrackCat offers to download the enhancement model and shows its progress.
Allow about 12 GB of free space to set up a mode. Exports also need temporary disk space;
OneTrackCat checks this before starting. After setup, enhancement works offline; your videos
are never uploaded.

AI enhancement takes extra time. It can improve
detail and motion, but cannot recover every detail missing from the original. Your video stays
on your computer, and no enhanced preview files are kept in your project.

## Saving your project

OneTrackCat autosaves the open project while you work, before export, and when it closes normally.
Use **Project → Reset project** to forget the saved project and start over. Exported videos are
ordinary files in the folder you choose.
Opening a new video or resetting the project clears the previous project's face-blur previews
and analysis. Reopening the saved project keeps them so you can continue where you left off.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play or pause |
| Left / Right | Move five seconds |
| Shift+Left / Shift+Right | Previous / next frame |
| Mouse wheel over the timeline | Zoom the timeline |
| Delete | Remove the selected item or marked section |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |

Shortcuts are disabled while face blur is being applied or a video is being exported.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for developer setup, builds, tests, optional pack creation,
and implementation notes.

## License

OneTrackCat source code is licensed under [GPL-3.0-only](LICENSE). Optional media, face-pack
components, and bundled fonts retain the licenses listed in their manifests and license files.
