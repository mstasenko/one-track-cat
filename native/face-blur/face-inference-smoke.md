# CPU model smoke fixture

`otc-face-blur-smoke` is an explicit CPU-only acceptance entrypoint. It does not download
fixtures or models. Build it with `-DFACE_BLUR_BUILD_SMOKE=ON`, then pass two binary P6 PPM files:

```text
otc-face-blur-smoke --model MODEL.xml --fixture large.ppm \
  --small-fixture small.ppm --device CPU --threshold 0.215
```

The source image is NASA asset S78-35302, an official portrait of astronaut Steven R. Nagel:

```text
https://images-assets.nasa.gov/image/s78-35302/s78-35302~medium.jpg
https://images-assets.nasa.gov/image/s78-35302/metadata.json
SHA-256: b6d858730ec0efe464365c14cc7fb4d85dfaa015fd3c9c8e36d06fe3cf606edd
The corresponding Wikimedia Commons record identifies the NASA photograph as public domain:
https://commons.wikimedia.org/wiki/File:Portrait_-_Astronaut_Steven_R._Nagel.jpg
```

The NASA asset is government-produced imagery made available through the NASA Image and Video
Library; users should follow NASA's current image and media guidelines. Convert it locally with
the application's FFmpeg binary or another trusted converter, and keep the downloaded JPEG out
of the source tree. A 512x512 small fixture can be made by cropping around the face and scaling
the crop to approximately 80px and 24px variants before padding. The large 512x512 fixture's
known face ROI is `[177,65,275,177]`; the small 1024x1024 fixture's 24px variant is placed at
`[500,500,524,528]` so detail mode necessarily runs overlapping 512px tiles. The prepared PPM fixtures are
`large.ppm` SHA-256 `f560c87a385e1cf5d51e7ef22fb975050cff835dccb8a0bfc58765709f6ce78e` and
`small.ppm` SHA-256 `8a533a36e7bb0d85564784b665b2ddc07fe90eaef526b17113013ab0b866f876`.

The exact CPU-only preparation filters were:

```text
ffmpeg -hwaccel none -i s78-35302~medium.jpg -vf crop=360:400:320:240,scale=128:128,pad=512:512:160:54:color=gray -frames:v 1 -f image2 large.ppm
ffmpeg -hwaccel none -i s78-35302~medium.jpg -vf crop=360:400:320:240,scale=32:32,pad=1024:1024:496:496:color=gray -frames:v 1 -f image2 small.ppm
```

The smoke test reports detection counts and boxes for both standard and overlapping-tile detail
mode, changed pixels inside every detected face for pixelate/blur/mask, exact inactivity
passthrough, and a 0.1-second missed-frame hold followed by expiry at 0.7 seconds. It refuses
`AUTO`; no GPU device query is made by this test.
