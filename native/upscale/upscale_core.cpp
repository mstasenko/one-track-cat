#include "upscale_core.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <stdexcept>

namespace otc::upscale {

bool needsRifeInterpolation(double sourceFps, double outputFps) {
  return outputFps > sourceFps + 1.0e-9;
}

double alignedInterpolationFps(double sourceFps, double outputFps, double durationSeconds) {
  if (!std::isfinite(sourceFps) || !std::isfinite(outputFps) ||
      !std::isfinite(durationSeconds) || sourceFps <= 0 || outputFps <= 0 || durationSeconds <= 0)
    throw std::invalid_argument("interpolation clocks must be finite and positive");
  const double multiple = std::round(outputFps / sourceFps);
  if (multiple < 1 || !std::isfinite(multiple)) return sourceFps;
  const double aligned = outputFps / multiple;
  const double relativeShift = std::abs(sourceFps / aligned - 1.0);
  // Container average rates can differ minutely from their nominal cadence.
  // Do not run UHD RIFE just to reconstruct an effectively original frame.
  // Both guards matter: preserve 29.97/59.94 and bound drift on long clips.
  return relativeShift <= 1.0e-4 && durationSeconds * relativeShift <= 0.001
      ? aligned : sourceFps;
}

std::uint64_t outputFrameCount(double durationSeconds, double outputFps) {
  if (!std::isfinite(durationSeconds) || !std::isfinite(outputFps) ||
      durationSeconds <= 0.0 || outputFps <= 0.0) {
    throw std::invalid_argument("duration and output fps must be finite and positive");
  }
  const long double product = static_cast<long double>(durationSeconds) *
                              static_cast<long double>(outputFps);
  if (!std::isfinite(product) || product > static_cast<long double>(10'000'000ULL)) {
    throw std::invalid_argument("requested output frame count exceeds the bounded limit");
  }
  // Decimal durations such as 0.1 are represented by binary doubles. Allow
  // only corresponding floating-point roundoff at an integer boundary.
  const long double roundoff =
      8.0L * static_cast<long double>(std::numeric_limits<double>::epsilon()) *
      std::max(1.0L, std::abs(product));
  const long double rounded = std::ceil(product - roundoff);
  if (rounded < 1.0L ||
      rounded > static_cast<long double>(std::numeric_limits<std::uint64_t>::max())) {
    throw std::invalid_argument("requested output frame count is out of range");
  }
  return static_cast<std::uint64_t>(rounded);
}

bool exactRgbEqual(int width, int height,
                   const std::vector<std::uint8_t>& first,
                   const std::vector<std::uint8_t>& second) {
  if (width <= 0 || height <= 0) return false;
  const auto maxSize = std::numeric_limits<std::size_t>::max();
  const auto w = static_cast<std::size_t>(width);
  const auto h = static_cast<std::size_t>(height);
  if (h > maxSize / w) return false;
  const auto pixels = w * h;
  if (pixels > maxSize / 3U) return false;
  const auto expected = pixels * 3U;
  return first.size() == expected && second.size() == expected && first == second;
}

}  // namespace otc::upscale
