#include "upscale_core.hpp"
#include "flash_prepare_cli.hpp"
#include "flash_stage.hpp"
#include "flash_video.hpp"
#include "rife_assets.hpp"
#include "rife_model.hpp"
#include "verified_kernel_files.hpp"
#include "spatial_ranges.hpp"
#include "interpolation_window.hpp"

#include <openvino/openvino.hpp>
#include <openvino/runtime/intel_gpu/properties.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <functional>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace otc::upscale {
namespace {

constexpr std::size_t kFlashWidth = 3840U;
constexpr std::size_t kFlashHeight = 2160U;
constexpr std::size_t kMaxFrameBytes = 512U * 1024U * 1024U;
constexpr std::uint64_t kMaxOutputFrames = 10'000'000ULL;
constexpr double kMaxDurationSeconds = 24.0 * 60.0 * 60.0;
constexpr double kTimeEpsilon = 1.0e-9;
constexpr double kSceneCutThreshold = 0.30;

enum class Rotation90 { clockwise, counterClockwise };

volatile std::sig_atomic_t stopRequested = 0;

struct Options final {
  std::filesystem::path models;
  std::filesystem::path scratch;
  std::filesystem::path rifeModel;
  FlashMode mode = FlashMode::turbo;
  int width = 0;
  int height = 0;
  double fps = 0.0;
  int outputWidth = 0;
  int outputHeight = 0;
  double outputFps = 0.0;
  double duration = 0.0;
  std::string device;
  std::vector<SpatialRange> spatialRanges;
  std::vector<SpatialRange> interpolationRanges;
};

[[noreturn]] void usageError(const std::string& message) {
  throw std::runtime_error(
      message +
      "\nusage: otc-upscale --mode turbo|base --models DIR --scratch PRIVATE_DIR "
      "--rife rife.xml --width N --height N --fps N "
      "--output-width N --output-height N --output-fps N --duration SECONDS "
      "--device AUTO|CPU|GPU.N [--spatial-range FIRST:STOP ...]");
}

void requestStop(int) noexcept { stopRequested = 1; }

void installSignalHandlers() {
  struct sigaction action {};
  action.sa_handler = requestStop;
  action.sa_flags = 0;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGINT, &action, nullptr) != 0 ||
      sigaction(SIGTERM, &action, nullptr) != 0)
    throw std::runtime_error("could not install AI worker signal handlers");
  if (std::signal(SIGPIPE, SIG_IGN) == SIG_ERR)
    throw std::runtime_error("could not ignore SIGPIPE");
}

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

double parseDouble(const std::string& value, const char* option) {
  std::size_t consumed = 0U;
  try {
    const double result = std::stod(value, &consumed);
    if (consumed != value.size() || !std::isfinite(result))
      usageError(std::string("invalid ") + option);
    return result;
  } catch (const std::exception&) {
    usageError(std::string("invalid ") + option);
  }
}

std::size_t checkedFrameBytes(int width, int height, const char* label) {
  if (width < 1 || height < 1 || width > 100'000 || height > 100'000)
    usageError(std::string(label) + " exceeds the bounded 100000x100000 limit");
  const auto pixels = static_cast<std::uint64_t>(width) *
                      static_cast<std::uint64_t>(height);
  const auto bytes = pixels * 3U;
  if (pixels == 0U || bytes > kMaxFrameBytes)
    usageError(std::string(label) + " exceeds the bounded frame-memory limit");
  return static_cast<std::size_t>(bytes);
}

bool isLandscapeFlashTarget(int width, int height) {
  return width == static_cast<int>(kFlashWidth) &&
         height == static_cast<int>(kFlashHeight);
}

bool isPortraitFlashTarget(int width, int height) {
  return width == static_cast<int>(kFlashHeight) &&
         height == static_cast<int>(kFlashWidth);
}

upscale::RgbFrame rotateRgb90(const upscale::RgbFrame& source, Rotation90 rotation) {
  const auto sourceBytes = checkedFrameBytes(source.width, source.height, "RGB frame");
  if (source.pixels.size() != sourceBytes)
    throw std::runtime_error("RGB frame pixel extent differs from its geometry");

  const int destinationWidth = source.height;
  const int destinationHeight = source.width;
  upscale::RgbFrame result{
      destinationWidth, destinationHeight,
      std::vector<std::uint8_t>(checkedFrameBytes(destinationWidth, destinationHeight,
                                                   "rotated RGB frame"))};
  for (int y = 0; y < source.height; ++y) {
    for (int x = 0; x < source.width; ++x) {
      const int destinationX = rotation == Rotation90::clockwise
                                   ? source.height - 1 - y
                                   : y;
      const int destinationY = rotation == Rotation90::clockwise
                                   ? x
                                   : source.width - 1 - x;
      const auto sourceOffset = (static_cast<std::size_t>(y) * source.width + x) * 3U;
      const auto destinationOffset =
          (static_cast<std::size_t>(destinationY) * destinationWidth + destinationX) * 3U;
      for (int channel = 0; channel < 3; ++channel)
        result.pixels[destinationOffset + static_cast<std::size_t>(channel)] =
            source.pixels[sourceOffset + static_cast<std::size_t>(channel)];
    }
  }
  return result;
}

bool isExplicitGpu(std::string_view device) {
  if (device.size() <= 4U || device.substr(0U, 4U) != "GPU.") return false;
  return std::all_of(device.begin() + 4U, device.end(),
                     [](char value) { return value >= '0' && value <= '9'; });
}

FlashMode parseMode(std::string_view value) {
  if (value == "turbo") return FlashMode::turbo;
  if (value == "base") return FlashMode::base;
  usageError("--mode must be turbo or base");
}

bool isPrivateDirectory(const std::filesystem::path& path) {
  if (!path.is_absolute() || !std::filesystem::is_directory(path)) return false;
  const auto permissions = std::filesystem::status(path).permissions();
  const auto publicBits = std::filesystem::perms::group_write |
                          std::filesystem::perms::group_read |
                          std::filesystem::perms::group_exec |
                          std::filesystem::perms::others_write |
                          std::filesystem::perms::others_read |
                          std::filesystem::perms::others_exec;
  return (permissions & publicBits) == std::filesystem::perms::none;
}

Options parseOptions(int argc, char** argv) {
  Options options;
  for (int index = 1; index < argc; ++index) {
    const std::string_view argument = argv[index];
    if (argument == "--help") {
      std::cout << "usage: otc-upscale --mode turbo|base --models DIR "
                    "--scratch PRIVATE_DIR --rife rife.xml "
                    "--width N --height N --fps N --output-width N "
                    "--output-height N --output-fps N --duration SECONDS "
                    "--device AUTO|CPU|GPU.N\n";
      std::exit(0);
    }
    if (argument == "--models") {
      options.models = requireValue(argc, argv, index, "--models");
    } else if (argument == "--scratch") {
      options.scratch = requireValue(argc, argv, index, "--scratch");
    } else if (argument == "--rife") {
      options.rifeModel = requireValue(argc, argv, index, "--rife");
    } else if (argument == "--mode") {
      options.mode = parseMode(requireValue(argc, argv, index, "--mode"));
    } else if (argument == "--spatial-range" || argument == "--interpolation-range") {
      auto& ranges = argument == "--spatial-range" ? options.spatialRanges : options.interpolationRanges;
      const auto value = requireValue(argc, argv, index, argument.data());
      const auto colon = value.find(':');
      if (colon == std::string::npos || ranges.size() >= 10'000U)
        usageError("invalid frame range");
      const auto first = parseInt(value.substr(0, colon), argument.data());
      const auto stop = parseInt(value.substr(colon + 1), argument.data());
      if (first < 0 || stop <= first ||
          (!ranges.empty() && static_cast<std::size_t>(first) < ranges.back().second))
        usageError("frame ranges must be ordered, disjoint and nonempty");
      ranges.emplace_back(first, stop);
    } else if (argument == "--width") {
      options.width = parseInt(requireValue(argc, argv, index, "--width"), "--width");
    } else if (argument == "--height") {
      options.height = parseInt(requireValue(argc, argv, index, "--height"), "--height");
    } else if (argument == "--fps") {
      options.fps = parseDouble(requireValue(argc, argv, index, "--fps"), "--fps");
    } else if (argument == "--output-width") {
      options.outputWidth = parseInt(requireValue(argc, argv, index, "--output-width"),
                                     "--output-width");
    } else if (argument == "--output-height") {
      options.outputHeight = parseInt(requireValue(argc, argv, index, "--output-height"),
                                      "--output-height");
    } else if (argument == "--output-fps") {
      options.outputFps = parseDouble(requireValue(argc, argv, index, "--output-fps"),
                                      "--output-fps");
    } else if (argument == "--duration") {
      options.duration = parseDouble(requireValue(argc, argv, index, "--duration"),
                                     "--duration");
    } else if (argument == "--device") {
      options.device = requireValue(argc, argv, index, "--device");
    } else {
      usageError("unknown option " + std::string(argument));
    }
  }

  checkedFrameBytes(options.width, options.height, "source dimensions");
  checkedFrameBytes(options.outputWidth, options.outputHeight, "output dimensions");
  if (options.device != "AUTO" && options.device != "CPU" &&
      !isExplicitGpu(options.device))
    usageError("--device must be AUTO, CPU, or an explicit GPU.N");
  if (!std::isfinite(options.fps) || options.fps <= 0.0 || options.fps > 1000.0)
    usageError("--fps must be in (0,1000]");
  if (!std::isfinite(options.outputFps) || options.outputFps <= 0.0 ||
      options.outputFps > 1000.0)
    usageError("--output-fps must be in (0,1000]");
  if (!std::isfinite(options.duration) || options.duration <= 0.0 ||
      options.duration > kMaxDurationSeconds)
    usageError("--duration must be in (0,86400]");

  const auto outputFrames = outputFrameCount(options.duration, options.outputFps);
  const auto sourceFrames = outputFrameCount(options.duration, options.fps);
  if (!options.spatialRanges.empty() && options.spatialRanges.back().second > sourceFrames)
    usageError("spatial range exceeds the source timeline");
  if (!options.interpolationRanges.empty() && options.interpolationRanges.back().second > sourceFrames)
    usageError("interpolation range exceeds the source timeline");
  if (outputFrames > kMaxOutputFrames)
    usageError("requested output frame count exceeds the bounded limit");

  const bool needFlash = !options.spatialRanges.empty() || options.outputWidth > options.width ||
                         options.outputHeight > options.height;
  const bool needResize = options.outputWidth != options.width ||
                          options.outputHeight != options.height;
  const bool needRife = needsRifeInterpolation(options.fps, options.outputFps) || !options.interpolationRanges.empty();
  if (needFlash && !isLandscapeFlashTarget(options.outputWidth, options.outputHeight) &&
      !isPortraitFlashTarget(options.outputWidth, options.outputHeight))
    usageError("spatial Flash enhancement requires the reviewed 3840x2160 or 2160x3840 target");
  if (needFlash && options.device == "CPU")
    usageError("spatial Flash enhancement requires a discrete Intel GPU");
  if (needFlash && !std::filesystem::is_directory(options.models))
    usageError("--models directory is required for Flash enhancement");
  if (needFlash && !isPrivateDirectory(options.scratch))
    usageError("--scratch must be an existing absolute private directory for Flash enhancement");
  if (needRife && !std::filesystem::is_regular_file(options.rifeModel))
    usageError("--rife model is required for a higher output fps and must be a regular file");
  if (!needFlash && !needResize && !needRife && !options.models.empty() &&
      !std::filesystem::is_directory(options.models))
    usageError("--models must be a directory when supplied");
  return options;
}

bool readFrame(std::istream& stream, std::vector<std::uint8_t>& frame) {
  stream.read(reinterpret_cast<char*>(frame.data()),
              static_cast<std::streamsize>(frame.size()));
  const auto received = stream.gcount();
  if (stopRequested != 0) return false;
  if (received == 0 && stream.eof()) return false;
  if (received != static_cast<std::streamsize>(frame.size()))
    throw std::runtime_error("input ended with a partial RGB24 frame");
  return true;
}

upscale::RgbFrame copyFrame(const upscale::RgbFrame& frame) {
  return {frame.width, frame.height, frame.pixels};
}

upscale::RgbFrame resizeRgb(const upscale::RgbFrame& source, int outputWidth, int outputHeight) {
  if (source.width == outputWidth && source.height == outputHeight) return copyFrame(source);
  upscale::RgbFrame result{
      outputWidth, outputHeight,
      std::vector<std::uint8_t>(static_cast<std::size_t>(outputWidth) *
                                static_cast<std::size_t>(outputHeight) * 3U)};
  for (int y = 0; y < outputHeight; ++y) {
    const double sourceY = (static_cast<double>(y) + 0.5) * source.height /
                               static_cast<double>(outputHeight) - 0.5;
    const int y0 = std::clamp(static_cast<int>(std::floor(sourceY)), 0, source.height - 1);
    const int y1 = std::clamp(y0 + 1, 0, source.height - 1);
    const double fy = std::clamp(sourceY - y0, 0.0, 1.0);
    for (int x = 0; x < outputWidth; ++x) {
      const double sourceX = (static_cast<double>(x) + 0.5) * source.width /
                                 static_cast<double>(outputWidth) - 0.5;
      const int x0 = std::clamp(static_cast<int>(std::floor(sourceX)), 0, source.width - 1);
      const int x1 = std::clamp(x0 + 1, 0, source.width - 1);
      const double fx = std::clamp(sourceX - x0, 0.0, 1.0);
      const auto destination = (static_cast<std::size_t>(y) * outputWidth + x) * 3U;
      const auto a = (static_cast<std::size_t>(y0) * source.width + x0) * 3U;
      const auto b = (static_cast<std::size_t>(y0) * source.width + x1) * 3U;
      const auto c = (static_cast<std::size_t>(y1) * source.width + x0) * 3U;
      const auto d = (static_cast<std::size_t>(y1) * source.width + x1) * 3U;
      for (int channel = 0; channel < 3; ++channel) {
        const double top = source.pixels[a + channel] * (1.0 - fx) +
                           source.pixels[b + channel] * fx;
        const double bottom = source.pixels[c + channel] * (1.0 - fx) +
                              source.pixels[d + channel] * fx;
        result.pixels[destination + channel] = static_cast<std::uint8_t>(
            std::clamp(std::lround(top * (1.0 - fy) + bottom * fy), 0L, 255L));
      }
    }
  }
  return result;
}

std::vector<std::uint8_t> sceneSample(const upscale::RgbFrame& frame) {
  constexpr int sampleWidth = 16;
  constexpr int sampleHeight = 16;
  std::vector<std::uint8_t> sample(sampleWidth * sampleHeight);
  for (int y = 0; y < sampleHeight; ++y) {
    const int sourceY = std::min(frame.height - 1, (y * frame.height) / sampleHeight);
    for (int x = 0; x < sampleWidth; ++x) {
      const int sourceX = std::min(frame.width - 1, (x * frame.width) / sampleWidth);
      const auto offset = (static_cast<std::size_t>(sourceY) * frame.width + sourceX) * 3U;
      const int luma = (77 * frame.pixels[offset] + 150 * frame.pixels[offset + 1U] +
                        29 * frame.pixels[offset + 2U]) >> 8;
      sample[static_cast<std::size_t>(y * sampleWidth + x)] =
          static_cast<std::uint8_t>(luma);
    }
  }
  return sample;
}

bool identicalFrames(const upscale::RgbFrame& first, const upscale::RgbFrame& second) {
  return exactRgbEqual(first.width, first.height, first.pixels, second.pixels);
}

int staticDimension(const ov::PartialShape& shape, std::size_t index) {
  if (shape.rank().is_dynamic() ||
      index >= static_cast<std::size_t>(shape.rank().get_length()) ||
      shape[index].is_dynamic())
    return -1;
  const auto length = shape[index].get_length();
  if (length < 1 || length > std::numeric_limits<int>::max()) return -1;
  return static_cast<int>(length);
}

void requireRgbOutputShape(const ov::PartialShape& shape, const char* label) {
  if (shape.rank().is_dynamic() || shape.rank().get_length() != 4 ||
      staticDimension(shape, 0) == 0 ||
      (staticDimension(shape, 0) > 0 && staticDimension(shape, 0) != 1) ||
      (staticDimension(shape, 1) > 0 && staticDimension(shape, 1) != 3))
    throw std::runtime_error(std::string(label) + " must be rank-4 NCHW RGB output");
}

void fillImageChannels(const upscale::RgbFrame& frame, int tensorWidth, int tensorHeight,
                       float* destination) {
  const auto plane = static_cast<std::size_t>(tensorWidth) * tensorHeight;
  for (int y = 0; y < tensorHeight; ++y) {
    const int sourceY = std::min(y, frame.height - 1);
    for (int x = 0; x < tensorWidth; ++x) {
      const int sourceX = std::min(x, frame.width - 1);
      const auto source = (static_cast<std::size_t>(sourceY) * frame.width + sourceX) * 3U;
      const auto pixel = static_cast<std::size_t>(y) * tensorWidth + x;
      for (int channel = 0; channel < 3; ++channel)
        destination[static_cast<std::size_t>(channel) * plane + pixel] =
            static_cast<float>(frame.pixels[source + channel]) / 255.0F;
    }
  }
}

std::uint8_t floatToByte(float value) {
  if (!std::isfinite(value)) throw std::runtime_error("RIFE output contains a non-finite value");
  // Positive, bounded rounding needs no per-channel libm call (or potentially
  // overflowing float-to-long conversion for an out-of-range model output).
  return static_cast<std::uint8_t>(std::clamp(static_cast<double>(value) * 255.0, 0.0, 255.0) + 0.5);
}

class RifeSession final {
 public:
  RifeSession(ov::Core& core, std::shared_ptr<ov::Model> model,
              const std::string& device, int sourceWidth, int sourceHeight,
              const std::filesystem::path& assets = {})
      : core_(core), device_(device) {
    if (!model) throw std::invalid_argument("RIFE model is missing");
    if (model->inputs().size() != 1U || model->outputs().empty())
      throw std::runtime_error("RIFE model must have one input and one output");
    inputShape_ = model->input().get_partial_shape();
    if (inputShape_.rank().is_dynamic() || inputShape_.rank().get_length() != 4 ||
        staticDimension(inputShape_, 0) != 1 || staticDimension(inputShape_, 1) != 7 ||
        model->input().get_element_type() != ov::element::f32)
      throw std::runtime_error("RIFE input must be static [1,7,H,W] FP32");
    model->reshape(ov::PartialShape{1U, 7U, static_cast<std::int64_t>(sourceHeight),
                                    static_cast<std::int64_t>(sourceWidth)});
    inputShape_ = model->input().get_partial_shape();
    requireRgbOutputShape(model->output().get_partial_shape(), "RIFE output");
    if (model->output().get_element_type() != ov::element::f32)
      throw std::runtime_error("RIFE output must use FP32");
#if defined(__linux__)
    gpuFast_ = device_ != "CPU";
    if (gpuFast_) {
      kernels_.emplace(VerifiedKernelFiles::open(assets, {kRifeWarpConfig,
          {VerifiedKernelSourceSpec{kRifeWarpSource, 1U}, {}}, 1U}));
      model = rifeGpuModel(std::move(model), sourceWidth, sourceHeight);
    }
#endif
    model_ = std::move(model);
    ensureCompiled();
  }

  void suspend() {
    // The GPU plugin retains inference buffers in the compiled model, not
    // just the request. Both must retire before Flash resumes on a 12GB GPU.
    request_.reset();
    compiled_.reset();
  }

  upscale::RgbFrame infer(const upscale::RgbFrame& first, const upscale::RgbFrame& second,
                    float timestep) {
    if (first.width != second.width || first.height != second.height)
      throw std::runtime_error("RIFE input dimensions differ");
    const int fixedHeight = staticDimension(inputShape_, 2);
    const int fixedWidth = staticDimension(inputShape_, 3);
    const int tensorHeight = fixedHeight > 0 ? fixedHeight : first.height;
    const int tensorWidth = fixedWidth > 0 ? fixedWidth : first.width;
    if (tensorHeight < first.height || tensorWidth < first.width)
      throw std::runtime_error("RIFE input shape is smaller than the RGB pair");
    const ov::Shape shape{1U, 7U, static_cast<std::size_t>(tensorHeight),
                          static_cast<std::size_t>(tensorWidth)};
    ensureCompiled();
    if (!request_) request_.emplace(compiled_->create_infer_request());
    if (gpuFast_) {
      if (first.width != tensorWidth || first.height != tensorHeight)
        throw std::runtime_error("RIFE RGB input dimensions differ from the compiled model");
      const ov::Shape rgbShape{1U, static_cast<std::size_t>(first.height),
                                static_cast<std::size_t>(first.width), 3U};
      request_->set_input_tensor(0U, ov::Tensor(ov::element::u8, rgbShape, const_cast<std::uint8_t*>(first.pixels.data())));
      request_->set_input_tensor(1U, ov::Tensor(ov::element::u8, rgbShape, const_cast<std::uint8_t*>(second.pixels.data())));
      ov::Tensor step(ov::element::f32, {});
      step.data<float>()[0] = timestep;
      request_->set_input_tensor(2U, step);
    } else {
      ov::Tensor input(ov::element::f32, shape);
      auto* destination = input.data<float>();
      fillImageChannels(first, tensorWidth, tensorHeight, destination);
      fillImageChannels(second, tensorWidth, tensorHeight,
                        destination + 3U * tensorWidth * tensorHeight);
      const auto plane = static_cast<std::size_t>(tensorWidth) * tensorHeight;
      std::fill(destination + 6U * plane, destination + 7U * plane, timestep);
      request_->set_input_tensor(0U, input);
    }
    request_->infer();
    const auto output = request_->get_output_tensor(0U);
    const auto outputShape = output.get_shape();
    if (outputShape.size() != 4U || outputShape[0] != 1U || outputShape[1] != 3U ||
        outputShape[2] < static_cast<std::size_t>(first.height) ||
        outputShape[3] < static_cast<std::size_t>(first.width))
      throw std::runtime_error("RIFE output does not preserve RGB dimensions");
    upscale::RgbFrame result{
        first.width, first.height,
        std::vector<std::uint8_t>(static_cast<std::size_t>(first.width) * first.height * 3U)};
    const auto* source = output.data<const float>();
    const auto outputPlane = outputShape[2] * outputShape[3];
    for (int y = 0; y < first.height; ++y) {
      for (int x = 0; x < first.width; ++x) {
        const auto pixel = static_cast<std::size_t>(y) * outputShape[3] + x;
        const auto destinationOffset =
            (static_cast<std::size_t>(y) * first.width + x) * 3U;
        for (int channel = 0; channel < 3; ++channel)
          result.pixels[destinationOffset + channel] =
              floatToByte(source[static_cast<std::size_t>(channel) * outputPlane + pixel]);
      }
    }
    return result;
  }

 private:
  void ensureCompiled() {
    if (compiled_) return;
    if (device_ != "CPU") {
      // Admission is deliberately above the measured UHD FP32 peak (9.80GB).
      // These counters cover our shared Core, not other processes on the GPU.
      const auto required = static_cast<std::uint64_t>(staticDimension(inputShape_, 2)) *
          static_cast<std::uint64_t>(staticDimension(inputShape_, 3)) * 1200U + (256ULL << 20U);
      const auto total = core_.get_property(device_, "GPU_DEVICE_TOTAL_MEM_SIZE").as<std::uint64_t>();
      const auto stats = core_.get_property(device_, "GPU_MEMORY_STATISTICS")
          .as<std::map<std::string, std::uint64_t>>();
      std::uint64_t used = 0;
      for (const auto* kind : {"usm_device", "usm_shared", "cl_mem", "unknown"}) {
        const auto found = stats.find(kind);
        if (found == stats.end() || found->second > std::numeric_limits<std::uint64_t>::max() - used)
          throw std::runtime_error("RIFE GPU memory statistics are unavailable");
        used += found->second;
      }
      if (total < required || used > total - required)
        throw std::runtime_error("not enough GPU memory for RIFE interpolation");
    }
    // Keep the explicit mixed-precision graph intact. A global FP16 hint also
    // converts the sensitive motion-coordinate path and is not repeatable.
    ov::AnyMap properties{
        ov::num_streams(ov::streams::Num(1)),
        ov::hint::execution_mode(ov::hint::ExecutionMode::ACCURACY),
        ov::hint::inference_precision(gpuFast_ ? ov::element::dynamic : ov::element::f32)};
    if (kernels_) properties.insert({"CONFIG_FILE", kernels_->configPath()});
    if (device_ != "CPU")
      properties.insert(ov::intel_gpu::hint::queue_throttle(
          ov::intel_gpu::hint::ThrottleLevel::LOW));
    compiled_.emplace(core_.compile_model(model_, device_, properties));
  }

  ov::Core& core_;
  std::string device_;
  std::shared_ptr<ov::Model> model_;
  ov::PartialShape inputShape_;
  bool gpuFast_ = false;
  std::optional<VerifiedKernelFiles> kernels_;
  std::optional<ov::CompiledModel> compiled_;
  std::optional<ov::InferRequest> request_;
};

std::string oneLineError(const std::exception& error) {
  std::string message = error.what();
  for (char& character : message)
    if (character == '\n' || character == '\r' || character == '\t') character = ' ';
  if (message.size() > 512U) message.resize(512U);
  return message;
}

bool looksDiscreteGpu(const std::string& fullName) {
  std::string lowerName = fullName;
  std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(),
                 [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
  return lowerName.find("arc") != std::string::npos ||
         lowerName.find("discrete") != std::string::npos ||
         lowerName.find("dg1") != std::string::npos ||
         lowerName.find("dg2") != std::string::npos ||
         lowerName.find("flex") != std::string::npos;
}

bool looksIntelGpuName(std::string fullName) {
  std::transform(fullName.begin(), fullName.end(), fullName.begin(),
                 [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
  return fullName.rfind("intel", 0U) == 0U;
}

std::string hardwareLabel(ov::Core& core, const std::string& device) {
  if (device == "CPU") return "CPU";
  try {
    const auto type = core.get_property(device, ov::device::type);
    if (type == ov::device::Type::DISCRETE) return "dGPU";
    if (type == ov::device::Type::INTEGRATED) return "iGPU";
  } catch (const ov::Exception&) {
  }
  return {};
}

void reportDevice(std::ostream& output, ov::Core& core, const char* phase,
                  const std::string& device) {
  output << "otc-upscale: " << phase << "-device=" << device;
  const auto hardware = hardwareLabel(core, device);
  if (!hardware.empty()) output << " hardware=" << hardware;
  output << '\n';
}

std::string canonicalDiscoveredDevice(const std::string& discovered) {
  if (discovered == "GPU") return "GPU.0";
  if (discovered == "CPU" || isExplicitGpu(discovered)) return discovered;
  throw std::invalid_argument("unsupported discovered device name");
}

std::vector<std::string> deviceCandidates(ov::Core& core, const std::string& requested,
                                          bool discreteOnly) {
  if (requested == "CPU") {
    if (discreteOnly) throw std::runtime_error("spatial Flash requires a discrete GPU");
    return {"CPU"};
  }
  if (isExplicitGpu(requested)) {
    if (!looksIntelGpuName(core.get_property(requested, ov::device::full_name)))
      throw std::runtime_error("AI processing requires an Intel GPU or CPU");
    if (discreteOnly && core.get_property(requested, ov::device::type) != ov::device::Type::DISCRETE)
      throw std::runtime_error("spatial Flash requires a discrete GPU");
    return {requested};
  }
  if (requested != "AUTO") throw std::invalid_argument("invalid device selection");

  std::vector<std::string> discrete;
  std::vector<std::string> otherGpu;
  std::vector<std::string> available;
  try {
    available = core.get_available_devices();
  } catch (const ov::Exception& error) {
    throw std::runtime_error("device discovery failed: " + oneLineError(error));
  }
  for (const auto& discovered : available) {
    std::string device;
    try {
      device = canonicalDiscoveredDevice(discovered);
    } catch (const std::invalid_argument&) {
      continue;
    }
    if (device == "CPU") continue;
    std::string fullName;
    try {
      fullName = core.get_property(device, ov::device::full_name);
    } catch (const ov::Exception&) {
      continue;
    }
    if (!looksIntelGpuName(fullName)) continue;
    bool isDiscrete = false;
    try {
      isDiscrete = core.get_property(device, ov::device::type) == ov::device::Type::DISCRETE;
    } catch (const ov::Exception&) {
      isDiscrete = looksDiscreteGpu(fullName);
    }
    auto& target = isDiscrete ? discrete : otherGpu;
    if (std::find(target.begin(), target.end(), device) == target.end()) target.push_back(device);
  }
  if (discreteOnly) {
    if (discrete.empty()) throw std::runtime_error("AUTO found no discrete Intel GPU");
    return discrete;
  }
  discrete.insert(discrete.end(), otherGpu.begin(), otherGpu.end());
  discrete.push_back("CPU");
  return discrete;
}

class RifeRuntime final {
 public:
  RifeRuntime(ov::Core core, const std::filesystem::path& model, std::vector<std::string> candidates,
              std::ostream& diagnostics)
      : core_(std::move(core)), owner_(readAssets(model)), assets_(model.parent_path()),
        candidates_(std::move(candidates)), diagnostics_(diagnostics) {
    const ov::Tensor weights(ov::element::u8, {owner_.binBytes()}, owner_.binData());
    model_ = core_.read_model(owner_.xml(), weights);
  }

  bool activate(int width, int height) {
    session_.reset();
    while (nextCandidate_ < candidates_.size() && stopRequested == 0) {
      const auto candidate = candidates_[nextCandidate_++];
      try {
        session_ = std::make_unique<RifeSession>(core_, model_->clone(), candidate, width, height, assets_);
        return true;
      } catch (const std::exception& error) {
        diagnostics_ << "otc-upscale: rife-device=" << candidate
                     << " failed reason=" << oneLineError(error) << '\n';
      }
    }
    return false;
  }

  void suspend() {
    if (session_) session_->suspend();
  }

  upscale::RgbFrame infer(const upscale::RgbFrame& first, const upscale::RgbFrame& second, float timestep) {
    if (!session_ && !activate(first.width, first.height))
      throw std::runtime_error("could not compile RIFE on any requested device");
    reportDevice(diagnostics_, core_, "rife", candidates_.at(nextCandidate_ - 1U));
    return session_->infer(first, second, timestep);
  }

 private:
  static ModelOwnedIr readAssets(const std::filesystem::path& path) {
    if (path.filename() != kRifeXml.name)
      throw std::invalid_argument("RIFE requires the qualified rife.xml model");
    return readModelIr(path.parent_path(), kRifeXml, kRifeBin);
  }

  ov::Core core_;
  ModelOwnedIr owner_; // Model constants must not outlive these authenticated bytes.
  std::filesystem::path assets_;
  std::shared_ptr<ov::Model> model_;
  std::vector<std::string> candidates_;
  std::size_t nextCandidate_ = 0U;
  std::unique_ptr<RifeSession> session_;
  std::ostream& diagnostics_;
};

struct InputReader final {
  const Options& options;
  std::size_t requiredFrames;
  std::size_t readCount = 0U;
  std::vector<std::uint8_t> previousSample;
  std::vector<std::uint8_t> previousOriginal{};
  std::size_t interpolationRange = 0;

  std::optional<SourceFrame> next(bool upscaleSpatial) {
    if (readCount >= requiredFrames || stopRequested != 0) return std::nullopt;
    upscale::RgbFrame original{
        options.width, options.height,
        std::vector<std::uint8_t>(checkedFrameBytes(options.width, options.height,
                                                    "source dimensions"))};
    if (!readFrame(std::cin, original.pixels)) return std::nullopt;
    const auto sample = sceneSample(original);
    double difference = 0.0;
    for (std::size_t index = 0U; index < previousSample.size(); ++index)
      difference += std::abs(static_cast<int>(sample[index]) -
                             static_cast<int>(previousSample[index])) / 255.0;
    const bool cut = !previousSample.empty() &&
                     difference / sample.size() >= kSceneCutThreshold;
    previousSample = sample;
    const auto index = static_cast<std::uint64_t>(readCount++);
    while (interpolationRange < options.interpolationRanges.size() &&
           index >= options.interpolationRanges[interpolationRange].second) ++interpolationRange;
    const bool fillDuplicates = interpolationRange < options.interpolationRanges.size() &&
                               index >= options.interpolationRanges[interpolationRange].first;
    const bool duplicate = fillDuplicates && index > options.interpolationRanges[interpolationRange].first &&
                           !cut && previousOriginal == original.pixels;
    if (fillDuplicates) previousOriginal = original.pixels;
    else previousOriginal.clear();
    upscale::RgbFrame prepared;
    if (upscaleSpatial) {
      // Flash graphs remain landscape. Rotate only the spatial input; scene
      // sampling above stays in the source coordinate system.
      auto landscape = isPortraitFlashTarget(options.outputWidth, options.outputHeight)
                           ? rotateRgb90(original, Rotation90::clockwise)
                           : std::move(original);
      prepared = resizeRgb(landscape, static_cast<int>(kFlashWidth),
                           static_cast<int>(kFlashHeight));
    } else {
      prepared = resizeRgb(original, options.outputWidth, options.outputHeight);
    }
    return SourceFrame{index, std::move(prepared), cut, duplicate};
  }

  void drain() {
    std::vector<std::uint8_t> frame(
        checkedFrameBytes(options.width, options.height, "source dimensions"));
    while (stopRequested == 0 && readFrame(std::cin, frame)) {}
  }
};

bool mayRetryRife(const Options& options) {
  return stopRequested == 0 && options.device == "AUTO";
}

upscale::RgbFrame processBaseFrame(const upscale::RgbFrame& first, const upscale::RgbFrame& second,
                              double alpha, bool allowRife, RifeRuntime* rife) {
  if (alpha <= kTimeEpsilon || alpha >= 1.0 - kTimeEpsilon || !allowRife)
    // Keep exact half-frame ties stable despite timestamp subtraction roundoff.
    return copyFrame(alpha < 0.5 - kTimeEpsilon ? first : second);
  if (!rife) throw std::runtime_error("RIFE runtime is unavailable");
  if (identicalFrames(first, second)) return copyFrame(first);
  return rife->infer(first, second, static_cast<float>(alpha));
}

class ProgressReporter final {
 public:
  explicit ProgressReporter(std::ostream& output) : output_(output) {}

  void operator()(double value) {
    if (stopRequested != 0) throw std::runtime_error("AI worker cancelled");
    if (!std::isfinite(value) || value < 0.0 || value > 1.0)
      throw std::runtime_error("Flash progress is outside [0,1]");
    if (value + 1.0e-12 < last_) throw std::runtime_error("Flash progress regressed");
    const int percent = static_cast<int>(std::floor(value * 100.0 + 1.0e-9));
    if (percent != lastPercent_ || value >= 1.0) {
      output_ << "otc-upscale: progress=" << value << '\n' << std::flush;
      lastPercent_ = percent;
    }
    last_ = value;
  }

 private:
  std::ostream& output_;
  double last_ = 0.0;
  int lastPercent_ = -1;
};

}  // namespace
}  // namespace otc::upscale

int main(int argc, char** argv) {
  using namespace otc::upscale;
  try {
    installSignalHandlers();
    if (argc == 3 && std::string_view(argv[1]) == "--verify-runtime") {
      validateFlashCacheRuntime(argv[2]);
      std::cerr << "otc-upscale: runtime-verified\n";
      return 0;
    }
    if (const auto result = runFlashPrepareCli(argc, argv, stopRequested,
                                               std::cerr, std::cerr))
      return *result;
    const auto options = parseOptions(argc, argv);
    const auto outputFrames = outputFrameCount(options.duration, options.outputFps);
    const auto requiredSourceFrames = outputFrameCount(options.duration, options.fps);
    auto clockOptions = options;
    clockOptions.fps = alignedInterpolationFps(options.fps, options.outputFps, options.duration);
    const bool needFlash = !options.spatialRanges.empty() || options.outputWidth > options.width ||
                           options.outputHeight > options.height;
    const bool needRife = requiredSourceFrames > 1 &&
        (needsRifeInterpolation(clockOptions.fps, options.outputFps) || !options.interpolationRanges.empty());

    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    std::cerr << "otc-upscale: starting\n";
    if (clockOptions.fps != options.fps)
      std::cerr << "otc-upscale: interpolation-fps=" << clockOptions.fps << '\n';
    if (!needRife && options.outputFps > options.fps + kTimeEpsilon)
      std::cerr << "otc-upscale: frame-rate-conversion=repeat\n";

    std::optional<ov::Core> core;
    if (needFlash || needRife) {
#if OTC_FLASH_EXECUTABLE_CACHE && defined(__linux__)
      // One pack-local registry prevents an ABI-compatible stock plugin from
      // winning discovery. Flash also authenticates the actual loaded library.
      const auto registry = std::filesystem::read_symlink("/proc/self/exe").parent_path() / "lib/plugins.xml";
      core.emplace(registry.string());
#else
      core.emplace();
#endif
    }
    std::unique_ptr<RifeRuntime> rife;
    if (needRife) {
      rife = std::make_unique<RifeRuntime>(
          *core, options.rifeModel, deviceCandidates(*core, options.device, false), std::cerr);
    }

    std::unique_ptr<InputReader> input;
    std::unique_ptr<SpatialRangeReader> spatial;
    if (needFlash) {
      const auto candidates = deviceCandidates(*core, options.device, true);
      if (candidates.empty()) throw std::runtime_error("no discrete GPU candidate for Flash");
      const auto flashDevice = candidates.front();
      core->set_property(flashDevice, ov::num_streams(1));
      const auto flashContext = core->get_default_context(flashDevice);
      const auto gpuBytes = core->get_property(flashDevice, "GPU_DEVICE_TOTAL_MEM_SIZE").as<std::uint64_t>();
      const bool useHostTileHistory = needRife && gpuBytes < (16ULL << 30U);
      input = std::make_unique<InputReader>(InputReader{
          options, static_cast<std::size_t>(requiredSourceFrames), 0U, {}});
      auto reader = [inputPtr = input.get()]() -> std::optional<SourceFrame> {
        if (stopRequested != 0) return std::nullopt;
        return inputPtr->next(true);
      };
      auto beforeGpu = [&, flashDevice]() {
        if (stopRequested != 0) throw std::runtime_error("AI worker cancelled");
        if (rife) rife->suspend();
        reportDevice(std::cerr, *core, "flash", flashDevice);
      };
      auto ranges = options.spatialRanges;
      if (ranges.empty()) ranges.emplace_back(0U, requiredSourceFrames);
      auto progress = std::make_shared<ProgressReporter>(std::cerr);
      spatial = std::make_unique<SpatialRangeReader>(std::move(ranges), std::move(reader),
          [&, flashContext, beforeGpu, useHostTileHistory, progress](SpatialRange range, SpatialRangeReader::Reader source) {
            auto report = [range, requiredSourceFrames, progress](double fraction) {
              (*progress)((range.first + fraction * (range.second - range.first)) / requiredSourceFrames);
            };
            auto controller = std::make_shared<FlashVideoController>(
                *core, flashContext, options.models, options.scratch, options.mode,
                range.second - range.first, std::move(source), beforeGpu, std::move(report), useHostTileHistory);
            return [controller]() { return controller->next(); };
          });
    } else {
      input = std::make_unique<InputReader>(InputReader{
          options, static_cast<std::size_t>(requiredSourceFrames), 0U, {}});
    }

    InterpolationWindow window{
        clockOptions.fps,
        [&, needFlash]() -> std::optional<SourceFrame> {
          if (needFlash) return spatial->next();
          return input->next(false);
        },
        std::nullopt, std::nullopt, false, options.outputFps};
    if (!window.initialize()) {
      if (stopRequested != 0) return 0;
      throw std::runtime_error("source ended before the requested duration");
    }

    for (std::uint64_t outputIndex = 0U;
         outputIndex < outputFrames && stopRequested == 0; ++outputIndex) {
      const double timestamp = static_cast<double>(outputIndex) / options.outputFps;
      window.ensureRight(timestamp);
      if (!window.left) throw std::runtime_error("source frame window is empty");

      RgbFrame output;
      if (!window.right) {
        output = copyFrame(window.left->frame);
      } else {
        const double leftTime = window.timestamp(window.left->index);
        const double rightTime = window.timestamp(window.right->index);
        const double interval = rightTime - leftTime;
        double alpha = interval > 0.0
                                 ? std::clamp((timestamp - leftTime) / interval, 0.0, 1.0)
                                 : 0.0;
        // A skipped duplicate run must not move the following scene cut early.
        if (window.right->cutBefore && timestamp < rightTime - kTimeEpsilon) alpha = 0.0;
        const bool allowRife = needRife && !window.right->cutBefore;
        while (true) {
          try {
            output = processBaseFrame(window.left->frame, window.right->frame, alpha,
                                      allowRife, rife.get());
            break;
          } catch (const std::exception& error) {
            if (!rife || !mayRetryRife(options)) throw;
            std::cerr << "otc-upscale: rife-retry reason=" << oneLineError(error) << '\n';
            if (!rife->activate(window.left->frame.width, window.left->frame.height))
              throw;
          }
        }
      }

      if (needFlash && isPortraitFlashTarget(options.outputWidth, options.outputHeight))
        output = rotateRgb90(output, Rotation90::counterClockwise);

      if (output.width != options.outputWidth || output.height != options.outputHeight ||
          output.pixels.size() != checkedFrameBytes(options.outputWidth, options.outputHeight,
                                                    "output dimensions"))
        throw std::runtime_error("output frame geometry differs from the requested contract");
      std::cout.write(reinterpret_cast<const char*>(output.pixels.data()),
                      static_cast<std::streamsize>(output.pixels.size()));
      if (!std::cout) throw std::runtime_error("output pipe closed");
    }

    if (stopRequested != 0) return 0;
    // The output clock may be slower than the source clock.  Consume the
    // remainder of the bounded source timeline before checking truncation;
    // this does not rewind Flash state and keeps drain/partial-frame behavior
    // identical for enhanced and passthrough paths.
    if (needFlash) {
      while (input->readCount < requiredSourceFrames && stopRequested == 0) {
        if (!spatial->next()) break;
      }
    } else {
      while (input->readCount < requiredSourceFrames && stopRequested == 0) {
        if (!input->next(false)) break;
      }
    }
    if (input->readCount < requiredSourceFrames)
      throw std::runtime_error("source ended before the requested duration");
    input->drain();
    return 0;
  } catch (const std::exception& error) {
    if (stopRequested != 0) return 0;
    std::cerr << "otc-upscale: error=" << error.what() << '\n';
    return 1;
  }
}
