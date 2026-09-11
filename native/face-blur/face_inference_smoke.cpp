#include "detection_pipeline.hpp"
#include "effects.hpp"
#include "tracker.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace otc::face {

namespace {

struct Image {
  int width = 0;
  int height = 0;
  std::vector<std::uint8_t> rgb;
};

struct Options {
  std::filesystem::path model;
  std::filesystem::path largeFixture;
  std::filesystem::path smallFixture;
  std::string device;
  float threshold = 0.215F;
};

constexpr int largeFixtureSide = 512;
constexpr int smallFixtureSide = 1024;
constexpr Box largeFaceRoi{177.0F, 65.0F, 275.0F, 177.0F};
constexpr Box smallFaceRoi{500.0F, 500.0F, 524.0F, 528.0F};

[[noreturn]] void fail(const std::string& message) { throw std::runtime_error(message); }

std::string requireValue(int argc, char** argv, int& index, const char* option) {
  if (index + 1 >= argc) fail(std::string("missing value for ") + option);
  return argv[++index];
}

int parseInt(const std::string& value, const char* label) {
  std::size_t consumed = 0U;
  try {
    const long long number = std::stoll(value, &consumed);
    if (consumed != value.size() || number < 1 || number > 8192) fail(std::string("invalid ") + label);
    return static_cast<int>(number);
  } catch (const std::exception&) {
    fail(std::string("invalid ") + label);
  }
}

float parseThreshold(const std::string& value) {
  std::size_t consumed = 0U;
  try {
    const float threshold = std::stof(value, &consumed);
    if (consumed != value.size() || !std::isfinite(threshold) || threshold < 0.05F || threshold > 0.60F) {
      fail("--threshold must be in [0.05,0.60]");
    }
    return threshold;
  } catch (const std::exception&) {
    fail("invalid --threshold");
  }
}

Options parseOptions(int argc, char** argv) {
  Options options;
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    if (argument == "--help") {
      std::cout << "usage: otc-face-blur-smoke --model MODEL.xml --fixture LARGE.ppm "
                    "--small-fixture SMALL.ppm --device CPU [--threshold 0.05..0.60]\n";
      std::exit(0);
    }
    if (argument == "--model") options.model = requireValue(argc, argv, index, "--model");
    else if (argument == "--fixture") options.largeFixture = requireValue(argc, argv, index, "--fixture");
    else if (argument == "--small-fixture") options.smallFixture = requireValue(argc, argv, index, "--small-fixture");
    else if (argument == "--device") options.device = requireValue(argc, argv, index, "--device");
    else if (argument == "--threshold") options.threshold = parseThreshold(requireValue(argc, argv, index, "--threshold"));
    else fail("unknown option " + argument);
  }
  if (options.model.empty() || options.largeFixture.empty() || options.smallFixture.empty() || options.device.empty()) {
    fail("--model, --fixture, --small-fixture, and --device are required");
  }
  if (options.device != "CPU") fail("smoke test requires explicit --device CPU");
  if (!std::filesystem::is_regular_file(options.model)) fail("model XML does not exist");
  if (!std::filesystem::is_regular_file(options.largeFixture)) fail("large fixture does not exist");
  if (!std::filesystem::is_regular_file(options.smallFixture)) fail("small fixture does not exist");
  return options;
}

std::string nextToken(std::istream& stream) {
  std::string token;
  char character = 0;
  while (stream.get(character)) {
    if (std::isspace(static_cast<unsigned char>(character))) continue;
    if (character == '#') {
      std::string comment;
      std::getline(stream, comment);
      continue;
    }
    token.push_back(character);
    break;
  }
  while (stream.get(character)) {
    if (std::isspace(static_cast<unsigned char>(character))) break;
    token.push_back(character);
  }
  if (token.empty()) fail("PPM header ended early");
  return token;
}

Image readPpm(const std::filesystem::path& path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) fail("cannot open PPM fixture");
  if (nextToken(stream) != "P6") fail("fixture must be binary P6 PPM");
  const int width = parseInt(nextToken(stream), "PPM width");
  const int height = parseInt(nextToken(stream), "PPM height");
  if (nextToken(stream) != "255") fail("PPM fixture must use max value 255");
  const std::size_t bytes = static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3U;
  constexpr std::size_t maximumFixtureBytes = 128U * 1024U * 1024U;
  if (bytes > maximumFixtureBytes) fail("PPM fixture exceeds the 128 MiB smoke-test bound");
  Image image{width, height, std::vector<std::uint8_t>(bytes)};
  stream.read(reinterpret_cast<char*>(image.rgb.data()), static_cast<std::streamsize>(bytes));
  if (stream.gcount() != static_cast<std::streamsize>(bytes)) fail("PPM fixture has a partial RGB payload");
  return image;
}

float sensitivityForThreshold(float threshold) {
  return std::clamp(1.0F - (threshold - 0.05F) / 0.55F, 0.0F, 1.0F);
}

std::size_t changedPixelsInBoxes(const std::vector<std::uint8_t>& before,
                                 const std::vector<std::uint8_t>& after,
                                 int width,
                                 int height,
                                 const std::vector<Detection>& detections) {
  std::size_t changed = 0U;
  for (const Detection& detection : detections) {
    const Box box = clipBox(detection.box, width, height);
    const int left = std::clamp(static_cast<int>(std::floor(box.x1)), 0, width - 1);
    const int right = std::clamp(static_cast<int>(std::ceil(box.x2)), left + 1, width);
    const int top = std::clamp(static_cast<int>(std::floor(box.y1)), 0, height - 1);
    const int bottom = std::clamp(static_cast<int>(std::ceil(box.y2)), top + 1, height);
    for (int y = top; y < bottom; ++y) {
      for (int x = left; x < right; ++x) {
        const std::size_t offset = (static_cast<std::size_t>(y) * static_cast<std::size_t>(width) +
                                    static_cast<std::size_t>(x)) * 3U;
        if (before[offset] != after[offset] || before[offset + 1U] != after[offset + 1U] ||
            before[offset + 2U] != after[offset + 2U]) {
          ++changed;
        }
      }
    }
  }
  return changed;
}

void reportDetections(const std::string& label, const Image& image, const std::vector<Detection>& detections) {
  std::cout << "fixture=" << label << " size=" << image.width << 'x' << image.height
            << " detections=" << detections.size() << '\n';
  for (std::size_t index = 0; index < detections.size(); ++index) {
    const Box& box = detections[index].box;
    std::cout << "  box[" << index << "]=" << box.x1 << ',' << box.y1 << ',' << box.x2 << ',' << box.y2
              << " score=" << detections[index].score << '\n';
  }
}

void requireKnownFace(const std::string& label,
                      const Image& image,
                      const std::vector<Detection>& detections,
                      const Box& expected,
                      int expectedSide) {
  if (image.width != expectedSide || image.height != expectedSide) {
    fail(label + " fixture has unexpected dimensions for the known face ROI");
  }
  const bool overlaps = std::any_of(detections.begin(), detections.end(), [&expected](const Detection& detection) {
    return boxIou(detection.box, expected) >= 0.05F;
  });
  if (!overlaps) fail(label + " detections do not overlap the known NASA face ROI");
  std::cout << "fixture=" << label << " known_face_roi=" << expected.x1 << ',' << expected.y1 << ','
            << expected.x2 << ',' << expected.y2 << '\n';
}

void renderChecks(const std::string& label,
                  const Image& image,
                  const std::vector<Detection>& detections,
                  const std::vector<Box>& boxes) {
  if (detections.empty() || boxes.empty()) fail(label + " has no detectable face");
  for (int style = 0; style <= 2; ++style) {
    std::vector<std::uint8_t> transformed = image.rgb;
    renderEffects(transformed, image.width, image.height, boxes, style, 1.0F);
    const std::size_t changed = changedPixelsInBoxes(image.rgb, transformed, image.width, image.height, detections);
    std::cout << "fixture=" << label << " style=" << style << " changed_face_pixels=" << changed << '\n';
    if (changed == 0U) fail(label + " style did not change detected face area");
  }
  std::vector<std::uint8_t> passthrough = image.rgb;
  renderEffects(passthrough, image.width, image.height, {}, 0, 1.0F);
  if (passthrough != image.rgb) fail(label + " inactivity passthrough changed pixels");
  std::cout << "fixture=" << label << " inactivity_passthrough=1\n";

  FaceTracker tracker;
  const std::vector<Box> initial = tracker.update(detections, 0.0, 0.5F, image.width, image.height);
  const std::vector<Box> held = tracker.update({}, 0.1, 0.5F, image.width, image.height);
  if (held.empty() || held.size() != initial.size()) fail(label + " missed-frame hold failed");
  std::vector<std::uint8_t> heldFrame = image.rgb;
  renderEffects(heldFrame, image.width, image.height, held, 2, 1.0F);
  const std::size_t heldChanged = changedPixelsInBoxes(image.rgb, heldFrame, image.width, image.height, detections);
  std::cout << "fixture=" << label << " held_boxes=" << held.size()
            << " held_changed_pixels=" << heldChanged << '\n';
  if (heldChanged == 0U) fail(label + " missed-frame hold did not obscure the held face");
  if (tracker.update({}, 0.7, 0.5F, image.width, image.height).size() != 0U) {
    fail(label + " missed-frame hold did not expire");
  }
}

void runFixture(RetinaFaceDetector& detector,
                const std::string& label,
                const Image& image,
                const Box& expectedFace,
                int expectedSide,
                float threshold,
                bool detail) {
  const Effect effect{0.0, 1.0, sensitivityForThreshold(threshold), detail, 0.5F, 1.0F, 0};
  const std::vector<Detection> detections = detectFrame(detector, image.rgb, image.width, image.height, &effect);
  reportDetections(label, image, detections);
  requireKnownFace(label, image, detections, expectedFace, expectedSide);
  FaceTracker tracker;
  const std::vector<Box> boxes = tracker.update(detections, 0.0, effect.holdSeconds, image.width, image.height);
  renderChecks(label, image, detections, boxes);
}

std::vector<std::uint8_t> copyRegionRgb(const Image& image, const Region& region) {
  const std::size_t rowBytes = static_cast<std::size_t>(region.width) * 3U;
  std::vector<std::uint8_t> tile(rowBytes * static_cast<std::size_t>(region.height));
  for (int y = 0; y < region.height; ++y) {
    const std::size_t source =
        (static_cast<std::size_t>(region.y + y) * static_cast<std::size_t>(image.width) +
         static_cast<std::size_t>(region.x)) * 3U;
    const std::size_t destination = static_cast<std::size_t>(y) * rowBytes;
    std::copy_n(image.rgb.data() + source, rowBytes, tile.data() + destination);
  }
  return tile;
}

void requireDetectionVectorsEqual(const std::string& label,
                                  const std::vector<Detection>& expected,
                                  const std::vector<Detection>& actual) {
  if (expected.size() != actual.size()) {
    fail(label + " detection count mismatch");
  }
  for (std::size_t index = 0; index < expected.size(); ++index) {
    const Detection& expectedDetection = expected[index];
    const Detection& actualDetection = actual[index];
    if (expectedDetection.score != actualDetection.score ||
        expectedDetection.box.x1 != actualDetection.box.x1 ||
        expectedDetection.box.y1 != actualDetection.box.y1 ||
        expectedDetection.box.x2 != actualDetection.box.x2 ||
        expectedDetection.box.y2 != actualDetection.box.y2) {
      fail(label + " detection mismatch at index " + std::to_string(index));
    }
  }
}

std::vector<Detection> expectedRegionDetections(RetinaFaceDetector& detector,
                                                const Image& image,
                                                const std::vector<Region>& regions,
                                                float threshold,
                                                std::size_t& cropDetections) {
  std::vector<Detection> expected;
  cropDetections = 0U;
  for (std::size_t index = 0; index < regions.size(); ++index) {
    const Region& region = regions[index];
    const std::vector<std::uint8_t> tile = copyRegionRgb(image, region);
    const std::vector<Detection> local =
        detector.detect(tile, region.width, region.height, threshold);
    if (index > 0U) cropDetections += local.size();
    for (Detection detection : local) {
      detection.box.x1 += static_cast<float>(region.x);
      detection.box.x2 += static_cast<float>(region.x);
      detection.box.y1 += static_cast<float>(region.y);
      detection.box.y2 += static_cast<float>(region.y);
      detection.box = clipBox(detection.box, image.width, image.height);
      expected.push_back(detection);
    }
  }
  return expected;
}

void requireInvalidRegionThrows(RetinaFaceDetector& detector,
                                const Image& image,
                                const Region& region,
                                float threshold,
                                const std::string& label) {
  bool threw = false;
  try {
    (void)detector.detectRegions(image.rgb, image.width, image.height, {region}, threshold);
  } catch (const std::runtime_error& error) {
    if (std::string(error.what()) == "invalid detection region") threw = true;
    else throw;
  }
  if (!threw) fail(label + " invalid region did not throw");
}

void runRegionChecks(RetinaFaceDetector& detector,
                     const Image& large,
                     const Image& small,
                     float threshold) {
  const std::vector<Detection> largeBefore =
      detector.detect(large.rgb, large.width, large.height, threshold);
  const Region fullFrame{0, 0, small.width, small.height};
  const Region firstCrop{256, 256, 512, 512};
  const Region secondCrop{384, 384, 512, 512};
  const std::vector<Region> oddRegions{fullFrame, firstCrop, secondCrop};
  const std::vector<Region> evenRegions{fullFrame, firstCrop};

  std::size_t cropDetections = 0U;
  const std::vector<Detection> expectedOdd =
      expectedRegionDetections(detector, small, oddRegions, threshold, cropDetections);
  const std::vector<Detection> actualOdd =
      detector.detectRegions(small.rgb, small.width, small.height, oddRegions, threshold);
  requireDetectionVectorsEqual("three-region request", expectedOdd, actualOdd);
  if (cropDetections == 0U) fail("small region crops found no face");

  std::size_t ignoredCropDetections = 0U;
  const std::vector<Detection> expectedEven =
      expectedRegionDetections(detector, small, evenRegions, threshold, ignoredCropDetections);
  const std::vector<Detection> actualEven =
      detector.detectRegions(small.rgb, small.width, small.height, evenRegions, threshold);
  requireDetectionVectorsEqual("two-region request", expectedEven, actualEven);

  if (!detector.detectRegions(small.rgb, small.width, small.height, {}, threshold).empty()) {
    fail("empty region request was not empty");
  }
  requireInvalidRegionThrows(detector, small, {-1, 0, 512, 512}, threshold, "negative region");
  requireInvalidRegionThrows(detector, small, {700, 700, 512, 512}, threshold, "out-of-frame region");
  requireInvalidRegionThrows(detector, small, {0, 0, 0, 512}, threshold, "zero-size region");

  const std::vector<Detection> largeAfter =
      detector.detect(large.rgb, large.width, large.height, threshold);
  requireDetectionVectorsEqual("large post-region request", largeBefore, largeAfter);
  std::cout << "fixture=small region_requests=3,2 crop_detections=" << cropDetections
            << " empty=1 invalid=3\n";
  std::cout << "fixture=large post_region_standard=1\n";
}

}  // namespace

}  // namespace otc::face

int main(int argc, char** argv) {
  using namespace otc::face;
  try {
    const Options options = parseOptions(argc, argv);
    const Image large = readPpm(options.largeFixture);
    const Image small = readPpm(options.smallFixture);
    RetinaFaceDetector detector(options.model, options.device);
    runRegionChecks(detector, large, small, options.threshold);
    const float sensitivity = sensitivityForThreshold(options.threshold);
    const Effect standard{0.0, 1.0, sensitivity, false, 0.5F, 1.0F, 0};
    const Effect detail{0.0, 1.0, sensitivity, true, 0.5F, 1.0F, 0};
    const std::vector<Detection> smallStandard = detectFrame(detector, small.rgb, small.width, small.height, &standard);
    const std::vector<Detection> smallDetail = detectFrame(detector, small.rgb, small.width, small.height, &detail);
    std::cout << "fixture=small standard_detections=" << smallStandard.size()
              << " detail_detections=" << smallDetail.size() << '\n';
    if (smallDetail.empty()) fail("small fixture detail mode found no face");
    runFixture(detector, "large", large, largeFaceRoi, largeFixtureSide, options.threshold, false);
    runFixture(detector, "small-detail", small, smallFaceRoi, smallFixtureSide, options.threshold, true);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "otc-face-blur-smoke: " << error.what() << '\n';
    return 1;
  }
}
