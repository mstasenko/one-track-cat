#include "interpolation_window.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <vector>

using namespace otc::upscale;

namespace {

constexpr double kEpsilon = 1.0e-9;
constexpr std::uint64_t kNoSource = std::numeric_limits<std::uint64_t>::max();

struct Rendered final {
  std::uint64_t source = kNoSource;
  bool inferred = false;
};

std::size_t nearestSlot(std::uint64_t index, double inputFps, double outputFps) {
  const auto value = std::round(static_cast<long double>(index) *
                                static_cast<long double>(outputFps) /
                                static_cast<long double>(inputFps));
  assert(value >= 0.0L && value <= static_cast<long double>(std::numeric_limits<std::size_t>::max()));
  return static_cast<std::size_t>(value);
}

std::vector<Rendered> renderClock(double inputFps, double outputFps,
                                  const std::vector<SourceFrame>& frames,
                                  std::size_t outputFrames) {
  std::size_t next = 0U;
  InterpolationWindow window{
      inputFps,
      [&]() -> std::optional<SourceFrame> {
        if (next == frames.size()) return std::nullopt;
        return frames[next++];
      },
      {}, {}, false, outputFps};
  assert(window.initialize());

  std::vector<Rendered> result;
  result.reserve(outputFrames);
  for (std::size_t slot = 0U; slot < outputFrames; ++slot) {
    const double time = static_cast<double>(slot) / outputFps;
    window.ensureRight(time);
    assert(window.left);
    if (!window.right) {
      result.push_back({window.left->index, false});
      continue;
    }

    const double leftTime = window.timestamp(window.left->index);
    const double rightTime = window.timestamp(window.right->index);
    const double interval = rightTime - leftTime;
    double alpha = interval > 0.0
                       ? std::clamp((time - leftTime) / interval, 0.0, 1.0)
                       : 0.0;
    if (window.right->cutBefore && time < rightTime - kEpsilon) alpha = 0.0;

    // This mirrors processBaseFrame's two non-AI guards: cuts never blend,
    // and an explicit freeze has identical adjacent RGB frames.
    const bool identical = window.left->frame.pixels == window.right->frame.pixels;
    const bool inferred = alpha > kEpsilon && alpha < 1.0 - kEpsilon &&
                          !window.right->cutBefore && !identical;
    if (inferred) result.push_back({kNoSource, true});
    else result.push_back({alpha < 0.5 - kEpsilon ? window.left->index : window.right->index,
                           false});
  }
  return result;
}

void checkNearestOutputSlots(double inputFps) {
  constexpr double outputFps = 60.0;
  constexpr std::size_t outputFrames = 60U;
  const auto sourceFrames = static_cast<std::size_t>(std::ceil(inputFps));
  std::vector<SourceFrame> frames;
  frames.reserve(sourceFrames);
  for (std::size_t index = 0U; index < sourceFrames; ++index) {
    frames.push_back({index, {1, 1, {static_cast<std::uint8_t>(index)}}, false, false});
  }

  const auto rendered = renderClock(inputFps, outputFps, frames, outputFrames);
  std::vector<std::uint64_t> occupied(outputFrames, kNoSource);
  std::size_t lastMapped = 0U;
  for (std::size_t index = 0U; index < sourceFrames; ++index) {
    const auto slot = nearestSlot(index, inputFps, outputFps);
    assert(slot < outputFrames);
    assert(occupied[slot] == kNoSource);
    occupied[slot] = index;
    lastMapped = slot;
  }

  std::size_t inferred = 0U;
  for (std::size_t slot = 0U; slot < outputFrames; ++slot) {
    const auto& frame = rendered[slot];
    if (occupied[slot] != kNoSource) {
      // Every source frame is retained exactly at its nearest output slot.
      assert(!frame.inferred && frame.source == occupied[slot]);
    } else if (slot <= lastMapped) {
      // Only slots between two retained source frames invoke RIFE.
      assert(frame.inferred && frame.source == kNoSource);
      ++inferred;
    } else {
      // A finite source tail is held; it is not an interpolation request.
      assert(!frame.inferred && frame.source == sourceFrames - 1U);
    }
  }

  std::size_t expectedGaps = 0U;
  for (std::size_t slot = 0U; slot <= lastMapped; ++slot)
    expectedGaps += occupied[slot] == kNoSource ? 1U : 0U;
  assert(inferred == expectedGaps);
}

void checkDuplicateAndCutBoundaries() {
  // At 50 -> 60, source index 1 occupies output slot 1 but is a duplicate
  // render-clock copy, so the window drops it and fills that slot between 0/2.
  const std::vector<SourceFrame> frames{
      {0, {1, 1, {0}}, false, false},
      {1, {1, 1, {0}}, false, true},
      {2, {1, 1, {20}}, false, false},
      {3, {1, 1, {20}}, false, true},
      {4, {1, 1, {40}}, false, false}};
  const auto rendered = renderClock(50.0, 60.0, frames, 6U);
  assert(rendered[0].source == 0U && !rendered[0].inferred);
  assert(rendered[1].inferred); // duplicate slot, now the only missing frame
  assert(rendered[2].source == 2U && !rendered[2].inferred);
  assert(rendered[3].inferred);
  assert(rendered[4].inferred);
  assert(rendered[5].source == 4U && !rendered[5].inferred);

  // A scene cut in the right frame keeps the missing slot on the old scene;
  // the cut frame itself remains an exact retained source frame.
  const std::vector<SourceFrame> cutFrames{
      {0, {1, 1, {0}}, false, false},
      {1, {1, 1, {0}}, false, true},
      {2, {1, 1, {40}}, true, false}};
  const auto cut = renderClock(50.0, 60.0, cutFrames, 3U);
  assert(cut[0].source == 0U && !cut[0].inferred);
  assert(cut[1].source == 0U && !cut[1].inferred);
  assert(cut[2].source == 2U && !cut[2].inferred);

  // Explicit freezes are not marked as duplicate-to-fill. Identical adjacent
  // freeze frames still avoid RIFE through processBaseFrame's equality guard.
  const std::vector<SourceFrame> freezeFrames{
      {0, {1, 1, {40}}, false, false},
      {1, {1, 1, {40}}, false, false}};
  const auto freeze = renderClock(30.0, 60.0, freezeFrames, 3U);
  for (const auto& frame : freeze) assert(frame.source == 0U || frame.source == 1U);
  assert(!freeze[1].inferred);
}

void checkSourceClockFallback() {
  InterpolationWindow window{
      30.0,
      []() -> std::optional<SourceFrame> { return SourceFrame{0, {1, 1, {1}}, false, false}; },
      {}, {}, false};
  assert(window.timestamp(1U) == 1.0 / 30.0);
  window.outputFps = 60.0;
  assert(window.timestamp(1U) == 2.0 / 60.0);
  assert(window.timestamp(2U) == 4.0 / 60.0);
}

}  // namespace

int main() {
  // Fractional and integer clocks exercise nearest-slot gaps from one to
  // thirty-six frames while retaining every input frame.
  for (const auto fps : {50.426654053916, 50.0, 24.0, 30.0, 59.94})
    checkNearestOutputSlots(fps);
  checkDuplicateAndCutBoundaries();
  checkSourceClockFallback();
}
