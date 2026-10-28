cmake_minimum_required(VERSION 3.20)
project(otc_upscale LANGUAGES CXX)

option(UPSCALE_BUILD_TESTS "Build pure timing, tiling and frame invariant tests" OFF)
option(UPSCALE_MATH_ONLY "Build pure tests without OpenVINO" OFF)
option(UPSCALE_EXECUTABLE_CACHE "Reuse compiled Flash stages with the pinned patched GPU plugin" OFF)
set(UPSCALE_GPU_PLUGIN "" CACHE FILEPATH "Source-verified GPU plugin to authenticate in the worker")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(otc-upscale-core STATIC upscale_core.cpp)
target_include_directories(otc-upscale-core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(otc-upscale-core PRIVATE -Wall -Wextra -Wpedantic)

find_package(OpenSSL REQUIRED COMPONENTS Crypto)
add_library(otc-upscale-assets STATIC model_assets.cpp model_prepare.cpp
  verified_kernel_files.cpp flash_prepare.cpp flash_prepare_cli.cpp)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_sources(otc-upscale-assets PRIVATE flash_history.cpp)
endif()
target_include_directories(otc-upscale-assets PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(otc-upscale-assets PUBLIC OpenSSL::Crypto)
target_compile_options(otc-upscale-assets PRIVATE -Wall -Wextra -Wpedantic)

# Build-time pin generation only; the AI pack ships the worker, not this tool.
add_executable(otc-upscale-bf16 EXCLUDE_FROM_ALL bf16_convert.cpp)
target_link_libraries(otc-upscale-bf16 PRIVATE otc-upscale-assets)
target_compile_options(otc-upscale-bf16 PRIVATE -Wall -Wextra -Wpedantic)

if(UPSCALE_MATH_ONLY OR UPSCALE_BUILD_TESTS)
  enable_testing()
  set_target_properties(otc-upscale-bf16 PROPERTIES EXCLUDE_FROM_ALL FALSE)
  find_package(Python3 QUIET COMPONENTS Interpreter)
  if(Python3_Interpreter_FOUND)
    add_test(NAME otc-upscale-bf16
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_bf16_convert.py"
              "$<TARGET_FILE:otc-upscale-bf16>")
    add_test(NAME otc-upscale-flash-prepare
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_prepare_flash_post.py")
    add_test(NAME otc-upscale-flash-structure
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_structure.py")
    add_test(NAME otc-upscale-flash-projection
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_projection.py")
    add_test(NAME otc-upscale-flash-cross
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_cross.py")
    add_test(NAME otc-upscale-flash-text-export
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_text.py")
    add_test(NAME otc-upscale-flash-conditioning-export
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_conditioning.py")
    add_test(NAME otc-upscale-flash-edges-export
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_edges.py")
    add_test(NAME otc-upscale-flash-decoder-export
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_decoder.py")
    add_test(NAME otc-upscale-flash-decoder-prepare
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_prepare_flash_decoder.py")
  endif()
  add_executable(otc-upscale-core-tests upscale_core_tests.cpp)
  target_link_libraries(otc-upscale-core-tests PRIVATE otc-upscale-core)
  target_compile_options(otc-upscale-core-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-core COMMAND otc-upscale-core-tests)
  add_executable(otc-upscale-spatial-ranges-tests spatial_ranges_tests.cpp)
  target_compile_options(otc-upscale-spatial-ranges-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-spatial-ranges COMMAND otc-upscale-spatial-ranges-tests)
  add_executable(otc-upscale-interpolation-window-tests interpolation_window_tests.cpp)
  target_compile_options(otc-upscale-interpolation-window-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-interpolation-window COMMAND otc-upscale-interpolation-window-tests)
  add_executable(otc-upscale-flash-stream-tests flash_stream_tests.cpp)
  target_compile_options(otc-upscale-flash-stream-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-stream COMMAND otc-upscale-flash-stream-tests)
  add_executable(otc-upscale-flash-source-tests flash_source_tests.cpp flash_source.cpp)
  target_compile_options(otc-upscale-flash-source-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-source COMMAND otc-upscale-flash-source-tests)
  add_executable(otc-upscale-flash-geometry-tests flash_geometry_tests.cpp flash_geometry.cpp)
  target_compile_options(otc-upscale-flash-geometry-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-geometry COMMAND otc-upscale-flash-geometry-tests)
  add_executable(otc-upscale-flash-rope-tests flash_rope_tests.cpp flash_rope.cpp flash_geometry.cpp)
  target_compile_options(otc-upscale-flash-rope-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-rope COMMAND otc-upscale-flash-rope-tests)
  add_executable(otc-upscale-flash-tokens-tests flash_tokens_tests.cpp flash_tokens.cpp)
  target_compile_options(otc-upscale-flash-tokens-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-tokens COMMAND otc-upscale-flash-tokens-tests)
  add_executable(otc-upscale-flash-prepare-tests flash_prepare_tests.cpp)
  target_link_libraries(otc-upscale-flash-prepare-tests PRIVATE otc-upscale-assets)
  target_compile_options(otc-upscale-flash-prepare-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-prepare-native COMMAND otc-upscale-flash-prepare-tests)
  add_executable(otc-upscale-flash-mask-tests flash_mask_tests.cpp flash_mask.cpp)
  target_compile_options(otc-upscale-flash-mask-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-mask COMMAND otc-upscale-flash-mask-tests)
  add_executable(otc-upscale-flash-decoder-frame-tests flash_decoder_frame_tests.cpp flash_decoder_frame.cpp flash_geometry.cpp)
  target_compile_options(otc-upscale-flash-decoder-frame-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-decoder-frame COMMAND otc-upscale-flash-decoder-frame-tests)
  add_executable(otc-upscale-assets-tests model_assets_tests.cpp)
  target_link_libraries(otc-upscale-assets-tests PRIVATE otc-upscale-assets)
  target_compile_options(otc-upscale-assets-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    add_executable(otc-upscale-flash-history-tests flash_history_tests.cpp)
    target_link_libraries(otc-upscale-flash-history-tests PRIVATE otc-upscale-assets)
    target_compile_options(otc-upscale-flash-history-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
    add_test(NAME otc-upscale-flash-history COMMAND otc-upscale-flash-history-tests "${CMAKE_CURRENT_BINARY_DIR}")
    add_executable(otc-upscale-kernel-files-tests verified_kernel_files_tests.cpp)
    target_link_libraries(otc-upscale-kernel-files-tests PRIVATE otc-upscale-assets)
    target_compile_options(otc-upscale-kernel-files-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
    file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/run-kernel-files-tests.cmake" CONTENT
"string(RANDOM LENGTH 16 ALPHABET 0123456789abcdef fixture)
execute_process(COMMAND \"$<TARGET_FILE:otc-upscale-kernel-files-tests>\" \"${CMAKE_CURRENT_BINARY_DIR}/kernel-fixture-\${fixture}\" RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  message(FATAL_ERROR \"Kernel snapshot tests failed: \${result}\")
endif()
")
    add_test(NAME otc-upscale-kernel-files COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_BINARY_DIR}/run-kernel-files-tests.cmake")
    add_executable(otc-upscale-prepare-tests model_prepare_tests.cpp)
    target_link_libraries(otc-upscale-prepare-tests PRIVATE otc-upscale-assets)
    target_compile_options(otc-upscale-prepare-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
    file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/run-prepare-tests.cmake" CONTENT
"string(RANDOM LENGTH 16 ALPHABET 0123456789abcdef fixture)
execute_process(COMMAND \"$<TARGET_FILE:otc-upscale-prepare-tests>\" \"${CMAKE_CURRENT_BINARY_DIR}/prepare-fixture-\${fixture}\" RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  message(FATAL_ERROR \"Prepare tests failed: \${result}\")
endif()
")
    add_test(NAME otc-upscale-prepare COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_BINARY_DIR}/run-prepare-tests.cmake")
    # Compile the verifier's tiny fixture seam only into this test executable.
    add_executable(otc-upscale-flash-prepare-cli-tests flash_prepare_cli_tests.cpp flash_prepare.cpp)
    target_compile_definitions(otc-upscale-flash-prepare-cli-tests PRIVATE OTC_FLASH_PREPARE_TESTING)
    target_link_libraries(otc-upscale-flash-prepare-cli-tests PRIVATE otc-upscale-assets)
    target_compile_options(otc-upscale-flash-prepare-cli-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
    add_test(NAME otc-upscale-flash-prepare-cli COMMAND otc-upscale-flash-prepare-cli-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  endif()
  # Asset fixtures deliberately reject reuse; provide a fresh small leaf each run.
  file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/run-assets-tests.cmake" CONTENT
"string(RANDOM LENGTH 16 ALPHABET 0123456789abcdef fixture)
execute_process(COMMAND \"$<TARGET_FILE:otc-upscale-assets-tests>\" \"${CMAKE_CURRENT_BINARY_DIR}/asset-fixture-\${fixture}\" RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  message(FATAL_ERROR \"Asset tests failed: \${result}\")
endif()
")
  add_test(NAME otc-upscale-assets COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_BINARY_DIR}/run-assets-tests.cmake")
endif()

if(UPSCALE_MATH_ONLY)
  return()
endif()

find_package(OpenVINO REQUIRED)

if(UPSCALE_BUILD_TESTS)
  add_executable(otc-upscale-rife-model-tests rife_model_tests.cpp)
  target_link_libraries(otc-upscale-rife-model-tests PRIVATE openvino::runtime)
  target_compile_options(otc-upscale-rife-model-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-rife-model COMMAND otc-upscale-rife-model-tests)
endif()

# The export worker and component gates use the same Flash implementation.
add_library(otc-upscale-flash STATIC EXCLUDE_FROM_ALL
  flash_ops.cpp flash_stage.cpp flash_model.cpp flash_pre_model.cpp flash_pre_session.cpp flash_post_session.cpp
  flash_lq_model.cpp flash_lq_session.cpp flash_cross_model.cpp flash_cross_session.cpp
  flash_edges_model.cpp flash_edges_session.cpp flash_decoder_model.cpp flash_decoder_frame.cpp flash_decoder_session.cpp flash_geometry.cpp
  flash_text_model.cpp flash_text_session.cpp flash_mask.cpp flash_rope.cpp
  flash_tokens.cpp flash_token_session.cpp flash_attention_session.cpp flash_source.cpp)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_sources(otc-upscale-flash PRIVATE flash_denoiser.cpp flash_video.cpp)
endif()
target_link_libraries(otc-upscale-flash PUBLIC otc-upscale-assets openvino::runtime)
target_link_libraries(otc-upscale-flash PRIVATE ${CMAKE_DL_LIBS})
target_compile_definitions(otc-upscale-flash PUBLIC OTC_FLASH_EXECUTABLE_CACHE=$<BOOL:${UPSCALE_EXECUTABLE_CACHE}>)
if(UPSCALE_EXECUTABLE_CACHE)
  if(NOT EXISTS "${UPSCALE_GPU_PLUGIN}" OR IS_DIRECTORY "${UPSCALE_GPU_PLUGIN}" OR
     IS_SYMLINK "${UPSCALE_GPU_PLUGIN}")
    message(FATAL_ERROR "Executable reuse requires UPSCALE_GPU_PLUGIN: a source-verified regular file")
  endif()
  file(SIZE "${UPSCALE_GPU_PLUGIN}" gpu_plugin_bytes)
  if(gpu_plugin_bytes LESS 1 OR gpu_plugin_bytes GREATER 536870912)
    message(FATAL_ERROR "GPU plugin size is outside its allowed range")
  endif()
  # The recipe authenticates source/ABI before configuration. Embed the resulting
  # artifact, not a mutable runtime manifest or a compiler-dependent release hash.
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${UPSCALE_GPU_PLUGIN}")
  file(SHA256 "${UPSCALE_GPU_PLUGIN}" gpu_plugin_sha256)
  string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," gpu_plugin_sha256_bytes "${gpu_plugin_sha256}")
  target_compile_definitions(otc-upscale-flash PRIVATE
    OTC_FLASH_GPU_PLUGIN_BYTES=${gpu_plugin_bytes}
    "OTC_FLASH_GPU_PLUGIN_SHA256_BYTES=${gpu_plugin_sha256_bytes}")
endif()
target_compile_options(otc-upscale-flash PRIVATE -Wall -Wextra -Wpedantic)
add_executable(otc-upscale main.cpp)
target_link_libraries(otc-upscale PRIVATE otc-upscale-core otc-upscale-flash)
target_include_directories(otc-upscale PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(otc-upscale PRIVATE -Wall -Wextra -Wpedantic)

set(UPSCALE_RUNTIME_TARGETS otc-upscale)
if(UPSCALE_BUILD_TESTS)
  add_executable(otc-upscale-cli-tests cli_tests.cpp)
  target_link_libraries(otc-upscale-cli-tests PRIVATE otc-upscale-core otc-upscale-flash)
  target_compile_options(otc-upscale-cli-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-cli COMMAND otc-upscale-cli-tests)
  if(UPSCALE_EXECUTABLE_CACHE)
    add_test(NAME otc-upscale-runtime-pin
      COMMAND "${CMAKE_COMMAND}" -E env
        "LD_LIBRARY_PATH=$<TARGET_FILE_DIR:openvino::runtime>:$ENV{LD_LIBRARY_PATH}"
        "$<TARGET_FILE:otc-upscale>" --verify-runtime "${UPSCALE_GPU_PLUGIN}")
    add_test(NAME otc-upscale-runtime-pin-reject
      COMMAND "${CMAKE_COMMAND}" -E env
        "LD_LIBRARY_PATH=$<TARGET_FILE_DIR:openvino::runtime>:$ENV{LD_LIBRARY_PATH}"
        "$<TARGET_FILE:otc-upscale>" --verify-runtime "${CMAKE_CURRENT_BINARY_DIR}/missing-gpu-plugin.so")
    set_tests_properties(otc-upscale-runtime-pin-reject PROPERTIES WILL_FAIL TRUE)
  endif()
  add_executable(otc-upscale-flash-ops-tests flash_ops_tests.cpp flash_ops.cpp)
  target_link_libraries(otc-upscale-flash-ops-tests PRIVATE openvino::runtime)
  target_compile_options(otc-upscale-flash-ops-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-ops COMMAND otc-upscale-flash-ops-tests)
  add_executable(otc-upscale-flash-post-tests flash_post_session_tests.cpp)
  target_link_libraries(otc-upscale-flash-post-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-post-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-post COMMAND otc-upscale-flash-post-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-upscale-flash-pre-tests flash_pre_model_tests.cpp)
  target_link_libraries(otc-upscale-flash-pre-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-pre-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-pre COMMAND otc-upscale-flash-pre-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-upscale-flash-stage-tests flash_stage_tests.cpp)
  target_link_libraries(otc-upscale-flash-stage-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-stage-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-stage COMMAND otc-upscale-flash-stage-tests)
  add_executable(otc-upscale-flash-setup-tests flash_setup_tests.cpp)
  target_link_libraries(otc-upscale-flash-setup-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-setup-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-setup COMMAND otc-upscale-flash-setup-tests)
  add_executable(otc-upscale-flash-model-tests flash_model_tests.cpp)
  target_link_libraries(otc-upscale-flash-model-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-model-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-model COMMAND otc-upscale-flash-model-tests)
  add_executable(otc-upscale-flash-lq-tests flash_lq_model_tests.cpp)
  target_link_libraries(otc-upscale-flash-lq-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-lq-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-lq COMMAND otc-upscale-flash-lq-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-upscale-flash-cross-tests flash_cross_model_tests.cpp)
  target_link_libraries(otc-upscale-flash-cross-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-cross-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-cross-model COMMAND otc-upscale-flash-cross-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-upscale-flash-edges-tests flash_edges_model_tests.cpp)
  target_link_libraries(otc-upscale-flash-edges-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-edges-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-edges-model COMMAND otc-upscale-flash-edges-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-upscale-flash-decoder-tests flash_decoder_model_tests.cpp)
  target_link_libraries(otc-upscale-flash-decoder-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-decoder-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-decoder-model COMMAND otc-upscale-flash-decoder-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-upscale-flash-text-tests flash_text_model_tests.cpp)
  target_link_libraries(otc-upscale-flash-text-tests PRIVATE otc-upscale-flash)
  target_compile_options(otc-upscale-flash-text-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-upscale-flash-text COMMAND otc-upscale-flash-text-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  list(APPEND UPSCALE_RUNTIME_TARGETS otc-upscale-cli-tests
    otc-upscale-flash-ops-tests otc-upscale-flash-post-tests
    otc-upscale-flash-pre-tests otc-upscale-flash-stage-tests otc-upscale-flash-lq-tests
    otc-upscale-flash-cross-tests otc-upscale-flash-edges-tests otc-upscale-flash-model-tests
    otc-upscale-flash-decoder-tests otc-upscale-flash-text-tests otc-upscale-flash-setup-tests)
endif()

get_target_property(OPENVINO_RUNTIME_LIBRARY openvino::runtime IMPORTED_LOCATION_RELEASE)
if(NOT OPENVINO_RUNTIME_LIBRARY)
  get_target_property(OPENVINO_RUNTIME_LIBRARY openvino::runtime IMPORTED_LOCATION)
endif()
if(OPENVINO_RUNTIME_LIBRARY)
  get_filename_component(OPENVINO_RUNTIME_LIB_DIR "${OPENVINO_RUNTIME_LIBRARY}" DIRECTORY)
  get_filename_component(OPENVINO_RUNTIME_ROOT "${OPENVINO_RUNTIME_LIB_DIR}/../.." ABSOLUTE)
  find_file(UPSCALE_TBB_LIBRARY NAMES libtbb.so.12.13 libtbb.so.12
    PATHS "${OPENVINO_RUNTIME_LIB_DIR}" "${OPENVINO_RUNTIME_ROOT}/3rdparty/tbb/lib" NO_DEFAULT_PATH)
  if(UPSCALE_TBB_LIBRARY)
    get_filename_component(UPSCALE_TBB_LIB_DIR "${UPSCALE_TBB_LIBRARY}" DIRECTORY)
    foreach(target IN LISTS UPSCALE_RUNTIME_TARGETS)
      target_link_libraries(${target} PRIVATE "${UPSCALE_TBB_LIBRARY}")
      target_link_options(${target} PRIVATE "-Wl,-rpath-link,${UPSCALE_TBB_LIB_DIR}")
    endforeach()
  endif()
endif()
set_target_properties(otc-upscale PROPERTIES
  BUILD_RPATH "$ORIGIN/lib"
  INSTALL_RPATH "$ORIGIN/lib"
  BUILD_WITH_INSTALL_RPATH TRUE
)
