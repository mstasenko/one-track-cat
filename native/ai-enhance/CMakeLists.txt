cmake_minimum_required(VERSION 3.20)
project(otc_ai_enhance LANGUAGES CXX)

option(AI_ENHANCE_BUILD_TESTS "Build pure timing, tiling and frame invariant tests" OFF)
option(AI_ENHANCE_MATH_ONLY "Build pure tests without OpenVINO" OFF)
option(AI_ENHANCE_EXECUTABLE_CACHE "Reuse compiled Flash stages with the pinned patched GPU plugin" OFF)
set(AI_ENHANCE_GPU_PLUGIN "" CACHE FILEPATH "Source-verified GPU plugin to authenticate in the worker")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(otc-ai-enhance-core STATIC ai_enhance_core.cpp)
target_include_directories(otc-ai-enhance-core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(otc-ai-enhance-core PRIVATE -Wall -Wextra -Wpedantic)

find_package(OpenSSL REQUIRED COMPONENTS Crypto)
add_library(otc-ai-enhance-assets STATIC seedvr_assets.cpp seedvr_prepare.cpp
  verified_kernel_files.cpp flash_prepare.cpp flash_prepare_cli.cpp)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_sources(otc-ai-enhance-assets PRIVATE flash_history.cpp)
endif()
target_include_directories(otc-ai-enhance-assets PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(otc-ai-enhance-assets PUBLIC OpenSSL::Crypto)
target_compile_options(otc-ai-enhance-assets PRIVATE -Wall -Wextra -Wpedantic)

# Build-time pin generation only; the AI pack ships the worker, not this tool.
add_executable(otc-ai-enhance-bf16 EXCLUDE_FROM_ALL bf16_convert.cpp)
target_link_libraries(otc-ai-enhance-bf16 PRIVATE otc-ai-enhance-assets)
target_compile_options(otc-ai-enhance-bf16 PRIVATE -Wall -Wextra -Wpedantic)

if(AI_ENHANCE_MATH_ONLY OR AI_ENHANCE_BUILD_TESTS)
  enable_testing()
  set_target_properties(otc-ai-enhance-bf16 PROPERTIES EXCLUDE_FROM_ALL FALSE)
  find_package(Python3 QUIET COMPONENTS Interpreter)
  if(Python3_Interpreter_FOUND)
    add_test(NAME otc-ai-enhance-bf16
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_bf16_convert.py"
              "$<TARGET_FILE:otc-ai-enhance-bf16>")
    add_test(NAME otc-ai-enhance-flash-prepare
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_prepare_flash_post.py")
    add_test(NAME otc-ai-enhance-flash-structure
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_structure.py")
    add_test(NAME otc-ai-enhance-flash-projection
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_projection.py")
    add_test(NAME otc-ai-enhance-flash-cross
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_cross.py")
    add_test(NAME otc-ai-enhance-flash-text-export
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_text.py")
    add_test(NAME otc-ai-enhance-flash-conditioning-export
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_conditioning.py")
    add_test(NAME otc-ai-enhance-flash-edges-export
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_edges.py")
    add_test(NAME otc-ai-enhance-flash-decoder-export
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_export_flash_decoder.py")
    add_test(NAME otc-ai-enhance-flash-decoder-prepare
      COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/test_prepare_flash_decoder.py")
  endif()
  add_executable(otc-ai-enhance-core-tests ai_enhance_core_tests.cpp)
  target_link_libraries(otc-ai-enhance-core-tests PRIVATE otc-ai-enhance-core)
  target_compile_options(otc-ai-enhance-core-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-core COMMAND otc-ai-enhance-core-tests)
  add_executable(otc-ai-enhance-spatial-ranges-tests spatial_ranges_tests.cpp)
  target_compile_options(otc-ai-enhance-spatial-ranges-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-spatial-ranges COMMAND otc-ai-enhance-spatial-ranges-tests)
  add_executable(otc-ai-enhance-flash-stream-tests flash_stream_tests.cpp)
  target_compile_options(otc-ai-enhance-flash-stream-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-stream COMMAND otc-ai-enhance-flash-stream-tests)
  add_executable(otc-ai-enhance-flash-source-tests flash_source_test.cpp flash_source.cpp)
  target_compile_options(otc-ai-enhance-flash-source-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-source COMMAND otc-ai-enhance-flash-source-tests)
  add_executable(otc-ai-enhance-flash-geometry-tests flash_geometry_tests.cpp flash_geometry.cpp)
  target_compile_options(otc-ai-enhance-flash-geometry-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-geometry COMMAND otc-ai-enhance-flash-geometry-tests)
  add_executable(otc-ai-enhance-flash-rope-tests flash_rope_tests.cpp flash_rope.cpp flash_geometry.cpp)
  target_compile_options(otc-ai-enhance-flash-rope-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-rope COMMAND otc-ai-enhance-flash-rope-tests)
  add_executable(otc-ai-enhance-flash-tokens-tests flash_tokens_tests.cpp flash_tokens.cpp)
  target_compile_options(otc-ai-enhance-flash-tokens-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-tokens COMMAND otc-ai-enhance-flash-tokens-tests)
  add_executable(otc-ai-enhance-flash-prepare-tests flash_prepare_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-prepare-tests PRIVATE otc-ai-enhance-assets)
  target_compile_options(otc-ai-enhance-flash-prepare-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-prepare-native COMMAND otc-ai-enhance-flash-prepare-tests)
  add_executable(otc-ai-enhance-flash-mask-tests flash_mask_tests.cpp flash_mask.cpp)
  target_compile_options(otc-ai-enhance-flash-mask-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-mask COMMAND otc-ai-enhance-flash-mask-tests)
  add_executable(otc-ai-enhance-flash-decoder-frame-tests flash_decoder_frame_tests.cpp flash_decoder_frame.cpp flash_geometry.cpp)
  target_compile_options(otc-ai-enhance-flash-decoder-frame-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-decoder-frame COMMAND otc-ai-enhance-flash-decoder-frame-tests)
  add_executable(otc-ai-enhance-assets-tests seedvr_assets_tests.cpp)
  target_link_libraries(otc-ai-enhance-assets-tests PRIVATE otc-ai-enhance-assets)
  target_compile_options(otc-ai-enhance-assets-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    add_executable(otc-ai-enhance-flash-history-tests flash_history_tests.cpp)
    target_link_libraries(otc-ai-enhance-flash-history-tests PRIVATE otc-ai-enhance-assets)
    target_compile_options(otc-ai-enhance-flash-history-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
    add_test(NAME otc-ai-enhance-flash-history COMMAND otc-ai-enhance-flash-history-tests "${CMAKE_CURRENT_BINARY_DIR}")
    add_executable(otc-ai-enhance-kernel-files-tests verified_kernel_files_tests.cpp)
    target_link_libraries(otc-ai-enhance-kernel-files-tests PRIVATE otc-ai-enhance-assets)
    target_compile_options(otc-ai-enhance-kernel-files-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
    file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/run-kernel-files-tests.cmake" CONTENT
"string(RANDOM LENGTH 16 ALPHABET 0123456789abcdef fixture)
execute_process(COMMAND \"$<TARGET_FILE:otc-ai-enhance-kernel-files-tests>\" \"${CMAKE_CURRENT_BINARY_DIR}/kernel-fixture-\${fixture}\" RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  message(FATAL_ERROR \"Kernel snapshot tests failed: \${result}\")
endif()
")
    add_test(NAME otc-ai-enhance-kernel-files COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_BINARY_DIR}/run-kernel-files-tests.cmake")
    add_executable(otc-ai-enhance-prepare-tests seedvr_prepare_tests.cpp)
    target_link_libraries(otc-ai-enhance-prepare-tests PRIVATE otc-ai-enhance-assets)
    target_compile_options(otc-ai-enhance-prepare-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
    file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/run-prepare-tests.cmake" CONTENT
"string(RANDOM LENGTH 16 ALPHABET 0123456789abcdef fixture)
execute_process(COMMAND \"$<TARGET_FILE:otc-ai-enhance-prepare-tests>\" \"${CMAKE_CURRENT_BINARY_DIR}/prepare-fixture-\${fixture}\" RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  message(FATAL_ERROR \"Prepare tests failed: \${result}\")
endif()
")
    add_test(NAME otc-ai-enhance-prepare COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_BINARY_DIR}/run-prepare-tests.cmake")
    # Compile the verifier's tiny fixture seam only into this test executable.
    add_executable(otc-ai-enhance-flash-prepare-cli-tests flash_prepare_cli_tests.cpp flash_prepare.cpp)
    target_compile_definitions(otc-ai-enhance-flash-prepare-cli-tests PRIVATE OTC_FLASH_PREPARE_TESTING)
    target_link_libraries(otc-ai-enhance-flash-prepare-cli-tests PRIVATE otc-ai-enhance-assets)
    target_compile_options(otc-ai-enhance-flash-prepare-cli-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
    add_test(NAME otc-ai-enhance-flash-prepare-cli COMMAND otc-ai-enhance-flash-prepare-cli-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  endif()
  # Asset fixtures deliberately reject reuse; provide a fresh small leaf each run.
  file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/run-assets-tests.cmake" CONTENT
"string(RANDOM LENGTH 16 ALPHABET 0123456789abcdef fixture)
execute_process(COMMAND \"$<TARGET_FILE:otc-ai-enhance-assets-tests>\" \"${CMAKE_CURRENT_BINARY_DIR}/asset-fixture-\${fixture}\" RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  message(FATAL_ERROR \"Asset tests failed: \${result}\")
endif()
")
  add_test(NAME otc-ai-enhance-assets COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_BINARY_DIR}/run-assets-tests.cmake")
endif()

if(AI_ENHANCE_MATH_ONLY)
  return()
endif()

find_package(OpenVINO REQUIRED)
# The export worker and component gates use the same Flash implementation.
add_library(otc-ai-enhance-flash STATIC EXCLUDE_FROM_ALL
  flash_ops.cpp flash_stage.cpp flash_model.cpp flash_pre_model.cpp flash_pre_session.cpp flash_post_session.cpp
  flash_lq_model.cpp flash_lq_session.cpp flash_cross_model.cpp flash_cross_session.cpp
  flash_edges_model.cpp flash_edges_session.cpp flash_decoder_model.cpp flash_decoder_frame.cpp flash_decoder_session.cpp flash_geometry.cpp
  flash_text_model.cpp flash_text_session.cpp flash_mask.cpp flash_rope.cpp
  flash_tokens.cpp flash_token_session.cpp flash_attention_session.cpp flash_source.cpp)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_sources(otc-ai-enhance-flash PRIVATE flash_denoiser.cpp flash_video.cpp)
endif()
target_link_libraries(otc-ai-enhance-flash PUBLIC otc-ai-enhance-assets openvino::runtime)
target_link_libraries(otc-ai-enhance-flash PRIVATE ${CMAKE_DL_LIBS})
target_compile_definitions(otc-ai-enhance-flash PUBLIC OTC_FLASH_EXECUTABLE_CACHE=$<BOOL:${AI_ENHANCE_EXECUTABLE_CACHE}>)
if(AI_ENHANCE_EXECUTABLE_CACHE)
  if(NOT EXISTS "${AI_ENHANCE_GPU_PLUGIN}" OR IS_DIRECTORY "${AI_ENHANCE_GPU_PLUGIN}" OR
     IS_SYMLINK "${AI_ENHANCE_GPU_PLUGIN}")
    message(FATAL_ERROR "Executable reuse requires AI_ENHANCE_GPU_PLUGIN: a source-verified regular file")
  endif()
  file(SIZE "${AI_ENHANCE_GPU_PLUGIN}" gpu_plugin_bytes)
  if(gpu_plugin_bytes LESS 1 OR gpu_plugin_bytes GREATER 536870912)
    message(FATAL_ERROR "GPU plugin size is outside its allowed range")
  endif()
  # The recipe authenticates source/ABI before configuration. Embed the resulting
  # artifact, not a mutable runtime manifest or a compiler-dependent release hash.
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${AI_ENHANCE_GPU_PLUGIN}")
  file(SHA256 "${AI_ENHANCE_GPU_PLUGIN}" gpu_plugin_sha256)
  string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," gpu_plugin_sha256_bytes "${gpu_plugin_sha256}")
  target_compile_definitions(otc-ai-enhance-flash PRIVATE
    OTC_FLASH_GPU_PLUGIN_BYTES=${gpu_plugin_bytes}
    "OTC_FLASH_GPU_PLUGIN_SHA256_BYTES=${gpu_plugin_sha256_bytes}")
endif()
target_compile_options(otc-ai-enhance-flash PRIVATE -Wall -Wextra -Wpedantic)
add_executable(otc-ai-enhance main.cpp)
target_link_libraries(otc-ai-enhance PRIVATE otc-ai-enhance-core otc-ai-enhance-flash)
target_include_directories(otc-ai-enhance PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(otc-ai-enhance PRIVATE -Wall -Wextra -Wpedantic)

set(AI_ENHANCE_RUNTIME_TARGETS otc-ai-enhance)
if(AI_ENHANCE_BUILD_TESTS)
  add_executable(otc-ai-enhance-cli-tests cli_tests.cpp)
  target_link_libraries(otc-ai-enhance-cli-tests PRIVATE otc-ai-enhance-core otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-cli-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-cli COMMAND otc-ai-enhance-cli-tests)
  if(AI_ENHANCE_EXECUTABLE_CACHE)
    add_test(NAME otc-ai-enhance-runtime-pin
      COMMAND "${CMAKE_COMMAND}" -E env
        "LD_LIBRARY_PATH=$<TARGET_FILE_DIR:openvino::runtime>:$ENV{LD_LIBRARY_PATH}"
        "$<TARGET_FILE:otc-ai-enhance>" --verify-runtime "${AI_ENHANCE_GPU_PLUGIN}")
    add_test(NAME otc-ai-enhance-runtime-pin-reject
      COMMAND "${CMAKE_COMMAND}" -E env
        "LD_LIBRARY_PATH=$<TARGET_FILE_DIR:openvino::runtime>:$ENV{LD_LIBRARY_PATH}"
        "$<TARGET_FILE:otc-ai-enhance>" --verify-runtime "${CMAKE_CURRENT_BINARY_DIR}/missing-gpu-plugin.so")
    set_tests_properties(otc-ai-enhance-runtime-pin-reject PROPERTIES WILL_FAIL TRUE)
  endif()
  add_executable(otc-ai-enhance-flash-ops-tests flash_ops_tests.cpp flash_ops.cpp)
  target_link_libraries(otc-ai-enhance-flash-ops-tests PRIVATE openvino::runtime)
  target_compile_options(otc-ai-enhance-flash-ops-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-ops COMMAND otc-ai-enhance-flash-ops-tests)
  add_executable(otc-ai-enhance-flash-post-tests flash_post_session_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-post-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-post-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-post COMMAND otc-ai-enhance-flash-post-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-ai-enhance-flash-pre-tests flash_pre_model_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-pre-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-pre-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-pre COMMAND otc-ai-enhance-flash-pre-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-ai-enhance-flash-stage-tests flash_stage_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-stage-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-stage-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-stage COMMAND otc-ai-enhance-flash-stage-tests)
  add_executable(otc-ai-enhance-flash-setup-tests flash_setup_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-setup-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-setup-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-setup COMMAND otc-ai-enhance-flash-setup-tests)
  add_executable(otc-ai-enhance-flash-model-tests flash_model_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-model-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-model-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-model COMMAND otc-ai-enhance-flash-model-tests)
  add_executable(otc-ai-enhance-flash-lq-tests flash_lq_model_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-lq-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-lq-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-lq COMMAND otc-ai-enhance-flash-lq-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-ai-enhance-flash-cross-tests flash_cross_model_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-cross-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-cross-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-cross-model COMMAND otc-ai-enhance-flash-cross-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-ai-enhance-flash-edges-tests flash_edges_model_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-edges-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-edges-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-edges-model COMMAND otc-ai-enhance-flash-edges-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-ai-enhance-flash-decoder-tests flash_decoder_model_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-decoder-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-decoder-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-decoder-model COMMAND otc-ai-enhance-flash-decoder-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  add_executable(otc-ai-enhance-flash-text-tests flash_text_model_tests.cpp)
  target_link_libraries(otc-ai-enhance-flash-text-tests PRIVATE otc-ai-enhance-flash)
  target_compile_options(otc-ai-enhance-flash-text-tests PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
  add_test(NAME otc-ai-enhance-flash-text COMMAND otc-ai-enhance-flash-text-tests "${CMAKE_CURRENT_SOURCE_DIR}/flash-assets")
  list(APPEND AI_ENHANCE_RUNTIME_TARGETS otc-ai-enhance-cli-tests
    otc-ai-enhance-flash-ops-tests otc-ai-enhance-flash-post-tests
    otc-ai-enhance-flash-pre-tests otc-ai-enhance-flash-stage-tests otc-ai-enhance-flash-lq-tests
    otc-ai-enhance-flash-cross-tests otc-ai-enhance-flash-edges-tests otc-ai-enhance-flash-model-tests
    otc-ai-enhance-flash-decoder-tests otc-ai-enhance-flash-text-tests otc-ai-enhance-flash-setup-tests)
endif()

get_target_property(OPENVINO_RUNTIME_LIBRARY openvino::runtime IMPORTED_LOCATION_RELEASE)
if(NOT OPENVINO_RUNTIME_LIBRARY)
  get_target_property(OPENVINO_RUNTIME_LIBRARY openvino::runtime IMPORTED_LOCATION)
endif()
if(OPENVINO_RUNTIME_LIBRARY)
  get_filename_component(OPENVINO_RUNTIME_LIB_DIR "${OPENVINO_RUNTIME_LIBRARY}" DIRECTORY)
  get_filename_component(OPENVINO_RUNTIME_ROOT "${OPENVINO_RUNTIME_LIB_DIR}/../.." ABSOLUTE)
  find_file(AI_ENHANCE_TBB_LIBRARY NAMES libtbb.so.12.13 libtbb.so.12
    PATHS "${OPENVINO_RUNTIME_LIB_DIR}" "${OPENVINO_RUNTIME_ROOT}/3rdparty/tbb/lib" NO_DEFAULT_PATH)
  if(AI_ENHANCE_TBB_LIBRARY)
    get_filename_component(AI_ENHANCE_TBB_LIB_DIR "${AI_ENHANCE_TBB_LIBRARY}" DIRECTORY)
    foreach(target IN LISTS AI_ENHANCE_RUNTIME_TARGETS)
      target_link_libraries(${target} PRIVATE "${AI_ENHANCE_TBB_LIBRARY}")
      target_link_options(${target} PRIVATE "-Wl,-rpath-link,${AI_ENHANCE_TBB_LIB_DIR}")
    endforeach()
  endif()
endif()
set_target_properties(otc-ai-enhance PROPERTIES
  BUILD_RPATH "$ORIGIN/lib"
  INSTALL_RPATH "$ORIGIN/lib"
  BUILD_WITH_INSTALL_RPATH TRUE
)
