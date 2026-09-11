#include "face_types.hpp"

#include <algorithm>
#include <stdexcept>

namespace otc::face {

float boxIou(const Box& first, const Box& second) {
  const float left = std::max(first.x1, second.x1);
  const float top = std::max(first.y1, second.y1);
  const float right = std::min(first.x2, second.x2);
  const float bottom = std::min(first.y2, second.y2);
  const float intersection = std::max(0.0F, right - left) * std::max(0.0F, bottom - top);
  const float firstArea = std::max(0.0F, first.x2 - first.x1) * std::max(0.0F, first.y2 - first.y1);
  const float secondArea = std::max(0.0F, second.x2 - second.x1) * std::max(0.0F, second.y2 - second.y1);
  const float unionArea = firstArea + secondArea - intersection;
  return unionArea > 0.0F ? intersection / unionArea : 0.0F;
}

Box clipBox(const Box& box, int width, int height) {
  return {std::clamp(box.x1, 0.0F, static_cast<float>(width)),
          std::clamp(box.y1, 0.0F, static_cast<float>(height)),
          std::clamp(box.x2, 0.0F, static_cast<float>(width)),
          std::clamp(box.y2, 0.0F, static_cast<float>(height))};
}

bool validBox(const Box& box) { return box.x2 > box.x1 + 1.0F && box.y2 > box.y1 + 1.0F; }

std::vector<Detection> nonMaxSuppression(std::vector<Detection> detections,
                                          float iouThreshold,
                                          std::size_t maximum) {
  std::stable_sort(detections.begin(), detections.end(), [](const Detection& first, const Detection& second) {
    return first.score > second.score;
  });
  std::vector<Detection> kept;
  kept.reserve(std::min(maximum, detections.size()));
  for (const Detection& candidate : detections) {
    bool suppressed = false;
    for (const Detection& selected : kept) {
      if (boxIou(candidate.box, selected.box) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) {
      if (kept.size() >= maximum) {
        throw std::runtime_error("face detection limit exceeded; refusing to drop detections");
      }
      kept.push_back(candidate);
    }
  }
  return kept;
}

}  // namespace otc::face
