#pragma once

namespace otc::upscale {

// The mode selects a reviewed, compiled asset table.  It is deliberately a
// small value type; no caller-provided strings or manifests select assets.
enum class FlashMode { turbo, base };

}  // namespace otc::upscale
