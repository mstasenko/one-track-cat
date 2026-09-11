#include "detection_cache.hpp"

#include <charconv>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <limits>
#include <sstream>
#include <utility>

namespace otc::face {

namespace {

bool boundedDetection(const Detection& detection, int width, int height) {
  const Box& box = detection.box;
  return width > 0 && height > 0 && std::isfinite(box.x1) && std::isfinite(box.y1) &&
         std::isfinite(box.x2) && std::isfinite(box.y2) && std::isfinite(detection.score) &&
         box.x1 >= 0.0F && box.y1 >= 0.0F && box.x2 <= static_cast<float>(width) &&
         box.y2 <= static_cast<float>(height) && box.x2 > box.x1 && box.y2 > box.y1 &&
         detection.score >= 0.0F && detection.score <= 1.0F;
}

template <typename Integer>
bool parseUnsigned(const std::string& value, Integer& result) {
  if (value.empty()) return false;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
  return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}

bool parseFloat(const std::string& value, float& result) {
  if (value.empty()) return false;
  char* end = nullptr;
  errno = 0;
  result = std::strtof(value.c_str(), &end);
  return errno != ERANGE && end == value.c_str() + value.size() && std::isfinite(result);
}

}  // namespace

bool writeDetectionRow(std::ostream& output,
                       std::uint64_t globalFrame,
                       const std::vector<Detection>& detections,
                       int width,
                       int height) {
  if (detections.size() > detectionCacheMaximumDetections) return false;
  for (const Detection& detection : detections) {
    if (!boundedDetection(detection, width, height)) return false;
  }

  std::ostringstream line;
  line << "RCFACE1 " << globalFrame << ' ' << detections.size();
  line << std::scientific << std::setprecision(std::numeric_limits<float>::max_digits10);
  for (const Detection& detection : detections) {
    line << ' ' << detection.box.x1 << ' ' << detection.box.y1 << ' '
         << detection.box.x2 << ' ' << detection.box.y2 << ' ' << detection.score;
  }
  line << '\n';
  output << line.str();
  return static_cast<bool>(output);
}

DetectionCache::DetectionCache(std::istream& input,
                               int width,
                               int height,
                               std::ostream* preservedOutput)
    : input_(input), preservedOutput_(preservedOutput), width_(width), height_(height),
      valid_(width > 0 && height > 0) {}

DetectionCache::ReadLineResult DetectionCache::readLine(std::string& line) {
  line.clear();
  if (end_) {
    end_ = true;
    return ReadLineResult::end;
  }
  if (!input_.good()) return input_.eof() ? ReadLineResult::end : ReadLineResult::invalid;
  char character = '\0';
  while (input_.get(character)) {
    inputBytes_ += 1U;
    if (inputBytes_ > detectionCacheMaximumInputBytes) return ReadLineResult::invalid;
    if (character == '\n') return ReadLineResult::line;
    if (line.size() >= detectionCacheMaximumLineBytes) return ReadLineResult::invalid;
    line.push_back(character);
  }
  if (input_.bad()) return ReadLineResult::invalid;
  if (!line.empty()) {
    end_ = true;
    return ReadLineResult::line;
  }
  end_ = true;
  return ReadLineResult::end;
}

bool DetectionCache::parseRow(const std::string& line, Row& row) {
  if (line.rfind("RCFACE1", 0U) != 0U) return true;
  if (line.size() < 8U || line[7] != ' ') return false;

  std::istringstream stream(line);
  std::string tag;
  std::string frameToken;
  std::string countToken;
  if (!(stream >> tag >> frameToken >> countToken) || tag != "RCFACE1") return false;
  std::uint64_t frame = 0U;
  std::size_t count = 0U;
  if (!parseUnsigned(frameToken, frame) || !parseUnsigned(countToken, count) ||
      count > detectionCacheMaximumDetections) {
    return false;
  }
  std::vector<Detection> detections;
  detections.reserve(count);
  for (std::size_t index = 0U; index < count; ++index) {
    std::string x1Token;
    std::string y1Token;
    std::string x2Token;
    std::string y2Token;
    std::string scoreToken;
    if (!(stream >> x1Token >> y1Token >> x2Token >> y2Token >> scoreToken)) return false;
    Detection detection;
    if (!parseFloat(x1Token, detection.box.x1) || !parseFloat(y1Token, detection.box.y1) ||
        !parseFloat(x2Token, detection.box.x2) || !parseFloat(y2Token, detection.box.y2) ||
        !parseFloat(scoreToken, detection.score) || !boundedDetection(detection, width_, height_)) {
      return false;
    }
    detections.push_back(detection);
  }
  std::string extra;
  if (stream >> extra) return false;
  if (haveLastFrame_ && frame <= lastFrame_) return false;
  row = {frame, std::move(detections)};
  lastFrame_ = frame;
  haveLastFrame_ = true;
  return true;
}

bool DetectionCache::readNext(Row& row) {
  while (valid_) {
    std::string line;
    const ReadLineResult result = readLine(line);
    if (result == ReadLineResult::end) return false;
    if (result == ReadLineResult::invalid || !parseRow(line, row)) {
      valid_ = false;
      lookahead_.reset();
      return false;
    }
    if (line.rfind("RCFACE1", 0U) == 0U) return true;
  }
  return false;
}

bool DetectionCache::preserve(const Row& row) {
  if (preservedOutput_ == nullptr) return true;
  // A failed optional cache write must never disable face processing itself.
  (void)writeDetectionRow(*preservedOutput_, row.frame, row.detections, width_, height_);
  return true;
}

bool DetectionCache::advance() {
  if (!valid_ || end_) {
    lookahead_.reset();
    return false;
  }
  Row next;
  if (!readNext(next)) {
    lookahead_.reset();
    return false;
  }
  lookahead_ = std::move(next);
  return true;
}

std::optional<std::vector<Detection>> DetectionCache::lookup(std::uint64_t globalFrame) {
  if (!valid_) return std::nullopt;
  if (!lookahead_ && !end_ && !advance()) return std::nullopt;
  while (valid_ && lookahead_ && lookahead_->frame < globalFrame) {
    preserve(*lookahead_);
    if (!advance()) break;
  }
  if (!valid_ || !lookahead_ || lookahead_->frame != globalFrame) return std::nullopt;
  std::vector<Detection> result = std::move(lookahead_->detections);
  advance();
  if (!valid_) return std::nullopt;
  return result;
}

void DetectionCache::flush() {
  if (!valid_) return;
  if (!lookahead_ && !end_ && !advance()) return;
  while (valid_ && lookahead_) {
    preserve(*lookahead_);
    if (!advance()) break;
  }
}

}  // namespace otc::face
