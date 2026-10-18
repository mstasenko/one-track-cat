#include "effects.hpp"
#include "face_types.hpp"
#include "tracker.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

using otc::face::Box;
using otc::face::Detection;
using otc::face::boxIou;
using otc::face::clipBox;
using otc::face::nonMaxSuppression;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

std::vector<std::uint8_t> changingFrame(int width, int height, int seed) {
  std::vector<std::uint8_t> frame(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3U);
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const std::size_t offset = (static_cast<std::size_t>(y) * static_cast<std::size_t>(width) +
                                  static_cast<std::size_t>(x)) * 3U;
      for (std::size_t channel = 0; channel < 3U; ++channel) {
        frame[offset + channel] = static_cast<std::uint8_t>((17 * x + 29 * y +
                                                             43 * static_cast<int>(channel) + 61 * seed) & 0xff);
      }
    }
  }
  return frame;
}

std::vector<std::uint8_t> renderFresh(const std::vector<std::uint8_t>& input,
                                      int width,
                                      int height,
                                      const std::vector<Box>& boxes,
                                      int style,
                                      float strength) {
  std::vector<std::uint8_t> output = input;
  std::thread worker([&] { otc::face::renderEffects(output, width, height, boxes, style, strength); });
  worker.join();
  return output;
}

Box translated(Box box, float x, float y) {
  box.x1 += x;
  box.x2 += x;
  box.y1 += y;
  box.y2 += y;
  return box;
}

bool legacyLooksLikeCut(const std::vector<std::uint8_t>& previous,
                        const std::vector<std::uint8_t>& current,
                        int width,
                        int height) {
  if (width <= 0 || height <= 0 || previous.size() != current.size() ||
      current.size() != static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3U) {
    return false;
  }
  constexpr int sampleWidth = 24;
  constexpr int sampleHeight = 16;
  std::uint64_t difference = 0U;
  std::uint64_t compared = 0U;
  for (int y = 0; y < sampleHeight; ++y) {
    const int sourceY = (y * height + height / (sampleHeight * 2)) / sampleHeight;
    for (int x = 0; x < sampleWidth; ++x) {
      const int sourceX = (x * width + width / (sampleWidth * 2)) / sampleWidth;
      const std::size_t offset = (static_cast<std::size_t>(sourceY) * static_cast<std::size_t>(width) +
                                  static_cast<std::size_t>(sourceX)) * 3U;
      for (int channel = 0; channel < 3; ++channel) {
        difference += static_cast<std::uint64_t>(
            std::abs(static_cast<int>(current[offset + static_cast<std::size_t>(channel)]) -
                     static_cast<int>(previous[offset + static_cast<std::size_t>(channel)])));
        compared += 1U;
      }
    }
  }
  return compared != 0U && (static_cast<double>(difference) / static_cast<double>(compared)) > 48.0;
}

int main() {
  require(std::abs(otc::face::faceScoreThresholdForSensitivity(0.0F) - 0.99F) < 1.0e-6F,
          "sensitivity zero threshold");
  require(std::abs(otc::face::faceScoreThresholdForSensitivity(0.5F) - 0.325F) < 1.0e-6F,
          "sensitivity midpoint threshold");
  require(std::abs(otc::face::faceScoreThresholdForSensitivity(0.7F) - 0.215F) < 1.0e-6F,
          "sensitivity standard threshold");
  require(std::abs(otc::face::faceScoreThresholdForSensitivity(1.0F) - 0.05F) < 1.0e-6F,
          "sensitivity maximum threshold");
  float previousThreshold = otc::face::faceScoreThresholdForSensitivity(0.0F);
  for (int step = 1; step <= 100; ++step) {
    const float sensitivity = static_cast<float>(step) / 100.0F;
    const float threshold = otc::face::faceScoreThresholdForSensitivity(sensitivity);
    require(std::isfinite(threshold) && threshold >= 0.05F && threshold <= 0.99F,
            "sensitivity threshold range");
    require(threshold <= previousThreshold + 1.0e-6F, "sensitivity threshold monotonicity");
    previousThreshold = threshold;
  }

  // Synthetic crop-edge regression: raw boxes translate to one global face,
  // while clipping each artificial crop first would reduce their IoU below NMS.
  const Box leftCropRaw{220.0F, 100.0F, 560.0F, 360.0F};
  const Box rightCropRaw{-164.0F, 100.0F, 176.0F, 360.0F};
  const Box leftGlobal = translated(leftCropRaw, 0.0F, 0.0F);
  const Box rightGlobal = translated(rightCropRaw, 384.0F, 0.0F);
  require(boxIou(leftGlobal, rightGlobal) > 0.99F, "raw crop boxes merge");
  const std::vector<Detection> mergedCropFace = nonMaxSuppression(
      {{{leftGlobal, 0.95F}, {rightGlobal, 0.90F}}}, 0.4F, 256U);
  require(mergedCropFace.size() == 1U, "raw crop boxes NMS");
  const Box earlyLeft = translated(clipBox(leftCropRaw, 512, 512), 0.0F, 0.0F);
  const Box earlyRight = translated(clipBox(rightCropRaw, 512, 512), 384.0F, 0.0F);
  require(boxIou(earlyLeft, earlyRight) < 0.4F, "early crop clipping fragments face");

  require(nonMaxSuppression(
              {{{100.0F, 100.0F, 220.0F, 260.0F}, 0.9F}, {{240.0F, 100.0F, 360.0F, 260.0F}, 0.8F}},
              0.4F, 256U)
              .size() == 2U,
          "disjoint faces stay separate");
  require(nonMaxSuppression(
              {{{100.0F, 100.0F, 220.0F, 260.0F}, 0.9F}, {{220.0F, 100.0F, 340.0F, 260.0F}, 0.8F}},
              0.4F, 256U)
              .size() == 2U,
          "adjacent faces stay separate");
  const Box bounded = clipBox({-10.0F, -20.0F, 40.0F, 50.0F}, 32, 32);
  require(bounded.x1 == 0.0F && bounded.y1 == 0.0F && bounded.x2 == 32.0F && bounded.y2 == 32.0F,
          "offimage clipping bounds");

  require(otc::face::boxIou({0, 0, 10, 10}, {5, 5, 15, 15}) > 0.14F, "IoU");
  otc::face::FaceTracker tracker;
  const std::vector<Detection> first{{{10, 10, 30, 30}, 0.9F}};
  require(tracker.update(first, 0.0, 0.5F, 100, 100).size() == 1U, "first track");
  const std::vector<Detection> second{{{20, 10, 40, 30}, 0.9F}};
  require(tracker.update(second, 0.1, 0.5F, 100, 100).size() == 1U, "associated track");
  require(tracker.update({}, 0.2, 0.5F, 100, 100).size() == 1U, "held track");
  require(tracker.update({}, 0.8, 0.5F, 100, 100).empty(), "expired hold");

  // Hold is measured from the last detection, not the start of the effect.
  // Exercise a continuous stream so a two-second hold cannot silently clamp to one.
  for (const float hold : {0.0F, 0.3F, 0.5F, 1.0F, 2.0F}) {
    otc::face::FaceTracker held;
    require(held.update({}, 0.0, hold, 100, 100).empty(), "hold cannot invent an initial face");
    require(held.update(first, 0.0, hold, 100, 100).size() == 1U, "hold acquires face");
    const int heldFrames = static_cast<int>(std::lround(hold * 60.0F));
    for (int frame = 1; frame <= heldFrames; ++frame) {
      require(held.update({}, static_cast<double>(frame) / 60.0, hold, 100, 100).size() == 1U,
              "hold covers missing frames through its duration");
    }
    require(held.update({}, static_cast<double>(heldFrames + 1) / 60.0, hold, 100, 100).empty(),
            "hold expires after its duration");
    require(held.update(first, 3.0, hold, 100, 100).size() == 1U, "face reacquired after long gap");
    held.reset();
    require(held.update({}, 3.01, hold, 100, 100).empty(), "reset prevents hold across cuts");
  }

  otc::face::FaceTracker refreshedHold;
  require(refreshedHold.update(first, 0.0, 0.5F, 100, 100).size() == 1U, "refresh acquires face");
  require(refreshedHold.update({}, 0.4, 0.5F, 100, 100).size() == 1U, "refresh holds initial miss");
  require(refreshedHold.update(first, 0.45, 0.5F, 100, 100).size() == 1U, "refresh observes face again");
  require(refreshedHold.update({}, 0.9, 0.5F, 100, 100).size() == 1U, "new detection restarts hold timer");
  require(refreshedHold.update({}, 1.0, 0.5F, 100, 100).empty(), "refreshed hold expires");

  // Outward motion must not shrink a held mask off an image edge before expiry.
  const std::vector<std::pair<Box, Box>> edgeMotions{
      {{65, 40, 85, 60}, {75, 40, 95, 60}},
      {{15, 40, 35, 60}, {5, 40, 25, 60}},
      {{40, 65, 60, 85}, {40, 75, 60, 95}},
      {{40, 15, 60, 35}, {40, 5, 60, 25}}};
  for (const auto& [beforeEdge, atEdge] : edgeMotions) {
    otc::face::FaceTracker edgeHold;
    (void)edgeHold.update({{beforeEdge, 0.99F}}, 0.0, 1.0F, 100, 100);
    require(edgeHold.update({{atEdge, 0.99F}}, 0.1, 1.0F, 100, 100).size() == 1U, "edge face associated");
    const std::vector<Box> held = edgeHold.update({}, 0.8, 1.0F, 100, 100);
    require(held.size() == 1U, "edge hold remains visible before expiry");
    require(std::abs((held[0].x2 - held[0].x1) - 20.0F) < 1.0e-5F &&
                std::abs((held[0].y2 - held[0].y1) - 20.0F) < 1.0e-5F,
            "edge hold preserves mask size");
    require(held[0].x1 >= 0.0F && held[0].y1 >= 0.0F && held[0].x2 <= 100.0F && held[0].y2 <= 100.0F,
            "edge hold stays inside frame");
    require(edgeHold.update({}, 1.2, 1.0F, 100, 100).empty(), "edge hold still expires");
  }

  otc::face::FaceTracker limitedTracker(1U);
  require(limitedTracker.update(first, 0.0, 1.0F, 100, 100).size() == 1U, "limited first track");
  bool trackLimitThrown = false;
  try {
    (void)limitedTracker.update({{{70, 70, 90, 90}, 0.8F}}, 0.1, 1.0F, 100, 100);
  } catch (const std::runtime_error&) {
    trackLimitThrown = true;
  }
  require(trackLimitThrown, "track limit");

  std::vector<std::uint8_t> black(20U * 20U * 3U, 0U);
  std::vector<std::uint8_t> white(20U * 20U * 3U, 255U);
  require(otc::face::looksLikeCut(black, white, 20, 20), "cut detection");
  require(!otc::face::looksLikeCut(black, black, 20, 20), "same scene");

  const std::vector<std::pair<int, int>> sceneCutSizes{{1, 1}, {13, 7}, {37, 19}, {3840, 2160}};
  for (const auto [width, height] : sceneCutSizes) {
    const std::vector<std::uint8_t> previousFrame = changingFrame(width, height, 1);
    const std::vector<std::uint8_t> currentFrame = changingFrame(width, height, 2);
    const std::vector<std::uint8_t> previousSample = otc::face::sceneCutSample(previousFrame, width, height);
    const std::vector<std::uint8_t> currentSample = otc::face::sceneCutSample(currentFrame, width, height);
    require(previousSample.size() == otc::face::sceneCutSampleBytes &&
                currentSample.size() == otc::face::sceneCutSampleBytes,
            "scene sample size");
    const bool legacyCut = legacyLooksLikeCut(previousFrame, currentFrame, width, height);
    const bool fullFrameCut = otc::face::looksLikeCut(previousFrame, currentFrame, width, height);
    const bool sampledCut = otc::face::looksLikeCut(previousSample, currentSample,
                                                    otc::face::sceneCutSampleWidth,
                                                    otc::face::sceneCutSampleHeight);
    require(fullFrameCut == legacyCut, "full-frame cut result changed");
    require(sampledCut == fullFrameCut, "scene sample changed cut result");
  }

  std::vector<std::uint8_t> thresholdPrevious(otc::face::sceneCutSampleBytes, 0U);
  std::vector<std::uint8_t> thresholdCurrent(otc::face::sceneCutSampleBytes, 48U);
  require(!legacyLooksLikeCut(thresholdPrevious, thresholdCurrent,
                              otc::face::sceneCutSampleWidth, otc::face::sceneCutSampleHeight),
          "legacy threshold equality");
  require(!otc::face::looksLikeCut(thresholdPrevious, thresholdCurrent,
                                   otc::face::sceneCutSampleWidth, otc::face::sceneCutSampleHeight),
          "sample threshold equality");
  thresholdCurrent.front() = 49U;
  require(legacyLooksLikeCut(thresholdPrevious, thresholdCurrent,
                             otc::face::sceneCutSampleWidth, otc::face::sceneCutSampleHeight),
          "legacy threshold crossing");
  require(otc::face::looksLikeCut(thresholdPrevious, thresholdCurrent,
                                  otc::face::sceneCutSampleWidth, otc::face::sceneCutSampleHeight),
          "sample threshold crossing");

  std::vector<std::uint8_t> image(20U * 20U * 3U, 255U);
  otc::face::renderEffects(image, 20, 20, std::vector<Box>{{5, 5, 15, 15}}, 2, 1.0F);
  require(image[(10U * 20U + 10U) * 3U] == 0U, "mask core");
  require(image[0] > 0U, "mask outside");

  std::vector<std::uint8_t> checker(20U * 20U * 3U, 0U);
  for (int y = 0; y < 20; ++y) {
    for (int x = 0; x < 20; ++x) {
      const std::uint8_t value = static_cast<std::uint8_t>(((x + y) % 2) * 255);
      checker[(static_cast<std::size_t>(y) * 20U + static_cast<std::size_t>(x)) * 3U] = value;
      checker[(static_cast<std::size_t>(y) * 20U + static_cast<std::size_t>(x)) * 3U + 1U] = value;
      checker[(static_cast<std::size_t>(y) * 20U + static_cast<std::size_t>(x)) * 3U + 2U] = value;
    }
  }
  otc::face::renderEffects(checker, 20, 20, std::vector<Box>{{5, 5, 15, 15}}, 0, 1.0F);
  require(checker[(10U * 20U + 10U) * 3U] > 0U && checker[(10U * 20U + 10U) * 3U] < 255U,
          "pixelation average");

  std::vector<std::uint8_t> largeChecker(512U * 512U * 3U, 0U);
  for (int y = 0; y < 512; ++y) {
    for (int x = 0; x < 512; ++x) {
      const std::uint8_t value = static_cast<std::uint8_t>(((x + y) % 2) * 255);
      const std::size_t offset = (static_cast<std::size_t>(y) * 512U + static_cast<std::size_t>(x)) * 3U;
      largeChecker[offset] = value;
      largeChecker[offset + 1U] = value;
      largeChecker[offset + 2U] = value;
    }
  }
  otc::face::renderEffects(largeChecker, 512, 512, std::vector<Box>{{0, 0, 512, 512}}, 0, 1.0F);
  std::size_t longestRun = 0U;
  std::size_t run = 0U;
  std::uint8_t previous = largeChecker[256U * 512U * 3U];
  for (int x = 0; x < 512; ++x) {
    const std::uint8_t value = largeChecker[(256U * 512U + static_cast<std::size_t>(x)) * 3U];
    run = value == previous ? run + 1U : 1U;
    longestRun = std::max(longestRun, run);
    previous = value;
  }
  require(longestRun >= 80U, "large-face pixelation scale");

  std::vector<std::uint8_t> impulse(20U * 20U * 3U, 0U);
  impulse[(10U * 20U + 10U) * 3U] = 255U;
  impulse[(10U * 20U + 10U) * 3U + 1U] = 255U;
  impulse[(10U * 20U + 10U) * 3U + 2U] = 255U;
  otc::face::renderEffects(impulse, 20, 20, std::vector<Box>{{5, 5, 15, 15}}, 1, 1.0F);
  require(impulse[(10U * 20U + 10U) * 3U] > 0U && impulse[(10U * 20U + 10U) * 3U] < 255U,
          "blur radius");

  std::vector<std::uint8_t> maskAtZero(20U * 20U * 3U, 255U);
  otc::face::renderEffects(maskAtZero, 20, 20, std::vector<Box>{{5, 5, 15, 15}}, 2, 0.0F);
  require(maskAtZero[(10U * 20U + 10U) * 3U] == 0U, "mask core at zero strength");

  std::vector<std::uint8_t> rectangularMask(100U * 100U * 3U, 255U);
  otc::face::renderEffects(rectangularMask, 100, 100, std::vector<Box>{{40, 45, 60, 55}}, 2, 0.0F);
  require(rectangularMask[(41U * 100U + 50U) * 3U] == 255U, "top feather edge");
  require(rectangularMask[(50U * 100U + 33U) * 3U] == 255U, "left feather edge");

  struct RenderCase {
    int width;
    int height;
    int style;
    float strength;
    std::vector<Box> boxes;
  };
  const std::vector<RenderCase> changingFrames{
    {11, 9, 0, 1.0F, {{1, 1, 7, 7}, {4, 2, 10, 8}}},
    {7, 13, 1, 0.35F, {{0, 2, 5, 10}, {2, 6, 7, 13}}},
    {19, 5, 0, 0.7F, {{2, 0, 8, 5}, {6, 1, 18, 4}}},
    {5, 4, 1, 1.0F, {{0, 0, 5, 4}, {1, 1, 4, 3}}},
    {13, 7, 2, 0.0F, {{1, 1, 8, 6}, {5, 2, 12, 7}}}
  };
  for (std::size_t index = 0; index < changingFrames.size(); ++index) {
    const RenderCase& renderCase = changingFrames[index];
    const std::vector<std::uint8_t> input = changingFrame(renderCase.width, renderCase.height,
                                                           static_cast<int>(index));
    std::vector<std::uint8_t> actual = input;
    otc::face::renderEffects(actual, renderCase.width, renderCase.height, renderCase.boxes,
                             renderCase.style, renderCase.strength);
    require(actual == renderFresh(input, renderCase.width, renderCase.height, renderCase.boxes,
                                  renderCase.style, renderCase.strength),
            "reused effect scratch changed output");
  }

  std::vector<Detection> many;
  many.reserve(257U);
  for (int index = 0; index < 257; ++index) {
    const float x = static_cast<float>(index * 3);
    many.push_back({{x, 0.0F, x + 1.5F, 1.5F}, 1.0F});
  }
  bool limitThrown = false;
  try {
    (void)otc::face::nonMaxSuppression(std::move(many), 0.4F, 256U);
  } catch (const std::runtime_error&) {
    limitThrown = true;
  }
  require(limitThrown, "NMS limit");
  return 0;
}
