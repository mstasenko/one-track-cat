cmake_minimum_required(VERSION 3.20)
project(otc_face_blur LANGUAGES CXX)

option(FACE_BLUR_BUILD_TESTS "Build pure tracking and rendering tests" OFF)
option(FACE_BLUR_MATH_ONLY "Build pure tests without the OpenVINO SDK" OFF)
option(FACE_BLUR_BUILD_SMOKE "Build the explicit CPU model smoke test" OFF)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(face-blur-core STATIC
  detection_cache.cpp
  effects.cpp
  face_types.cpp
  resize_bgr.cpp
  tracker.cpp
)
target_include_directories(face-blur-core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(face-blur-core PRIVATE -Wall -Wextra -Wpedantic)

if(FACE_BLUR_MATH_ONLY OR FACE_BLUR_BUILD_TESTS)
  enable_testing()
  add_executable(face-blur-resize-tests resize_bgr_tests.cpp)
  target_link_libraries(face-blur-resize-tests PRIVATE face-blur-core)
  target_include_directories(face-blur-resize-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
  target_compile_options(face-blur-resize-tests PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME face-blur-resize COMMAND face-blur-resize-tests)
endif()

if(FACE_BLUR_MATH_ONLY)
  enable_testing()
  add_executable(face-blur-math-tests face_math_tests.cpp)
  target_link_libraries(face-blur-math-tests PRIVATE face-blur-core)
  target_include_directories(face-blur-math-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
  target_compile_options(face-blur-math-tests PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME face-blur-math COMMAND face-blur-math-tests)
  add_executable(face-blur-detection-cache-tests detection_cache_tests.cpp)
  target_link_libraries(face-blur-detection-cache-tests PRIVATE face-blur-core)
  target_include_directories(face-blur-detection-cache-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
  target_compile_options(face-blur-detection-cache-tests PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME face-blur-detection-cache COMMAND face-blur-detection-cache-tests)
  return()
endif()

find_package(OpenVINO REQUIRED)
add_executable(otc-face-blur
  detection_pipeline.cpp
  main.cpp
  retinaface.cpp
)
target_link_libraries(otc-face-blur PRIVATE face-blur-core openvino::runtime)
target_include_directories(otc-face-blur PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(otc-face-blur PRIVATE -Wall -Wextra -Wpedantic)
get_target_property(OPENVINO_RUNTIME_LIBRARY openvino::runtime IMPORTED_LOCATION_RELEASE)
if(NOT OPENVINO_RUNTIME_LIBRARY)
  get_target_property(OPENVINO_RUNTIME_LIBRARY openvino::runtime IMPORTED_LOCATION)
endif()
if(OPENVINO_RUNTIME_LIBRARY)
  get_filename_component(OPENVINO_RUNTIME_LIB_DIR "${OPENVINO_RUNTIME_LIBRARY}" DIRECTORY)
  get_filename_component(OPENVINO_RUNTIME_ROOT "${OPENVINO_RUNTIME_LIB_DIR}/../.." ABSOLUTE)
  find_file(FACE_BLUR_TBB_LIBRARY NAMES libtbb.so.12.13 libtbb.so.12
    PATHS "${OPENVINO_RUNTIME_ROOT}/3rdparty/tbb/lib" NO_DEFAULT_PATH)
  if(FACE_BLUR_TBB_LIBRARY)
    target_link_libraries(otc-face-blur PRIVATE "${FACE_BLUR_TBB_LIBRARY}")
    target_link_options(otc-face-blur PRIVATE "-Wl,-rpath-link,$<TARGET_FILE_DIR:openvino::runtime>/../../3rdparty/tbb/lib")
  endif()
endif()
set_target_properties(otc-face-blur PROPERTIES
  BUILD_RPATH "$ORIGIN/lib"
  INSTALL_RPATH "$ORIGIN/lib"
  BUILD_WITH_INSTALL_RPATH TRUE
)

if(FACE_BLUR_BUILD_SMOKE)
  add_executable(otc-face-blur-smoke
    detection_pipeline.cpp
    face_inference_smoke.cpp
    retinaface.cpp
  )
  target_link_libraries(otc-face-blur-smoke PRIVATE face-blur-core openvino::runtime)
  target_include_directories(otc-face-blur-smoke PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
  target_compile_options(otc-face-blur-smoke PRIVATE -Wall -Wextra -Wpedantic)
  if(FACE_BLUR_TBB_LIBRARY)
    target_link_libraries(otc-face-blur-smoke PRIVATE "${FACE_BLUR_TBB_LIBRARY}")
    target_link_options(otc-face-blur-smoke PRIVATE "-Wl,-rpath-link,$<TARGET_FILE_DIR:openvino::runtime>/../../3rdparty/tbb/lib")
  endif()
  set_target_properties(otc-face-blur-smoke PROPERTIES
    BUILD_RPATH "$ORIGIN/lib"
    INSTALL_RPATH "$ORIGIN/lib"
    BUILD_WITH_INSTALL_RPATH TRUE
  )
endif()

if(FACE_BLUR_BUILD_TESTS)
  enable_testing()
  add_executable(face-blur-math-tests face_math_tests.cpp)
  target_link_libraries(face-blur-math-tests PRIVATE face-blur-core)
  target_include_directories(face-blur-math-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
  target_compile_options(face-blur-math-tests PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME face-blur-math COMMAND face-blur-math-tests)
  add_executable(face-blur-detection-cache-tests detection_cache_tests.cpp)
  target_link_libraries(face-blur-detection-cache-tests PRIVATE face-blur-core)
  target_include_directories(face-blur-detection-cache-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
  target_compile_options(face-blur-detection-cache-tests PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME face-blur-detection-cache COMMAND face-blur-detection-cache-tests)
endif()
