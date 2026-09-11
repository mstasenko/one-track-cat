#pragma once

#include "face_types.hpp"

#include <cstdint>
#include <vector>

namespace otc::face {

void renderEffects(std::vector<std::uint8_t>& rgb,
                   int width,
                   int height,
                   const std::vector<Box>& boxes,
                   int style,
                   float strength);

}  // namespace otc::face
