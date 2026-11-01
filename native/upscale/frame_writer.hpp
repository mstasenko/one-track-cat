#pragma once

#include "video_frame.hpp"

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace otc::upscale {

class FrameWriter final {
 public:
  using Frame = std::shared_ptr<const RgbFrame>;
  using WriteCallback = std::function<void(const RgbFrame&)>;
  using CancelCallback = std::function<bool()>;

  static constexpr std::size_t kCapacity = 2U;

  explicit FrameWriter(WriteCallback write, CancelCallback cancelled = {})
      : write_(std::move(write)), cancelRequested_(std::move(cancelled)), worker_([this] { run(); }) {}

  ~FrameWriter() noexcept {
    cancel();
    if (worker_.joinable()) worker_.join();
  }

  FrameWriter(const FrameWriter&) = delete;
  FrameWriter& operator=(const FrameWriter&) = delete;

  // Returns false when cancellation wins before the frame is accepted.
  bool enqueue(Frame frame) {
    if (!frame) throw std::invalid_argument("FrameWriter cannot enqueue a null frame");
    std::unique_lock lock(mutex_);
    for (;;) {
      if (queue_.size() >= kCapacity)
        cv_.wait_for(lock, std::chrono::milliseconds(100), [this] {
          return cancelled_ || error_ || closed_ || queue_.size() < kCapacity;
        });
      if (error_) std::rethrow_exception(error_);
      if (cancelled_) return false;
      if (closed_) throw std::logic_error("FrameWriter is already finished");

      // A signal cannot notify this CV, so the bounded wait above lets the
      // producer sample external cancellation even when the queue is full.
      if (externallyCancelled()) {
        cancelled_ = true;
        queue_.clear();
        lock.unlock();
        cv_.notify_all();
        return false;
      }
      if (queue_.size() >= kCapacity) continue;
      queue_.push_back(std::move(frame));
      lock.unlock();
      cv_.notify_one();
      return true;
    }
  }

  void cancel() noexcept {
    {
      std::lock_guard lock(mutex_);
      cancelled_ = true;
      queue_.clear();
    }
    cv_.notify_all();
  }

  void finish() {
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    cv_.notify_all();
    if (worker_.joinable()) worker_.join();

    std::lock_guard lock(mutex_);
    if (error_) std::rethrow_exception(error_);
  }

 private:
  bool externallyCancelled() const { return cancelRequested_ && cancelRequested_(); }

  void fail(std::exception_ptr error) noexcept {
    {
      std::lock_guard lock(mutex_);
      if (!error_) error_ = std::move(error);
      cancelled_ = true;
      queue_.clear();
    }
    cv_.notify_all();
  }

  void run() noexcept {
    for (;;) {
      try {
        if (externallyCancelled()) {
          cancel();
          return;
        }
      } catch (...) {
        fail(std::current_exception());
        return;
      }

      Frame frame;
      {
        std::unique_lock lock(mutex_);
        cv_.wait(lock, [this] {
          return cancelled_ || error_ || closed_ || !queue_.empty();
        });
        if (cancelled_ || error_) return;
        if (queue_.empty() && closed_) return;
        frame = std::move(queue_.front());
        queue_.pop_front();
      }
      cv_.notify_all();

      try {
        write_(*frame);
      } catch (...) {
        fail(std::current_exception());
        return;
      }
    }
  }

  WriteCallback write_;
  CancelCallback cancelRequested_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<Frame> queue_;
  std::exception_ptr error_;
  bool closed_ = false;
  bool cancelled_ = false;
  std::thread worker_;
};

}  // namespace otc::upscale
