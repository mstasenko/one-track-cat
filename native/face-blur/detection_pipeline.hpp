#pragma once

#include "face_types.hpp"
#include "retinaface.hpp"

#include <cstdint>
#include <vector>

namespace otc::face {

std::vector<Detection> detectFrame(RetinaFaceDetector& detector,
                                   const std::vector<std::uint8_t>& frame,
                                   int width,
                                   int height,
                                   const Effect* effect);

}  // namespace otc::face
