#pragma once
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>

namespace otc::upscale {
enum class ModelPrepareStage { authenticate, reconstruct, published };
struct ModelPrepareProgress {
  ModelPrepareStage stage;
  std::string name;
  std::uint64_t done;
  std::uint64_t total;
};
// Called synchronously, at most one MiB of IO between cancellation polls.
// Return false to cancel. The callback must not modify source/destination
// files.
using ModelPrepareCallback = std::function<bool(const ModelPrepareProgress&)>;
class ModelPrepareCancelled final : public std::runtime_error {
 public:
  ModelPrepareCancelled()
      : std::runtime_error("AI model preparation cancelled") {}
};
}  // namespace otc::upscale
