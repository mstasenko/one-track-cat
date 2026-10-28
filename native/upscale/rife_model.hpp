#pragma once

#include <openvino/openvino.hpp>
#include <openvino/opsets/opset13.hpp>
#include <stdexcept>

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

}  // namespace otc::upscale
