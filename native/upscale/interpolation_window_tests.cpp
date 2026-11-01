#include "interpolation_window.hpp"
#include "frame_buffer_pool.hpp"

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

struct ReaderObservation final {
  std::uint64_t previous = kNoSource;
  std::uint64_t current = kNoSource;
  bool duplicate = false;
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
      [&](const SourceFrame*) -> std::optional<SourceFrame> {
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
    const bool holdsGap = window.holdsGap();
    if ((window.right->cutBefore || holdsGap) && time < rightTime - kEpsilon)
      alpha = 0.0;

    // This mirrors processBaseFrame's two non-AI guards: cuts never blend,
    // and an explicit freeze has identical adjacent RGB frames.
    const bool identical = window.left->frame.pixels == window.right->frame.pixels;
    const bool inferred = alpha > kEpsilon && alpha < 1.0 - kEpsilon &&
                          !window.right->cutBefore && !holdsGap && !identical;
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

void checkLongDuplicateHoldGuard() {
  std::vector<SourceFrame> held{
      {0, {1, 1, {0}}, false, false}};
  for (std::uint64_t index = 1U; index < 158U; ++index)
    held.push_back({index, {1, 1, {0}}, false, true});
  held.push_back({158, {1, 1, {255}}, false, false});
  const auto preserved = renderClock(60.0, 60.0, held, 159U);
  for (std::size_t slot = 0U; slot < 158U; ++slot)
    assert(preserved[slot].source == 0U && !preserved[slot].inferred);
  assert(preserved[158].source == 158U && !preserved[158].inferred);

  // A long duplicate gap and a scene cut must both preserve the old frame
  // until the cut endpoint's exact output slot.
  held.back().cutBefore = true;
  const auto heldCut = renderClock(60.0, 60.0, held, 159U);
  for (std::size_t slot = 0U; slot < 158U; ++slot)
    assert(heldCut[slot].source == 0U && !heldCut[slot].inferred);
  assert(heldCut[158].source == 158U && !heldCut[158].inferred);

  // A single skipped frame is still a normal interpolation request.
  const std::vector<SourceFrame> oneHole{
      {0, {1, 1, {0}}, false, false},
      {1, {1, 1, {0}}, false, true},
      {2, {1, 1, {255}}, false, false}};
  const auto interpolated = renderClock(60.0, 60.0, oneHole, 3U);
  assert(interpolated[0].source == 0U && !interpolated[0].inferred);
  assert(interpolated[1].source == kNoSource && interpolated[1].inferred);
  assert(interpolated[2].source == 2U && !interpolated[2].inferred);

  // Sparse source footage follows the same limit without skipped indices.
  const std::vector<SourceFrame> sparseFrames{
      {0, {1, 1, {0}}, false, false},
      {1, {1, 1, {255}}, false, false}};
  const auto sparse = renderClock(1.0, 60.0, sparseFrames, 61U);
  for (std::size_t slot = 0U; slot < 60U; ++slot)
    assert(sparse[slot].source == 0U && !sparse[slot].inferred);
  assert(sparse[60].source == 1U && !sparse[60].inferred);

  // Only intervals strictly below half a second may synthesize frames.
  for (const std::uint64_t endpoint : {29U, 30U, 31U}) {
    std::vector<SourceFrame> boundary{{0, {1, 1, {0}}, false, false}};
    for (std::uint64_t index = 1U; index < endpoint; ++index)
      boundary.push_back({index, {1, 1, {0}}, false, true});
    boundary.push_back({endpoint, {1, 1, {255}}, false, false});
    const auto rendered = renderClock(60.0, 60.0, boundary, endpoint + 1U);
    for (std::size_t slot = 1U; slot < endpoint; ++slot) {
      if (endpoint < 30U)
        assert(rendered[slot].source == kNoSource && rendered[slot].inferred);
      else
        assert(rendered[slot].source == 0U && !rendered[slot].inferred);
    }
    assert(rendered[endpoint].source == endpoint && !rendered[endpoint].inferred);
  }
}

void checkSourceClockFallback() {
  InterpolationWindow window{
      30.0,
      [](const SourceFrame*) -> std::optional<SourceFrame> {
        return SourceFrame{0, {1, 1, {1}}, false, false};
      },
      {}, {}, false};
  assert(window.timestamp(1U) == 1.0 / 30.0);
  window.outputFps = 60.0;
  assert(window.timestamp(1U) == 2.0 / 60.0);
  assert(window.timestamp(2U) == 4.0 / 60.0);
}

void checkBorrowedPreviousAcrossDuplicateSkips() {
  // The reader derives duplicateBefore from the borrowed retained frame. The
  // range ends at frame 4, and a cut at frame 2 must not inherit the old
  // scene's duplicate decision.
  const std::vector<SourceFrame> source{
      {0, {1, 1, {10}}, false, false},
      {1, {1, 1, {10}}, false, false},
      {2, {1, 1, {20}}, true, false},
      {3, {1, 1, {20}}, false, false},
      {4, {1, 1, {20}}, false, false},
      {5, {1, 1, {30}}, false, false}};
  std::size_t next = 0U;
  std::vector<ReaderObservation> observations;
  InterpolationWindow window{
      50.0,
      [&](const SourceFrame* previous) -> std::optional<SourceFrame> {
        if (next == source.size()) return std::nullopt;
        auto frame = source[next++];
        const bool inInterpolationRange = frame.index >= 1U && frame.index < 4U;
        frame.duplicateBefore = inInterpolationRange && previous != nullptr &&
            !frame.cutBefore && frame.frame.pixels == previous->frame.pixels;
        observations.push_back({previous ? previous->index : kNoSource,
                                frame.index, frame.duplicateBefore});
        return frame;
      },
      {}, {}, false, 60.0};

  assert(window.initialize());
  assert(window.left && window.left->index == 0U);
  window.ensureRight(0.0);
  assert(window.left && window.left->index == 0U);
  assert(window.right && window.right->index == 2U);

  // Exercise the right-predecessor path explicitly. Frame 3 matches frame 2
  // but not frame 0, so using left here would fail the duplicate decision.
  assert(window.readOne());
  assert(window.left && window.left->index == 0U);
  assert(window.right && window.right->index == 4U);

  // Advance across the post-cut duplicate and the interpolation-range end.
  window.ensureRight(6.0 / 60.0);
  assert(window.left && window.left->index == 4U);
  assert(window.right && window.right->index == 5U);
  assert(observations.size() == 6U);
  assert(observations[0].previous == kNoSource && observations[0].current == 0U &&
         !observations[0].duplicate);
  assert(observations[1].previous == 0U && observations[1].current == 1U &&
         observations[1].duplicate);
  // The retained predecessor stays borrowed while duplicate candidates are
  // skipped; the skipped candidate itself must not become a dangling input.
  assert(observations[2].previous == 0U && observations[2].current == 2U &&
         !observations[2].duplicate);
  assert(observations[3].previous == 2U && observations[3].current == 3U &&
         observations[3].duplicate);
  assert(observations[4].previous == 2U && observations[4].current == 4U &&
         !observations[4].duplicate);
  assert(observations[5].previous == 4U && observations[5].current == 5U &&
         !observations[5].duplicate);
}

void checkRetainerRecyclesSkippedCandidates() {
  auto pool = std::make_shared<FrameBufferPool>(1U);
  const std::vector<SourceFrame> source{
      {0, {1, 1, {10}}, false, false},
      {1, {1, 1, {10}}, false, true},
      // A cut is retained even when duplicateBefore is set.
      {2, {1, 1, {20}}, true, true},
      {3, {1, 1, {30}}, false, false}};
  std::size_t next = 0U;
  InterpolationWindow window{
      60.0,
      [&](const SourceFrame*) -> std::optional<SourceFrame> {
        if (next == source.size()) return std::nullopt;
        return source[next++];
      },
      {}, {}, false, 60.0,
      [pool](SourceFrame&& frame) { return retainSourceFrame(std::move(frame), pool); }};

  assert(window.initialize());
  window.ensureRight(0.0);
  assert(window.left && window.left->index == 0U);
  assert(window.right && window.right->index == 2U && window.right->cutBefore);
  // Candidate 1 was wrapped before the duplicate check and its owner has
  // already returned its byte buffer to the pool.
  assert(pool->freeCount() == 1U);
  auto recycled = pool->acquire();
  recycled[0] = 77U;
  assert(window.left->frame.pixels[0] == 10U);
  assert(window.right->frame.pixels[0] == 20U);
  pool->release(std::move(recycled));

  assert(window.readOne());
  assert(window.right && window.right->index == 3U);
}

}  // namespace

int main() {
  // Fractional and integer clocks exercise nearest-slot gaps from one to
  // thirty-six frames while retaining every input frame.
  for (const auto fps : {50.426654053916, 50.0, 24.0, 30.0, 59.94})
    checkNearestOutputSlots(fps);
  checkDuplicateAndCutBoundaries();
  checkLongDuplicateHoldGuard();
  checkSourceClockFallback();
  checkBorrowedPreviousAcrossDuplicateSkips();
  checkRetainerRecyclesSkippedCandidates();
}
