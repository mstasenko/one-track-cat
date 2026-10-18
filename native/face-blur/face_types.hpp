#pragma once

#include <cstdint>
#include <vector>

namespace otc::face {

inline constexpr float maximumHoldSeconds = 2.0F;

struct Box {
  float x1 = 0.0F;
  float y1 = 0.0F;
  float x2 = 0.0F;
  float y2 = 0.0F;
};

struct Detection {
  Box box;
  float score = 0.0F;
};

struct Effect {
  double startSeconds = 0.0;
  double endSeconds = 0.0;
  float sensitivity = 0.0F;
  bool detail = false;
  float holdSeconds = 0.0F;
  float strength = 0.0F;
  int style = 0;
};

float boxIou(const Box& first, const Box& second);
Box clipBox(const Box& box, int width, int height);
bool validBox(const Box& box);

// Keep the established score mapping for sensitivity >= 0.5 while making the
// low-sensitivity half stricter, reaching a .99 threshold at sensitivity 0.
float faceScoreThresholdForSensitivity(float sensitivity);

std::vector<Detection> nonMaxSuppression(std::vector<Detection> detections,
                                          float iouThreshold,
                                          std::size_t maximum);

}  // namespace otc::face
