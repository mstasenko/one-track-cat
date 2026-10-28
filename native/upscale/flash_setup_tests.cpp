#include "flash_edges_session.hpp"
#include "flash_text_session.hpp"
#include "flash_attention_session.hpp"
#include "flash_token_session.hpp"
#include "flash_denoiser.hpp"

#include <cassert>
#include <filesystem>
#include <openvino/openvino.hpp>
#include <stdexcept>

namespace {

constexpr const char* kMissingAssets =
    "/__otc_flash_text_edges_constructor_test_assets__/";

template <class Action>
void expectInvalidArgument(Action action) {
  bool rejected = false;
  try {
    action();
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  assert(rejected);
}

template <class Action>
void expectMissingAsset(Action action) {
  bool rejected = false;
  try {
    action();
  } catch (const std::runtime_error&) {
    rejected = true;
  }
  assert(rejected);
}

void testInvalidModesAndRolesRejectBeforeAssetIO() {
  ov::Core core;
  ov::RemoteContext context;
  const auto invalidMode = static_cast<otc::upscale::FlashMode>(255);
  const auto invalidRole = static_cast<otc::upscale::FlashEdgesRole>(255);

  expectInvalidArgument([&] {
    otc::upscale::FlashTextSession session(core, context, kMissingAssets, invalidMode);
  });
  expectInvalidArgument([&] {
    otc::upscale::FlashEdgesSession session(core, context, kMissingAssets, invalidMode,
                                       otc::upscale::FlashEdgesRole::prefix);
  });
  expectInvalidArgument([&] {
    otc::upscale::FlashEdgesSession session(core, context, kMissingAssets, invalidMode,
                                       otc::upscale::FlashEdgesRole::suffix);
  });
  expectInvalidArgument([&] {
    otc::upscale::FlashEdgesSession session(core, context, kMissingAssets,
                                       otc::upscale::FlashMode::turbo, invalidRole);
  });
}

void testValidSelectionReachesAuthenticatedAssetRead() {
  ov::Core core;
  ov::RemoteContext context;

  // These selections pass mode/role validation and fail while authenticating
  // the missing asset directory. Therefore no read_model/compile/infer path
  // is reached by this CPU-only ordering test.
  expectMissingAsset([&] {
    otc::upscale::FlashTextSession session(core, context, kMissingAssets,
                                      otc::upscale::FlashMode::turbo);
  });
  expectMissingAsset([&] {
    otc::upscale::FlashEdgesSession session(core, context, kMissingAssets,
                                       otc::upscale::FlashMode::turbo,
                                       otc::upscale::FlashEdgesRole::prefix);
  });
  expectMissingAsset([&] {
    otc::upscale::FlashEdgesSession session(core, context, kMissingAssets,
                                       otc::upscale::FlashMode::base,
                                       otc::upscale::FlashEdgesRole::suffix);
  });
}

void testAttentionAdmissionPrecedesDeviceWork() {
  ov::Core core;
  ov::RemoteContext context;
  for (const auto windows : {0U, 511U}) {
    bool rejected = false;
    try {
      otc::upscale::FlashAttentionSession session(core, context, kMissingAssets, windows);
    } catch (const std::runtime_error& error) {
      rejected = std::string(error.what()).find("spatial window count") != std::string::npos;
    }
    assert(rejected); // No assets or context have been dereferenced.
  }
  expectMissingAsset([&] {
    otc::upscale::FlashAttentionSession session(core, context, kMissingAssets);
  });
}

void testTokenGeometryPrecedesContextWork() {
  for (const otc::upscale::FlashTokenGeometry geometry : {
           otc::upscale::FlashTokenGeometry{0U, 8U, 8U},
           otc::upscale::FlashTokenGeometry{4U, 7U, 8U},
           otc::upscale::FlashTokenGeometry{4U, 240U, 240U}}) {
    expectInvalidArgument([&] {
      otc::upscale::FlashTokenSession session(ov::RemoteContext{}, geometry);
    });
  }
}

#if defined(__linux__)
void testDenoiserPlanPrecedesDeviceWork() {
  ov::Core core;
  ov::RemoteContext context;
  expectInvalidArgument([&] {
    otc::upscale::FlashDenoiserSession session(core, context, kMissingAssets,
        kMissingAssets, static_cast<otc::upscale::FlashMode>(255), 1U);
  });
  expectInvalidArgument([&] {
    otc::upscale::FlashDenoiserSession session(core, context, kMissingAssets,
        kMissingAssets, otc::upscale::FlashMode::turbo, 0U);
  });
}
#endif

}  // namespace

int main() {
  testInvalidModesAndRolesRejectBeforeAssetIO();
  testValidSelectionReachesAuthenticatedAssetRead();
  testAttentionAdmissionPrecedesDeviceWork();
  testTokenGeometryPrecedesContextWork();
#if defined(__linux__)
  testDenoiserPlanPrecedesDeviceWork();
#endif
  return 0;
}
