#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace otc::upscale {

// Model-neutral storage shared by FlashVSR and RIFE. Expected pins originate
// in reviewed native tables, never caller/IPC manifests.
struct ModelAssetPin {
  std::string name;
  std::uint64_t bytes;
  std::array<std::uint8_t, 32> sha256;
};
struct ModelWeightSpan {
  std::uint64_t offset;
  std::uint64_t bytes;
  std::uint64_t elements; // Two-byte learned storage; checked against the model's type/shape.
};

class ModelOwnedIr final {
 public:
  ModelOwnedIr(ModelOwnedIr&&) noexcept = default;
  ModelOwnedIr& operator=(ModelOwnedIr&&) noexcept = default;
  ModelOwnedIr(const ModelOwnedIr&) = delete;
  ModelOwnedIr& operator=(const ModelOwnedIr&) = delete;

  const std::string& xml() const noexcept { return xml_; }
  const std::uint8_t* binData() const noexcept;
  std::size_t binBytes() const noexcept { return binBytes_; }
  const std::uint8_t* weightData(const ModelWeightSpan& span) const;

 private:
  ModelOwnedIr() = default;
  friend ModelOwnedIr readModelIr(const std::filesystem::path&, const ModelAssetPin&,
                                   const ModelAssetPin&, const std::vector<ModelWeightSpan>&);
  std::string xml_;
  std::vector<std::uint16_t> bin_;
  std::size_t binBytes_ = 0;
  std::size_t prefix_ = 0;
};

// Same API serves retained snapshots and bounded per-block fallback. Parse only
// these owned bytes; OpenVINO models sharing them must not outlive this owner.
// Learned spans are read-only views and may overlap when reusing one weight.
std::string readModelXml(const std::filesystem::path& directory, const ModelAssetPin& pin);
void verifyModelAsset(const std::filesystem::path& directory, const ModelAssetPin& pin);
// Small fixed prompt/conditioning tensors only (at most 8 MiB). Authenticate
// the retained bytes and reject nonfinite BF16 without numeric FP16 conversion.
std::vector<std::uint16_t> readBf16Asset(const std::filesystem::path& directory,
                                       const ModelAssetPin& pin);
ModelOwnedIr readModelIr(const std::filesystem::path& directory,
                          const ModelAssetPin& xml, const ModelAssetPin& bin,
                          const std::vector<ModelWeightSpan>& spans = {});

} // namespace otc::upscale
