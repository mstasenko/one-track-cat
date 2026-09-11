#include "effects.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace otc::face {

namespace {

struct Pixel {
  std::uint8_t red;
  std::uint8_t green;
  std::uint8_t blue;
};

Box expand(const Box& box, float ratio, int width, int height) {
  const float boxWidth = std::max(1.0F, box.x2 - box.x1);
  const float boxHeight = std::max(1.0F, box.y2 - box.y1);
  return clipBox({box.x1 - boxWidth * ratio, box.y1 - boxHeight * ratio,
                  box.x2 + boxWidth * ratio, box.y2 + boxHeight * ratio}, width, height);
}

float outsideDistance(const Box& core, const Box& outer, float x, float y) {
  if (x >= core.x1 && x < core.x2 && y >= core.y1 && y < core.y2) return 0.0F;
  const float dx = std::max({core.x1 - x, 0.0F, x - core.x2});
  const float dy = std::max({core.y1 - y, 0.0F, y - core.y2});
  const float horizontalMargin = x < core.x1 ? std::max(core.x1 - outer.x1, 1.0F)
                                              : std::max(outer.x2 - core.x2, 1.0F);
  const float verticalMargin = y < core.y1 ? std::max(core.y1 - outer.y1, 1.0F)
                                            : std::max(outer.y2 - core.y2, 1.0F);
  const float normalizedX = dx / horizontalMargin;
  const float normalizedY = dy / verticalMargin;
  return std::clamp(std::sqrt(normalizedX * normalizedX + normalizedY * normalizedY), 0.0F, 1.0F);
}

float opacity(const Box& core, const Box& outer, int x, int y) {
  if (x >= static_cast<int>(std::floor(core.x1)) && x < static_cast<int>(std::ceil(core.x2)) &&
      y >= static_cast<int>(std::floor(core.y1)) && y < static_cast<int>(std::ceil(core.y2))) {
    return 1.0F;
  }
  const float fade = outsideDistance(core, outer, static_cast<float>(x) + 0.5F,
                                     static_cast<float>(y) + 0.5F);
  const float feather = 1.0F - fade * fade * (3.0F - 2.0F * fade);
  return std::clamp(feather, 0.0F, 1.0F);
}

std::size_t pixelOffset(int x, int y, int width) {
  return (static_cast<std::size_t>(y) * static_cast<std::size_t>(width) +
          static_cast<std::size_t>(x)) * 3U;
}

Pixel readPixel(const std::vector<std::uint8_t>& image, int x, int y, int width) {
  const std::size_t offset = pixelOffset(x, y, width);
  return {image[offset], image[offset + 1U], image[offset + 2U]};
}

void writeBlend(std::vector<std::uint8_t>& image, int x, int y, int width, Pixel replacement,
                float amount) {
  const std::size_t offset = pixelOffset(x, y, width);
  const float inverse = 1.0F - amount;
  image[offset] = static_cast<std::uint8_t>(std::lround(inverse * image[offset] + amount * replacement.red));
  image[offset + 1U] = static_cast<std::uint8_t>(
      std::lround(inverse * image[offset + 1U] + amount * replacement.green));
  image[offset + 2U] = static_cast<std::uint8_t>(
      std::lround(inverse * image[offset + 2U] + amount * replacement.blue));
}

void pixelateRegion(const std::vector<std::uint8_t>& source,
                    std::vector<std::uint8_t>& transformed,
                    const Box& region,
                    int width,
                    int height,
                    int block) {
  const int left = std::clamp(static_cast<int>(std::floor(region.x1)), 0, width - 1);
  const int right = std::clamp(static_cast<int>(std::ceil(region.x2)), left + 1, width);
  const int top = std::clamp(static_cast<int>(std::floor(region.y1)), 0, height - 1);
  const int bottom = std::clamp(static_cast<int>(std::ceil(region.y2)), top + 1, height);
  for (int blockTop = top; blockTop < bottom; blockTop += block) {
    for (int blockLeft = left; blockLeft < right; blockLeft += block) {
      const int blockRight = std::min(blockLeft + block, right);
      const int blockBottom = std::min(blockTop + block, bottom);
      std::uint64_t red = 0U;
      std::uint64_t green = 0U;
      std::uint64_t blue = 0U;
      std::uint64_t count = 0U;
      for (int y = blockTop; y < blockBottom; ++y) {
        for (int x = blockLeft; x < blockRight; ++x) {
          const Pixel pixel = readPixel(source, x, y, width);
          red += pixel.red;
          green += pixel.green;
          blue += pixel.blue;
          count += 1U;
        }
      }
      const Pixel average{static_cast<std::uint8_t>(red / count), static_cast<std::uint8_t>(green / count),
                          static_cast<std::uint8_t>(blue / count)};
      for (int y = blockTop; y < blockBottom; ++y) {
        for (int x = blockLeft; x < blockRight; ++x) {
          const std::size_t offset = pixelOffset(x, y, width);
          transformed[offset] = average.red;
          transformed[offset + 1U] = average.green;
          transformed[offset + 2U] = average.blue;
        }
      }
    }
  }
}

void blurRegion(const std::vector<std::uint8_t>& source,
                std::vector<std::uint8_t>& horizontal,
                std::vector<std::uint8_t>& blurred,
                const Box& region,
                int width,
                int height,
                int radius) {
  const int left = std::clamp(static_cast<int>(std::floor(region.x1)), 0, width - 1);
  const int right = std::clamp(static_cast<int>(std::ceil(region.x2)), left + 1, width);
  const int top = std::clamp(static_cast<int>(std::floor(region.y1)), 0, height - 1);
  const int bottom = std::clamp(static_cast<int>(std::ceil(region.y2)), top + 1, height);
  const int window = radius * 2 + 1;
  for (int y = top; y < bottom; ++y) {
    std::uint64_t red = 0U;
    std::uint64_t green = 0U;
    std::uint64_t blue = 0U;
    for (int dx = -radius; dx <= radius; ++dx) {
      const Pixel pixel = readPixel(source, std::clamp(left + dx, left, right - 1), y, width);
      red += pixel.red;
      green += pixel.green;
      blue += pixel.blue;
    }
    for (int x = left; x < right; ++x) {
      if (x != left) {
        const Pixel leaving = readPixel(source, std::clamp(x - radius - 1, left, right - 1), y, width);
        const Pixel entering = readPixel(source, std::clamp(x + radius, left, right - 1), y, width);
        red = red - leaving.red + entering.red;
        green = green - leaving.green + entering.green;
        blue = blue - leaving.blue + entering.blue;
      }
      const std::size_t offset = pixelOffset(x, y, width);
      horizontal[offset] = static_cast<std::uint8_t>(red / static_cast<std::uint64_t>(window));
      horizontal[offset + 1U] = static_cast<std::uint8_t>(green / static_cast<std::uint64_t>(window));
      horizontal[offset + 2U] = static_cast<std::uint8_t>(blue / static_cast<std::uint64_t>(window));
    }
  }
  for (int x = left; x < right; ++x) {
    std::uint64_t red = 0U;
    std::uint64_t green = 0U;
    std::uint64_t blue = 0U;
    for (int dy = -radius; dy <= radius; ++dy) {
      const Pixel pixel = readPixel(horizontal, x, std::clamp(top + dy, top, bottom - 1), width);
      red += pixel.red;
      green += pixel.green;
      blue += pixel.blue;
    }
    for (int y = top; y < bottom; ++y) {
      if (y != top) {
        const Pixel leaving = readPixel(horizontal, x, std::clamp(y - radius - 1, top, bottom - 1), width);
        const Pixel entering = readPixel(horizontal, x, std::clamp(y + radius, top, bottom - 1), width);
        red = red - leaving.red + entering.red;
        green = green - leaving.green + entering.green;
        blue = blue - leaving.blue + entering.blue;
      }
      const std::size_t offset = pixelOffset(x, y, width);
      blurred[offset] = static_cast<std::uint8_t>(red / static_cast<std::uint64_t>(window));
      blurred[offset + 1U] = static_cast<std::uint8_t>(green / static_cast<std::uint64_t>(window));
      blurred[offset + 2U] = static_cast<std::uint8_t>(blue / static_cast<std::uint64_t>(window));
    }
  }
}

}  // namespace

void renderEffects(std::vector<std::uint8_t>& rgb,
                   int width,
                   int height,
                   const std::vector<Box>& boxes,
                   int style,
                   float strength) {
  if (width <= 0 || height <= 0 || rgb.size() != static_cast<std::size_t>(width) *
                                                     static_cast<std::size_t>(height) * 3U ||
      boxes.empty()) {
    return;
  }
  const float boundedStrength = std::clamp(strength, 0.0F, 1.0F);
  // Reuse scratch across frames. Region filters fill every scratch pixel they
  // read; only source needs a full copy to preserve overlapping-face behavior.
  thread_local std::vector<std::uint8_t> source;
  thread_local std::vector<std::uint8_t> transformed;
  thread_local std::vector<std::uint8_t> horizontal;
  if (style == 0 || style == 1) {
    source = rgb;
    transformed.resize(rgb.size());
  }
  if (style == 1) horizontal.resize(rgb.size());
  for (const Box& rawBox : boxes) {
    const Box detectorBox = clipBox(rawBox, width, height);
    if (!validBox(detectorBox)) continue;
    const Box core = expand(detectorBox, 0.15F, width, height);
    if (!validBox(core)) continue;
    const Box outer = expand(core, 0.12F + 0.16F * boundedStrength, width, height);
    const int left = std::clamp(static_cast<int>(std::floor(outer.x1)), 0, width - 1);
    const int right = std::clamp(static_cast<int>(std::ceil(outer.x2)), left + 1, width);
    const int top = std::clamp(static_cast<int>(std::floor(outer.y1)), 0, height - 1);
    const int bottom = std::clamp(static_cast<int>(std::ceil(outer.y2)), top + 1, height);
    const float faceSize = std::min(core.x2 - core.x1, core.y2 - core.y1);
    const int block = std::max(3, 3 + static_cast<int>(std::lround(faceSize * (0.08F + 0.16F * boundedStrength))));
    const int radius = std::max(2, 2 + static_cast<int>(std::lround(faceSize * (0.06F + 0.10F * boundedStrength))));
    if (style == 0) pixelateRegion(source, transformed, outer, width, height, block);
    else if (style == 1) blurRegion(source, horizontal, transformed, outer, width, height, radius);
    for (int y = top; y < bottom; ++y) {
      for (int x = left; x < right; ++x) {
        Pixel replacement{0U, 0U, 0U};
        if (style == 0 || style == 1) replacement = readPixel(transformed, x, y, width);
        writeBlend(rgb, x, y, width, replacement, opacity(core, outer, x, y));
      }
    }
  }
}

}  // namespace otc::face
