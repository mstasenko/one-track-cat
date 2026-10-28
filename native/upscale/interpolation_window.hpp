#pragma once

#include "video_frame.hpp"
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <utility>

namespace otc::upscale {

// Keep real source indices when skipping known repeated render-clock frames.
// Only lower-rate clip ranges mark duplicates; explicit freezes remain intact.
// Reading ahead keeps two frames, not a decoded-video cache.
struct InterpolationWindow final {
  using Reader = std::function<std::optional<SourceFrame>()>;
  double fps;
  Reader reader;
  std::optional<SourceFrame> left;
  std::optional<SourceFrame> right;
  bool eof = false;
  // Zero keeps the source-clock behavior used by existing callers.  When the
  // output clock is faster, source frames occupy their nearest output slots;
  // the gaps between those slots are the only frames eligible for RIFE.
  double outputFps = 0.0;

  double timestamp(std::uint64_t index) const {
    if (outputFps <= fps) return static_cast<double>(index) / fps;
    const auto source = static_cast<long double>(index);
    const auto output = static_cast<long double>(outputFps);
    const auto input = static_cast<long double>(fps);
    const auto slot = std::round(source * output / input);
    return static_cast<double>(slot / output);
  }

  bool readOne() {
    if (eof) return false;
    auto next = reader();
    while (next && left && next->duplicateBefore && !next->cutBefore) next = reader();
    if (!next) { eof = true; return false; }
    if (!left) left = std::move(next);
    else right = std::move(next);
    return true;
  }

  bool initialize() { return readOne(); }

  void ensureRight(double timestamp) {
    while (!right || this->timestamp(right->index) < timestamp - 1.0e-9) {
      if (right) { left = std::move(right); right.reset(); }
      if (!readOne()) break;
    }
  }
};

}  // namespace otc::upscale
