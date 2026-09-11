#pragma once

#include "face_types.hpp"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace otc::face {

inline constexpr int sceneCutSampleWidth = 24;
inline constexpr int sceneCutSampleHeight = 16;
inline constexpr std::size_t sceneCutSampleBytes =
    static_cast<std::size_t>(sceneCutSampleWidth) * static_cast<std::size_t>(sceneCutSampleHeight) * 3U;

class FaceTracker {
 public:
  explicit FaceTracker(std::size_t maximumTracks = 256U);

  void reset();
  std::vector<Box> update(const std::vector<Detection>& detections,
                          double timestampSeconds,
                          float holdSeconds,
                          int width,
                          int height);

 private:
  struct Track {
    Box box;
    float velocityX = 0.0F;
    float velocityY = 0.0F;
    double lastTimestamp = 0.0;
    double missedSeconds = 0.0;
  };

  std::vector<Track> tracks_;
  std::size_t maximumTracks_;
};

bool looksLikeCut(const std::vector<std::uint8_t>& previous,
                 const std::vector<std::uint8_t>& current,
                 int width,
                 int height);

std::vector<std::uint8_t> sceneCutSample(const std::vector<std::uint8_t>& rgb,
                                         int width,
                                         int height);

}  // namespace otc::face
