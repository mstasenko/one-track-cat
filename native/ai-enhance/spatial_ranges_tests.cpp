#include "spatial_ranges.hpp"

#include <cassert>
#include <functional>
#include <memory>
#include <vector>

using namespace otc::ai;

void rejects(const std::function<void()>& operation) {
  bool rejected = false;
  try { operation(); } catch (const std::exception&) { rejected = true; }
  assert(rejected);
}

int main() {
  // A fake temporal processor reads ahead, just as Flash does, and changes only
  // selected pixels. Every source frame must still be consumed/published once.
  for (const auto& ranges : {std::vector<SpatialRange>{}, {{0, 1}}, {{2, 5}},
                           {{0, 3}, {3, 4}, {7, 10}}, {{0, 10}}}) {
    std::size_t read = 0, factories = 0, destroyed = 0;
    auto source = [&]() -> std::optional<SourceFrame> {
      if (read == 10) return std::nullopt;
      const auto index = read++;
      return SourceFrame{index, RgbFrame{1, 1, {static_cast<std::uint8_t>(index), 2, 3}}, index == 6};
    };
    SpatialRangeReader sequence(ranges, source, [&](SpatialRange range, SpatialRangeReader::Reader input) {
      ++factories;
      assert(factories == destroyed + 1); // Never keep two temporal models alive.
      auto frames = std::shared_ptr<std::vector<SourceFrame>>(new std::vector<SourceFrame>,
          [&](auto* data) { ++destroyed; delete data; });
      while (auto frame = input()) {
        assert(frame->index == frames->size());
        frame->frame.pixels[0] += 100;
        frames->push_back(std::move(*frame));
      }
      assert(frames->size() == range.second - range.first);
      return [frames, index = std::size_t{0}]() mutable -> std::optional<SourceFrame> {
        if (index == frames->size()) return std::nullopt;
        return std::move((*frames)[index++]);
      };
    });
    for (std::size_t index = 0; index < 10; ++index) {
      const auto frame = sequence.next();
      bool selected = false, boundary = index == 6;
      for (const auto range : ranges) {
        selected = selected || (index >= range.first && index < range.second);
        boundary = boundary || index == range.first || index == range.second;
      }
      assert(frame && frame->index == index);
      assert(frame->frame.pixels[0] == index + (selected ? 100 : 0));
      assert(frame->cutBefore == boundary);
    }
    assert(!sequence.next());
    assert(!sequence.next());
    assert(read == 10 && factories == ranges.size() && destroyed == factories);
  }
  for (const auto& ranges : {std::vector<SpatialRange>{{2, 2}}, {{2, 1}}, {{3, 5}, {4, 6}}})
    rejects([&] { SpatialRangeReader sequence(ranges, {}, {}); });
  SpatialRangeReader truncated({{2, 4}}, [] { return std::optional<SourceFrame>{}; }, {});
  rejects([&] { (void)truncated.next(); });
  SpatialRangeReader wrongIndex({}, [] { return SourceFrame{9, RgbFrame{}, false}; }, {});
  rejects([&] { (void)wrongIndex.next(); });
  SpatialRangeReader shortProcessor({{0, 1}}, [] { return SourceFrame{}; },
      [](auto, auto) { return [] { return std::optional<SourceFrame>{}; }; });
  rejects([&] { (void)shortProcessor.next(); });
}
