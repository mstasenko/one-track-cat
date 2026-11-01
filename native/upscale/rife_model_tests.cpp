#include "rife_model.hpp"

#include <openvino/opsets/opset13.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using namespace ov::opset13;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

template <class Action>
void expectRejected(Action&& action, const std::string& label) {
  try {
    action();
  } catch (const std::exception&) {
    return;
  }
  throw std::runtime_error(label + ": malformed model was accepted");
}

std::shared_ptr<ov::opset13::Constant> identityGrid(std::size_t height,
                                                     std::size_t width) {
  std::vector<float> values(height * width * 2U);
  for (std::size_t y = 0; y < height; ++y) {
    for (std::size_t x = 0; x < width; ++x) {
      const auto pixel = (y * width + x) * 2U;
      values[pixel] = width == 1U
          ? 0.0F
          : 2.0F * static_cast<float>(x) / static_cast<float>(width - 1U) - 1.0F;
      values[pixel + 1U] = height == 1U
          ? 0.0F
          : 2.0F * static_cast<float>(y) / static_cast<float>(height - 1U) - 1.0F;
    }
  }
  return Constant::create(ov::element::f32, {1U, height, width, 2U}, values);
}

std::shared_ptr<ov::Model> syntheticModel(
    std::size_t height, std::size_t width, std::size_t warpCount = 5U,
    GridSample::Attributes attributes =
        GridSample::Attributes(true, GridSample::InterpolationMode::BILINEAR,
                               GridSample::PaddingMode::BORDER),
    const ov::element::Type& dataType = ov::element::f32, bool withBody = true) {
  auto input = std::make_shared<Parameter>(dataType,
                                            ov::Shape{1U, 7U, height, width});
  input->set_friendly_name("packed7");
  auto value = input->output(0);
  const auto grid = identityGrid(height, width);
  for (std::size_t index = 0; index < warpCount; ++index) {
    auto warp = std::make_shared<GridSample>(value, grid, attributes);
    warp->set_friendly_name("/warp" + std::to_string(index));
    value = warp->output(0);
  }

  if (!withBody) {
    return std::make_shared<ov::Model>(ov::OutputVector{value},
                                       ov::ParameterVector{input}, "rife_fixture");
  }

  // The weights select first-frame R, second-frame G, and timestep from the
  // packed seven-channel input.  The deconvolution is an identity 1x1 stage.
  std::vector<float> convolutionWeights(3U * 7U, 0.0F);
  convolutionWeights[0U * 7U + 0U] = 1.0F;
  convolutionWeights[1U * 7U + 4U] = 1.0F;
  convolutionWeights[2U * 7U + 6U] = 1.0F;
  auto convWeights = Constant::create(ov::element::f32, {3U, 7U, 1U, 1U},
                                      convolutionWeights);
  auto convolution = std::make_shared<Convolution>(
      value, convWeights, ov::Strides{1U, 1U}, ov::CoordinateDiff{0, 0},
      ov::CoordinateDiff{0, 0}, ov::Strides{1U, 1U}, ov::op::PadType::EXPLICIT);
  convolution->set_friendly_name("/encode/conv");

  std::vector<float> deconvolutionWeights(3U * 3U, 0.0F);
  for (std::size_t channel = 0; channel < 3U; ++channel)
    deconvolutionWeights[channel * 3U + channel] = 1.0F;
  auto deconvWeights = Constant::create(ov::element::f32, {3U, 3U, 1U, 1U},
                                        deconvolutionWeights);
  auto deconvolution = std::make_shared<ConvolutionBackpropData>(
      convolution, deconvWeights, ov::Strides{1U, 1U}, ov::CoordinateDiff{0, 0},
      ov::CoordinateDiff{0, 0}, ov::Strides{1U, 1U}, ov::op::PadType::EXPLICIT);
  deconvolution->set_friendly_name("/encode/deconv");

  auto slope = Constant::create(ov::element::f32, {1U, 3U, 1U, 1U},
                                std::vector<float>{1.0F, 1.0F, 1.0F});
  auto prelu = std::make_shared<PRelu>(deconvolution, slope);
  prelu->set_friendly_name("/block0/prelu");
  auto zero = Constant::create(ov::element::f32, {1U, 3U, 1U, 1U},
                               std::vector<float>{0.0F, 0.0F, 0.0F});
  auto add = std::make_shared<Add>(prelu, zero);
  add->set_friendly_name("/block0/add");
  auto depthToSpace = std::make_shared<DepthToSpace>(
      add, DepthToSpace::DepthToSpaceMode::BLOCKS_FIRST, 1U);
  depthToSpace->set_friendly_name("/block0/depth_to_space");

  return std::make_shared<ov::Model>(ov::OutputVector{depthToSpace->output(0)},
                                     ov::ParameterVector{input}, "rife_fixture");
}

std::shared_ptr<ov::Model> outputFixture(const std::vector<float>& values,
                                         std::size_t height = 1U) {
  require(height > 0U && values.size() >= 3U * height &&
              values.size() % (3U * height) == 0U,
          "RIFE output fixture requires three packed channels");
  const auto width = values.size() / (3U * height);
  auto input = std::make_shared<Parameter>(ov::element::f32,
                                            ov::Shape{1U, 3U, height, width});
  return std::make_shared<ov::Model>(ov::OutputVector{input->output(0)},
                                     ov::ParameterVector{input}, "rife_output_fixture");
}

float roundingBoundary(std::size_t value) {
  const double boundary = (static_cast<double>(value) - 0.5) / 255.0;
  auto threshold = static_cast<float>(boundary);
  if (static_cast<double>(threshold) < boundary)
    threshold = std::nextafter(threshold, std::numeric_limits<float>::infinity());
  return threshold;
}

std::uint8_t expectedOutputByte(float value) {
  if (!std::isfinite(value)) return 0U;
  const auto scaled = std::clamp(static_cast<double>(value) * 255.0, 0.0, 255.0);
  return static_cast<std::uint8_t>(scaled + 0.5);
}

void checkModelAbi(const ov::Model& model, std::size_t height, std::size_t width) {
  require(model.inputs().size() == 3U, "packed RIFE model must have three inputs");
  require(model.outputs().size() == 1U, "packed RIFE model must have one output");
  const auto expectedImageShape = ov::PartialShape{
      1U, static_cast<std::int64_t>(height), static_cast<std::int64_t>(width), 3U};
  require(model.input(0U).get_element_type() == ov::element::u8 &&
              model.input(0U).get_partial_shape() == expectedImageShape,
          "first packed image input ABI differs");
  require(model.input(1U).get_element_type() == ov::element::u8 &&
              model.input(1U).get_partial_shape() == expectedImageShape,
          "second packed image input ABI differs");
  require(model.input(2U).get_element_type() == ov::element::f32 &&
              model.input(2U).get_partial_shape().rank().is_static() &&
              model.input(2U).get_partial_shape().rank().get_length() == 0,
          "timestep input ABI differs");
  require(model.output(0U).get_element_type() == ov::element::f32 &&
              model.output(0U).get_partial_shape() ==
                  ov::PartialShape{1U, 3U, static_cast<std::int64_t>(height),
                                   static_cast<std::int64_t>(width)},
          "packed RIFE output ABI differs");
}

void checkMixedPrecisionGraph(const ov::Model& model) {
  std::size_t warps = 0U;
  std::size_t mixedNodes = 0U;
  for (const auto& node : model.get_ordered_ops()) {
    const std::string type = node->get_type_name();
    if (const auto warp = ov::as_type_ptr<GridSample>(node)) {
      ++warps;
      require(warp->get_input_element_type(0U) == ov::element::f32 &&
                  warp->get_input_element_type(1U) == ov::element::f32 &&
                  warp->get_output_element_type(0U) == ov::element::f32,
              "warp data or coordinates were narrowed");
      continue;
    }

    const bool shouldBeHalf = type == "Convolution" ||
                              type == "ConvolutionBackpropData" ||
                              type == "PRelu" || type == "Add" ||
                              type == "DepthToSpace";
    if (!shouldBeHalf) continue;
    ++mixedNodes;
    for (std::size_t index = 0; index < node->get_input_size(); ++index)
      require(node->input_value(index).get_element_type() == ov::element::f16,
              type + " input is not FP16");
    require(node->get_output_element_type(0U) == ov::element::f16,
            type + " output is not FP16");
    bool restored = false;
    for (const auto& user : node->get_users()) {
      if (std::string(user->get_type_name()) == "Convert" &&
          user->get_output_element_type(0U) == ov::element::f32 &&
          user->input_value(0U).get_node_shared_ptr() == node) {
        restored = true;
        break;
      }
    }
    require(restored, type + " is not restored to FP32");
  }
  require(warps == 5U, "transformed fixture warp count differs");
  require(mixedNodes == 5U,
          "expected Conv/deconv/block mixed-precision nodes missing: " +
              std::to_string(mixedNodes));
}

void checkCpuPacking(std::size_t height, std::size_t width) {
  auto model = otc::upscale::rifeGpuModel(
      syntheticModel(height, width), static_cast<int>(width),
      static_cast<int>(height));
  checkModelAbi(*model, height, width);
  checkMixedPrecisionGraph(*model);

  std::vector<std::uint8_t> first(height * width * 3U);
  std::vector<std::uint8_t> second(height * width * 3U);
  for (std::size_t index = 0; index < first.size(); ++index) {
    first[index] = static_cast<std::uint8_t>((index * 17U + 3U) % 251U);
    second[index] = static_cast<std::uint8_t>((index * 31U + 11U) % 251U);
  }
  constexpr float timestep = 0.375F;

  ov::Core core;
  auto compiled = core.compile_model(model, "CPU");
  auto request = compiled.create_infer_request();
  const ov::Shape imageShape{1U, height, width, 3U};
  request.set_input_tensor(0U,
                           ov::Tensor(ov::element::u8, imageShape, first.data()));
  request.set_input_tensor(1U,
                           ov::Tensor(ov::element::u8, imageShape, second.data()));
  ov::Tensor step(ov::element::f32, {});
  step.data<float>()[0] = timestep;
  request.set_input_tensor(2U, step);
  request.infer();

  const auto output = request.get_output_tensor(0U);
  require(output.get_shape() == ov::Shape{1U, 3U, height, width},
          "CPU fixture output shape differs");
  const auto* values = output.data<const float>();
  const auto plane = height * width;
  for (std::size_t y = 0; y < height; ++y) {
    for (std::size_t x = 0; x < width; ++x) {
      const auto source = (y * width + x) * 3U;
      const auto pixel = y * width + x;
      const float expected[] = {
          static_cast<float>(first[source]) / 255.0F,
          static_cast<float>(second[source + 1U]) / 255.0F,
          timestep,
      };
      for (std::size_t channel = 0; channel < 3U; ++channel) {
        require(std::isfinite(values[channel * plane + pixel]) &&
                    std::fabs(values[channel * plane + pixel] - expected[channel]) < 0.003F,
                "CPU packed image normalization or timestep value differs");
      }
    }
  }
}

void checkGpuOutputConversion() {
  std::vector<float> samples{0.0F,
                             std::nextafter(0.0F, 1.0F),
                             std::nextafter(0.0F, -1.0F)};
  for (std::size_t value = 1U; value <= 255U; ++value) {
    const auto threshold = roundingBoundary(value);
    samples.push_back(threshold);
    samples.push_back(std::nextafter(threshold, -std::numeric_limits<float>::infinity()));
    samples.push_back(std::nextafter(threshold, std::numeric_limits<float>::infinity()));
  }
  samples.insert(samples.end(), {-1.0F, 2.0F,
                                 std::numeric_limits<float>::quiet_NaN(),
                                 std::numeric_limits<float>::infinity(),
                                 -std::numeric_limits<float>::infinity()});

  constexpr std::size_t height = 2U;
  samples.push_back(0.375F);
  const auto width = samples.size();
  require(width % height == 0U, "RIFE finite-mask fixture requires even sample count");
  const auto rowWidth = width / height;
  const auto plane = height * rowWidth;
  std::vector<float> input(plane * 3U);
  for (std::size_t y = 0U; y < height; ++y) {
    for (std::size_t x = 0U; x < rowWidth; ++x) {
      const auto pixel = y * rowWidth + x;
      input[pixel] = samples[pixel];
      input[plane + pixel] = static_cast<float>((pixel % 9U) + 1U) / 10.0F;
      input[2U * plane + pixel] = static_cast<float>(8U - (pixel % 9U)) / 10.0F;
    }
  }

  ov::Core core;
  auto model = otc::upscale::rifeGpuOutputModel(outputFixture(input, height), rowWidth, height);
  require(model->outputs().size() == 2U, "RIFE GPU output model result count differs");
  require(model->output(0U).get_element_type() == ov::element::u8 &&
              model->output(0U).get_partial_shape() ==
                  ov::PartialShape{1U, static_cast<std::int64_t>(height),
                                   static_cast<std::int64_t>(rowWidth), 3U},
          "RIFE GPU output byte ABI differs");
  require(model->output(1U).get_element_type() == ov::element::boolean &&
              model->output(1U).get_partial_shape() ==
                  ov::PartialShape{1U, 3U, static_cast<std::int64_t>(height)},
          "RIFE GPU finite mask ABI differs");

  auto compiled = core.compile_model(model, "CPU");
  auto request = compiled.create_infer_request();
  request.set_input_tensor(0U, ov::Tensor(ov::element::f32,
                                           ov::Shape{1U, 3U, height, rowWidth}, input.data()));
  request.infer();

  const auto bytes = request.get_output_tensor(0U);
  require(bytes.get_shape() == ov::Shape{1U, height, rowWidth, 3U},
          "RIFE GPU output byte shape differs at runtime");
  const auto* output = bytes.data<const std::uint8_t>();
  for (std::size_t y = 0U; y < height; ++y) {
    for (std::size_t x = 0U; x < rowWidth; ++x) {
      const auto pixel = y * rowWidth + x;
      for (std::size_t channel = 0U; channel < 3U; ++channel) {
        const auto expected = expectedOutputByte(input[channel * plane + pixel]);
        require(output[pixel * 3U + channel] == expected,
                "RIFE GPU output conversion differs from the CPU byte contract");
      }
    }
  }
  const auto finiteMask = request.get_output_tensor(1U);
  require(finiteMask.get_shape() == ov::Shape{1U, 3U, height},
          "RIFE GPU finite mask shape differs at runtime");
  const auto* finite = finiteMask.data<const char>();
  for (std::size_t channel = 0U; channel < 3U; ++channel) {
    for (std::size_t y = 0U; y < height; ++y) {
      bool expectedFinite = true;
      for (std::size_t x = 0U; x < rowWidth; ++x)
        expectedFinite &= std::isfinite(input[channel * plane + y * rowWidth + x]);
      const auto row = channel * height + y;
      require((finite[row] != 0) == expectedFinite,
              "RIFE GPU finite mask differs at channel-row " + std::to_string(row));
    }
  }

  std::vector<float> validInput{0.0F, 0.5F, 1.0F,
                                0.25F, 0.75F, 1.25F,
                                -0.25F, 0.125F, 0.875F};
  auto validModel = otc::upscale::rifeGpuOutputModel(outputFixture(validInput), 3, 1);
  auto validCompiled = core.compile_model(validModel, "CPU");
  auto validRequest = validCompiled.create_infer_request();
  validRequest.set_input_tensor(0U, ov::Tensor(ov::element::f32,
                                                ov::Shape{1U, 3U, 1U, 3U},
                                                validInput.data()));
  validRequest.infer();
  const auto validFiniteMask = validRequest.get_output_tensor(1U);
  require(validFiniteMask.get_shape() == ov::Shape{1U, 3U, 1U},
          "RIFE GPU finite mask valid shape differs at runtime");
  const auto* validFinite = validFiniteMask.data<const char>();
  for (std::size_t channel = 0U; channel < 3U; ++channel)
    require(validFinite[channel] != 0,
            "RIFE GPU finite mask rejected finite out-of-range row");
}

void checkGpuOutputCrop() {
  constexpr std::size_t paddedHeight = 2U;
  constexpr std::size_t paddedWidth = 3U;
  constexpr std::size_t requestedHeight = 1U;
  constexpr std::size_t requestedWidth = 2U;
  const auto plane = paddedHeight * paddedWidth;
  std::vector<float> input(3U * plane, 0.0F);
  input[0U] = 0.1F;
  input[1U] = 0.2F;
  input[2U] = std::numeric_limits<float>::infinity(); // outside visible width
  input[3U] = 0.3F;
  input[4U] = 0.4F;
  input[5U] = std::numeric_limits<float>::quiet_NaN(); // outside visible height
  input[plane + 0U] = 0.5F;
  input[plane + 1U] = 0.6F;
  input[2U * plane + 0U] = 0.7F;
  input[2U * plane + 1U] = 0.8F;

  ov::Core core;
  auto model = otc::upscale::rifeGpuOutputModel(
      outputFixture(input, paddedHeight), requestedWidth, requestedHeight);
  auto compiled = core.compile_model(model, "CPU");
  auto request = compiled.create_infer_request();
  request.set_input_tensor(0U, ov::Tensor(ov::element::f32,
                                           ov::Shape{1U, 3U, paddedHeight, paddedWidth},
                                           input.data()));
  request.infer();

  const auto bytes = request.get_output_tensor(0U);
  require(bytes.get_shape() == ov::Shape{1U, requestedHeight, requestedWidth, 3U},
          "RIFE GPU crop output shape differs");
  const auto* output = bytes.data<const std::uint8_t>();
  for (std::size_t channel = 0U; channel < 3U; ++channel)
    for (std::size_t x = 0U; x < requestedWidth; ++x)
      require(output[x * 3U + channel] == expectedOutputByte(input[channel * plane + x]),
              "RIFE GPU crop changed top-left RGB bytes");

  const auto finite = request.get_output_tensor(1U);
  require(finite.get_shape() == ov::Shape{1U, 3U, requestedHeight},
          "RIFE GPU crop finite mask shape differs");
  const auto* finiteValues = finite.data<const char>();
  for (std::size_t channel = 0U; channel < 3U; ++channel)
    require(finiteValues[channel] != 0,
            "RIFE GPU crop propagated nonfinite padded pixels");
}

void checkInvalidModels() {
  const std::size_t height = 2U, width = 3U;
  const auto validAttributes = GridSample::Attributes(
      true, GridSample::InterpolationMode::BILINEAR,
      GridSample::PaddingMode::BORDER);

  const std::vector<std::pair<std::string, GridSample::Attributes>> wrongAttributes{
      {"wrong GridSample interpolation", GridSample::Attributes(
          true, GridSample::InterpolationMode::NEAREST,
          GridSample::PaddingMode::BORDER)},
      {"wrong GridSample padding", GridSample::Attributes(
          true, GridSample::InterpolationMode::BILINEAR,
          GridSample::PaddingMode::ZEROS)},
      {"wrong GridSample alignment", GridSample::Attributes(
          false, GridSample::InterpolationMode::BILINEAR,
          GridSample::PaddingMode::BORDER)},
  };
  for (const auto& [label, attributes] : wrongAttributes) {
    expectRejected(
        [&] {
          (void)otc::upscale::rifeGpuModel(
              syntheticModel(height, width, 5U, attributes, ov::element::f32,
                             false),
              static_cast<int>(width), static_cast<int>(height));
        },
        label);
  }

  expectRejected(
      [&] {
        (void)otc::upscale::rifeGpuModel(
            syntheticModel(height, width, 4U, validAttributes, ov::element::f32,
                           false),
            static_cast<int>(width), static_cast<int>(height));
      },
      "wrong GridSample count");

  expectRejected(
      [&] {
        (void)otc::upscale::rifeGpuModel(
            syntheticModel(height, width, 5U, validAttributes, ov::element::f16,
                           false),
            static_cast<int>(width), static_cast<int>(height));
      },
      "non-FP32 GridSample data");
}

}  // namespace

int main() {
  try {
    checkCpuPacking(2U, 3U);
    checkCpuPacking(3U, 4U);
    checkGpuOutputConversion();
    checkGpuOutputCrop();
    checkInvalidModels();
    std::cout << "rife_model_tests=pass cpu_only=1 gpu_calls=0\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "rife_model_tests: " << error.what() << '\n';
    return 1;
  }
}
