#pragma once

#include <cstdint>
#include <vector>

namespace otc::upscale {

std::uint64_t outputFrameCount(double durationSeconds, double outputFps);

// Align nearly identical clocks only when the entire clip shifts by <=1 ms.
// Input ownership/frame counts still follow the original source rate.
double alignedInterpolationFps(double sourceFps, double outputFps, double durationSeconds);

// A higher output clock needs intermediate frames; UI eligibility is separate.
bool needsRifeInterpolation(double sourceFps, double outputFps);

bool exactRgbEqual(int width, int height,
                   const std::vector<std::uint8_t>& first,
                   const std::vector<std::uint8_t>& second);

}  // namespace otc::upscale
