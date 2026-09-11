#include "retinaface.hpp"
#include "resize_bgr.hpp"

#include <openvino/openvino.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

namespace otc::face {

namespace {

constexpr int modelSize = faceModelSize;
constexpr std::array<int, 3> strides{8, 16, 32};
constexpr std::array<std::array<int, 2>, 3> minimumSizes{{{{16, 32}}, {{64, 128}}, {{256, 512}}}};

std::string lower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return text;
}

bool discreteGpuName(const std::string& fullName) {
  const std::string name = lower(fullName);
  return name.find("arc") != std::string::npos || name.find("dg1") != std::string::npos ||
         name.find("dg2") != std::string::npos || name.find("discrete") != std::string::npos ||
         name.find("flex") != std::string::npos;
}

std::vector<RetinaFaceDetector::Anchor> makeAnchors() {
  std::vector<RetinaFaceDetector::Anchor> anchors;
  anchors.reserve(16800U);
  for (std::size_t level = 0; level < strides.size(); ++level) {
    const int featureSize = modelSize / strides[level];
    for (int y = 0; y < featureSize; ++y) {
      for (int x = 0; x < featureSize; ++x) {
        for (int minimumSize : minimumSizes[level]) {
          anchors.push_back({(static_cast<float>(x) + 0.5F) * static_cast<float>(strides[level]) /
                                 static_cast<float>(modelSize),
                             (static_cast<float>(y) + 0.5F) * static_cast<float>(strides[level]) /
                                 static_cast<float>(modelSize),
                             static_cast<float>(minimumSize) / static_cast<float>(modelSize),
                             static_cast<float>(minimumSize) / static_cast<float>(modelSize)});
        }
      }
    }
  }
  return anchors;
}

std::vector<Detection> decodeDetections(
    ov::Tensor& bboxTensor,
    ov::Tensor& scoreTensor,
    const std::vector<RetinaFaceDetector::Anchor>& anchors,
    int width,
    int height,
    float scoreThreshold) {
  if (bboxTensor.get_element_type() != ov::element::f32 || scoreTensor.get_element_type() != ov::element::f32 ||
      bboxTensor.get_size() < anchors.size() * 4U || scoreTensor.get_size() < anchors.size() * 2U) {
    throw std::runtime_error("RetinaFace outputs have an unexpected type or shape");
  }
  const float* boxes = bboxTensor.data<float>();
  const float* scores = scoreTensor.data<float>();
  std::vector<Detection> detections;
  detections.reserve(256U);
  for (std::size_t index = 0; index < anchors.size(); ++index) {
    const float score = scores[index * 2U + 1U];
    if (!std::isfinite(score) || score < scoreThreshold) continue;
    const RetinaFaceDetector::Anchor& anchor = anchors[index];
    const float centerX = anchor.centerX + boxes[index * 4U] * 0.1F * anchor.width;
    const float centerY = anchor.centerY + boxes[index * 4U + 1U] * 0.1F * anchor.height;
    const float boxWidth = anchor.width * std::exp(std::clamp(boxes[index * 4U + 2U] * 0.2F, -10.0F, 10.0F));
    const float boxHeight = anchor.height * std::exp(std::clamp(boxes[index * 4U + 3U] * 0.2F, -10.0F, 10.0F));
    const Box box{(centerX - boxWidth * 0.5F) * static_cast<float>(width),
                  (centerY - boxHeight * 0.5F) * static_cast<float>(height),
                  (centerX + boxWidth * 0.5F) * static_cast<float>(width),
                  (centerY + boxHeight * 0.5F) * static_cast<float>(height)};
    const Box clipped = clipBox(box, width, height);
    if (validBox(clipped)) detections.push_back({clipped, score});
  }
  return detections;
}

void copyRegion(const std::vector<std::uint8_t>& frame,
                int frameWidth,
                const Region& region,
                std::vector<std::uint8_t>& tile) {
  const std::size_t rowBytes = static_cast<std::size_t>(region.width) * 3U;
  tile.resize(static_cast<std::size_t>(region.width) * static_cast<std::size_t>(region.height) * 3U);
  for (int y = 0; y < region.height; ++y) {
    const std::size_t source =
        (static_cast<std::size_t>(region.y + y) * static_cast<std::size_t>(frameWidth) +
         static_cast<std::size_t>(region.x)) * 3U;
    const std::size_t destination = static_cast<std::size_t>(y) * rowBytes;
    std::copy_n(frame.data() + source, rowBytes, tile.data() + destination);
  }
}

ov::Output<const ov::Node> findOutput(const std::vector<ov::Output<const ov::Node>>& outputs,
                                       const std::string& suffix) {
  for (const auto& output : outputs) {
    for (const auto& name : output.get_names()) {
      if (name == suffix || name.find(suffix) != std::string::npos) return output;
    }
  }
  throw std::runtime_error("RetinaFace model is missing output " + suffix);
}

void requireOutputShape(const ov::Output<const ov::Node>& output,
                        std::size_t anchorCount,
                        std::size_t channels,
                        const char* label) {
  const ov::Shape shape = output.get_shape();
  if (shape.size() != 3U || shape[0] != 1U || shape[1] != anchorCount || shape[2] != channels) {
    throw std::runtime_error(std::string("RetinaFace output has unexpected shape: ") + label);
  }
}

ov::CompiledModel compileModel(ov::Core& core,
                               const std::filesystem::path& modelXml,
                               const std::string& device) {
  core.set_property(device, ov::num_streams(1));
  if (device == "CPU") {
    core.set_property("CPU", ov::inference_num_threads(4));
  }
  return core.compile_model(core.read_model(modelXml.string()), device);
}

}  // namespace

class RetinaFaceDetector::Impl {
 public:
  Impl(const std::filesystem::path& modelXml, const std::string& device)
      : core(), compiled(compileModel(core, modelXml, device)),
        request(compiled.create_infer_request()), anchors(makeAnchors()), deviceName(device) {
    if (compiled.inputs().size() != 1U) throw std::runtime_error("RetinaFace model must have one input");
    const auto inputShape = compiled.input().get_shape();
    if (inputShape.size() != 4U || inputShape[0] != 1U || inputShape[1] != 3U ||
        inputShape[2] != modelSize || inputShape[3] != modelSize) {
      throw std::runtime_error("RetinaFace model input must be 1x3x640x640");
    }
    if (compiled.input().get_element_type() != ov::element::f32) {
      throw std::runtime_error("RetinaFace model input must use f32");
    }
    inputTensors[0] = request.get_input_tensor();
    if (deviceName.rfind("GPU", 0U) == 0U) {
      inputTensors[1] = ov::Tensor(ov::element::f32, inputShape);
    }
    bboxOutput = findOutput(compiled.outputs(), "face_rpn_bbox_pred");
    scoreOutput = findOutput(compiled.outputs(), "face_rpn_cls_prob");
    const ov::Output<const ov::Node> landmarkOutput = findOutput(compiled.outputs(), "face_rpn_landmark_pred");
    requireOutputShape(bboxOutput, anchors.size(), 4U, "face_rpn_bbox_pred");
    requireOutputShape(scoreOutput, anchors.size(), 2U, "face_rpn_cls_prob");
    requireOutputShape(landmarkOutput, anchors.size(), 10U, "face_rpn_landmark_pred");
  }

  ov::Core core;
  ov::CompiledModel compiled;
  ov::InferRequest request;
  std::vector<Anchor> anchors;
  std::string deviceName;
  std::array<ov::Tensor, 2> inputTensors;
  ov::Output<const ov::Node> bboxOutput;
  ov::Output<const ov::Node> scoreOutput;
};

std::vector<std::string> openVinoDeviceCandidates(const std::string& requested) {
  if (requested == "CPU") return {"CPU"};
  if (requested != "AUTO") throw std::runtime_error("--device must be CPU or AUTO");
  ov::Core core;
  std::vector<std::string> discrete;
  std::vector<std::string> integrated;
  std::vector<std::string> available;
  try {
    available = core.get_available_devices();
  } catch (const ov::Exception&) {
    return {"CPU"};
  }
  for (const std::string& device : available) {
    if (device.rfind("GPU", 0U) != 0U) continue;
    std::string name;
    bool hasDeviceType = false;
    bool isDiscrete = false;
    try {
      name = core.get_property(device, ov::device::full_name);
    } catch (const ov::Exception&) {
      name = device;
    }
    try {
      isDiscrete = core.get_property(device, ov::device::type) == ov::device::Type::DISCRETE;
      hasDeviceType = true;
    } catch (const ov::Exception&) {
      hasDeviceType = false;
    }
    (hasDeviceType ? (isDiscrete ? discrete : integrated) : (discreteGpuName(name) ? discrete : integrated)).push_back(device);
  }
  std::vector<std::string> result;
  result.insert(result.end(), discrete.begin(), discrete.end());
  result.insert(result.end(), integrated.begin(), integrated.end());
  result.push_back("CPU");
  return result;
}

std::string openVinoDeviceHardwareLabel(const std::string& device) {
  if (device == "CPU") return "CPU";
  try {
    ov::Core core;
    const ov::device::Type type = core.get_property(device, ov::device::type);
    if (type == ov::device::Type::DISCRETE) return "dGPU";
    if (type == ov::device::Type::INTEGRATED) return "iGPU";
  } catch (const ov::Exception&) {
    // The device id is still reported; without DEVICE_TYPE it is not safe to guess.
  }
  return {};
}

RetinaFaceDetector::RetinaFaceDetector(const std::filesystem::path& modelXml, const std::string& device)
    : impl_(std::make_shared<Impl>(modelXml, device)) {}

std::vector<Detection> RetinaFaceDetector::detect(const std::vector<std::uint8_t>& rgb,
                                                  int width,
                                                  int height,
                                                  float scoreThreshold) {
  if (width <= 0 || height <= 0 || rgb.size() != static_cast<std::size_t>(width) *
                                                     static_cast<std::size_t>(height) * 3U) {
    throw std::runtime_error("invalid frame dimensions");
  }
  // Rebind after a region sequence may have left the request on input buffer 1.
  impl_->request.set_input_tensor(impl_->inputTensors[0]);
  float* input = impl_->inputTensors[0].data<float>();
  resizeBgr(rgb, width, height, input);
  impl_->request.infer();
  ov::Tensor bboxTensor = impl_->request.get_tensor(impl_->bboxOutput);
  ov::Tensor scoreTensor = impl_->request.get_tensor(impl_->scoreOutput);
  std::vector<Detection> detections =
      decodeDetections(bboxTensor, scoreTensor, impl_->anchors, width, height, scoreThreshold);
  return nonMaxSuppression(std::move(detections), 0.4F, 256U);
}

std::vector<Detection> RetinaFaceDetector::detectRegions(const std::vector<std::uint8_t>& rgb,
                                                         int width,
                                                         int height,
                                                         const std::vector<Region>& regions,
                                                         float scoreThreshold) {
  if (width <= 0 || height <= 0 || rgb.size() != static_cast<std::size_t>(width) *
                                                     static_cast<std::size_t>(height) * 3U) {
    throw std::runtime_error("invalid frame dimensions");
  }
  for (const Region& region : regions) {
    if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
        region.width > width || region.height > height || region.x > width - region.width ||
        region.y > height - region.height) {
      throw std::runtime_error("invalid detection region");
    }
  }
  if (regions.empty()) return {};

  std::vector<Detection> detections;
  detections.reserve(regions.size() * 4U);
  std::vector<std::uint8_t> tile;
  const auto fullFrame = [&](const Region& region) {
    return region.x == 0 && region.y == 0 && region.width == width && region.height == height;
  };
  const auto appendRegion = [&](const Region& region, const std::vector<Detection>& local) {
    for (Detection detection : local) {
      detection.box.x1 += static_cast<float>(region.x);
      detection.box.x2 += static_cast<float>(region.x);
      detection.box.y1 += static_cast<float>(region.y);
      detection.box.y2 += static_cast<float>(region.y);
      detection.box = clipBox(detection.box, width, height);
      detections.push_back(detection);
    }
  };

  if (impl_->deviceName.rfind("GPU", 0U) != 0U) {
    for (const Region& region : regions) {
      std::vector<Detection> local;
      if (fullFrame(region)) {
        local = detect(rgb, width, height, scoreThreshold);
      } else {
        copyRegion(rgb, width, region, tile);
        local = detect(tile, region.width, region.height, scoreThreshold);
      }
      appendRegion(region, local);
    }
    return detections;
  }

  const auto prepareRegion = [&](const Region& region, std::size_t inputIndex) {
    if (fullFrame(region)) {
      resizeBgr(rgb, width, height, impl_->inputTensors[inputIndex].data<float>());
    } else {
      copyRegion(rgb, width, region, tile);
      resizeBgr(tile, region.width, region.height, impl_->inputTensors[inputIndex].data<float>());
    }
  };

  prepareRegion(regions.front(), 0U);
  for (std::size_t index = 0; index < regions.size(); ++index) {
    const std::size_t currentInput = index & 1U;
    impl_->request.set_input_tensor(impl_->inputTensors[currentInput]);
    // Keep one inference in flight while the CPU prepares the other input buffer.
    impl_->request.start_async();
    try {
      if (index + 1U < regions.size()) prepareRegion(regions[index + 1U], currentInput ^ 1U);
    } catch (...) {
      // Do not rethrow a preparation failure while the request still owns its buffer.
      impl_->request.wait();
      throw;
    }
    impl_->request.wait();

    ov::Tensor bboxTensor = impl_->request.get_tensor(impl_->bboxOutput);
    ov::Tensor scoreTensor = impl_->request.get_tensor(impl_->scoreOutput);
    std::vector<Detection> local = decodeDetections(bboxTensor, scoreTensor, impl_->anchors,
                                                    regions[index].width, regions[index].height,
                                                    scoreThreshold);
    local = nonMaxSuppression(std::move(local), 0.4F, 256U);
    appendRegion(regions[index], local);
  }
  return detections;
}

}  // namespace otc::face
