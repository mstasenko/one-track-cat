#include "ai_enhance_core.hpp"

#include <cstdint>
#include <cmath>
#include <functional>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void rejects(const std::function<void()>& call) {
  bool rejected = false;
  try {
    call();
  } catch (const std::exception&) {
    rejected = true;
  }
  require(rejected, "expected rejection");
}

}  // namespace

int main() {
  using otc::ai::exactRgbEqual;
  using otc::ai::outputFrameCount;
  using otc::ai::alignedInterpolationFps;
  using otc::ai::needsRifeInterpolation;

  require(alignedInterpolationFps(30.000845094228005, 60, 17.30411991549296) == 30,
          "near-30 source avoids redundant RIFE");
  require(alignedInterpolationFps(29.9999, 60, 30) == 30, "near-30 lower clock");
  require(alignedInterpolationFps(59.9999, 60, 30) == 60, "near-60 needs no RIFE");
  require(alignedInterpolationFps(24.0001, 72, 30) == 24, "integer triple cadence");
  for (double rate : {29.97, 30000.0 / 1001.0, 59.94, 60000.0 / 1001.0, 24.0, 25.0})
    require(alignedInterpolationFps(rate, 60, 30) == rate, "preserve intentional frame rate");
  require(alignedInterpolationFps(30.000845094228005, 60, 300) == 30.000845094228005,
          "long clip must not exceed one millisecond drift");
  require(alignedInterpolationFps(30, 60, 3600) == 30, "exact cadence unchanged");
  for (double bad : {0.0, -1.0, std::numeric_limits<double>::infinity(),
                     std::numeric_limits<double>::quiet_NaN()}) {
    rejects([&] { (void)alignedInterpolationFps(bad, 60, 1); });
    rejects([&] { (void)alignedInterpolationFps(30, bad, 1); });
    rejects([&] { (void)alignedInterpolationFps(30, 60, bad); });
  }

  for (double rate : {24.0, 29.97, 30.0, 49.999, 50.0})
    require(needsRifeInterpolation(rate, 60), "RIFE through 50 fps inclusive");
  for (double rate : {std::nextafter(50.0, 60.0), 55.0, 58.436707235803205, 59.0, 59.94, 60.0, 120.0})
    require(!needsRifeInterpolation(rate, 60), "repeat near-60 frames without RIFE");
  require(needsRifeInterpolation(59, 120), "other higher output rates still interpolate");
  require(!needsRifeInterpolation(30, 30), "unchanged rate requires no interpolation");
  require(outputFrameCount(1.0, 60.0) == 60U, "60 fps count");
  require(outputFrameCount(1.0, 30.0) == 30U, "30 fps count");
  require(outputFrameCount(0.1, 30.0) == 3U, "decimal count");
  require(outputFrameCount(0.1, 60.0) == 6U, "decimal 60 fps count");
  require(outputFrameCount(0.3, 30.0) == 9U, "decimal boundary count");
  require(outputFrameCount(0.1, 29.97) == 3U, "fractional fps count");
  require(outputFrameCount(0.1, 59.94) == 6U, "fractional 60 fps count");
  require(outputFrameCount(1.0 / 60.0, 60.0) == 1U, "integer roundoff");
  require(outputFrameCount(0.1001, 30.0) == 4U, "fractional frame ceiling");
  rejects([] { (void)outputFrameCount(0.0, 30.0); });
  rejects([] { (void)outputFrameCount(1.0, 0.0); });
  rejects([] { (void)outputFrameCount(-1.0, 30.0); });
  rejects([] { (void)outputFrameCount(1.0, -30.0); });
  rejects([] { (void)outputFrameCount(std::numeric_limits<double>::quiet_NaN(), 30.0); });
  rejects([] { (void)outputFrameCount(1.0, std::numeric_limits<double>::infinity()); });
  rejects([] { (void)outputFrameCount(10'000'001.0, 1.0); });
  rejects([] { (void)outputFrameCount(std::numeric_limits<double>::max(), 2.0); });

  const std::vector<std::uint8_t> rgb{0U, 1U, 2U, 3U, 4U, 5U,
                                      6U, 7U, 8U, 9U, 10U, 11U};
  require(exactRgbEqual(2, 2, rgb, rgb), "equal RGB frame");
  auto changed = rgb;
  changed.back() ^= 1U;
  require(!exactRgbEqual(2, 2, rgb, changed), "changed RGB frame");
  require(!exactRgbEqual(2, 2, rgb, std::vector<std::uint8_t>(11U)), "short RGB frame");
  require(!exactRgbEqual(2, 2, rgb, std::vector<std::uint8_t>(13U)), "long RGB frame");
  require(!exactRgbEqual(0, 2, rgb, rgb), "zero width");
  require(!exactRgbEqual(2, 0, rgb, rgb), "zero height");
  require(!exactRgbEqual(-2, 2, rgb, rgb), "negative width");
  require(!exactRgbEqual(2, -2, rgb, rgb), "negative height");
  // This must fail by shape/size validation without attempting a giant
  // allocation. On 32-bit hosts it also exercises checked multiplication.
  require(!exactRgbEqual(std::numeric_limits<int>::max(),
                         std::numeric_limits<int>::max(), {}, {}),
          "oversized RGB shape");

  std::cout << "otc-ai-enhance-core-tests: ok\n";
  return 0;
}
