#include "frame_writer.hpp"

#include <cassert>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using otc::upscale::FrameWriter;
using otc::upscale::RgbFrame;
using otc::upscale::SourceFrame;

namespace {

std::shared_ptr<const RgbFrame> frame(std::uint8_t id) {
  return std::make_shared<const RgbFrame>(RgbFrame{1, 1, {id}});
}

void checkBoundedAndOrdered() {
  std::mutex mutex;
  std::condition_variable cv;
  bool firstStarted = false;
  bool releaseFirst = false;
  bool fourthEntered = false;
  bool fourthDone = false;
  std::vector<std::uint8_t> written;

  FrameWriter writer([&](const RgbFrame& value) {
    std::unique_lock lock(mutex);
    if (value.pixels.front() == 1U) {
      firstStarted = true;
      cv.notify_all();
      cv.wait(lock, [&] { return releaseFirst; });
    }
    written.push_back(value.pixels.front());
    cv.notify_all();
  });

  assert(writer.enqueue(frame(1U)));
  {
    std::unique_lock lock(mutex);
    cv.wait(lock, [&] { return firstStarted; });
  }
  assert(writer.enqueue(frame(2U)));
  assert(writer.enqueue(frame(3U)));

  std::thread blocked([&] {
    {
      std::lock_guard lock(mutex);
      fourthEntered = true;
      cv.notify_all();
    }
    assert(writer.enqueue(frame(4U)));
    std::lock_guard lock(mutex);
    fourthDone = true;
    cv.notify_all();
  });
  {
    std::unique_lock lock(mutex);
    cv.wait(lock, [&] { return fourthEntered; });
    assert(!fourthDone);
    assert(written.empty());
    releaseFirst = true;
    cv.notify_all();
  }

  blocked.join();
  writer.finish();
  assert((written == std::vector<std::uint8_t>{1U, 2U, 3U, 4U}));
}

void checkExceptionPropagation() {
  std::mutex mutex;
  std::condition_variable cv;
  bool firstStarted = false;
  bool releaseFirst = false;
  FrameWriter writer([&](const RgbFrame& value) {
    if (value.pixels.front() == 1U) {
      std::unique_lock lock(mutex);
      firstStarted = true;
      cv.notify_all();
      cv.wait(lock, [&] { return releaseFirst; });
    } else {
      throw std::runtime_error("write failed");
    }
  });
  assert(writer.enqueue(frame(1U)));
  {
    std::unique_lock lock(mutex);
    cv.wait(lock, [&] { return firstStarted; });
  }
  assert(writer.enqueue(frame(2U)));

  {
    std::lock_guard lock(mutex);
    releaseFirst = true;
    cv.notify_all();
  }

  bool propagated = false;
  try {
    writer.finish();
  } catch (const std::runtime_error& error) {
    propagated = std::string(error.what()) == "write failed";
  }
  assert(propagated);
}

void checkCancellationWakesProducer() {
  std::mutex mutex;
  std::condition_variable cv;
  bool started = false;
  bool release = false;
  bool producerEntered = false;
  bool producerDone = false;

  FrameWriter writer([&](const RgbFrame&) {
    std::unique_lock lock(mutex);
    started = true;
    cv.notify_all();
    cv.wait(lock, [&] { return release; });
  });
  assert(writer.enqueue(frame(1U)));
  {
    std::unique_lock lock(mutex);
    cv.wait(lock, [&] { return started; });
  }
  assert(writer.enqueue(frame(2U)));
  assert(writer.enqueue(frame(3U)));

  std::thread blocked([&] {
    {
      std::lock_guard lock(mutex);
      producerEntered = true;
      cv.notify_all();
    }
    assert(!writer.enqueue(frame(4U)));
    std::lock_guard lock(mutex);
    producerDone = true;
    cv.notify_all();
  });
  {
    std::unique_lock lock(mutex);
    cv.wait(lock, [&] { return producerEntered; });
    assert(!producerDone);
  }
  writer.cancel();
  {
    std::unique_lock lock(mutex);
    cv.wait(lock, [&] { return producerDone; });
    release = true;
    cv.notify_all();
  }
  blocked.join();
  writer.finish();
}

void checkExternalCancellationWakesFullProducer() {
  std::mutex callbackMutex;
  std::condition_variable callbackCv;
  bool started = false;
  bool release = false;
  std::atomic_bool stop = false;

  std::mutex stateMutex;
  std::condition_variable stateCv;
  std::atomic<unsigned> cancellationChecks = 0U;
  bool producerDone = false;

  FrameWriter writer(
      [&](const RgbFrame&) {
        std::unique_lock lock(callbackMutex);
        started = true;
        callbackCv.notify_all();
        callbackCv.wait(lock, [&] { return release; });
      },
      [&] {
        cancellationChecks.fetch_add(1U, std::memory_order_relaxed);
        stateCv.notify_all();
        return stop.load(std::memory_order_acquire);
      });

  assert(writer.enqueue(frame(1U)));
  {
    std::unique_lock lock(callbackMutex);
    callbackCv.wait(lock, [&] { return started; });
  }
  assert(writer.enqueue(frame(2U)));
  assert(writer.enqueue(frame(3U)));

  const auto checksBeforeProducer = cancellationChecks.load(std::memory_order_relaxed);
  std::thread blocked([&] {
    assert(!writer.enqueue(frame(4U)));
    {
      std::lock_guard lock(stateMutex);
      producerDone = true;
    }
    stateCv.notify_all();
  });
  {
    std::unique_lock lock(stateMutex);
    stateCv.wait(lock, [&] {
      return cancellationChecks.load(std::memory_order_relaxed) > checksBeforeProducer;
    });
  }
  stop.store(true, std::memory_order_release);

  bool completedBeforeRelease = false;
  {
    std::unique_lock lock(stateMutex);
    completedBeforeRelease = stateCv.wait_for(
        lock, std::chrono::milliseconds(500), [&] { return producerDone; });
  }
  {
    std::lock_guard lock(callbackMutex);
    release = true;
  }
  callbackCv.notify_all();
  blocked.join();
  writer.finish();
  assert(completedBeforeRelease);
}

void checkAliasedSourceSurvivesWindowAdvance() {
  std::mutex mutex;
  std::condition_variable cv;
  bool firstStarted = false;
  bool releaseFirst = false;
  std::vector<std::uint8_t> observed;

  FrameWriter writer([&](const RgbFrame& value) {
    if (value.pixels.front() == 1U) {
      std::unique_lock lock(mutex);
      firstStarted = true;
      cv.notify_all();
      cv.wait(lock, [&] { return releaseFirst; });
      return;
    }
    std::lock_guard lock(mutex);
    observed = value.pixels;
  });

  assert(writer.enqueue(frame(1U)));
  {
    std::unique_lock lock(mutex);
    cv.wait(lock, [&] { return firstStarted; });
  }

  auto windowOwner = std::make_shared<SourceFrame>(SourceFrame{
      7U, RgbFrame{1, 1, {17U, 34U, 51U}}, false, false});
  auto output = std::shared_ptr<const RgbFrame>(windowOwner, &windowOwner->frame);
  assert(writer.enqueue(std::move(output)));

  // The worker is still blocked on the first frame, so this alias remains in
  // the queue while the interpolation window advances to a new owner.
  windowOwner = std::make_shared<SourceFrame>(SourceFrame{
      8U, RgbFrame{1, 1, {99U}}, false, false});
  assert(observed.empty());

  {
    std::lock_guard lock(mutex);
    releaseFirst = true;
  }
  cv.notify_all();
  writer.finish();
  assert((observed == std::vector<std::uint8_t>{17U, 34U, 51U}));
}

}  // namespace

int main() {
  checkBoundedAndOrdered();
  checkExceptionPropagation();
  checkCancellationWakesProducer();
  checkExternalCancellationWakesFullProducer();
  checkAliasedSourceSurvivesWindowAdvance();
}
