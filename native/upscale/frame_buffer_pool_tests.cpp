#include "frame_buffer_pool.hpp"

#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <thread>
#include <utility>
#include <vector>

using namespace otc::upscale;

namespace {

std::shared_ptr<SourceFrame> retained(std::uint8_t value,
                                      const std::shared_ptr<FrameBufferPool>& pool) {
  SourceFrame source{0U, RgbFrame{1, 1, std::vector<std::uint8_t>{value}}, false, false};
  return retainSourceFrame(std::move(source), pool);
}

void checkReuseAndWrongSize() {
  auto pool = std::make_shared<FrameBufferPool>(8U);
  auto first = pool->acquire();
  assert(first.size() == 8U);
  std::fill(first.begin(), first.end(), 0xa5U);
  pool->release(std::move(first));
  assert(pool->freeCount() == 1U);

  auto reused = pool->acquire();
  assert(reused.size() == 8U);
  std::fill(reused.begin(), reused.end(), 0x3cU);
  pool->release(std::move(reused));
  assert(pool->freeCount() == 1U);

  // A partial-sized buffer is never admitted to the reusable cache.  The
  // input reader similarly never publishes a frame after a partial read.
  auto partial = pool->acquire();
  partial.resize(3U);
  pool->release(std::move(partial));
  assert(pool->freeCount() == 0U);
  auto full = pool->acquire();
  assert(full.size() == 8U);
}

void checkRetainedAliasLifetime() {
  auto pool = std::make_shared<FrameBufferPool>(1U);
  auto owner = retained(17U, pool);
  const auto* heldPixels = owner->frame.pixels.data();
  auto alias = std::shared_ptr<const RgbFrame>(owner, &owner->frame);
  owner.reset();
  assert(pool->freeCount() == 0U);

  auto concurrent = pool->acquire();
  assert(concurrent.data() != heldPixels);
  concurrent[0] = 99U;
  assert(alias->pixels[0] == 17U);

  alias.reset();
  assert(pool->freeCount() == 1U);
  pool->release(std::move(concurrent));
  assert(pool->freeCount() == 2U);
}

void checkConcurrentReleaseBound() {
  auto pool = std::make_shared<FrameBufferPool>(1U);
  std::vector<std::shared_ptr<SourceFrame>> owners;
  owners.reserve(8U);
  for (std::uint8_t value = 0U; value < 8U; ++value) owners.push_back(retained(value, pool));

  std::vector<std::thread> workers;
  workers.reserve(owners.size());
  for (auto& owner : owners) {
    auto* slot = &owner;
    workers.emplace_back([slot] { slot->reset(); });
  }
  for (auto& worker : workers) worker.join();
  assert(pool->freeCount() <= FrameBufferPool::kSlots);
}

}  // namespace

int main() {
  checkReuseAndWrongSize();
  checkRetainedAliasLifetime();
  checkConcurrentReleaseBound();
}
