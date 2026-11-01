#pragma once

#include "video_frame.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <utility>
#include <vector>

namespace otc::upscale {

// A deliberately small pool for exact-size source RGB buffers.  The shared
// owner, rather than the window, decides when a buffer can be recycled: the
// writer may still hold an alias after the window has advanced.
class FrameBufferPool final {
 public:
  static constexpr std::size_t kSlots = 2U;

  explicit FrameBufferPool(std::size_t bytes) : bytes_(bytes) {
    if (bytes_ == 0U) throw std::invalid_argument("frame buffer pool requires nonzero bytes");
    free_.reserve(kSlots);
  }

  std::vector<std::uint8_t> acquire() {
    {
      std::lock_guard lock(mutex_);
      if (!free_.empty()) {
        auto result = std::move(free_.back());
        free_.pop_back();
        return result;
      }
    }
    // The caller writes every byte before publishing a frame.  Recycled
    // vectors retain their size, avoiding a second zero-fill on each read.
    return std::vector<std::uint8_t>(bytes_);
  }

  void release(std::vector<std::uint8_t>&& pixels) noexcept {
    if (pixels.size() != bytes_) return;
    try {
      std::lock_guard lock(mutex_);
      if (free_.size() < kSlots) free_.push_back(std::move(pixels));
    } catch (...) {
      // A release runs from a shared_ptr deleter; failure must discard the
      // buffer rather than escape through destruction.
    }
  }

  std::size_t bytes() const noexcept { return bytes_; }

  std::size_t freeCount() const noexcept {
    std::lock_guard lock(mutex_);
    return free_.size();
  }

 private:
  const std::size_t bytes_;
  mutable std::mutex mutex_;
  std::vector<std::vector<std::uint8_t>> free_;
};

inline std::shared_ptr<SourceFrame> retainSourceFrame(
    SourceFrame&& source, const std::shared_ptr<FrameBufferPool>& pool) {
  if (!pool) return std::make_shared<SourceFrame>(std::move(source));
  auto* owner = new SourceFrame(std::move(source));
  return std::shared_ptr<SourceFrame>(owner, [pool](SourceFrame* frame) noexcept {
    auto pixels = std::move(frame->frame.pixels);
    delete frame;
    pool->release(std::move(pixels));
  });
}

}  // namespace otc::upscale
