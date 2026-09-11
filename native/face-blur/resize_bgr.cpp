#include "resize_bgr.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <utility>

namespace otc::face {

namespace {

int nearest(int coordinate, int limit) { return std::clamp(coordinate, 0, limit - 1); }

}  // namespace

// Cache two horizontally interpolated rows, then blend each contiguous output row vertically.
void resizeBgr(const std::vector<std::uint8_t>& rgb,
               int width,
               int height,
               float* destination) {
  std::array<int, faceModelSize> x0;
  std::array<int, faceModelSize> x1;
  std::array<float, faceModelSize> fx;
  for (int x = 0; x < faceModelSize; ++x) {
    const float sourceX = (static_cast<float>(x) + 0.5F) * static_cast<float>(width) /
                              static_cast<float>(faceModelSize) - 0.5F;
    x0[static_cast<std::size_t>(x)] = nearest(static_cast<int>(std::floor(sourceX)), width);
    x1[static_cast<std::size_t>(x)] = nearest(x0[static_cast<std::size_t>(x)] + 1, width);
    fx[static_cast<std::size_t>(x)] = std::clamp(sourceX - std::floor(sourceX), 0.0F, 1.0F);
  }

  constexpr std::size_t rowElements = 3U * static_cast<std::size_t>(faceModelSize);
  std::array<float, rowElements> rowStorageA;
  std::array<float, rowElements> rowStorageB;
  float* topRow = rowStorageA.data();
  float* bottomRow = rowStorageB.data();
  int topSource = -1;
  int bottomSource = -1;
  const auto fillHorizontalRow = [&](int sourceRow, float* row) {
    for (int channel = 0; channel < 3; ++channel) {
      const int bgrChannel = 2 - channel;
      float* channelDestination = row + static_cast<std::size_t>(bgrChannel) * faceModelSize;
      for (int x = 0; x < faceModelSize; ++x) {
        const std::size_t xIndex = static_cast<std::size_t>(x);
        const std::size_t left = (static_cast<std::size_t>(sourceRow) * static_cast<std::size_t>(width) +
                                  static_cast<std::size_t>(x0[xIndex])) * 3U;
        const std::size_t right = (static_cast<std::size_t>(sourceRow) * static_cast<std::size_t>(width) +
                                   static_cast<std::size_t>(x1[xIndex])) * 3U;
        const float top = static_cast<float>(rgb[left + static_cast<std::size_t>(channel)]) * (1.0F - fx[xIndex]) +
                          static_cast<float>(rgb[right + static_cast<std::size_t>(channel)]) * fx[xIndex];
        channelDestination[x] = top;
      }
    }
  };

  for (int y = 0; y < faceModelSize; ++y) {
    const float sourceY = (static_cast<float>(y) + 0.5F) * static_cast<float>(height) /
                              static_cast<float>(faceModelSize) - 0.5F;
    const int y0 = nearest(static_cast<int>(std::floor(sourceY)), height);
    const int y1 = nearest(y0 + 1, height);
    const float fy = std::clamp(sourceY - std::floor(sourceY), 0.0F, 1.0F);

    if (topSource != y0) {
      if (bottomSource == y0) {
        std::swap(topRow, bottomRow);
        std::swap(topSource, bottomSource);
      } else {
        fillHorizontalRow(y0, topRow);
        topSource = y0;
      }
    }
    const float* sourceTop = topRow;
    const float* sourceBottom = sourceTop;
    if (y1 != y0) {
      if (bottomSource != y1) {
        fillHorizontalRow(y1, bottomRow);
        bottomSource = y1;
      }
      sourceBottom = bottomRow;
    }

    for (int channel = 0; channel < 3; ++channel) {
      const int bgrChannel = 2 - channel;
      // OMZ's model.yml passes --mean_values to Model Optimizer.  The converted IR
      // therefore owns the subtraction; this helper supplies only resized BGR pixels.
      const float* const topChannel = sourceTop +
          static_cast<std::size_t>(bgrChannel) * faceModelSize;
      const float* const bottomChannel = sourceBottom +
          static_cast<std::size_t>(bgrChannel) * faceModelSize;
      float* const channelDestination = destination +
          static_cast<std::size_t>(bgrChannel) * faceModelSize * faceModelSize +
          static_cast<std::size_t>(y) * faceModelSize;
      for (int x = 0; x < faceModelSize; ++x) {
        channelDestination[x] = topChannel[x] * (1.0F - fy) + bottomChannel[x] * fy;
      }
    }
  }
}

}  // namespace otc::face
