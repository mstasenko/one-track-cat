#include "flash_stage.hpp"
#include "flash_model.hpp"

#include <openvino/runtime/intel_gpu/remote_properties.hpp>
#include <openvino/runtime/intel_gpu/properties.hpp>
#if OTC_FLASH_EXECUTABLE_CACHE
#include <openvino/pass/manager.hpp>
#include <openvino/pass/serialize.hpp>
#include <openssl/evp.h>
#endif

#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <list>
#include <limits>
#include <mutex>
#include <sstream>
#include <string_view>
#if defined(__linux__)
#include <link.h>
#endif

namespace otc::upscale {
namespace {

#if OTC_FLASH_EXECUTABLE_CACHE
void requireCacheRuntime() {
#if defined(__linux__)
  static const bool verified = [] {
    std::vector<std::filesystem::path> libraries;
    dl_iterate_phdr([](dl_phdr_info* info, std::size_t, void* data) {
      const std::filesystem::path path(info->dlpi_name);
      if (path.filename() == "libopenvino_intel_gpu_plugin.so")
        static_cast<std::vector<std::filesystem::path>*>(data)->push_back(path);
      return 0;
    }, &libraries);
    if (libraries.size() != 1)
      throw std::runtime_error("Flash executable reuse requires one pinned patched OpenVINO GPU plugin");
    validateFlashCacheRuntime(libraries.front());
    return true;
  }();
  (void)verified;
#else
  throw std::runtime_error("Flash executable reuse is qualified only on Linux");
#endif
}
#endif

#if OTC_FLASH_EXECUTABLE_CACHE
// Exported executable blobs are useful only for this process and exact
// OpenCL context. Keep this cache deliberately small: it must not become a
// second model/weight store or retain compiled GPU workspaces.
constexpr std::size_t kFlashExecutableCacheMaxEntries = 256U;
constexpr std::size_t kFlashExecutableCacheMaxBytes = 256U * 1024U * 1024U;
constexpr std::size_t kFlashExecutableConfigMaxBytes = 8U * 1024U * 1024U;
constexpr std::size_t kFlashExecutableSourceMaxBytes = 64U * 1024U * 1024U;

using FlashExecutableBlob = std::shared_ptr<const std::string>;

struct FlashExecutableCacheEntry final {
  std::string key;
  FlashExecutableBlob blob;
};

struct FlashExecutableCacheState final {
  std::mutex mutex;
  std::list<FlashExecutableCacheEntry> entries;
  std::size_t bytes = 0U;
};

FlashExecutableCacheState& flashExecutableCache() {
  static FlashExecutableCacheState cache;
  return cache;
}

void appendCacheField(std::string& destination, std::string_view value) {
  const auto size = static_cast<std::uint64_t>(value.size());
  destination.append(reinterpret_cast<const char*>(&size), sizeof(size));
  destination.append(value.data(), value.size());
}

std::string sha256Bytes(const void* data, std::size_t bytes, const char* label) {
  std::array<unsigned char, EVP_MAX_MD_SIZE> digest{};
  unsigned length = 0U;
  const auto* input = static_cast<const unsigned char*>(data);
  if (EVP_Digest(input, bytes, digest.data(), &length, EVP_sha256(), nullptr) != 1 ||
      length != 32U)
    throw std::runtime_error(std::string("Flash executable cache ") + label + " digest failed");
  return std::string(reinterpret_cast<const char*>(digest.data()), length);
}

std::string readBoundedFile(const std::string& path, std::size_t maximum,
                            const char* label) {
  std::ifstream file(path, std::ios::binary);
  if (!file) throw std::runtime_error(std::string("Flash executable cache ") + label + " cannot be read");
  file.seekg(0, std::ios::end);
  const auto extent = file.tellg();
  if (extent < 0 || static_cast<std::uintmax_t>(extent) > maximum)
    throw std::runtime_error(std::string("Flash executable cache ") + label + " exceeds its bound");
  std::string contents(static_cast<std::size_t>(extent), '\0');
  file.seekg(0, std::ios::beg);
  if (!contents.empty() &&
      !file.read(contents.data(), static_cast<std::streamsize>(contents.size())))
    throw std::runtime_error(std::string("Flash executable cache ") + label + " read failed");
  return contents;
}

std::string readKernelConfig(const std::string& path) {
  auto contents = readBoundedFile(path, kFlashExecutableConfigMaxBytes, "CONFIG_FILE");

  // VerifiedKernelFiles creates a fresh sealed CONFIG_FILE per controller and
  // rewrites its source references to /proc/self/fd/<number>. Normalize the
  // process-local number, but include the sealed source bytes in the identity;
  // normalizing numbers alone could alias two different kernels.
  constexpr std::string_view descriptor = "/proc/self/fd/";
  std::string sourceIdentity;
  std::size_t cursor = 0U;
  while ((cursor = contents.find(descriptor, cursor)) != std::string::npos) {
    auto digits = cursor + descriptor.size();
    auto end = digits;
    while (end < contents.size() &&
           std::isdigit(static_cast<unsigned char>(contents[end])))
      ++end;
    if (end == digits)
      throw std::runtime_error("Flash executable cache CONFIG_FILE has malformed fd reference");
    const auto source = readBoundedFile(std::string(descriptor) +
                                            contents.substr(digits, end - digits),
                                        kFlashExecutableSourceMaxBytes,
                                        "kernel source");
    contents.replace(digits, end - digits, "#");
    appendCacheField(sourceIdentity,
                     sha256Bytes(source.data(), source.size(), "kernel source"));
    cursor = digits + 1U;
  }
  contents.append(sourceIdentity);
  return contents;
}

std::string compileConfigIdentity(const ov::AnyMap& config) {
  std::string identity;
  for (const auto& [name, value] : config) {
    appendCacheField(identity, name);
    appendCacheField(identity, value.type_info().name());
    if (name == "CONFIG_FILE") {
      if (!value.is<std::string>())
        throw std::runtime_error("Flash executable cache CONFIG_FILE type differs");
      const auto contents = readKernelConfig(value.as<std::string>());
      appendCacheField(identity, std::filesystem::path(value.as<std::string>())
          .filename().generic_string());
      appendCacheField(identity, sha256Bytes(contents.data(), contents.size(), "kernel config"));
      continue;
    }
    std::ostringstream rendered;
    value.print(rendered);
    appendCacheField(identity, rendered.str());
  }
  return sha256Bytes(identity.data(), identity.size(), "compile config");
}

std::string graphIdentity(const ov::Model& model) {
  // StreamSerialize includes operation attributes and small Constants in
  // addition to ports/topology. Learned banks are Parameters in the admitted
  // graphs, so their contents never enter this identity or the cache blob.
  auto copy = model.clone();
  copy->set_friendly_name("stage");
  // Generated operation names contain process-global counters. They have no
  // execution meaning, but would otherwise prevent equivalent new controllers
  // from reusing the same executable.
  std::size_t index = 0;
  for (const auto& node : copy->get_ordered_ops()) node->set_friendly_name("stage_" + std::to_string(index++));
  std::ostringstream serialized(std::ios::out | std::ios::binary);
  ov::pass::Manager manager;
  manager.register_pass<ov::pass::StreamSerialize>(serialized);
  manager.run_passes(copy);
  const auto bytes = serialized.str();
  if (bytes.empty() || serialized.fail())
    throw std::runtime_error("Flash executable cache graph serialization failed");
  return sha256Bytes(bytes.data(), bytes.size(), "graph");
}

std::string makeFlashExecutableCacheKey(const ov::Model& model,
                                        const std::string& device,
                                        void* contextMarker,
                                        const ov::AnyMap& compileConfig) {
  std::string key;
  appendCacheField(key, "flash-executable-cache-v2");
  appendCacheField(key, ov::get_openvino_version().buildNumber);
  appendCacheField(key, device);
  appendCacheField(key, std::to_string(reinterpret_cast<std::uintptr_t>(contextMarker)));
  appendCacheField(key, graphIdentity(model));
  appendCacheField(key, compileConfigIdentity(compileConfig));
#ifdef OTC_FLASH_GPU_PLUGIN_SHA256_BYTES
  const std::array<unsigned char, 32> pluginHash{{OTC_FLASH_GPU_PLUGIN_SHA256_BYTES}};
  appendCacheField(key, std::string_view(reinterpret_cast<const char*>(pluginHash.data()),
                                         pluginHash.size()));
#endif
  return key;
}

FlashExecutableBlob lookupFlashExecutable(const std::string& key) {
  if (key.empty()) return {};
  auto& cache = flashExecutableCache();
  std::lock_guard<std::mutex> lock(cache.mutex);
  for (auto entry = cache.entries.begin(); entry != cache.entries.end(); ++entry) {
    if (entry->key != key) continue;
    auto blob = entry->blob;
    cache.entries.splice(cache.entries.begin(), cache.entries, entry);
    return blob;
  }
  return {};
}

void eraseFlashExecutable(const std::string& key, const FlashExecutableBlob& expected) noexcept {
  if (key.empty()) return;
  auto& cache = flashExecutableCache();
  std::lock_guard<std::mutex> lock(cache.mutex);
  for (auto entry = cache.entries.begin(); entry != cache.entries.end(); ++entry) {
    if (entry->key == key && (!expected || entry->blob == expected)) {
      cache.bytes -= entry->blob->size();
      cache.entries.erase(entry);
      return;
    }
  }
}

void storeFlashExecutable(std::string key, const FlashExecutableBlob& shared) {
  if (key.empty() || !shared || shared->empty() ||
      shared->size() > kFlashExecutableCacheMaxBytes) return;
  auto& cache = flashExecutableCache();
  std::lock_guard<std::mutex> lock(cache.mutex);
  for (auto entry = cache.entries.begin(); entry != cache.entries.end(); ++entry) {
    if (entry->key != key) continue;
    cache.bytes -= entry->blob->size();
    cache.entries.erase(entry);
    break;
  }
  while (!cache.entries.empty() &&
         (cache.entries.size() >= kFlashExecutableCacheMaxEntries ||
          cache.bytes > kFlashExecutableCacheMaxBytes - shared->size())) {
    cache.bytes -= cache.entries.back().blob->size();
    cache.entries.pop_back();
  }
  cache.entries.push_front({std::move(key), shared});
  cache.bytes += shared->size();
}
#endif

void require(bool value, const std::string& message) {
  if (!value) throw std::runtime_error("FlashVSR+ GPU stage: " + message);
}

void* marker(const ov::AnyMap& parameters, const char* name) {
  const auto found = parameters.find(name);
  require(found != parameters.end(), std::string("missing remote marker ") + name);
  void* value = found->second.as<void*>();
  require(value != nullptr, std::string("empty remote marker ") + name);
  return value;
}

template<class Ports>
FlashPorts describe(const Ports& ports) {
  FlashPorts result;
  for (const auto& port : ports) {
    require(port.get_names().size() == 1 && port.get_partial_shape().is_static(),
            "static canonical ports required");
    require(result.emplace(port.get_any_name(),
                           std::make_pair(port.get_element_type(), port.get_shape())).second,
            "duplicate port");
  }
  return result;
}

} // namespace

std::string detail::flashExecutableCacheKey(const ov::Model& model, const std::string& device,
                                            void* context, const ov::AnyMap& config) {
#if OTC_FLASH_EXECUTABLE_CACHE
  return makeFlashExecutableCacheKey(model, device, context, config);
#else
  (void)model; (void)device; (void)context; (void)config;
  return {};
#endif
}

void validateFlashCacheRuntime(const std::filesystem::path& library) {
#if OTC_FLASH_EXECUTABLE_CACHE
  // Source authentication happens in the build recipe. Verify its exact output
  // here; a runtime manifest cannot authorize a replacement plugin.
  const ModelAssetPin pin{library.filename().string(), OTC_FLASH_GPU_PLUGIN_BYTES,
                          {OTC_FLASH_GPU_PLUGIN_SHA256_BYTES}};
  try {
    verifyModelAsset(library.parent_path(), pin);
  } catch (const std::exception&) {
    throw std::runtime_error("Flash executable reuse requires the pinned patched OpenVINO GPU plugin");
  }
#else
  (void)library;
  throw std::runtime_error("Flash executable reuse is not enabled in this worker");
#endif
}

bool flashUsesPackedKv(ov::Core& core, const ov::RemoteContext& context) {
  // The qualified Gen12 path lacks the Xe2 2D-block load used by attention.
  // Share this packing policy across attention/cross-attention, rather than
  // matching product names. Untested Gen12 GPUs are not thereby qualified.
  return core.get_property(context.get_device_name(), ov::intel_gpu::uarch_version).rfind("12.", 0) == 0;
}

void validateFlashBf16Output(const std::uint16_t* words, std::size_t elements) {
  require(words && elements, "empty BF16 output");
  // Accumulate instead of branching per word so the compiler can vectorize
  // the scan. Every NaN/Inf bit pattern is still rejected before publication.
  std::uint16_t nonFinite = 0;
  for (std::size_t i = 0; i < elements; ++i)
    nonFinite |= (words[i] & 0x7f80U) == 0x7f80U;
  if (nonFinite)
    throw std::runtime_error("FlashVSR+ GPU stage: non-finite BF16 output");
}

ov::Tensor flashDeviceTensor(ov::RemoteContext& context,
                             ov::element::Type type, const ov::Shape& shape) {
  return context.create_tensor(type, shape,
      {ov::intel_gpu::shared_mem_type(ov::intel_gpu::SharedMemType::USM_DEVICE_BUFFER)});
}

void validateFlashWeightExtent(const ov::Shape& shape,
                               const ModelWeightSpan& span) {
  require(!shape.empty(), "weight must not be scalar");
  std::uint64_t elements = 1;
  for (const auto dimension : shape) {
    require(dimension != 0 &&
                dimension <= std::numeric_limits<std::uint64_t>::max() / elements,
            "weight shape overflows");
    elements *= dimension;
  }
  require(elements == span.elements &&
              elements <= std::numeric_limits<std::uint64_t>::max() / 2U &&
              elements * 2U == span.bytes,
          "weight span differs");
}

void validateFlashStageWeights(const FlashPorts& inputs,
                               const std::vector<FlashStageWeight>& weights) {
  std::set<std::string> weightNames;
  for (const auto& weight : weights) {
    validateFlashWeightExtent(weight.shape, weight.span);
    const auto found = inputs.find(weight.name);
    require(found != inputs.end() &&
                found->second == std::make_pair(ov::element::bf16, weight.shape) &&
                weight.name.rfind("weight__", 0) == 0 && weightNames.insert(weight.name).second,
            "weight binding differs");
  }
  for (const auto& [name, contract] : inputs)
    require(name.rfind("weight__", 0) != 0 || weightNames.count(name), "unbound learned input " + name);
}

FlashGpuStage::FlashGpuStage(ov::Core& core, ov::RemoteContext context,
                             const std::shared_ptr<ov::Model>& model,
                             std::vector<FlashStageWeight> weights,
                             FlashPrecision precision,
                             const std::string& kernelConfig,
                             const std::vector<std::string>& finiteFlags,
                             FlashOutputCheck outputCheck)
    : core_(core),
      context_(std::move(context)),
      model_(model),
      bindings_(std::move(weights)),
      precision_(precision),
      outputCheck_(outputCheck) {
  require(model != nullptr, "missing model");
  require(precision == FlashPrecision::pluginDefault || precision == FlashPrecision::source ||
              precision == FlashPrecision::rawBf16Transport,
          "unknown precision policy");
  require(outputCheck == FlashOutputCheck::none || outputCheck == FlashOutputCheck::bf16 ||
              outputCheck == FlashOutputCheck::bf16Readback,
          "unknown output validation policy");
  require(outputCheck == FlashOutputCheck::none || finiteFlags.empty(),
          "separate output validation cannot also use inline flags");
  inputs_ = describe(model->inputs());
  outputs_ = describe(model->outputs());
  if (outputCheck != FlashOutputCheck::none) {
    require(!outputs_.empty(), "finite check requires data outputs");
    for (const auto& [name, contract] : outputs_)
      require(name != "finite" && contract.first == ov::element::bf16,
              "finite check requires BF16 data with non-reserved names");
  }
  validateFlashStageWeights(inputs_, bindings_);
  std::set<std::string> flagNames;
  for (const auto& name : finiteFlags) {
    const auto found = outputs_.find(name);
    require(found != outputs_.end() && found->second == std::make_pair(ov::element::f16, ov::Shape{}) &&
                flagNames.insert(name).second, "finite flag must be a unique scalar F16 output");
  }
  const auto device = context_.get_device_name();
  require(device.rfind("GPU.", 0) == 0 && device.size() > 4 &&
              std::all_of(device.begin() + 4, device.end(), [](char c) { return c >= '0' && c <= '9'; }),
          "an explicitly resolved GPU context is required");
  require(std::string(ov::get_openvino_version().buildNumber) ==
              "2026.5.0-23457-7d81aad55a5", "unqualified OpenVINO build");
#if OTC_FLASH_EXECUTABLE_CACHE
  requireCacheRuntime();
#endif
  contextMarker_ = marker(context_.get_params(), "OCL_CONTEXT");
  compileConfig_ = ov::AnyMap{ov::num_streams(ov::streams::Num(1)), {"CACHE_DIR", std::string()},
      // Request the Intel driver's low-power wait policy, not queue priority.
      ov::intel_gpu::hint::queue_throttle(ov::intel_gpu::hint::ThrottleLevel::LOW),
      {"PERFORMANCE_HINT", ov::hint::PerformanceMode::LATENCY},
      {"EXECUTION_MODE_HINT", ov::hint::ExecutionMode::ACCURACY}};
  // POST disables implicit precision changes; PRE uses the plugin default.
  // Split-key attention uses F16-shaped ports containing raw BF16 words.
  const auto requestedPrecision = precision_ == FlashPrecision::rawBf16Transport
      ? ov::element::f16 : ov::element::dynamic;
  if (precision_ != FlashPrecision::pluginDefault)
    compileConfig_["INFERENCE_PRECISION_HINT"] = requestedPrecision;
  if (!kernelConfig.empty()) compileConfig_["CONFIG_FILE"] = kernelConfig;
#if OTC_FLASH_EXECUTABLE_CACHE
  // Cache identity generation is advisory. If a future graph/custom op cannot
  // be serialized, compile normally rather than weakening the key or changing
  // the worker's functional behavior.
  try {
    executableCacheKey_ = detail::flashExecutableCacheKey(
        *model_, device, contextMarker_, compileConfig_);
  } catch (const std::exception&) {
    executableCacheKey_.clear();
  }
#endif
  for (const auto& weight : bindings_)
    weights_.emplace(weight.name, flashDeviceTensor(context_, ov::element::bf16, weight.shape));
  for (const auto& name : finiteFlags)
    flags_.emplace(name, ov::Tensor(ov::element::f16, {}));
  // Build each output checker once. Its compiled request is independently
  // suspended/resumed with this stage; only its GPU workspace is discarded.
  if (outputCheck_ == FlashOutputCheck::bf16) {
    for (const auto& [name, contract] : outputs_) {
      if (outputChecks_.count(contract.second)) continue;
      auto check = std::make_unique<FlashGpuStage>(
          core_, context_, makeFlashBf16OutputCheck(contract.second),
          std::vector<FlashStageWeight>{}, FlashPrecision::pluginDefault,
          std::string{}, std::vector<std::string>{"finite"});
      outputChecks_.emplace(contract.second, std::move(check));
    }
  }
  // Authenticated weighted stages become ready only after bind(); finite-check
  // and other weight-free stages are valid immediately after construction.
  ready_ = bindings_.empty();
  ensureCompiled();
}

void FlashGpuStage::ensureCompiled() {
  if (compiled_) return;
  const auto device = context_.get_device_name();
  const auto requestedPrecision = precision_ == FlashPrecision::rawBf16Transport
      ? ov::element::f16 : ov::element::dynamic;
#if OTC_FLASH_EXECUTABLE_CACHE
  // Prefer this stage's own export. The process cache is only a sharing
  // opportunity; its LRU may have evicted an entry still needed by a stage.
  FlashExecutableBlob importedBlob = compiledBlob_;
#endif
  try {
    const auto validateCompiled = [&] {
      require(compiled_.get_property("EXECUTION_DEVICES").as<std::vector<std::string>>() ==
                  std::vector<std::string>{device}, "compiled execution device differs");
      require(marker(compiled_.get_context().get_params(), "OCL_CONTEXT") == contextMarker_,
              "compiled execution context differs");
      require(static_cast<std::int32_t>(compiled_.get_property(ov::num_streams)) == 1 &&
                  compiled_.get_property("EXECUTION_MODE_HINT").as<ov::hint::ExecutionMode>() ==
                      ov::hint::ExecutionMode::ACCURACY &&
                  (precision_ == FlashPrecision::pluginDefault ||
                   compiled_.get_property("INFERENCE_PRECISION_HINT").as<ov::element::Type>() ==
                       requestedPrecision), "compiled stream/precision policy differs");
      validateFlashPorts(compiled_.inputs(), inputs_, true);
      validateFlashPorts(compiled_.outputs(), outputs_, true);
    };
#if OTC_FLASH_EXECUTABLE_CACHE
    if (!importedBlob && !executableCacheKey_.empty())
      importedBlob = lookupFlashExecutable(executableCacheKey_);
    if (importedBlob) {
      try {
        std::istringstream blob(*importedBlob, std::ios::in | std::ios::binary);
        compiled_ = core_.import_model(blob, context_, compileConfig_);
        validateCompiled();
        compiledBlob_ = importedBlob;
      } catch (...) {
        // A stale export is an ordinary cache miss. Never publish it again;
        // compile and validate the graph under the current context instead.
        eraseFlashExecutable(executableCacheKey_, importedBlob);
        importedBlob.reset();
        compiledBlob_.reset();
        compiled_ = ov::CompiledModel{};
      }
    }
    if (!compiled_)
#endif
    {
      compiled_ = core_.compile_model(model_, context_, compileConfig_);
      validateCompiled();
    }
#if OTC_FLASH_EXECUTABLE_CACHE
    if (!importedBlob) {
      // Reuse is advisory: export/allocation failure must not invalidate an
      // already compiled and validated model under host-memory pressure.
      try {
        std::ostringstream blob(std::ios::out | std::ios::binary);
        compiled_.export_model(blob);
        auto exported = blob.str();
        require(!exported.empty(), "compiled executable export is empty");
        compiledBlob_ = std::make_shared<const std::string>(std::move(exported));
        storeFlashExecutable(executableCacheKey_, compiledBlob_);
      } catch (const std::exception&) {
        compiledBlob_.reset();
      }
    }
#endif
    request_ = compiled_.create_infer_request();
    for (const auto& weight : bindings_) {
      request_.set_tensor(weight.name, weights_.at(weight.name));
    }
    for (const auto& [name, tensor] : flags_)
      request_.set_tensor(name, tensor);
    for (auto& [shape, check] : outputChecks_) check->ensureCompiled();
  } catch (...) {
#if OTC_FLASH_EXECUTABLE_CACHE
    if (importedBlob) {
      eraseFlashExecutable(executableCacheKey_, importedBlob);
      compiledBlob_.reset();
    }
#endif
    ready_ = false;
    request_ = ov::InferRequest{};
    compiled_ = ov::CompiledModel{};
    for (auto& [shape, check] : outputChecks_) check->suspend();
    throw;
  }
}

void FlashGpuStage::suspend() noexcept {
  request_ = ov::InferRequest{};
  compiled_ = ov::CompiledModel{};
  std::vector<std::uint16_t>().swap(readback_);
  for (auto& [shape, check] : outputChecks_) check->suspend();
}

void FlashGpuStage::bind(const ModelOwnedIr& owner) {
  ensureCompiled();
  invalidate();
  for (const auto& binding : bindings_) {
    const ov::Tensor host(ov::element::bf16, binding.shape, owner.weightData(binding.span));
    auto destination = weights_.at(binding.name).as<ov::RemoteTensor>();
    destination.copy_from(host);
  }
  for (auto& [shape, check] : outputChecks_) check->bind(owner); // No learned banks.
  ready_ = true;
}

void* FlashGpuStage::validateTensor(
    const ov::Tensor& tensor, const std::pair<ov::element::Type, ov::Shape>& expected) const {
  require(tensor && tensor.is<ov::RemoteTensor>() && tensor.get_element_type() == expected.first &&
              tensor.get_shape() == expected.second, "complete typed remote root required");
  std::size_t bytes = expected.first.size();
  require(bytes > 0, "remote storage type has no byte extent");
  for (auto dimension : expected.second) {
    require(dimension && dimension <= std::numeric_limits<std::size_t>::max() / bytes,
            "remote byte extent overflows");
    bytes *= dimension;
  }
  require(tensor.get_byte_size() == bytes, "remote byte extent differs");
  const auto remote = tensor.as<ov::RemoteTensor>();
  require(remote.get_device_name() == context_.get_device_name(), "remote device differs");
  const auto params = remote.get_params();
  require(marker(params, "OCL_CONTEXT") == contextMarker_, "remote context differs");
  const auto storage = params.find(ov::intel_gpu::shared_mem_type.name());
  require(storage != params.end() &&
              (storage->second.as<ov::intel_gpu::SharedMemType>() == ov::intel_gpu::SharedMemType::USM_DEVICE_BUFFER ||
               storage->second.as<ov::intel_gpu::SharedMemType>() == ov::intel_gpu::SharedMemType::USM_HOST_BUFFER),
          "USM storage required");
  return marker(params, "MEM_HANDLE");
}

void FlashGpuStage::run(const FlashTensors& inputs, const FlashTensors& outputs) {
  require(ready_, "no completely bound layer");
  require(inputs.size() == inputs_.size() - weights_.size() &&
              outputs.size() == outputs_.size() - flags_.size(), "feed/output count differs");
  std::set<void*> inputHandles, outputHandles;
  for (const auto& [name, tensor] : inputs) {
    const auto found = inputs_.find(name);
    require(found != inputs_.end() && !weights_.count(name), "unexpected data input");
    inputHandles.insert(validateTensor(tensor, found->second));
  }
  for (const auto& [name, tensor] : outputs) {
    const auto found = outputs_.find(name);
    require(found != outputs_.end() && !flags_.count(name), "unexpected data output");
    const auto handle = validateTensor(tensor, found->second);
    require(!inputHandles.count(handle) && outputHandles.insert(handle).second,
            "output aliases an input or another output root");
  }
  // All caller-owned shape, extent, context, and alias checks happen before
  // any lazy compile can allocate a new graph workspace.
  ensureCompiled();
  // start_async/wait avoids eager readback; the selected validator below owns
  // any explicit host copy. Compute and causal roots use the admitted context.
  // Every successful or failed call is synchronous from the controller's view.
  try {
    // A flag must be freshly written by this request, never accepted from a
    // previous successful call if execution fails to publish its scalar.
    for (auto& [name, tensor] : flags_) tensor.data<ov::float16>()[0] = ov::float16(0.0f);
    for (const auto& [name, tensor] : inputs) request_.set_tensor(name, tensor);
    for (const auto& [name, tensor] : outputs) request_.set_tensor(name, tensor);
    request_.start_async();
    request_.wait();
    if (!outputChecks_.empty())
      for (const auto& [name, tensor] : outputs)
        outputChecks_.at(tensor.get_shape())->run({{"data", tensor}}, {});
    if (outputCheck_ == FlashOutputCheck::bf16Readback) {
      for (const auto& [name, tensor] : outputs) {
        const auto params = tensor.as<ov::RemoteTensor>().get_params();
        if (params.at("SHARED_MEM_TYPE").as<ov::intel_gpu::SharedMemType>() ==
            ov::intel_gpu::SharedMemType::USM_HOST_BUFFER) {
          // wait() above completed all GPU writes. Host USM is already CPU-
          // accessible; copying these large causal roots again adds no safety.
          validateFlashBf16Output(
              static_cast<const std::uint16_t*>(marker(params, "MEM_HANDLE")), tensor.get_size());
          continue;
        }
        readback_.resize(tensor.get_size());
        ov::Tensor host(ov::element::bf16, tensor.get_shape(), readback_.data());
        tensor.copy_to(host);
        validateFlashBf16Output(readback_.data(), tensor.get_size());
      }
    }
    for (const auto& [name, tensor] : flags_)
      require(static_cast<float>(tensor.data<const ov::float16>()[0]) == 1.0f,
              "non-finite output reported by " + name);
  } catch (...) {
    invalidate();
    throw;
  }
}

} // namespace otc::upscale
