#include "detection_pipeline.hpp"

#include <algorithm>
#include <cstddef>
#include <stdexcept>
#include <utility>

namespace otc::face {

std::vector<Detection> detectFrame(RetinaFaceDetector& detector,
                                   const std::vector<std::uint8_t>& frame,
                                   int width,
                                   int height,
                                   const Effect* effect) {
  const float threshold = effect == nullptr ? 0.55F : 0.05F + (1.0F - effect->sensitivity) * 0.55F;
  if (effect == nullptr || !effect->detail) return detector.detect(frame, width, height, threshold);

  constexpr int maximumTileSide = 640;
  constexpr int targetTileSide = 512;
  const int tileWidth = std::min(maximumTileSide, std::max(1, std::min(width, targetTileSide)));
  const int tileHeight = std::min(maximumTileSide, std::max(1, std::min(height, targetTileSide)));
  const int overlapX = std::max(1, tileWidth / 4);
  const int overlapY = std::max(1, tileHeight / 4);
  const int stepX = std::max(1, tileWidth - overlapX);
  const int stepY = std::max(1, tileHeight - overlapY);
  std::vector<int> startsX;
  std::vector<int> startsY;
  for (int position = 0;; position += stepX) {
    startsX.push_back(std::min(position, width - tileWidth));
    if (position + tileWidth >= width) break;
  }
  for (int position = 0;; position += stepY) {
    startsY.push_back(std::min(position, height - tileHeight));
    if (position + tileHeight >= height) break;
  }
  constexpr std::size_t maximumTiles = 64U;
  if (startsX.size() * startsY.size() > maximumTiles) {
    throw std::runtime_error("small-face tile limit exceeded for this frame");
  }
  std::vector<Region> regions;
  regions.reserve(1U + startsX.size() * startsY.size());
  regions.push_back({0, 0, width, height});
  for (int y0 : startsY) {
    for (int x0 : startsX) {
      regions.push_back({x0, y0, tileWidth, tileHeight});
    }
  }
  std::vector<Detection> detections = detector.detectRegions(frame, width, height, regions, threshold);
  return nonMaxSuppression(std::move(detections), 0.4F, 256U);
}

}  // namespace otc::face
