#pragma once

#include "flash_source.hpp"

#include <functional>
#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

namespace otc::upscale {

using SpatialRange = std::pair<std::size_t, std::size_t>;

// Sequence one bounded Flash stream per selected interval. Unselected frames
// bypass the model; local model indices never replace the global output clock.
class SpatialRangeReader final {
 public:
  using Reader = FlashSourceWindow::Reader;
  using Factory = std::function<Reader(SpatialRange, Reader)>;

  SpatialRangeReader(std::vector<SpatialRange> ranges, Reader source, Factory factory)
      : ranges_(std::move(ranges)), source_(std::move(source)), factory_(std::move(factory)) {
    std::size_t previous = 0;
    for (const auto& range : ranges_) {
      if (range.first < previous || range.second <= range.first)
        throw std::invalid_argument("spatial ranges must be ordered, disjoint and nonempty");
      previous = range.second;
    }
  }

  std::optional<SourceFrame> next() {
    if (active_ && next_ == ranges_[range_].second) {
      if (read_ != next_) throw std::runtime_error("spatial reader left unread source frames");
      active_ = {}; // Retire temporal/GPU state before the next interval or bypass.
      ++range_;
      boundary_ = true;
    }
    if (range_ < ranges_.size() && next_ == ranges_[range_].first && !active_) {
      const auto range = ranges_[range_];
      active_ = factory_(range, [this, range]() -> std::optional<SourceFrame> {
        if (read_ == range.second) return std::nullopt;
        auto frame = readSource();
        if (frame) frame->index -= range.first;
        return frame;
      });
      if (!active_) throw std::runtime_error("spatial reader has no processor");
      boundary_ = true;
    }
    auto frame = active_ ? active_() : readSource();
    if (!frame) {
      if (active_ || range_ < ranges_.size())
        throw std::runtime_error("source ended before a spatial range was complete");
      return std::nullopt;
    }
    if (active_) frame->index += ranges_[range_].first;
    if (frame->index != next_++) throw std::runtime_error("spatial output chronology changed");
    frame->cutBefore = frame->cutBefore || boundary_;
    boundary_ = false;
    return frame;
  }

 private:
  std::optional<SourceFrame> readSource() {
    auto frame = source_();
    if (frame && frame->index != read_++) throw std::runtime_error("spatial source chronology changed");
    return frame;
  }

  std::vector<SpatialRange> ranges_;
  Reader source_;
  Factory factory_;
  Reader active_;
  std::size_t range_ = 0;
  std::size_t next_ = 0;
  std::size_t read_ = 0;
  bool boundary_ = false;
};

} // namespace otc::upscale
