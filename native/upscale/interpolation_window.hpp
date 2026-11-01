#pragma once

#include "video_frame.hpp"
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <memory>
#include <utility>

namespace otc::upscale {

// Keep real source indices when skipping known repeated render-clock frames.
// Only lower-rate clip ranges mark duplicates; explicit freezes remain intact.
// Reading ahead keeps two frames, not a decoded-video cache.
struct InterpolationWindow final {
  using Reader = std::function<std::optional<SourceFrame>(const SourceFrame*)>;
  double fps;
  Reader reader;
  std::shared_ptr<SourceFrame> left;
  std::shared_ptr<SourceFrame> right;
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

  // Repeated render-clock slots spanning missing footage stay a hold.
  // Allow 1 ns for subtraction rounding at the half-second boundary.
  bool holdsGap() const {
    if (!left || !right || right->index <= left->index) return false;
    return timestamp(right->index) - timestamp(left->index) >= 0.5 - 1.0e-9;
  }

  bool readOne() {
    if (eof) return false;
    // Keep the retained predecessor alive while the reader skips duplicates;
    // exact-geometry input may borrow its RGB bytes without copying them.
    const SourceFrame* previous = right ? &*right : (left ? &*left : nullptr);
    auto next = reader(previous);
    while (next && left && next->duplicateBefore && !next->cutBefore)
      next = reader(previous);
    if (!next) { eof = true; return false; }
    if (!left) left = std::make_shared<SourceFrame>(std::move(*next));
    else right = std::make_shared<SourceFrame>(std::move(*next));
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
