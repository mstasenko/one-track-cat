#include "resize_bgr.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <utility>
#include <vector>

namespace {

constexpr int referenceModelSize = 640;

int referenceNearest(int coordinate, int limit) {
  return std::clamp(coordinate, 0, limit - 1);
}

void resizeBgrReference(const std::vector<std::uint8_t>& rgb,
                        int width,
                        int height,
                        float* destination) {
  for (int y = 0; y < referenceModelSize; ++y) {
    const float sourceY = (static_cast<float>(y) + 0.5F) * static_cast<float>(height) /
                              static_cast<float>(referenceModelSize) - 0.5F;
    const int y0 = referenceNearest(static_cast<int>(std::floor(sourceY)), height);
    const int y1 = referenceNearest(y0 + 1, height);
    const float fy = std::clamp(sourceY - std::floor(sourceY), 0.0F, 1.0F);
    for (int x = 0; x < referenceModelSize; ++x) {
      const float sourceX = (static_cast<float>(x) + 0.5F) * static_cast<float>(width) /
                                static_cast<float>(referenceModelSize) - 0.5F;
      const int x0 = referenceNearest(static_cast<int>(std::floor(sourceX)), width);
      const int x1 = referenceNearest(x0 + 1, width);
      const float fx = std::clamp(sourceX - std::floor(sourceX), 0.0F, 1.0F);
      const std::size_t topLeft = (static_cast<std::size_t>(y0) * static_cast<std::size_t>(width) +
                                   static_cast<std::size_t>(x0)) * 3U;
      const std::size_t topRight = (static_cast<std::size_t>(y0) * static_cast<std::size_t>(width) +
                                    static_cast<std::size_t>(x1)) * 3U;
      const std::size_t bottomLeft = (static_cast<std::size_t>(y1) * static_cast<std::size_t>(width) +
                                      static_cast<std::size_t>(x0)) * 3U;
      const std::size_t bottomRight = (static_cast<std::size_t>(y1) * static_cast<std::size_t>(width) +
                                       static_cast<std::size_t>(x1)) * 3U;
      for (int channel = 0; channel < 3; ++channel) {
        const float top = static_cast<float>(rgb[topLeft + static_cast<std::size_t>(channel)]) * (1.0F - fx) +
                          static_cast<float>(rgb[topRight + static_cast<std::size_t>(channel)]) * fx;
        const float bottom = static_cast<float>(rgb[bottomLeft + static_cast<std::size_t>(channel)]) * (1.0F - fx) +
                             static_cast<float>(rgb[bottomRight + static_cast<std::size_t>(channel)]) * fx;
        const float rgbValue = top * (1.0F - fy) + bottom * fy;
        const int bgrChannel = 2 - channel;
        destination[static_cast<std::size_t>(bgrChannel) * referenceModelSize * referenceModelSize +
                    static_cast<std::size_t>(y) * referenceModelSize + static_cast<std::size_t>(x)] = rgbValue;
      }
    }
  }
}

std::vector<std::uint8_t> fixedRandomPixels(int width, int height, std::uint32_t seed) {
  std::vector<std::uint8_t> pixels(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3U);
  for (std::uint8_t& pixel : pixels) {
    seed ^= seed << 13U;
    seed ^= seed >> 17U;
    seed ^= seed << 5U;
    pixel = static_cast<std::uint8_t>(seed >> 24U);
  }
  return pixels;
}

}  // namespace

int main() {
  constexpr std::array<std::pair<int, int>, 10> dimensions{{
      {1, 1}, {2, 3}, {32, 36}, {512, 512}, {640, 640},
      {3840, 2160}, {641, 513}, {1, 641}, {641, 1}, {639, 641}}};
  constexpr std::size_t outputFloats =
      3U * static_cast<std::size_t>(referenceModelSize) *
      static_cast<std::size_t>(referenceModelSize);
  std::vector<float> reference(outputFloats);
  std::vector<float> candidate(outputFloats);

  for (std::size_t index = 0; index < dimensions.size(); ++index) {
    const auto [width, height] = dimensions[index];
    const std::uint32_t baseSeed =
        0x13579BDFU + static_cast<std::uint32_t>(index) * 0x1020304U;
    const std::array<std::uint32_t, 2> seeds{{baseSeed, baseSeed ^ 0xA5A5A5A5U}};
    for (const std::uint32_t seed : seeds) {
      const std::vector<std::uint8_t> pixels = fixedRandomPixels(width, height, seed);
      resizeBgrReference(pixels, width, height, reference.data());
      otc::face::resizeBgr(pixels, width, height, candidate.data());
      for (std::size_t output = 0; output < outputFloats; ++output) {
        std::uint32_t referenceBits = 0U;
        std::uint32_t candidateBits = 0U;
        std::memcpy(&referenceBits, &reference[output], sizeof(referenceBits));
        std::memcpy(&candidateBits, &candidate[output], sizeof(candidateBits));
        if (referenceBits != candidateBits) {
          std::cerr << "resize mismatch width=" << width
                    << " height=" << height << " seed=" << seed
                    << " output=" << output << '\n';
          return 1;
        }
      }
    }
  }
  return 0;
}
