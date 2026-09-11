#include "effects.hpp"
#include "tracker.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstdint>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

using otc::face::Box;
using otc::face::Detection;

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
  require(otc::face::boxIou({0, 0, 10, 10}, {5, 5, 15, 15}) > 0.14F, "IoU");
  otc::face::FaceTracker tracker;
  const std::vector<Detection> first{{{10, 10, 30, 30}, 0.9F}};
  require(tracker.update(first, 0.0, 0.5F, 100, 100).size() == 1U, "first track");
  const std::vector<Detection> second{{{20, 10, 40, 30}, 0.9F}};
  require(tracker.update(second, 0.1, 0.5F, 100, 100).size() == 1U, "associated track");
  require(tracker.update({}, 0.2, 0.5F, 100, 100).size() == 1U, "held track");
  require(tracker.update({}, 0.8, 0.5F, 100, 100).empty(), "expired hold");

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
