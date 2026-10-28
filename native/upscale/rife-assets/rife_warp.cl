// FP32 bilinear border sampling for the authenticated RIFE graph. Adjacent
// threads process adjacent X pixels, keeping image-plane accesses coalesced.
__kernel void otc_rife_warp(__global const float* data,
                           __global const float* grid,
                           __global float* output) {
  const uint id = get_global_id(0);
  const uint width = INPUT0_DIMS[3], height = INPUT0_DIMS[2];
  const uint plane = OUTPUT0_DIMS[2] * OUTPUT0_DIMS[3];
  if (id >= OUTPUT0_DIMS[0] * OUTPUT0_DIMS[1] * plane) return;
  const uint batch = id / (plane * OUTPUT0_DIMS[1]);
  const uint pixel = id % plane;
  const uint gridOffset = (batch * plane + pixel) * 2;
  const float x = clamp((grid[gridOffset] + 1.f) * (width - 1) / 2.f, 0.f, (float)(width - 1));
  const float y = clamp((grid[gridOffset + 1] + 1.f) * (height - 1) / 2.f, 0.f, (float)(height - 1));
  const uint x0 = (uint)floor(x), y0 = (uint)floor(y);
  const uint x1 = min(x0 + 1, width - 1), y1 = min(y0 + 1, height - 1);
  const float dx = x - x0, dy = y - y0;
  const uint base = (id / plane) * width * height;
  const float a = data[base + y0 * width + x0], b = data[base + y0 * width + x1];
  const float c = data[base + y1 * width + x0], d = data[base + y1 * width + x1];
  output[id] = (1.f - dy) * ((1.f - dx) * a + dx * b) + dy * ((1.f - dx) * c + dx * d);
}
