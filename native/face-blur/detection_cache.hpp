#pragma once

#include "face_types.hpp"

#include <cstddef>
#include <cstdint>
#include <istream>
#include <optional>
#include <ostream>
#include <string>
#include <vector>

namespace otc::face {

constexpr std::size_t detectionCacheMaximumDetections = 256U;
constexpr std::size_t detectionCacheMaximumLineBytes = 64U * 1024U;
constexpr std::size_t detectionCacheMaximumInputBytes = 64U * 1024U * 1024U;

// Writes one lossless raw-detection row. Invalid rows are ignored because the cache is optional.
bool writeDetectionRow(std::ostream& output,
                       std::uint64_t globalFrame,
                       const std::vector<Detection>& detections,
                       int width,
                       int height);

class DetectionCache {
 public:
  DetectionCache(std::istream& input, int width, int height, std::ostream* preservedOutput = nullptr);

  // Returns an engaged optional for a valid cached row, including an empty row.
  // A disengaged optional means cache miss or an invalidated cache.
  std::optional<std::vector<Detection>> lookup(std::uint64_t globalFrame);
  void flush();
  bool valid() const noexcept { return valid_; }

 private:
  struct Row {
    std::uint64_t frame = 0U;
    std::vector<Detection> detections;
  };

  enum class ReadLineResult { end, line, invalid };

  ReadLineResult readLine(std::string& line);
  bool readNext(Row& row);
  bool parseRow(const std::string& line, Row& row);
  bool preserve(const Row& row);
  bool advance();

  std::istream& input_;
  std::ostream* preservedOutput_;
  int width_;
  int height_;
  std::size_t inputBytes_ = 0U;
  std::uint64_t lastFrame_ = 0U;
  bool haveLastFrame_ = false;
  bool valid_ = true;
  bool end_ = false;
  std::optional<Row> lookahead_;
};

}  // namespace otc::face
