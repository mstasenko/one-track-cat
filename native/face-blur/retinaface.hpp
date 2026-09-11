#pragma once

#include "face_types.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace otc::face {

std::vector<std::string> openVinoDeviceCandidates(const std::string& requested);
// Returns an authoritative CPU/iGPU/dGPU label when OpenVINO exposes DEVICE_TYPE.
// An empty result means the runtime did not provide enough information to label the GPU.
std::string openVinoDeviceHardwareLabel(const std::string& device);

struct Region {
  int x;
  int y;
  int width;
  int height;
};

class RetinaFaceDetector {
 public:
  struct Anchor {
    float centerX;
    float centerY;
    float width;
    float height;
  };

  RetinaFaceDetector(const std::filesystem::path& modelXml, const std::string& device);

  std::vector<Detection> detect(const std::vector<std::uint8_t>& rgb,
                                int width,
                                int height,
                                float scoreThreshold);

  std::vector<Detection> detectRegions(const std::vector<std::uint8_t>& rgb,
                                       int width,
                                       int height,
                                       const std::vector<Region>& regions,
                                       float scoreThreshold);

 private:
  class Impl;
  std::shared_ptr<Impl> impl_;
};

}  // namespace otc::face
