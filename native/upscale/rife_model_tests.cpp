#include "rife_model.hpp"

#include <openvino/opsets/opset13.hpp>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iostream>
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
    checkInvalidModels();
    std::cout << "rife_model_tests=pass cpu_only=1 gpu_calls=0\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "rife_model_tests: " << error.what() << '\n';
    return 1;
  }
}
