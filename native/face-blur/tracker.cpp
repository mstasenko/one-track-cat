#include "tracker.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace otc::face {

namespace {

float centerX(const Box& box) { return (box.x1 + box.x2) * 0.5F; }
float centerY(const Box& box) { return (box.y1 + box.y2) * 0.5F; }

Box moveBox(const Box& box, float dx, float dy, int width, int height) {
  return clipBox({box.x1 + dx, box.y1 + dy, box.x2 + dx, box.y2 + dy}, width, height);
}

bool hasRgbFrameShape(const std::vector<std::uint8_t>& rgb, int width, int height) {
  return width > 0 && height > 0 &&
         rgb.size() == static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3U;
}

bool looksLikeCutSamples(const std::vector<std::uint8_t>& previous,
                         const std::vector<std::uint8_t>& current) {
  if (previous.size() != sceneCutSampleBytes || current.size() != sceneCutSampleBytes) return false;
  std::uint64_t difference = 0U;
  for (std::size_t index = 0U; index < sceneCutSampleBytes; ++index) {
    difference += static_cast<std::uint64_t>(
        std::abs(static_cast<int>(current[index]) - static_cast<int>(previous[index])));
  }
  return (static_cast<double>(difference) / static_cast<double>(sceneCutSampleBytes)) > 48.0;
}

}  // namespace

FaceTracker::FaceTracker(std::size_t maximumTracks)
    : maximumTracks_(std::max<std::size_t>(1U, maximumTracks)) {}

void FaceTracker::reset() { tracks_.clear(); }

std::vector<Box> FaceTracker::update(const std::vector<Detection>& detections,
                                     double timestampSeconds,
                                     float holdSeconds,
                                     int width,
                                     int height) {
  const double boundedHold = std::clamp(static_cast<double>(holdSeconds), 0.0, 1.0);
  std::vector<bool> used(detections.size(), false);
  std::vector<Track> next;
  next.reserve(std::min(maximumTracks_, tracks_.size() + detections.size()));

  for (Track track : tracks_) {
    const double delta = std::clamp(timestampSeconds - track.lastTimestamp, 0.0, 1.0);
    Box predicted = moveBox(track.box,
                            track.velocityX * static_cast<float>(delta),
                            track.velocityY * static_cast<float>(delta), width, height);
    std::size_t best = detections.size();
    float bestIou = 0.18F;
    for (std::size_t index = 0; index < detections.size(); ++index) {
      if (used[index]) continue;
      const float overlap = boxIou(predicted, detections[index].box);
      if (overlap > bestIou) {
        bestIou = overlap;
        best = index;
      }
    }

    if (best != detections.size()) {
      const Box observed = clipBox(detections[best].box, width, height);
      const float observedDelta = static_cast<float>(std::max(delta, 1.0 / 240.0));
      const float nextVelocityX = (centerX(observed) - centerX(track.box)) / observedDelta;
      const float nextVelocityY = (centerY(observed) - centerY(track.box)) / observedDelta;
      const float maxVelocity = static_cast<float>(std::max(width, height)) * 0.75F;
      track.velocityX = std::clamp(nextVelocityX, -maxVelocity, maxVelocity);
      track.velocityY = std::clamp(nextVelocityY, -maxVelocity, maxVelocity);
      track.box = observed;
      track.missedSeconds = 0.0;
      track.lastTimestamp = timestampSeconds;
      used[best] = true;
    } else {
      track.box = predicted;
      track.missedSeconds += delta;
      track.lastTimestamp = timestampSeconds;
    }

    if (track.missedSeconds <= boundedHold && validBox(track.box)) next.push_back(track);
  }

  for (std::size_t index = 0; index < detections.size() && next.size() < maximumTracks_; ++index) {
    if (used[index]) continue;
    const Box box = clipBox(detections[index].box, width, height);
    if (!validBox(box)) continue;
    next.push_back({box, 0.0F, 0.0F, timestampSeconds, 0.0});
    used[index] = true;
  }
  for (std::size_t index = 0; index < detections.size(); ++index) {
    if (used[index]) continue;
    if (validBox(clipBox(detections[index].box, width, height))) {
      throw std::runtime_error("face track limit exceeded; refusing to drop a new face");
    }
  }
  tracks_ = std::move(next);

  std::vector<Box> result;
  result.reserve(tracks_.size());
  for (const Track& track : tracks_) result.push_back(track.box);
  return result;
}

bool looksLikeCut(const std::vector<std::uint8_t>& previous,
                 const std::vector<std::uint8_t>& current,
                 int width,
                 int height) {
  if (width == sceneCutSampleWidth && height == sceneCutSampleHeight &&
      previous.size() == sceneCutSampleBytes && current.size() == sceneCutSampleBytes) {
    return looksLikeCutSamples(previous, current);
  }
  if (!hasRgbFrameShape(previous, width, height) || previous.size() != current.size() ||
      !hasRgbFrameShape(current, width, height)) {
    return false;
  }
  return looksLikeCutSamples(sceneCutSample(previous, width, height), sceneCutSample(current, width, height));
}

std::vector<std::uint8_t> sceneCutSample(const std::vector<std::uint8_t>& rgb, int width, int height) {
  if (!hasRgbFrameShape(rgb, width, height)) return {};

  std::vector<std::uint8_t> sample(sceneCutSampleBytes);
  for (int y = 0; y < sceneCutSampleHeight; ++y) {
    const int sourceY = (y * height + height / (sceneCutSampleHeight * 2)) / sceneCutSampleHeight;
    for (int x = 0; x < sceneCutSampleWidth; ++x) {
      const int sourceX = (x * width + width / (sceneCutSampleWidth * 2)) / sceneCutSampleWidth;
      const std::size_t sourceOffset =
          (static_cast<std::size_t>(sourceY) * static_cast<std::size_t>(width) +
           static_cast<std::size_t>(sourceX)) * 3U;
      const std::size_t sampleOffset =
          (static_cast<std::size_t>(y) * static_cast<std::size_t>(sceneCutSampleWidth) +
           static_cast<std::size_t>(x)) * 3U;
      std::copy_n(rgb.data() + sourceOffset, 3U, sample.data() + sampleOffset);
    }
  }
  return sample;
}

}  // namespace otc::face
