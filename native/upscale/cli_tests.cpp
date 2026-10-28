#include <cassert>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <openvino/opsets/opset13.hpp>

#define main workerMain
#include "main.cpp"
#undef main

namespace {

std::vector<char*> rawArguments(std::vector<std::string>& arguments) {
  std::vector<char*> raw;
  raw.reserve(arguments.size());
  for (auto& argument : arguments) raw.push_back(argument.data());
  return raw;
}

bool rejects(std::vector<std::string> arguments) {
  auto raw = rawArguments(arguments);
  try {
    (void)otc::upscale::parseOptions(static_cast<int>(raw.size()), raw.data());
  } catch (const std::runtime_error&) {
    return true;
  }
  return false;
}

struct RunResult final {
  int exit = 0;
  std::string output;
  std::string errors;
};

RunResult runPassthrough(const std::string& input, const char* outputFps = "3", const char* inputFps = "3") {
  std::vector<std::string> arguments{
      "otc-upscale", "--mode", "base", "--width", "2", "--height", "1",
      "--fps", inputFps, "--output-width", "2", "--output-height", "1",
      "--output-fps", outputFps, "--duration", "1", "--device", "CPU"};
  auto raw = rawArguments(arguments);
  std::istringstream inputStream(input);
  std::ostringstream outputStream;
  std::ostringstream errorStream;
  auto* oldInput = std::cin.rdbuf(inputStream.rdbuf());
  auto* oldOutput = std::cout.rdbuf(outputStream.rdbuf());
  auto* oldError = std::cerr.rdbuf(errorStream.rdbuf());
  std::cin.clear();
  std::cout.clear();
  std::cerr.clear();
  otc::upscale::stopRequested = 0;
  const int exit = workerMain(static_cast<int>(raw.size()), raw.data());
  std::cin.rdbuf(oldInput);
  std::cout.rdbuf(oldOutput);
  std::cerr.rdbuf(oldError);
  std::cin.clear();
  std::cout.clear();
  std::cerr.clear();
  return {exit, outputStream.str(), errorStream.str()};
}

std::vector<std::string> validArguments() {
  return {"worker", "--mode", "turbo", "--width", "2", "--height", "1",
          "--fps", "3", "--output-width", "2", "--output-height", "1",
          "--output-fps", "3", "--duration", "1", "--device", "CPU"};
}

void checkRgbRotation() {
  const otc::upscale::RgbFrame source{
      2, 3,
      {1U, 2U, 3U, 4U, 5U, 6U,
       7U, 8U, 9U, 10U, 11U, 12U,
       13U, 14U, 15U, 16U, 17U, 18U}};
  const auto clockwise = otc::upscale::rotateRgb90(source, otc::upscale::Rotation90::clockwise);
  assert(clockwise.width == 3 && clockwise.height == 2);
  assert((clockwise.pixels == std::vector<std::uint8_t>{
              13U, 14U, 15U, 7U, 8U, 9U, 1U, 2U, 3U,
              16U, 17U, 18U, 10U, 11U, 12U, 4U, 5U, 6U}));
  const auto restored =
      otc::upscale::rotateRgb90(clockwise, otc::upscale::Rotation90::counterClockwise);
  assert(restored.width == source.width && restored.height == source.height);
  assert(restored.pixels == source.pixels);

  bool rejected = false;
  try {
    (void)otc::upscale::rotateRgb90(otc::upscale::RgbFrame{0, 2, {}},
                                otc::upscale::Rotation90::clockwise);
  } catch (const std::runtime_error&) {
    rejected = true;
  }
  assert(rejected);
  rejected = false;
  try {
    (void)otc::upscale::rotateRgb90(otc::upscale::RgbFrame{2, 2, {1U, 2U, 3U}},
                                otc::upscale::Rotation90::clockwise);
  } catch (const std::runtime_error&) {
    rejected = true;
  }
  assert(rejected);
}

void checkRgbRounding() {
  using otc::upscale::floatToByte;
  const auto matchesReference = [](float value) {
    const auto expected = static_cast<std::uint8_t>(
        std::clamp(std::lround(static_cast<double>(value) * 255.0), 0L, 255L));
    assert(floatToByte(value) == expected);
  };
  for (int color = 0; color < 255; ++color) {
    const auto midpoint = static_cast<float>((color + 0.5) / 255.0);
    matchesReference(midpoint);
    matchesReference(std::nextafter(midpoint, 0.0F));
    matchesReference(std::nextafter(midpoint, 1.0F));
  }
  for (unsigned bits = 0; bits < 65536; ++bits) {
    if ((bits & 0x7f80U) == 0x7f80U) continue;
    const std::uint32_t f32bits = bits << 16U;
    float value;
    std::memcpy(&value, &f32bits, sizeof(value));
    // Normalized Flash output has only BF16 values. Check its conversion too.
    const auto scaled = (std::clamp(value, -1.0F, 1.0F) + 1.0F) * 127.5F;
    assert(static_cast<std::uint8_t>(static_cast<double>(scaled) + 0.5) ==
           static_cast<std::uint8_t>(std::lround(scaled)));
    if (value >= -1.0F && value <= 2.0F) matchesReference(value);
  }
  assert(floatToByte(std::numeric_limits<float>::max()) == 255);
  assert(floatToByte(-std::numeric_limits<float>::max()) == 0);
  for (float value : {std::numeric_limits<float>::infinity(),
                      -std::numeric_limits<float>::infinity(),
                      std::numeric_limits<float>::quiet_NaN()}) {
    bool rejected = false;
    try { (void)floatToByte(value); } catch (const std::runtime_error&) { rejected = true; }
    assert(rejected);
  }
}

void checkAlignedInterpolationClock() {
  using namespace otc::upscale;
  Options sourceOptions{};
  sourceOptions.fps = 30.000845094228005;
  sourceOptions.outputFps = 60;
  sourceOptions.duration = 17.30411991549296;
  auto clock = sourceOptions;
  clock.fps = alignedInterpolationFps(sourceOptions.fps, sourceOptions.outputFps, sourceOptions.duration);
  const auto count = outputFrameCount(sourceOptions.duration, sourceOptions.fps);
  std::uint64_t next = 0;
  InterpolationWindow window{clock.fps, [&]() -> std::optional<SourceFrame> {
    if (next >= count) return std::nullopt;
    return SourceFrame{next++, RgbFrame{1, 1, {1, 2, 3}}, false};
  }, std::nullopt, std::nullopt, false};
  assert(window.initialize());
  const auto outputCount = outputFrameCount(sourceOptions.duration, sourceOptions.outputFps);
  std::size_t interpolated = 0;
  for (std::uint64_t index = 0; index < outputCount; ++index) {
    const double time = static_cast<double>(index) / sourceOptions.outputFps;
    window.ensureRight(time);
    assert(window.left);
    if (!window.right) continue;
    const double alpha = (time * clock.fps - window.left->index) /
        static_cast<double>(window.right->index - window.left->index);
    if (alpha > kTimeEpsilon && alpha < 1.0 - kTimeEpsilon) ++interpolated;
    else {
      // Every second output is an existing source frame, not an AI remake.
      assert(index % 2 == 0);
      const auto copied = alpha < 0.5 ? window.left->index : window.right->index;
      assert(copied == index / 2);
    }
  }
  assert(interpolated == outputCount / 2);
  assert(next <= count);
  assert(outputFrameCount(sourceOptions.duration, sourceOptions.fps) == 520);
}

void checkPortraitOptions() {
  const auto root = std::filesystem::temp_directory_path() /
                    ("otc-upscale-portrait-" +
                     std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  const auto models = root / "models";
  std::filesystem::create_directories(models);
  std::filesystem::permissions(root, std::filesystem::perms::owner_all,
                               std::filesystem::perm_options::replace);
  std::filesystem::permissions(models, std::filesystem::perms::owner_all,
                               std::filesystem::perm_options::replace);

  auto portrait = validArguments();
  portrait[4] = "1080";
  portrait[6] = "1920";
  portrait[10] = "2160";
  portrait[12] = "3840";
  portrait[18] = "AUTO";
  portrait.insert(portrait.end(), {"--models", models.string(), "--scratch", root.string()});
  auto raw = rawArguments(portrait);
  const auto options = otc::upscale::parseOptions(static_cast<int>(raw.size()), raw.data());
  assert(options.width == 1080 && options.height == 1920);
  assert(options.outputWidth == 2160 && options.outputHeight == 3840);
  assert(otc::upscale::isPortraitFlashTarget(options.outputWidth, options.outputHeight));

  auto cpu = portrait;
  cpu[18] = "CPU";
  assert(rejects(cpu));
  auto wrongTarget = portrait;
  wrongTarget[10] = "1280";
  wrongTarget[12] = "720";
  assert(rejects(wrongTarget));

  auto noSpatial = validArguments();
  noSpatial[4] = "2160";
  noSpatial[6] = "3840";
  noSpatial[10] = "2160";
  noSpatial[12] = "3840";
  auto noSpatialRaw = rawArguments(noSpatial);
  const auto noSpatialOptions =
      otc::upscale::parseOptions(static_cast<int>(noSpatialRaw.size()), noSpatialRaw.data());
  assert(noSpatialOptions.outputWidth == 2160 && noSpatialOptions.outputHeight == 3840);

  // Same-size 4K close-ups still require Flash, but only for bounded intervals.
  auto selective = noSpatial;
  selective[18] = "AUTO";
  selective.insert(selective.end(), {"--models", models.string(), "--scratch", root.string(),
                                      "--spatial-range", "0:1", "--spatial-range", "2:3"});
  auto selectiveRaw = rawArguments(selective);
  const auto selected = otc::upscale::parseOptions(static_cast<int>(selectiveRaw.size()), selectiveRaw.data());
  assert((selected.spatialRanges == std::vector<otc::upscale::SpatialRange>{{0, 1}, {2, 3}}));
  for (const auto* invalid : {"-1:1", "1:1", "2:1", "0:4", "0:1:2", "nan:1", "0"}) {
    auto bad = selective;
    bad.back() = invalid;
    assert(rejects(bad));
  }
  auto noGpu = selective;
  noGpu[18] = "CPU";
  assert(rejects(noGpu));

  std::filesystem::remove_all(root);
}

void checkPortraitNonSpatialInputBypass() {
  otc::upscale::Options options;
  options.width = 2;
  options.height = 3;
  options.outputWidth = 2160;
  options.outputHeight = 3840;
  const otc::upscale::RgbFrame source{
      2, 3,
      {1U, 2U, 3U, 4U, 5U, 6U,
       7U, 8U, 9U, 10U, 11U, 12U,
       13U, 14U, 15U, 16U, 17U, 18U}};
  const std::string input(reinterpret_cast<const char*>(source.pixels.data()),
                          source.pixels.size());
  std::istringstream inputStream(input);
  auto* oldInput = std::cin.rdbuf(inputStream.rdbuf());
  std::cin.clear();
  otc::upscale::stopRequested = 0;
  otc::upscale::InputReader reader{options, 1U, 0U, {}};
  const auto frame = reader.next(false);
  std::cin.rdbuf(oldInput);
  std::cin.clear();
  assert(frame.has_value());
  const auto expected = otc::upscale::resizeRgb(source, options.outputWidth, options.outputHeight);
  assert(frame->frame.width == options.outputWidth &&
         frame->frame.height == options.outputHeight);
  assert(frame->frame.pixels == expected.pixels);
}

void checkRifeReshapeAndResume() {
  // A tiny packed-7 model returns the first RGB image. Its original static
  // extent deliberately differs from the worker's requested frame geometry.
  auto input = std::make_shared<ov::opset13::Parameter>(ov::element::f32, ov::Shape{1, 7, 2, 2});
  auto split = std::make_shared<ov::opset13::Split>(input, ov::opset13::Constant::create(ov::element::i64, {}, {1}), 7);
  auto rgb = std::make_shared<ov::opset13::Concat>(ov::OutputVector{split->output(0), split->output(1), split->output(2)}, 1);
  auto model = std::make_shared<ov::Model>(ov::OutputVector{rgb}, ov::ParameterVector{input});
  ov::Core core;
  otc::upscale::RifeSession session(core, std::move(model), "CPU", 4, 4);
  const otc::upscale::RgbFrame first{4, 4, std::vector<std::uint8_t>(48, 42)};
  const otc::upscale::RgbFrame second{4, 4, std::vector<std::uint8_t>(48, 99)};
  assert(session.infer(first, second, .5F).pixels == first.pixels);
  session.suspend();
  assert(session.infer(first, second, .5F).pixels == first.pixels);
}

}  // namespace

int main() {
  assert(otc::upscale::looksIntelGpuName("Intel(R) Arc(TM) B580 Graphics"));
  assert(otc::upscale::looksIntelGpuName("INTEL UHD Graphics"));
  assert(!otc::upscale::looksIntelGpuName("NVIDIA GeForce RTX 5060 Ti"));
  assert(!otc::upscale::looksIntelGpuName("AMD Radeon Graphics"));
  assert(!otc::upscale::looksIntelGpuName("Unknown Intel-compatible device"));
  using namespace otc::upscale;
  assert(isExplicitGpu("GPU.0"));
  assert(isExplicitGpu("GPU.12"));
  for (const auto* invalid : {"GPU", "GPU.", "GPU.x", "GPU.-1", "GPU.0.1",
                              "MULTI:CPU,GPU.0", "gpu.0"})
    assert(!isExplicitGpu(invalid));

  auto valid = validArguments();
  auto raw = rawArguments(valid);
  const auto options = parseOptions(static_cast<int>(raw.size()), raw.data());
  assert(options.mode == FlashMode::turbo);
  valid[2] = "base";
  raw = rawArguments(valid);
  assert(parseOptions(static_cast<int>(raw.size()), raw.data()).mode == FlashMode::base);

  auto invalidMode = validArguments();
  invalidMode[2] = "temporal";
  assert(rejects(invalidMode));
  auto invalidDevice = validArguments();
  invalidDevice.back() = "GPU";
  assert(rejects(invalidDevice));
  auto invalidSpatialCpu = validArguments();
  invalidSpatialCpu[10] = "3840";
  invalidSpatialCpu[12] = "2160";
  assert(rejects(invalidSpatialCpu));
  auto invalidSpatialTarget = validArguments();
  invalidSpatialTarget[10] = "1280";
  invalidSpatialTarget[12] = "720";
  invalidSpatialTarget[18] = "AUTO";
  invalidSpatialTarget.insert(invalidSpatialTarget.end(), {"--models", ".", "--scratch", "/"});
  assert(rejects(invalidSpatialTarget));
  auto invalidScratch = validArguments();
  invalidScratch[10] = "3840";
  invalidScratch[12] = "2160";
  invalidScratch[18] = "AUTO";
  invalidScratch.insert(invalidScratch.end(), {"--models", ".", "--scratch", "relative"});
  assert(rejects(invalidScratch));
  auto invalidRife = validArguments();
  invalidRife[14] = "6";
  invalidRife.push_back("--rife");
  invalidRife.push_back("/does/not/exist/model.xml");
  assert(rejects(invalidRife));

  checkRgbRotation();
  checkRgbRounding();
  checkAlignedInterpolationClock();
  checkPortraitOptions();
  checkPortraitNonSpatialInputBypass();

  // Keep workerMain's first sync_with_stdio call from replacing the captured
  // stream buffers used by the no-feature passthrough checks.
  std::ios::sync_with_stdio(false);
  const std::string rgb("abcdefghijklmnopqr", 18);
  const auto pass = runPassthrough(rgb);
  assert(pass.exit == 0);
  assert(pass.output == rgb);
  assert(pass.errors.find("starting") != std::string::npos);
  const auto slowerOutputClock = runPassthrough(rgb, "1");
  assert(slowerOutputClock.exit == 0 && slowerOutputClock.output == rgb.substr(0, 6));

  // Near-60 conversion must now request RIFE, not silently repeat frames.
  for (const auto rate : {51, 59}) {
    std::string frames;
    for (int i = 0; i < rate; ++i) frames.append(6, static_cast<char>(i));
    const auto inputFps = std::to_string(rate);
    const auto converted = runPassthrough(frames, "60", inputFps.c_str());
    assert(converted.exit != 0 && converted.output.empty());
    assert(converted.errors.find("--rife") != std::string::npos);
    assert(converted.errors.find("rife-device") == std::string::npos);
  }

  const auto empty = runPassthrough("");
  assert(empty.exit == 1 && empty.output.empty() &&
         empty.errors.find("source ended") != std::string::npos);
  const auto truncated = runPassthrough(rgb.substr(0, 12));
  assert(truncated.exit == 1 && truncated.errors.find("source ended") != std::string::npos);
  const auto partial = runPassthrough(rgb.substr(0, 13));
  assert(partial.exit == 1 && partial.errors.find("partial RGB24") != std::string::npos);

  checkRifeReshapeAndResume();

  std::cout << "PASS CPU-only Flash CLI parsing, strict spatial/device guards, "
               "passthrough, truncation, and partial-frame behavior\n";
}
