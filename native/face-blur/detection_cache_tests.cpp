#include "detection_cache.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <streambuf>
#include <string>
#include <vector>

namespace otc::face {

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

bool sameFloat(float first, float second) {
  return std::memcmp(&first, &second, sizeof(first)) == 0;
}

Detection sampleDetection() {
  return {{1.25F, 2.5F, 63.75F, 55.125F}, 0.93750006F};
}

class RepeatingDiagnosticsBuffer final : public std::streambuf {
 public:
  RepeatingDiagnosticsBuffer() { setg(block_.data(), block_.data(), block_.data()); }

 protected:
  int_type underflow() override {
    std::fill(block_.begin(), block_.end() - 1, 'x');
    block_.back() = '\n';
    setg(block_.data(), block_.data(), block_.data() + block_.size());
    return traits_type::to_int_type(*gptr());
  }

 private:
  std::array<char, 4097U> block_{};
};

std::string row(std::uint64_t frame, const std::vector<Detection>& detections = {}) {
  std::ostringstream output;
  require(writeDetectionRow(output, frame, detections, 128, 96), "could not serialize detection row");
  return output.str();
}

void testRawFloatIdentity() {
  const Detection expected = sampleDetection();
  std::stringstream input(row(7U, {expected}));
  DetectionCache cache(input, 128, 96);
  const auto result = cache.lookup(7U);
  require(result.has_value() && result->size() == 1U, "raw detection row was not a cache hit");
  require(sameFloat(result->front().box.x1, expected.box.x1) &&
              sameFloat(result->front().box.y2, expected.box.y2) &&
              sameFloat(result->front().score, expected.score),
          "raw detection float did not round-trip exactly");
}

void testHitMissAndMerge() {
  std::stringstream input(row(2U) + row(4U, {sampleDetection()}) + row(6U));
  std::stringstream preserved;
  DetectionCache cache(input, 128, 96, &preserved);
  require(!cache.lookup(1U).has_value(), "future row was reported as a hit");
  const auto empty = cache.lookup(2U);
  require(empty.has_value() && empty->empty(), "empty cached row was not distinguishable from a miss");
  require(writeDetectionRow(preserved, 2U, *empty, 128, 96), "could not write empty current merged row");
  const auto hit = cache.lookup(4U);
  require(hit.has_value() && hit->size() == 1U, "matching cached row was missed");
  require(writeDetectionRow(preserved, 4U, *hit, 128, 96), "could not write current merged row");
  cache.flush();
  const std::string merged = preserved.str();
  const std::size_t first = merged.find("RCFACE1 2 ");
  const std::size_t current = merged.find("RCFACE1 4 ");
  const std::size_t last = merged.find("RCFACE1 6 ");
  require(first != std::string::npos && current != std::string::npos && last != std::string::npos &&
              first < current && current < last,
          "preserved cache rows were not merged in frame order");
}

void testMalformedAndOutOfOrder() {
  std::stringstream malformed("RCFACE1 2 1 0 0 nan 1 0.5\n");
  DetectionCache malformedCache(malformed, 128, 96);
  require(!malformedCache.lookup(2U).has_value() && !malformedCache.valid(), "malformed row did not invalidate cache");

  std::stringstream outOfOrder(row(3U) + row(2U));
  DetectionCache outOfOrderCache(outOfOrder, 128, 96);
  require(!outOfOrderCache.lookup(4U).has_value() && !outOfOrderCache.valid(),
          "out-of-order row did not invalidate cache");

  std::stringstream oversized(std::string(detectionCacheMaximumLineBytes + 1U, 'x') + '\n');
  DetectionCache oversizedCache(oversized, 128, 96);
  require(!oversizedCache.lookup(0U).has_value() && !oversizedCache.valid(),
          "oversized cache line did not invalidate cache");
}

void testLimits() {
  std::ostringstream rows;
  for (std::size_t index = 0U; index < 65537U; ++index) {
    rows << "RCFACE1 " << index << " 0\n";
  }
  std::stringstream input(rows.str());
  DetectionCache cache(input, 128, 96);
  require(!cache.lookup(UINT64_MAX).has_value() && cache.valid(),
          "bounded cache rejected rows below the byte limit");

  std::vector<Detection> detections(detectionCacheMaximumDetections + 1U, sampleDetection());
  std::ostringstream output;
  require(!writeDetectionRow(output, 0U, detections, 128, 96), "detection count limit was not enforced");

  RepeatingDiagnosticsBuffer diagnostics;
  std::istream diagnosticInput(&diagnostics);
  DetectionCache byteLimitedCache(diagnosticInput, 128, 96);
  require(!byteLimitedCache.lookup(0U).has_value() && !byteLimitedCache.valid(),
          "cache input byte limit was not enforced");
}

}  // namespace

}  // namespace otc::face

int main() {
  using namespace otc::face;
  try {
    testRawFloatIdentity();
    testHitMissAndMerge();
    testMalformedAndOutOfOrder();
    testLimits();
    std::cout << "detection cache tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "detection cache tests failed: " << error.what() << '\n';
    return 1;
  }
}
