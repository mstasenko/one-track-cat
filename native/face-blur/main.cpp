#include "effects.hpp"
#include "detection_pipeline.hpp"
#include "detection_cache.hpp"
#include "retinaface.hpp"
#include "tracker.hpp"

#include <cmath>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace otc::face {

namespace {

struct Options {
  std::filesystem::path model;
  std::filesystem::path effects;
  int width = 0;
  int height = 0;
  double fps = 0.0;
  std::string device;
  std::filesystem::path detectionsCache;
  bool emitDetections = false;
  std::uint64_t frameOffset = 0U;
};

constexpr std::size_t maxFrameBytes = 256U * 1024U * 1024U;

volatile std::sig_atomic_t stopRequested = 0;

// Keep signal handlers side-effect free so the GPU context can drain before normal destruction.
void requestStop(int) noexcept { stopRequested = 1; }

void installSignalHandlers() {
  struct sigaction action {};
  action.sa_handler = requestStop;
  action.sa_flags = 0;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGINT, &action, nullptr) != 0 || sigaction(SIGTERM, &action, nullptr) != 0) {
    throw std::runtime_error("could not install face worker signal handlers");
  }
  if (std::signal(SIGPIPE, SIG_IGN) == SIG_ERR) {
    throw std::runtime_error("could not ignore SIGPIPE");
  }
}

[[noreturn]] void usageError(const std::string& message) {
  throw std::runtime_error(message +
                           "\nusage: otc-face-blur --model MODEL.xml --width N --height N "
                           "--fps N --effects EFFECTS.tsv --device CPU|AUTO [--detections-cache PATH] "
                           "[--emit-detections] [--frame-offset N]");
}

bool isOption(std::string_view value, std::string_view option) { return value == option; }

std::string requireValue(int argc, char** argv, int& index, const char* option) {
  if (index + 1 >= argc) usageError(std::string("missing value for ") + option);
  ++index;
  return argv[index];
}

int parseInt(const std::string& value, const char* option) {
  std::size_t consumed = 0U;
  try {
    const int result = std::stoi(value, &consumed);
    if (consumed != value.size()) usageError(std::string("invalid ") + option);
    return result;
  } catch (const std::exception&) {
    usageError(std::string("invalid ") + option);
  }
}

std::uint64_t parseFrameOffset(const std::string& value) {
  if (value.empty() || value.front() == '-') usageError("invalid --frame-offset");
  std::size_t consumed = 0U;
  try {
    const std::uint64_t result = std::stoull(value, &consumed);
    if (consumed != value.size()) usageError("invalid --frame-offset");
    return result;
  } catch (const std::exception&) {
    usageError("invalid --frame-offset");
  }
}

double parseDouble(const std::string& value, const char* option) {
  std::size_t consumed = 0U;
  try {
    const double result = std::stod(value, &consumed);
    if (consumed != value.size() || !std::isfinite(result)) usageError(std::string("invalid ") + option);
    return result;
  } catch (const std::exception&) {
    usageError(std::string("invalid ") + option);
  }
}

Options parseOptions(int argc, char** argv) {
  Options options;
  for (int index = 1; index < argc; ++index) {
    const std::string_view argument = argv[index];
    if (argument == "--help") {
      std::cout << "usage: otc-face-blur --model MODEL.xml --width N --height N --fps N "
                    "--effects EFFECTS.tsv --device CPU|AUTO [--detections-cache PATH] "
                    "[--emit-detections] [--frame-offset N]\n";
      std::exit(0);
    }
    if (isOption(argument, "--model")) options.model = requireValue(argc, argv, index, "--model");
    else if (isOption(argument, "--effects")) options.effects = requireValue(argc, argv, index, "--effects");
    else if (isOption(argument, "--width")) options.width = parseInt(requireValue(argc, argv, index, "--width"), "--width");
    else if (isOption(argument, "--height")) options.height = parseInt(requireValue(argc, argv, index, "--height"), "--height");
    else if (isOption(argument, "--fps")) options.fps = parseDouble(requireValue(argc, argv, index, "--fps"), "--fps");
    else if (isOption(argument, "--device")) options.device = requireValue(argc, argv, index, "--device");
    else if (isOption(argument, "--detections-cache")) options.detectionsCache = requireValue(argc, argv, index, "--detections-cache");
    else if (isOption(argument, "--emit-detections")) options.emitDetections = true;
    else if (isOption(argument, "--frame-offset")) options.frameOffset = parseFrameOffset(requireValue(argc, argv, index, "--frame-offset"));
    else usageError("unknown option " + std::string(argument));
  }
  if (options.model.empty() || options.effects.empty() || options.device.empty()) usageError("all options are required");
  if (options.width < 1 || options.height < 1 || options.width > 100000 || options.height > 100000 ||
      static_cast<std::size_t>(options.width) * static_cast<std::size_t>(options.height) * 3U > maxFrameBytes) {
    usageError("frame dimensions exceed the bounded 100000x100000/256 MiB limit");
  }
  if (options.fps <= 0.0 || options.fps > 1000.0) usageError("--fps must be in (0,1000]");
  if (options.device != "CPU" && options.device != "AUTO") usageError("--device must be CPU or AUTO");
  if (!std::filesystem::is_regular_file(options.model)) usageError("model XML does not exist");
  if (!std::filesystem::is_regular_file(options.effects)) usageError("effects TSV does not exist");
  return options;
}

std::vector<std::string> splitTsv(const std::string& line) {
  std::vector<std::string> fields;
  std::stringstream stream(line);
  std::string field;
  while (std::getline(stream, field, '\t')) fields.push_back(field);
  return fields;
}

float parseRange(const std::string& value, const char* label) {
  const double number = parseDouble(value, label);
  if (number < 0.0 || number > 1.0) usageError(std::string(label) + " must be between 0 and 1");
  return static_cast<float>(number);
}

std::vector<Effect> readEffects(const std::filesystem::path& path) {
  std::ifstream stream(path);
  if (!stream) usageError("cannot open effects TSV");
  std::vector<Effect> effects;
  std::string line;
  double previousEnd = 0.0;
  constexpr double boundaryEpsilon = 1e-4;
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    if (line.size() > 4096U) usageError("effect row is too long");
    const std::vector<std::string> fields = splitTsv(line);
    if (fields.size() != 7U) usageError("each effect row must contain exactly 7 tab-separated fields");
    const double start = parseDouble(fields[0], "effect start_seconds");
    const double end = parseDouble(fields[1], "effect end_seconds");
    const int detail = parseInt(fields[3], "effect detail");
    const int style = parseInt(fields[6], "effect style");
    if (effects.size() >= 100U) usageError("effects TSV may contain at most 100 rows");
    if (start < 0.0 || end <= start || start + boundaryEpsilon < previousEnd) {
      usageError("effect rows must be sorted, non-overlapping, and have positive duration");
    }
    if (detail != 0 && detail != 1) usageError("effect detail must be 0 or 1");
    if (style < 0 || style > 2) usageError("effect style must be 0, 1, or 2");
    const float hold = parseRange(fields[4], "effect hold_seconds");
    const float strength = parseRange(fields[5], "effect strength");
    if (hold > 1.0F) usageError("effect hold_seconds must be <= 1");
    effects.push_back({start, end, parseRange(fields[2], "effect sensitivity"), detail == 1,
                       hold, strength, style});
    previousEnd = end;
  }
  return effects;
}

int activeEffect(const std::vector<Effect>& effects, double timestamp) {
  for (std::size_t index = 0; index < effects.size(); ++index) {
    if (timestamp >= effects[index].startSeconds && timestamp < effects[index].endSeconds) {
      return static_cast<int>(index);
    }
  }
  return -1;
}

bool readFrame(std::istream& stream, std::vector<std::uint8_t>& frame) {
  const std::streamsize bytes = static_cast<std::streamsize>(frame.size());
  stream.read(reinterpret_cast<char*>(frame.data()), bytes);
  const std::streamsize received = stream.gcount();
  if (stopRequested != 0) return false;
  if (received == 0 && stream.eof()) return false;
  if (received != bytes) throw std::runtime_error("input ended with a partial RGB24 frame");
  return true;
}

}  // namespace

}  // namespace otc::face

int main(int argc, char** argv) {
  using namespace otc::face;
  try {
    installSignalHandlers();
    const Options options = parseOptions(argc, argv);
    const std::vector<Effect> effects = readEffects(options.effects);
    std::cerr << "otc-face-blur: starting\n";
    std::ifstream detectionsInput;
    std::unique_ptr<DetectionCache> detectionCache;
    if (!options.detectionsCache.empty()) {
      detectionsInput.open(options.detectionsCache);
      if (detectionsInput) {
        detectionCache = std::make_unique<DetectionCache>(
            detectionsInput, options.width, options.height, options.emitDetections ? &std::cerr : nullptr);
      }
    }

    std::unique_ptr<RetinaFaceDetector> detector;
    auto ensureDetector = [&]() -> RetinaFaceDetector& {
      if (detector) return *detector;
      const std::vector<std::string> candidates = openVinoDeviceCandidates(options.device);
      std::string device;
      std::string lastError;
      for (const std::string& candidate : candidates) {
        if (stopRequested != 0) break;
        try {
          detector = std::make_unique<RetinaFaceDetector>(options.model, candidate);
          device = candidate;
          break;
        } catch (const std::exception& error) {
          lastError = error.what();
          if (options.device == "CPU") break;
        }
      }
      if (stopRequested != 0) throw std::runtime_error("face detection stopped");
      if (!detector) throw std::runtime_error("could not compile RetinaFace for any requested device: " + lastError);
      std::cerr << "otc-face-blur: device=" << device;
      const std::string hardwareLabel = openVinoDeviceHardwareLabel(device);
      if (!hardwareLabel.empty()) std::cerr << " hardware=" << hardwareLabel;
      std::cerr << " protocol=RGB24\n";
      return *detector;
    };

    const std::size_t frameBytes = static_cast<std::size_t>(options.width) *
                                   static_cast<std::size_t>(options.height) * 3U;
    std::vector<std::uint8_t> frame(frameBytes);
    std::vector<std::uint8_t> previousSceneSample;
    FaceTracker tracker;
    int previousEffect = -2;
    std::size_t frameIndex = 0U;
    std::size_t cacheHits = 0U;
    std::size_t detectedFrames = 0U;
    enum class ProcessingMode { none, cached, inference };
    ProcessingMode lastProcessingMode = ProcessingMode::none;
    while (stopRequested == 0 && readFrame(std::cin, frame)) {
      if (static_cast<std::uint64_t>(frameIndex) > std::numeric_limits<std::uint64_t>::max() - options.frameOffset) {
        throw std::runtime_error("frame index exceeds the bounded global frame range");
      }
      const std::uint64_t globalFrame = options.frameOffset + static_cast<std::uint64_t>(frameIndex);
      const std::optional<std::vector<Detection>> cachedDetections =
          detectionCache ? detectionCache->lookup(globalFrame) : std::nullopt;
      if (cachedDetections) {
        cacheHits += 1U;
      }
      // frameOffset identifies cache rows only. Effects are rebased by the caller for
      // clipped preview ranges, so their timeline remains local to this worker stream.
      const double timestamp = static_cast<double>(frameIndex) / options.fps;
      const int effectIndex = activeEffect(effects, timestamp);
      if (effectIndex < 0) {
        lastProcessingMode = ProcessingMode::none;
        tracker.reset();
        previousSceneSample.clear();
        previousEffect = effectIndex;
        if (options.emitDetections && cachedDetections) {
          (void)writeDetectionRow(std::cerr, globalFrame, *cachedDetections, options.width, options.height);
        }
        std::cout.write(reinterpret_cast<const char*>(frame.data()), static_cast<std::streamsize>(frame.size()));
        if (!std::cout) throw std::runtime_error("output pipe closed");
        frameIndex += 1U;
        continue;
      }
      std::vector<std::uint8_t> currentSceneSample = sceneCutSample(frame, options.width, options.height);
      if (effectIndex != previousEffect ||
          (!previousSceneSample.empty() &&
           looksLikeCut(previousSceneSample, currentSceneSample, sceneCutSampleWidth, sceneCutSampleHeight))) {
        tracker.reset();
      }
      const Effect* effect = effectIndex >= 0 ? &effects[static_cast<std::size_t>(effectIndex)] : nullptr;
      previousSceneSample.swap(currentSceneSample);
      std::vector<Detection> detections;
      if (cachedDetections) {
        if (lastProcessingMode != ProcessingMode::cached) {
          std::cerr << "otc-face-blur: mode=cached render=CPU\n";
          lastProcessingMode = ProcessingMode::cached;
        }
        detections = *cachedDetections;
      } else {
        detections = detectFrame(ensureDetector(), frame, options.width, options.height, effect);
        detectedFrames += 1U;
        if (lastProcessingMode != ProcessingMode::inference) {
          std::cerr << "otc-face-blur: mode=inference render=CPU\n";
          lastProcessingMode = ProcessingMode::inference;
        }
      }
      if (stopRequested != 0) break;
      if (options.emitDetections) {
        (void)writeDetectionRow(std::cerr, globalFrame, detections, options.width, options.height);
      }
      const std::vector<Box> boxes = tracker.update(detections, timestamp, effect == nullptr ? 0.0F : effect->holdSeconds,
                                                     options.width, options.height);
      if (effect != nullptr) renderEffects(frame, options.width, options.height, boxes, effect->style, effect->strength);
      std::cout.write(reinterpret_cast<const char*>(frame.data()), static_cast<std::streamsize>(frame.size()));
      if (!std::cout) throw std::runtime_error("output pipe closed");
      previousEffect = effectIndex;
      frameIndex += 1U;
    }
    if (stopRequested == 0 && detectionCache) detectionCache->flush();
    if (stopRequested == 0 && options.emitDetections) {
      std::cerr << "otc-face-blur: cache_hits=" << cacheHits << " detections=" << detectedFrames << '\n';
    }
    return stopRequested != 0 ? 130 : 0;
  } catch (const std::exception& error) {
    if (stopRequested != 0) return 130;
    std::cerr << "otc-face-blur: " << error.what() << '\n';
    return 1;
  }
}
