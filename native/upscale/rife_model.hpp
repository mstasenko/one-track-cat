#pragma once

#include <openvino/openvino.hpp>
#include <openvino/op/result.hpp>
#include <openvino/opsets/opset13.hpp>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

namespace otc::upscale {

// This optimization is only for the authenticated packed-7 RIFE model. Its
// normalized motion coordinates and warps must remain FP32: globally selecting
// FP16 produces non-repeatable UHD results in the pinned GPU runtime.
inline std::shared_ptr<ov::Model> rifeGpuModel(std::shared_ptr<ov::Model> model,
                                              int width, int height) {
  using namespace ov::opset13;
  std::size_t warps = 0;
  for (const auto& node : model->get_ordered_ops()) {
    if (const auto warp = ov::as_type_ptr<GridSample>(node)) {
      const auto attributes = warp->get_attributes();
      if (attributes.mode != GridSample::InterpolationMode::BILINEAR ||
          attributes.padding_mode != GridSample::PaddingMode::BORDER || !attributes.align_corners ||
          warp->get_input_element_type(0) != ov::element::f32 ||
          warp->get_input_element_type(1) != ov::element::f32)
        throw std::runtime_error("RIFE warp differs from the qualified FP32 bilinear model");
      ++warps;
    }
    const std::string type = node->get_type_name(), name = node->get_friendly_name();
    const bool block = name.find("/block") != std::string::npos || name.find("/encode/") != std::string::npos;
    if (type != "Convolution" && type != "ConvolutionBackpropData" &&
        !(block && (type == "PRelu" || type == "Add" || type == "DepthToSpace"))) continue;
    ov::OutputVector inputs;
    for (const auto& input : node->input_values())
      inputs.push_back(std::make_shared<Convert>(input, ov::element::f16));
    const auto half = node->clone_with_new_inputs(inputs);
    ov::replace_node(node, std::make_shared<Convert>(half, ov::element::f32));
  }
  if (warps != 5) throw std::runtime_error("RIFE warp count differs from the qualified model");

  // Transfer the original RGB bytes, not a CPU-built 7-plane FP32 tensor.
  // Both images remain caller-owned until synchronous inference completes.
  const ov::Shape shape{1U, static_cast<std::size_t>(height), static_cast<std::size_t>(width), 3U};
  auto first = std::make_shared<Parameter>(ov::element::u8, shape);
  auto second = std::make_shared<Parameter>(ov::element::u8, shape);
  auto step = std::make_shared<Parameter>(ov::element::f32, ov::Shape{});
  const auto planes = [](const std::shared_ptr<Parameter>& input) -> ov::Output<ov::Node> {
    auto values = std::make_shared<Convert>(input, ov::element::f32);
    auto order = Constant::create(ov::element::i64, {4}, {0, 3, 1, 2});
    auto transposed = std::make_shared<Transpose>(values, order);
    return std::make_shared<Divide>(transposed, Constant::create(ov::element::f32, {}, {255.f}));
  };
  auto time = std::make_shared<Broadcast>(step,
      Constant::create(ov::element::i64, {4}, {1, 1, height, width}));
  auto packed = std::make_shared<Concat>(ov::OutputVector{planes(first), planes(second), time}, 1);
  model->get_parameters().at(0)->output(0).replace(packed->output(0));
  return std::make_shared<ov::Model>(model->outputs(), ov::ParameterVector{first, second, step});
}

// Keep byte conversion on the device while matching the worker's double-based
// clamp/round/truncate contract.  The threshold table corrects f32 multiply
// and add rounding at the half-byte boundaries.
inline std::shared_ptr<ov::Model> rifeGpuOutputModel(std::shared_ptr<ov::Model> model,
                                                    int width, int height) {
  using namespace ov::opset13;
  if (!model || model->outputs().size() != 1U)
    throw std::invalid_argument("RIFE GPU output model requires one result");
  if (width <= 0 || height <= 0)
    throw std::invalid_argument("RIFE GPU output crop dimensions must be positive");
  const auto sourceResult = std::dynamic_pointer_cast<ov::op::v0::Result>(
      model->output(0U).get_node_shared_ptr());
  const auto source = sourceResult ? sourceResult->input_value(0U) : model->output(0U);
  const auto sourceShape = source.get_partial_shape();
  if (source.get_element_type() != ov::element::f32 || sourceShape.rank().is_dynamic() ||
      sourceShape.rank().get_length() != 4)
    throw std::invalid_argument("RIFE GPU output must be static-rank FP32 NCHW");
  if ((sourceShape[2].is_static() && sourceShape[2].get_length() < height) ||
      (sourceShape[3].is_static() && sourceShape[3].get_length() < width))
    throw std::invalid_argument("RIFE GPU output is smaller than the requested crop");

  // Match the CPU path's top-left crop before checking finiteness or
  // converting bytes; invalid padded pixels must not poison the visible frame.
  const auto cropped = std::make_shared<Slice>(
      source,
      Constant::create(ov::element::i64, {2}, {0, 0}),
      Constant::create(ov::element::i64, {2}, {height, width}),
      Constant::create(ov::element::i64, {2}, {1, 1}),
      Constant::create(ov::element::i64, {2}, {2, 3}));

  // IsFinite rejects subnormals in the pinned CPU plugin; this comparison
  // accepts them while still rejecting NaN and infinity.
  const auto finite = std::make_shared<LessEqual>(std::make_shared<Abs>(cropped),
      Constant::create(ov::element::f32, {}, {std::numeric_limits<float>::max()}));
  const auto zero = Constant::create(ov::element::f32, {}, {0.0F});
  const auto one = Constant::create(ov::element::f32, {}, {1.0F});
  const auto clean = std::make_shared<Minimum>(
      std::make_shared<Maximum>(std::make_shared<Select>(finite, cropped, zero), zero), one);
  const auto rounded = std::make_shared<Floor>(std::make_shared<Add>(
      std::make_shared<Multiply>(clean,
                                 Constant::create(ov::element::f32, {}, {255.0F})),
      Constant::create(ov::element::f32, {}, {0.5F})));
  const auto quantized = std::make_shared<Convert>(rounded, ov::element::i32);

  std::vector<float> thresholds(256U, 0.0F);
  for (std::size_t value = 1U; value < thresholds.size(); ++value) {
    const double boundary = (static_cast<double>(value) - 0.5) / 255.0;
    auto threshold = static_cast<float>(boundary);
    if (static_cast<double>(threshold) < boundary)
      threshold = std::nextafter(threshold, std::numeric_limits<float>::infinity());
    thresholds[value] = threshold;
  }
  const auto thresholdAtQuantized = std::make_shared<Gather>(
      Constant::create(ov::element::f32, {thresholds.size()}, thresholds), quantized,
      Constant::create(ov::element::i64, {}, {0}));
  const auto corrected = std::make_shared<Subtract>(
      quantized, std::make_shared<Convert>(
                     std::make_shared<Less>(clean, thresholdAtQuantized),
                     ov::element::i32));
  const auto nhwc = std::make_shared<Transpose>(
      std::make_shared<Convert>(corrected, ov::element::u8),
      Constant::create(ov::element::i64, {4}, {0, 2, 3, 1}));
  auto output = std::make_shared<Result>(nhwc);
  // Reduce independent rows, not the whole UHD image into one serial GPU reduction.
  auto finiteOutput = std::make_shared<Result>(std::make_shared<ReduceLogicalAnd>(
      finite, Constant::create(ov::element::i64, {1}, {3}), false));
  output->set_friendly_name("rife_u8_output");
  finiteOutput->set_friendly_name("finite_mask");
  output->output(0).get_tensor().set_names({"rife_u8_output"});
  finiteOutput->output(0).get_tensor().set_names({"finite_mask"});
  return std::make_shared<ov::Model>(ov::ResultVector{output, finiteOutput},
                                     model->get_parameters(), "rife_gpu_output");
}

}  // namespace otc::upscale
