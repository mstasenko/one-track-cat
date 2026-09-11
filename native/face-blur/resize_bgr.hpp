#pragma once

#include <cstdint>
#include <vector>

namespace otc::face {

inline constexpr int faceModelSize = 640;

void resizeBgr(const std::vector<std::uint8_t>& rgb,
              int width,
              int height,
              float* destination);

}  // namespace otc::face
